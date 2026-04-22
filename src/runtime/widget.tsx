/**
 * Plant Explorer widget
 * =====================
 *
 * Purpose
 * -------
 * This widget displays the current garden bed hierarchy and the current plant
 * stock held in each bed.
 *
 * Backend data model
 * ------------------
 * - GardenBedsTransactions is the backend source of truth.
 * - GardenBeds_Active is the backend-derived current-state bed layer.
 * - PlantsInBeds is the backend-derived current stock summary.
 *
 * Frontend data model
 * -------------------
 * - This widget reads the configured current bed layer through the shared
 *   Experience Builder datasource.
 * - It reads PlantsInBeds and Plant_Species directly through REST queries in
 *   plant-queries.ts.
 * - It does not reconstruct current beds from transactions in the browser.
 *
 * Core behavior
 * -------------
 * 1. Build a zones -> beds tree from the configured current bed datasource.
 * 2. Keep tree selection, datasource selection, and map selection in sync.
 * 3. Let the user filter by zone text and species.
 * 4. Let the user isolate zones on the map without changing datasource state.
 * 5. Lazily load plant totals and detailed stock lines only when a bed is expanded.
 *
 * Important assumptions
 * ---------------------
 * - The configured datasource should be the published current bed layer
 *   (for example GardenBedsTEST_Active).
 * - The bed datasource must expose garden_uid, zone, and bed_no.
 * - PlantsInBeds and Plant_Species service URLs are configured in service-urls.ts.
 */

import {
  React,
  type AllWidgetProps,
  type DataSource,
  DataSourceComponent,
  DataSourceStatus
} from 'jimu-core'
import {
  JimuMapViewComponent,
  type JimuMapView
} from 'jimu-arcgis'
import FeatureEffect from 'esri/layers/support/FeatureEffect'
import FeatureFilter from 'esri/layers/support/FeatureFilter'
import { buildSqlInClause, firstValue, getGardenUidFromRecord, escapeSqlValue } from './lib/field-helpers'
import { queryGardenUidsForSpecies, queryPlantLinesForBed, queryPlantsInBedTotal, querySpeciesOptions } from './lib/plant-queries'
import type { PlantLine, SpeciesOption } from './lib/plant-types'
import { SELECTED_SPECIES_UID_KEY } from './lib/service-urls'

const { useEffect, useState } = React

interface TemporalContextValue {
  viewMode: 'Current' | 'Historical'
  effectiveDate: string
  requestToken: number
  dataState: 'current-ready' | 'historical-pending' | 'historical-ready'
}

interface HistoricalBedSnapshotRow {
  gardenUid: string
  zone: string
  bedNo: string
  area?: string
}

interface HistoricalPlantSnapshotLine {
  gardenUid: string
  speciesUid: string
  costPerUnit: number
  potSize: string
  unitType: string
  currentQuantity: number
}

// Fallback title/URL fragments used when Experience Builder does not give us a
// clean datasource id match for the configured current bed layer.
const CURRENT_BED_LAYER_HINTS = [
  'gardenbedstest_active',
  'gardenbeds active',
  'gardenbeds_active',
  'gardenbedsactive'
]
const ACCENT_COLOR = '#007ac2'
const MUTED_TEXT_COLOR = '#666'
const SECONDARY_TEXT_COLOR = '#8a8a8a'
const DANGER_TEXT_COLOR = '#c62828'
const TREE_TOGGLE_STYLE = {
  background: 'none',
  border: 'none',
  color: '#444',
  textDecoration: 'none',
  fontWeight: 700,
  minWidth: '0.8rem',
  width: '0.8rem',
  padding: 0,
  fontSize: '0.72rem',
  lineHeight: 1
}
const LINK_BUTTON_STYLE = {
  background: 'none',
  border: 'none',
  color: ACCENT_COLOR,
  textDecoration: 'underline'
}
const PLAIN_BUTTON_STYLE = {
  background: 'none',
  border: 'none'
}
const EMPTY_STATE_TEXT_STYLE = {
  color: MUTED_TEXT_COLOR,
  lineHeight: 1.5
}
const EMPTY_STATE_DETAIL_STYLE = {
  marginBottom: 0,
  fontSize: '0.92rem',
  color: SECONDARY_TEXT_COLOR
}
const SECTION_LABEL_STYLE = {
  display: 'grid',
  gridTemplateColumns: '4.75rem 1fr',
  columnGap: '0.5rem',
  alignItems: 'center',
  marginBottom: '0.5rem',
  paddingBottom: '0.35rem',
  borderBottom: '1px solid #e6e6e6'
}
const CHECKBOX_STYLE = {
  width: '0.95rem',
  height: '0.95rem',
  accentColor: ACCENT_COLOR,
  cursor: 'pointer'
}
const ZONE_ROW_STYLE = {
  display: 'grid',
  gridTemplateColumns: '4.75rem 1fr',
  columnGap: '0.5rem',
  alignItems: 'start'
}
const ZONE_ISOLATE_HEADER_STYLE = {
  fontSize: '0.72rem',
  letterSpacing: '0.05em',
  textTransform: 'uppercase' as const,
  color: SECONDARY_TEXT_COLOR,
  fontWeight: 700,
  textAlign: 'center' as const
}
const SECTION_TITLE_STYLE = {
  fontSize: '0.88rem',
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  color: '#4d4d4d',
  fontWeight: 700
}
const HELP_BUTTON_STYLE = {
  ...PLAIN_BUTTON_STYLE,
  width: '1.25rem',
  height: '1.25rem',
  borderRadius: '999px',
  border: `1px solid ${ACCENT_COLOR}`,
  color: ACCENT_COLOR,
  fontSize: '0.78rem',
  fontWeight: 700,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer'
}
const HELP_POPOVER_STYLE = {
  position: 'absolute' as const,
  top: '1.7rem',
  left: 0,
  zIndex: 2,
  width: '15.5rem',
  padding: '0.7rem 0.8rem',
  backgroundColor: '#fff',
  border: '1px solid #d6e7f2',
  borderRadius: '6px',
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.12)',
  color: '#333',
  fontSize: '0.82rem',
  lineHeight: 1.45
}
const WIDGET_VERSION = 'v2026.04.20-1.10'
const TEMPORAL_CONTEXT_STORAGE_KEY = 'LIVING_PLACES_TEMPORAL_CONTEXT'
const TEMPORAL_CONTEXT_EVENT_NAME = 'living-places:temporal-context-changed'
const HISTORICAL_BED_SNAPSHOT_STORAGE_KEY = 'LIVING_PLACES_HISTORICAL_BED_SNAPSHOT'
const HISTORICAL_PLANT_SNAPSHOT_STORAGE_KEY = 'LIVING_PLACES_HISTORICAL_PLANT_SNAPSHOT'

const readTemporalContextFromSession = (): TemporalContextValue | null =>
{
  try
  {
    const rawValue = sessionStorage.getItem(TEMPORAL_CONTEXT_STORAGE_KEY)

    if (!rawValue)
    {
      return null
    }

    const parsedValue = JSON.parse(rawValue)

    if (
      (parsedValue?.viewMode !== 'Current' && parsedValue?.viewMode !== 'Historical') ||
      typeof parsedValue?.effectiveDate !== 'string' ||
      typeof parsedValue?.requestToken !== 'number' ||
      (parsedValue?.dataState !== 'current-ready' && parsedValue?.dataState !== 'historical-pending' && parsedValue?.dataState !== 'historical-ready')
    )
    {
      return null
    }

    return parsedValue as TemporalContextValue
  }
  catch (error)
  {
    console.warn('Failed to parse Living Places temporal context from session storage', error)
    return null
  }
}

const readJsonFromSession = <T,>(storageKey: string): T | null =>
{
  try
  {
    const rawValue = sessionStorage.getItem(storageKey)

    if (!rawValue)
    {
      return null
    }

    return JSON.parse(rawValue) as T
  }
  catch (error)
  {
    console.warn(`Failed to parse session storage value for ${storageKey}`, error)
    return null
  }
}

// Shared arrow icon used throughout the hierarchy tree.
const getTreeToggleIcon = (isExpanded: boolean): string =>
{
  return isExpanded ? '▼' : '▶'
}

// A single bed entry rendered under a zone.
interface BedItem {
  gardenUid: string
  bedNo: string
  area: string
}

interface SpeciesGroup {
  speciesUid: string
  speciesName: string
  totalQuantity: number
  lines: PlantLine[]
}

interface ZoneGroup {
  zone: string
  beds: BedItem[]
}

interface HighlightHandle {
  remove: () => void
}

interface ViewEventHandle {
  remove: () => void
}

// Formats counts/costs without trailing decimal zeroes.
const formatNumber = (value: number): string =>
{
  if (Number.isInteger(value))
  {
    return String(value)
  }

  return value.toFixed(2).replace(/\.?0+$/, '')
}

const compareZoneValues = (left: string, right: string): number =>
{
  const leftIsNumeric = /^\d+$/.test(left)
  const rightIsNumeric = /^\d+$/.test(right)

  if (leftIsNumeric && rightIsNumeric)
  {
    return Number(left) - Number(right)
  }

  if (leftIsNumeric !== rightIsNumeric)
  {
    return leftIsNumeric ? -1 : 1
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

const normalizeFilterValue = (value: string): string =>
{
  return value.trim().toLowerCase()
}

const isConfiguredBedLayerMatch = (layerLike: any, dataSourceId?: string): boolean =>
{
  const layerId = String(layerLike?.id || '')
  const layerDataSourceId =
    layerLike?.layerDataSourceId ||
    layerLike?.dataSourceId ||
    layerLike?.layerDataSource?.id ||
    layerLike?.dataSource?.id ||
    ''
  const layerTitle =
    layerLike?.title ||
    layerLike?.layer?.title ||
    layerLike?.layerView?.layer?.title ||
    layerLike?.getLabel?.() ||
    layerLike?.layerDataSource?.getLabel?.() ||
    layerLike?.dataSource?.getLabel?.() ||
    ''
  const layerUrl =
    layerLike?.url ||
    layerLike?.layer?.url ||
    layerLike?.layerView?.layer?.url ||
    layerLike?.layerDataSource?.getDataSourceJson?.()?.url ||
    layerLike?.dataSource?.getDataSourceJson?.()?.url ||
    layerLike?.parent?.url ||
    ''

  return (
    (dataSourceId ? layerDataSourceId === dataSourceId || layerId.includes(dataSourceId) : false) ||
    CURRENT_BED_LAYER_HINTS.some((hint) =>
    {
      return String(layerTitle).toLowerCase().includes(hint) || String(layerUrl).toLowerCase().includes(hint)
    })
  )
}

const groupPlantLinesBySpecies = (plantLines: PlantLine[]): SpeciesGroup[] =>
{
  const speciesMap = new Map<string, SpeciesGroup>()

  plantLines.forEach((plantLine) =>
  {
    const speciesKey = `${plantLine.speciesUid}|||${plantLine.speciesName}`

    if (!speciesMap.has(speciesKey))
    {
      speciesMap.set(speciesKey, {
        speciesUid: plantLine.speciesUid,
        speciesName: plantLine.speciesName,
        totalQuantity: 0,
        lines: []
      })
    }

    const speciesGroup = speciesMap.get(speciesKey)

    if (speciesGroup)
    {
      speciesGroup.totalQuantity += plantLine.quantity
      speciesGroup.lines.push(plantLine)
    }
  })

  return Array.from(speciesMap.values())
    .map((speciesGroup) =>
    {
      return {
        ...speciesGroup,
        lines: speciesGroup.lines.slice().sort((left, right) =>
        {
          if (right.quantity !== left.quantity)
          {
            return right.quantity - left.quantity
          }

          if (left.costPerUnit !== right.costPerUnit)
          {
            return left.costPerUnit - right.costPerUnit
          }

          return left.unitType.localeCompare(right.unitType, undefined, { numeric: true, sensitivity: 'base' })
        })
      }
    })
    .sort((left, right) =>
    {
      const speciesCompare = left.speciesName.localeCompare(right.speciesName, undefined, { numeric: true, sensitivity: 'base' })

      if (speciesCompare !== 0)
      {
        return speciesCompare
      }

      return right.totalQuantity - left.totalQuantity
    })
}

const getSelectedBedRowStyle = (isSelected: boolean) =>
{
  return {
    marginBottom: '0.35rem',
    padding: isSelected ? '0.25rem 0.5rem' : 0,
    marginLeft: isSelected ? '-0.5rem' : 0,
    borderLeft: isSelected ? `3px solid ${ACCENT_COLOR}` : '3px solid transparent',
    backgroundColor: isSelected ? '#eef7fd' : 'transparent',
    borderRadius: '4px'
  }
}

const getExpandIcon = (isExpanded: boolean): string =>
{
  return isExpanded ? '▾' : '▸'
}

const Widget = (props: AllWidgetProps<any>) =>
{
  const [displayMode, setDisplayMode] = useState<'current' | 'historical'>('current')
  // Shared Experience Builder datasource for the published current bed layer.
  const [bedDs, setBedDs] = useState<DataSource | null>(null)
  const [jimuMapView, setJimuMapView] = useState<JimuMapView | null>(null)
  const [zoneGroups, setZoneGroups] = useState<ZoneGroup[]>([])
  const [hasLoadedBedRecords, setHasLoadedBedRecords] = useState(false)
  const [isLoadingZones, setIsLoadingZones] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [zoneFilterText, setZoneFilterText] = useState('')
  const [isolatedZones, setIsolatedZones] = useState<string[]>([])
  const [showHelp, setShowHelp] = useState(false)
  const [speciesOptions, setSpeciesOptions] = useState<SpeciesOption[]>([])
  const [isLoadingSpeciesOptions, setIsLoadingSpeciesOptions] = useState(false)
  const [speciesLoadError, setSpeciesLoadError] = useState('')
  const [isLoadingSpeciesBeds, setIsLoadingSpeciesBeds] = useState(false)
  const [filteredGardenUidsForSpecies, setFilteredGardenUidsForSpecies] = useState<string[] | null>(null)
  const [selectedBedUid, setSelectedBedUid] = useState('')
  const [expandedZones, setExpandedZones] = useState<string[]>([])
  const [expandedBeds, setExpandedBeds] = useState<string[]>([])
  const [bedPlantTotals, setBedPlantTotals] = useState<Record<string, number>>({})
  const [loadingBedTotals, setLoadingBedTotals] = useState<Record<string, boolean>>({})
  const [expandedPlantTotals, setExpandedPlantTotals] = useState<string[]>([])
  const [bedPlantLines, setBedPlantLines] = useState<Record<string, PlantLine[]>>({})
  const [loadingBedPlantLines, setLoadingBedPlantLines] = useState<Record<string, boolean>>({})
  const [expandedSpeciesGroups, setExpandedSpeciesGroups] = useState<string[]>([])
  const [selectedSpeciesUid, setSelectedSpeciesUid] = useState('')
  const [timelinerContextLabel, setTimelinerContextLabel] = useState('')
  const [historicalPlantSnapshotLines, setHistoricalPlantSnapshotLines] = useState<HistoricalPlantSnapshotLine[]>([])

  const highlightHandleRef = React.useRef<HighlightHandle | null>(null)
  const mapClickHandleRef = React.useRef<ViewEventHandle | null>(null)
  const bedRowRefs = React.useRef<Record<string, HTMLDivElement | null>>({})
  const latestTemporalRequestTokenRef = React.useRef<number>(0)
  const displayModeRef = React.useRef<'current' | 'historical'>('current')
  const visibleGardenUidsRef = React.useRef<Set<string>>(new Set())
  const normalizedZoneFilterText = normalizeFilterValue(zoneFilterText)

  // Reads the currently selected species from session storage so the widget can
  // preserve the user's last species filter choice across reloads.
  const syncSelectedSpeciesUidFromSession = () =>
  {
    setSelectedSpeciesUid(sessionStorage.getItem(SELECTED_SPECIES_UID_KEY) || '')
  }

  const applySelectedSpeciesUid = (speciesUid: string) =>
  {
    setSelectedSpeciesUid(speciesUid)

    if (speciesUid !== '')
    {
      sessionStorage.setItem(SELECTED_SPECIES_UID_KEY, speciesUid)
    }
    else
    {
      sessionStorage.removeItem(SELECTED_SPECIES_UID_KEY)
    }
  }

  // Rebuild the visible zone/bed tree from the records currently loaded in the
  // shared current-bed datasource. This lets Plant Explorer react to filters or
  // selections applied elsewhere in the app.
  const rebuildZoneGroupsFromDataSource = (dataSource: DataSource) =>
  {
    const records = dataSource.getRecords ? dataSource.getRecords() : []
    setHasLoadedBedRecords((records || []).length > 0)
    const zoneMap = new Map<string, BedItem[]>()

    ;(records || []).forEach((record: any) =>
    {
      const attributes = record.getData ? record.getData() : (record.attributes || {})
      const gardenUid = firstValue(attributes, ['garden_uid', 'GARDEN_UID'])
      const zoneValue = firstValue(attributes, ['zone', 'ZONE'])
      const bedNo = firstValue(attributes, ['bed_no', 'BED_NO'])
      const area = firstValue(attributes, ['Shape__Area', 'Shape_Area', 'shape_area', 'SHAPE__AREA', 'SHAPE_AREA'])

      if (gardenUid === '' || zoneValue === '' || bedNo === '')
      {
        return
      }

      if (!zoneMap.has(zoneValue))
      {
        zoneMap.set(zoneValue, [])
      }

      zoneMap.get(zoneValue)?.push({
        gardenUid,
        bedNo,
        area
      })
    })

    const nextZoneGroups = Array.from(zoneMap.entries())
      .map(([zone, beds]) =>
      {
        const uniqueBeds = Array.from(
          new Map(beds.map((bed) => [bed.gardenUid, bed])).values()
        ).sort((left, right) =>
        {
          return left.bedNo.localeCompare(right.bedNo, undefined, { numeric: true, sensitivity: 'base' })
        })

        return {
          zone,
          beds: uniqueBeds
        }
      })

    nextZoneGroups.sort((left, right) =>
    {
      return compareZoneValues(left.zone, right.zone)
    })

    const availableZones = new Set(nextZoneGroups.map((zoneGroup) => zoneGroup.zone))
    const availableBeds = new Set(nextZoneGroups.flatMap((zoneGroup) => zoneGroup.beds.map((bed) => bed.gardenUid)))

    setZoneGroups(nextZoneGroups)
    setExpandedZones((previous) => previous.filter((zone) => availableZones.has(zone)))
    setExpandedBeds((previous) => previous.filter((gardenUid) => availableBeds.has(gardenUid)))
    setExpandedPlantTotals((previous) => previous.filter((gardenUid) => availableBeds.has(gardenUid)))
    setExpandedSpeciesGroups((previous) => previous.filter((speciesKey) =>
    {
      const gardenUid = speciesKey.split('|||')[0]
      return availableBeds.has(gardenUid)
    }))
    setBedPlantTotals((previous) =>
    {
      const next: Record<string, number> = {}

      Object.keys(previous).forEach((gardenUid) =>
      {
        if (availableBeds.has(gardenUid))
        {
          next[gardenUid] = previous[gardenUid]
        }
      })

      return next
    })
    setLoadingBedTotals((previous) =>
    {
      const next: Record<string, boolean> = {}

      Object.keys(previous).forEach((gardenUid) =>
      {
        if (availableBeds.has(gardenUid))
        {
          next[gardenUid] = previous[gardenUid]
        }
      })

      return next
    })
    setBedPlantLines((previous) =>
    {
      const next: Record<string, PlantLine[]> = {}

      Object.keys(previous).forEach((gardenUid) =>
      {
        if (availableBeds.has(gardenUid))
        {
          next[gardenUid] = previous[gardenUid]
        }
      })

      return next
    })
    setLoadingBedPlantLines((previous) =>
    {
      const next: Record<string, boolean> = {}

      Object.keys(previous).forEach((gardenUid) =>
      {
        if (availableBeds.has(gardenUid))
        {
          next[gardenUid] = previous[gardenUid]
        }
      })

      return next
    })
    setSelectedBedUid((previous) => availableBeds.has(previous) ? previous : '')
  }

  const applyHistoricalSnapshotToView = (
    historicalBeds: HistoricalBedSnapshotRow[],
    historicalPlantLines: HistoricalPlantSnapshotLine[],
    effectiveDate: string
  ) =>
  {
    const zoneMap = new Map<string, BedItem[]>()
    const plantLinesByBedUid = new Map<string, HistoricalPlantSnapshotLine[]>()

    historicalBeds.forEach((bed) =>
    {
      if (!zoneMap.has(bed.zone))
      {
        zoneMap.set(bed.zone, [])
      }

      zoneMap.get(bed.zone)?.push({
        gardenUid: bed.gardenUid,
        bedNo: bed.bedNo,
        area: String(bed.area || '')
      })
    })

    historicalPlantLines.forEach((plantLine) =>
    {
      if (!plantLinesByBedUid.has(plantLine.gardenUid))
      {
        plantLinesByBedUid.set(plantLine.gardenUid, [])
      }

      plantLinesByBedUid.get(plantLine.gardenUid)?.push(plantLine)
    })

    const nextZoneGroups = Array.from(zoneMap.entries())
      .map(([zone, beds]) =>
      {
        return {
          zone,
          beds: beds.slice().sort((left, right) =>
          {
            return left.bedNo.localeCompare(right.bedNo, undefined, { numeric: true, sensitivity: 'base' })
          })
        }
      })
      .sort((left, right) =>
      {
        return compareZoneValues(left.zone, right.zone)
      })

    const historicalBedPlantTotals: Record<string, number> = {}

    historicalBeds.forEach((bed) =>
    {
      historicalBedPlantTotals[bed.gardenUid] = (plantLinesByBedUid.get(bed.gardenUid) || []).reduce((sum, line) =>
      {
        return sum + line.currentQuantity
      }, 0)
    })

    displayModeRef.current = 'historical'
    setDisplayMode('historical')
    setHasLoadedBedRecords(historicalBeds.length > 0)
    setIsLoadingZones(false)
    setLoadError('')
    setZoneGroups(nextZoneGroups)
    setExpandedZones([])
    setExpandedBeds([])
    setExpandedPlantTotals([])
    setExpandedSpeciesGroups([])
    setBedPlantTotals(historicalBedPlantTotals)
    setLoadingBedTotals({})
    setBedPlantLines({})
    setLoadingBedPlantLines({})
    setHistoricalPlantSnapshotLines(historicalPlantLines)
    setTimelinerContextLabel(`Controlled by Timeliner: Historical as at ${effectiveDate}`)
  }

  // Removes the current map highlight when the selected bed changes or the widget unmounts.
  const clearMapHighlight = () =>
  {
    if (highlightHandleRef.current)
    {
      highlightHandleRef.current.remove()
      highlightHandleRef.current = null
    }
  }

  // Remove the map click handler when the active map changes or the widget unmounts.
  const clearMapClickHandle = () =>
  {
    if (mapClickHandleRef.current)
    {
      mapClickHandleRef.current.remove()
      mapClickHandleRef.current = null
    }
  }

  // Clears popup-style map state so tree-driven zoom behaves more like a fresh selection.
  const clearMapViewSelectionState = () =>
  {
    const jsApiMapView = jimuMapView?.view as any
    const popup = jsApiMapView?.popup

    if (popup)
    {
      if (typeof popup.clear === 'function')
      {
        popup.clear()
      }

      if (typeof popup.close === 'function')
      {
        popup.close()
      }
    }
  }

  // Clear any shared Experience Builder selection against the configured bed layer.
  const clearBedDataSourceSelection = () =>
  {
    const dataSourceLike = bedDs as any

    if (dataSourceLike && typeof dataSourceLike.clearSelection === 'function')
    {
      dataSourceLike.clearSelection()
    }

    const matchingJimuLayerView = findMatchingJimuLayerView() as any
    const layerDataSource = matchingJimuLayerView?.layerDataSource || matchingJimuLayerView?.dataSource

    if (layerDataSource && typeof layerDataSource.clearSelection === 'function')
    {
      layerDataSource.clearSelection()
    }
  }

  // Locate the configured current-bed layer inside the connected map widget.
  const findMatchingJimuLayerView = () =>
  {
    if (!jimuMapView || !bedDs)
    {
      return null
    }

    const dataSourceId =
      (props.useDataSources && props.useDataSources[0] && (props.useDataSources[0] as any).dataSourceId) ||
      (bedDs as any)?.id

    if (!dataSourceId)
    {
      return null
    }

    const layerViewEntries = Object.values((jimuMapView as any).jimuLayerViews || {})

    return layerViewEntries.find((entry: any) => isConfiguredBedLayerMatch(entry, dataSourceId)) || null
  }

  const findHistoricalMapLayerForGardenBed = async (gardenUid: string) =>
  {
    const jsApiMapView = jimuMapView?.view as any
    const configuredCurrentLayer = findMatchingJimuLayerView()?.layer as any
    const configuredCurrentLayerUrl = String(configuredCurrentLayer?.url || '').trim().toLowerCase()
    const allLayers = jsApiMapView?.map?.allLayers?.toArray ? jsApiMapView.map.allLayers.toArray() : []

    for (const layer of allLayers)
    {
      if (!layer || layer === configuredCurrentLayer || layer.visible !== true || String(layer?.type || '').toLowerCase() !== 'feature')
      {
        continue
      }

      const layerUrl = String(layer?.url || '').trim().toLowerCase()

      if (configuredCurrentLayerUrl !== '' && layerUrl === configuredCurrentLayerUrl)
      {
        continue
      }

      const layerFields = Array.isArray(layer.fields) ? layer.fields : []
      const gardenUidField =
        layerFields.find((field: any) => String(field?.name || '').toLowerCase() === 'garden_uid')?.name ||
        layerFields.find((field: any) => String(field?.name || '').toLowerCase().endsWith('.garden_uid'))?.name ||
        null

      if (!gardenUidField)
      {
        continue
      }

      const query = layer.createQuery()
      query.where = `${gardenUidField} = '${escapeSqlValue(gardenUid)}'`
      query.outFields = ['*']
      query.returnGeometry = true

      const featureSet = await layer.queryFeatures(query)
      const features = featureSet?.features || []

      if (features.length > 0)
      {
        const layerView = typeof jsApiMapView?.whenLayerView === 'function'
          ? await jsApiMapView.whenLayerView(layer)
          : null

        return {
          layer,
          layerView,
          features
        }
      }
    }

    return null
  }

  const resolveGardenUidFromHitResult = async (result: any): Promise<string> =>
  {
    const resultAttributes = result?.graphic?.attributes || {}
    const directGardenUid = firstValue(resultAttributes, ['garden_uid', 'GARDEN_UID'])

    if (directGardenUid !== '')
    {
      return directGardenUid
    }

    const resultLayer = result?.graphic?.layer
    const objectIdField = String(resultLayer?.objectIdField || '').trim()
    const objectIdValue = objectIdField !== '' ? resultAttributes?.[objectIdField] : null
    const layerFields = Array.isArray(resultLayer?.fields) ? resultLayer.fields : []
    const gardenUidField =
      layerFields.find((field: any) => String(field?.name || '').toLowerCase() === 'garden_uid')?.name ||
      layerFields.find((field: any) => String(field?.name || '').toLowerCase().endsWith('.garden_uid'))?.name ||
      null

    if (!resultLayer || typeof resultLayer.createQuery !== 'function' || typeof resultLayer.queryFeatures !== 'function' || !gardenUidField || objectIdField === '' || objectIdValue === null || objectIdValue === undefined)
    {
      return ''
    }

    try
    {
      const query = resultLayer.createQuery()
      query.where = `${objectIdField} = ${Number(objectIdValue)}`
      query.outFields = [gardenUidField]
      query.returnGeometry = false

      const featureSet = await resultLayer.queryFeatures(query)
      const featureAttributes = featureSet?.features?.[0]?.attributes || {}

      return firstValue(featureAttributes, [gardenUidField, 'garden_uid', 'GARDEN_UID'])
    }
    catch (error)
    {
      console.warn('Failed to resolve garden_uid from clicked map feature', error)
      return ''
    }
  }

  const applyZoneIsolationToMap = () =>
  {
    const matchingJimuLayerView = findMatchingJimuLayerView()
    const jsApiLayerView = matchingJimuLayerView?.view as any
    const jsApiLayer = matchingJimuLayerView?.layer || jsApiLayerView?.layer

    if (!jsApiLayerView || !jsApiLayer)
    {
      return
    }

    const layerFields = Array.isArray(jsApiLayer.fields) ? jsApiLayer.fields : []
    const whereClauses: string[] = []

    if (filteredGardenUidsForSpecies !== null)
    {
      const gardenUidField =
        layerFields.find((field: any) => String(field?.name || '').toLowerCase() === 'garden_uid')?.name ||
        layerFields.find((field: any) => String(field?.name || '').toLowerCase().endsWith('.garden_uid'))?.name ||
        null

      if (!gardenUidField)
      {
        return
      }

      if (filteredGardenUidsForSpecies.length === 0)
      {
        jsApiLayerView.filter = null
        jsApiLayerView.featureEffect = new FeatureEffect({
          filter: new FeatureFilter({
            where: '1=2'
          }),
          excludedEffect: 'opacity(0%)'
        })
        return
      }

      whereClauses.push(buildSqlInClause(gardenUidField, filteredGardenUidsForSpecies))
    }

    if (isolatedZones.length === 0 && whereClauses.length === 0)
    {
      jsApiLayerView.filter = null
      jsApiLayerView.featureEffect = null
      return
    }

    const zoneField =
      layerFields.find((field: any) => String(field?.name || '').toLowerCase() === 'zone')?.name ||
      layerFields.find((field: any) => String(field?.name || '').toLowerCase().endsWith('.zone'))?.name ||
      null

    if (isolatedZones.length > 0 && !zoneField)
    {
      return
    }

    if (isolatedZones.length > 0)
    {
      whereClauses.push(buildSqlInClause(zoneField as string, isolatedZones))
    }

    const zoneFilter = new FeatureFilter({
      where: whereClauses.length === 1 ? whereClauses[0] : whereClauses.map((clause) => `(${clause})`).join(' AND ')
    })

    jsApiLayerView.filter = null
    jsApiLayerView.featureEffect = new FeatureEffect({
      filter: zoneFilter,
      excludedEffect: 'opacity(0%)'
    })
  }

  // Opens the correct zone and bed so external selections can be revealed in the tree.
  const openBedInTree = (gardenUid: string) =>
  {
    const matchingZoneGroup = zoneGroups.find((zoneGroup) =>
    {
      return zoneGroup.beds.some((bed) => bed.gardenUid === gardenUid)
    })

    if (!matchingZoneGroup)
    {
      return
    }

    if (normalizedZoneFilterText !== '' && !normalizeFilterValue(matchingZoneGroup.zone).includes(normalizedZoneFilterText))
    {
      setZoneFilterText('')
    }

    setExpandedZones((previous) =>
    {
      return previous.includes(matchingZoneGroup.zone) ? previous : [...previous, matchingZoneGroup.zone]
    })
    setExpandedBeds((previous) =>
    {
      return previous.includes(gardenUid) ? previous : [...previous, gardenUid]
    })
  }

  // Push a selected bed back into Experience Builder's shared datasource selection.
  const selectBedRecordInDataSource = (gardenUid: string) =>
  {
    if (!bedDs || gardenUid === '')
    {
      return
    }

    const records = bedDs.getRecords ? bedDs.getRecords() : []
    const matchingRecord = (records || []).find((record: any) =>
    {
      return getGardenUidFromRecord(record) === gardenUid
    })

    if (!matchingRecord)
    {
      return
    }

    const recordId =
      (typeof matchingRecord.getId === 'function' && matchingRecord.getId()) ||
      matchingRecord.id ||
      ''

    if (recordId !== '' && typeof (bedDs as any).selectRecordsByIds === 'function')
    {
      ;(bedDs as any).selectRecordsByIds([String(recordId)], [matchingRecord])
    }
  }

  // Pulls the current ExB datasource selection into the widget's local tree state.
  const syncSelectedBedFromDataSource = (dataSource: DataSource | null) =>
  {
    if (!dataSource || typeof (dataSource as any).getSelectedRecords !== 'function')
    {
      return
    }

    const selectedRecords = (dataSource as any).getSelectedRecords() || []
    const selectedGardenUid = selectedRecords.length > 0 ? getGardenUidFromRecord(selectedRecords[0]) : ''

    if (selectedGardenUid === '')
    {
      return
    }

    openBedInTree(selectedGardenUid)
    setSelectedBedUid(selectedGardenUid)
  }

  // Single entry point for selecting a bed from the tree or map.
  const selectBed = (gardenUid: string) =>
  {
    openBedInTree(gardenUid)
    clearBedDataSourceSelection()
    selectBedRecordInDataSource(gardenUid)

    if (selectedBedUid === gardenUid)
    {
      void syncMapToGardenBed(gardenUid)
      return
    }

    setSelectedBedUid(gardenUid)
  }

  // Fully clears the widget's selected bed state and any matching map/datasource selection.
  const clearSelectedBed = () =>
  {
    clearMapHighlight()
    clearBedDataSourceSelection()
    clearMapViewSelectionState()
    setSelectedBedUid('')
  }

  const resetViewStateForTemporalApply = () =>
  {
    clearSelectedBed()
    setZoneFilterText('')
    setIsolatedZones([])
    setExpandedZones([])
    setExpandedBeds([])
    setExpandedPlantTotals([])
    setExpandedSpeciesGroups([])
  }

  // Find the configured bed layer inside the selected map widget, then
  // highlight and zoom to the chosen bed.
  const syncMapToGardenBed = async (gardenUid: string) =>
  {
    if (!jimuMapView || !bedDs || gardenUid === '')
    {
      return
    }

    clearBedDataSourceSelection()
    clearMapHighlight()
    clearMapViewSelectionState()
    applyZoneIsolationToMap()

    try
    {
      const jsApiMapView = jimuMapView.view
      let jsApiLayerView: any = null
      let jsApiLayer: any = null
      let features: any[] = []

      if (displayModeRef.current === 'historical')
      {
        const historicalMatch = await findHistoricalMapLayerForGardenBed(gardenUid)

        jsApiLayerView = historicalMatch?.layerView
        jsApiLayer = historicalMatch?.layer || jsApiLayerView?.layer
        features = historicalMatch?.features || []
      }
      else
      {
        const matchingJimuLayerView = findMatchingJimuLayerView()
        jsApiLayerView = matchingJimuLayerView?.view
        jsApiLayer = matchingJimuLayerView?.layer || jsApiLayerView?.layer
      }

      if (!jsApiMapView || !jsApiLayerView || !jsApiLayer)
      {
        return
      }

      if (features.length === 0)
      {
        const layerFields = Array.isArray(jsApiLayer.fields) ? jsApiLayer.fields : []
        const gardenUidField =
          layerFields.find((field: any) => String(field?.name || '').toLowerCase() === 'garden_uid')?.name ||
          layerFields.find((field: any) => String(field?.name || '').toLowerCase().endsWith('.garden_uid'))?.name ||
          null

        if (!gardenUidField)
        {
          return
        }

        const query = jsApiLayer.createQuery()
        query.where = `${gardenUidField} = '${escapeSqlValue(gardenUid)}'`
        query.outFields = ['*']
        query.returnGeometry = true

        const featureSet = await jsApiLayer.queryFeatures(query)
        features = featureSet?.features || []

        if (features.length === 0)
        {
          return
        }
      }

      if (typeof jsApiLayerView.highlight === 'function')
      {
        highlightHandleRef.current = jsApiLayerView.highlight(features)
      }

      if (typeof jsApiMapView.goTo === 'function')
      {
        await jsApiMapView.goTo(features)
      }

      if (jsApiMapView?.popup && typeof jsApiMapView.popup.close === 'function')
      {
        jsApiMapView.popup.close()
      }

      applyZoneIsolationToMap()
    }
    catch (error)
    {
      console.warn('Failed to highlight selected bed on map', error)
    }
  }

  // Expand/collapse helpers for the tree UI.
  const toggleZone = (zone: string) =>
  {
    setExpandedZones((previous) =>
    {
      if (previous.includes(zone))
      {
        return previous.filter((value) => value !== zone)
      }

      return [...previous, zone]
    })
  }

  const toggleZoneIsolation = (zone: string) =>
  {
    setIsolatedZones((previous) =>
    {
      if (previous.includes(zone))
      {
        return previous.filter((value) => value !== zone)
      }

      return [...previous, zone].sort(compareZoneValues)
    })
  }

  // Expands/collapses a single bed to show/hide its summary details.
  const toggleBed = (gardenUid: string) =>
  {
    setExpandedBeds((previous) =>
    {
      if (previous.includes(gardenUid))
      {
        return previous.filter((value) => value !== gardenUid)
      }

      return [...previous, gardenUid]
    })
  }

  // Expands/collapses the lazy-loaded stock line list under "Total Plants".
  const togglePlantTotals = (gardenUid: string) =>
  {
    setExpandedPlantTotals((previous) =>
    {
      if (previous.includes(gardenUid))
      {
        return previous.filter((value) => value !== gardenUid)
      }

      return [...previous, gardenUid]
    })
  }

  const toggleSpeciesGroup = (speciesGroupKey: string) =>
  {
    setExpandedSpeciesGroups((previous) =>
    {
      if (previous.includes(speciesGroupKey))
      {
        return previous.filter((value) => value !== speciesGroupKey)
      }

      return [...previous, speciesGroupKey]
    })
  }

  const expandAll = () =>
  {
    setExpandedZones(zoneGroups.map((zoneGroup) => zoneGroup.zone))
    setExpandedBeds(zoneGroups.flatMap((zoneGroup) => zoneGroup.beds.map((bed) => bed.gardenUid)))
  }

  const collapseAll = () =>
  {
    setExpandedZones([])
    setExpandedBeds([])
    setExpandedPlantTotals([])
  }

  const clearZoneIsolation = () =>
  {
    setIsolatedZones([])
  }

  // Applies a lightweight local zone text filter without changing any shared datasource state.
  const visibleZoneGroups = zoneGroups
    .map((zoneGroup) =>
    {
      const filteredBeds = filteredGardenUidsForSpecies === null
        ? zoneGroup.beds
        : zoneGroup.beds.filter((bed) => filteredGardenUidsForSpecies.includes(bed.gardenUid))

      return {
        ...zoneGroup,
        beds: filteredBeds
      }
    })
    .filter((zoneGroup) =>
    {
      return zoneGroup.beds.length > 0 &&
        (normalizedZoneFilterText === '' || normalizeFilterValue(zoneGroup.zone).includes(normalizedZoneFilterText))
    })

  useEffect(() =>
  {
    visibleGardenUidsRef.current = new Set(zoneGroups.flatMap((zoneGroup) => zoneGroup.beds.map((bed) => bed.gardenUid)))
  }, [zoneGroups])

  // Loads bed-level plant totals only for beds that are currently expanded.
  useEffect(() =>
  {
    syncSelectedSpeciesUidFromSession()
  }, [])

  useEffect(() =>
  {
    const applyTemporalContext = (temporalContext: TemporalContextValue | null) =>
    {
      if (!temporalContext || temporalContext.requestToken <= latestTemporalRequestTokenRef.current)
      {
        return
      }

      latestTemporalRequestTokenRef.current = temporalContext.requestToken

      if (temporalContext.viewMode === 'Current' && temporalContext.dataState === 'current-ready')
      {
        resetViewStateForTemporalApply()
        displayModeRef.current = 'current'
        setDisplayMode('current')
        setBedPlantTotals({})
        setLoadingBedTotals({})
        setBedPlantLines({})
        setLoadingBedPlantLines({})
        setHistoricalPlantSnapshotLines([])

        if (bedDs)
        {
          rebuildZoneGroupsFromDataSource(bedDs)
        }

        setTimelinerContextLabel('Controlled by Timeliner: Current')
        return
      }

      if (temporalContext.viewMode === 'Historical' && temporalContext.dataState === 'historical-ready')
      {
        const historicalBedSnapshot = readJsonFromSession<{ activeBeds: HistoricalBedSnapshotRow[] }>(HISTORICAL_BED_SNAPSHOT_STORAGE_KEY)
        const historicalPlantSnapshot = readJsonFromSession<{ plantLines: HistoricalPlantSnapshotLine[] }>(HISTORICAL_PLANT_SNAPSHOT_STORAGE_KEY)

        if (!historicalBedSnapshot || !historicalPlantSnapshot)
        {
          setTimelinerContextLabel('Timeliner historical snapshot is missing from session storage.')
          return
        }

        resetViewStateForTemporalApply()
        applyHistoricalSnapshotToView(
          historicalBedSnapshot.activeBeds || [],
          historicalPlantSnapshot.plantLines || [],
          temporalContext.effectiveDate
        )
        return
      }

      if (temporalContext.viewMode === 'Historical' && temporalContext.dataState === 'historical-pending')
      {
        setTimelinerContextLabel('')
      }
    }

    const handleTemporalContextChanged = (event: Event) =>
    {
      const customEvent = event as CustomEvent<TemporalContextValue>
      applyTemporalContext(customEvent.detail || null)
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
    {
      window.addEventListener(TEMPORAL_CONTEXT_EVENT_NAME, handleTemporalContextChanged as EventListener)
    }

    return () =>
    {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function')
      {
        window.removeEventListener(TEMPORAL_CONTEXT_EVENT_NAME, handleTemporalContextChanged as EventListener)
      }
    }
  }, [bedDs])

  useEffect(() =>
  {
    const loadSpeciesOptions = async () =>
    {
      setIsLoadingSpeciesOptions(true)
      setSpeciesLoadError('')

      try
      {
        const loadedSpeciesOptions = await querySpeciesOptions()
        setSpeciesOptions(loadedSpeciesOptions)
      }
      catch (error)
      {
        console.warn('Failed to load species options for Plant Explorer', error)
        setSpeciesLoadError('Failed to load species options.')
        setSpeciesOptions([])
      }
      finally
      {
        setIsLoadingSpeciesOptions(false)
      }
    }

    void loadSpeciesOptions()
  }, [])

  useEffect(() =>
  {
    const syncSpeciesFilter = async () =>
    {
      if (selectedSpeciesUid === '')
      {
        setFilteredGardenUidsForSpecies(null)
        setIsLoadingSpeciesBeds(false)
        return
      }

      setIsLoadingSpeciesBeds(true)

      if (displayMode === 'historical')
      {
        const matchingGardenUids = Array.from(new Set(
          historicalPlantSnapshotLines
            .filter((line) => line.speciesUid === selectedSpeciesUid)
            .map((line) => line.gardenUid)
        ))

        setFilteredGardenUidsForSpecies(matchingGardenUids)
        setIsLoadingSpeciesBeds(false)
        return
      }

      try
      {
        const matchingGardenUids = await queryGardenUidsForSpecies(selectedSpeciesUid)

        if (matchingGardenUids.length === 0)
        {
          setFilteredGardenUidsForSpecies([])
          return
        }

        setFilteredGardenUidsForSpecies(matchingGardenUids)
      }
      catch (error)
      {
        console.warn(`Failed to apply species filter for species_uid ${selectedSpeciesUid}`, error)
        setFilteredGardenUidsForSpecies([])
      }
      finally
      {
        setIsLoadingSpeciesBeds(false)
      }
    }

    void syncSpeciesFilter()
  }, [selectedSpeciesUid, displayMode, historicalPlantSnapshotLines])

  useEffect(() =>
  {
    if (selectedBedUid !== '' && filteredGardenUidsForSpecies !== null && !filteredGardenUidsForSpecies.includes(selectedBedUid))
    {
      setSelectedBedUid('')
    }
  }, [selectedBedUid, filteredGardenUidsForSpecies])

  useEffect(() =>
  {
      const loadExpandedBedTotals = async () =>
      {
      if (displayMode === 'historical')
      {
        return
      }

      const bedUidsToLoad = expandedBeds.filter((gardenUid) =>
      {
        return bedPlantTotals[gardenUid] === undefined && !loadingBedTotals[gardenUid]
      })

      if (bedUidsToLoad.length === 0)
      {
        return
      }

      bedUidsToLoad.forEach((gardenUid) =>
      {
        setLoadingBedTotals((previous) => ({
          ...previous,
          [gardenUid]: true
        }))
      })

      for (const gardenUid of bedUidsToLoad)
      {
        try
        {
          const totalPlants = await queryPlantsInBedTotal(gardenUid)

          setBedPlantTotals((previous) => ({
            ...previous,
            [gardenUid]: totalPlants
          }))
        }
        finally
        {
          setLoadingBedTotals((previous) => ({
            ...previous,
            [gardenUid]: false
          }))
        }
      }
    }

    void loadExpandedBedTotals()
  }, [expandedBeds, bedPlantTotals, loadingBedTotals, displayMode])

  // Loads detailed plant lines only for beds whose "Total Plants" section is expanded.
  useEffect(() =>
  {
      const loadExpandedPlantLines = async () =>
      {
      if (displayMode === 'historical')
      {
        const speciesNameByUid = new Map<string, string>(
          speciesOptions.map((speciesOption) => [speciesOption.speciesUid, speciesOption.speciesName])
        )

        const bedUidsToLoad = expandedPlantTotals.filter((gardenUid) =>
        {
          return bedPlantLines[gardenUid] === undefined
        })

        if (bedUidsToLoad.length === 0)
        {
          return
        }

        bedUidsToLoad.forEach((gardenUid) =>
        {
          const matchingLines = historicalPlantSnapshotLines
            .filter((line) => line.gardenUid === gardenUid)
            .map((line) =>
            {
              const speciesName = speciesNameByUid.get(line.speciesUid) || line.speciesUid

              return {
                speciesUid: line.speciesUid,
                speciesName,
                quantity: line.currentQuantity,
                costPerUnit: line.costPerUnit,
                unitType: line.unitType,
                usedSpeciesUidFallback: speciesName === line.speciesUid
              }
            })

          setBedPlantLines((previous) => ({
            ...previous,
            [gardenUid]: matchingLines
          }))
        })

        return
      }

      const bedUidsToLoad = expandedPlantTotals.filter((gardenUid) =>
      {
        return bedPlantLines[gardenUid] === undefined && !loadingBedPlantLines[gardenUid]
      })

      if (bedUidsToLoad.length === 0)
      {
        return
      }

      bedUidsToLoad.forEach((gardenUid) =>
      {
        setLoadingBedPlantLines((previous) => ({
          ...previous,
          [gardenUid]: true
        }))
      })

      for (const gardenUid of bedUidsToLoad)
      {
        try
        {
          const plantLines = await queryPlantLinesForBed(gardenUid)

          setBedPlantLines((previous) => ({
            ...previous,
            [gardenUid]: plantLines
          }))
        }
        finally
        {
          setLoadingBedPlantLines((previous) => ({
            ...previous,
            [gardenUid]: false
          }))
        }
      }
    }

    void loadExpandedPlantLines()
  }, [expandedPlantTotals, bedPlantLines, loadingBedPlantLines, displayMode, historicalPlantSnapshotLines, speciesOptions])

  const getHistoricalDisplayPlantLines = (gardenUid: string) =>
  {
    const speciesNameByUid = new Map<string, string>(
      speciesOptions.map((speciesOption) => [speciesOption.speciesUid, speciesOption.speciesName])
    )

    return historicalPlantSnapshotLines
      .filter((line) => line.gardenUid === gardenUid)
      .map((line) =>
      {
        const speciesName = speciesNameByUid.get(line.speciesUid) || line.speciesUid

        return {
          speciesUid: line.speciesUid,
          speciesName,
          quantity: line.currentQuantity,
          costPerUnit: line.costPerUnit,
          unitType: line.unitType,
          usedSpeciesUidFallback: speciesName === line.speciesUid
        }
      })
  }

  const getDisplayPlantLines = (gardenUid: string) =>
  {
    if (displayMode === 'historical')
    {
      return getHistoricalDisplayPlantLines(gardenUid)
    }

    return bedPlantLines[gardenUid] || []
  }

  const getDisplayPlantTotal = (gardenUid: string) =>
  {
    if (displayMode === 'historical')
    {
      return getHistoricalDisplayPlantLines(gardenUid).reduce((sum, line) => sum + line.quantity, 0)
    }

    return bedPlantTotals[gardenUid] ?? 0
  }

  // Keeps map highlight in sync with the currently selected bed.
  useEffect(() =>
  {
    if (selectedBedUid === '')
    {
      clearMapHighlight()
      return
    }

    void syncMapToGardenBed(selectedBedUid)
  }, [selectedBedUid, jimuMapView, bedDs])

  // Applies zone isolate to the connected map only, leaving the tree unchanged.
  useEffect(() =>
  {
    applyZoneIsolationToMap()
  }, [isolatedZones, selectedBedUid, jimuMapView, bedDs, filteredGardenUidsForSpecies])

  // Keeps the active bed visible in the scrollable tree when selection changes.
  useEffect(() =>
  {
    if (selectedBedUid === '')
    {
      return
    }

    const selectedRow = bedRowRefs.current[selectedBedUid]

    if (selectedRow && typeof selectedRow.scrollIntoView === 'function')
    {
      selectedRow.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      })
    }
  }, [selectedBedUid, expandedZones, expandedBeds, visibleZoneGroups])

  // Mirrors map clicks back into the tree so selected beds open and stay visible.
  useEffect(() =>
  {
    clearMapClickHandle()

    const jsApiMapView = jimuMapView?.view
    const matchingJimuLayerView = findMatchingJimuLayerView()
    const targetLayer = matchingJimuLayerView?.layer || matchingJimuLayerView?.view?.layer

    if (!jsApiMapView || typeof jsApiMapView.on !== 'function')
    {
      return
    }

    mapClickHandleRef.current = jsApiMapView.on('click', async (event: any) =>
    {
      try
      {
        if (typeof jsApiMapView.hitTest !== 'function')
        {
          return
        }

        const hitTestResult = await jsApiMapView.hitTest(event)
        const results = Array.isArray(hitTestResult?.results) ? hitTestResult.results : []
        let matchingResult: any = null

        for (const result of results)
        {
          const resultLayer = result?.graphic?.layer
          const resultGardenUid = await resolveGardenUidFromHitResult(result)
          const isHistoricalMode = displayModeRef.current === 'historical'

          if (
            resultGardenUid !== '' &&
            (
              (
                isHistoricalMode &&
                visibleGardenUidsRef.current.has(resultGardenUid)
              ) ||
              (
                !isHistoricalMode &&
                targetLayer &&
                (
                  resultLayer === targetLayer ||
                  isConfiguredBedLayerMatch(resultLayer) ||
                  isConfiguredBedLayerMatch(result?.graphic) ||
                  String(resultLayer?.url || '').toLowerCase() === String(targetLayer?.url || '').toLowerCase() ||
                  String(resultLayer?.title || '').toLowerCase() === String(targetLayer?.title || '').toLowerCase()
                )
              )
            )
          )
          {
            matchingResult = {
              result,
              gardenUid: resultGardenUid
            }
            break
          }
        }

        const gardenUid = matchingResult?.gardenUid || ''

        if (gardenUid !== '')
        {
          selectBed(gardenUid)
          return
        }

        clearSelectedBed()
      }
      catch (error)
      {
        console.warn('Failed to sync selected map bed back to Plant Explorer', error)
      }
    })

    return () =>
    {
      clearMapClickHandle()
    }
  }, [jimuMapView, bedDs, zoneGroups, normalizedZoneFilterText])

  // Clears highlight handle when the widget unmounts.
  useEffect(() =>
  {
    return () =>
    {
      clearMapClickHandle()
      clearMapHighlight()
    }
  }, [])

  if (!props.useDataSources || props.useDataSources.length < 1)
  {
    return (
      <div className="widget-plant-explorer jimu-widget p-3">
        <h3>Plant Explorer</h3>
        <p>Select the GardenBeds_Active data source in widget settings.</p>
      </div>
    )
  }

  return (
    <div
      className="widget-plant-explorer jimu-widget d-flex flex-column"
      style={{
        backgroundColor: '#fff',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        padding: '0.75rem'
      }}
    >
      <DataSourceComponent
        useDataSource={props.useDataSources[0]}
        widgetId={props.id}
        query={{
          outFields: ['*'],
          pageSize: 2000
        }}
        onDataSourceCreated={(dataSource) =>
        {
          setBedDs(dataSource)
          syncSelectedSpeciesUidFromSession()
          if (displayModeRef.current === 'current')
          {
            rebuildZoneGroupsFromDataSource(dataSource)
            syncSelectedBedFromDataSource(dataSource)
          }
        }}
        onDataSourceInfoChange={() =>
        {
          syncSelectedSpeciesUidFromSession()
          if (displayModeRef.current === 'current' && bedDs)
          {
            rebuildZoneGroupsFromDataSource(bedDs)
            syncSelectedBedFromDataSource(bedDs)
          }
        }}
        onSelectionChange={() =>
        {
          if (displayModeRef.current === 'current' && bedDs)
          {
            syncSelectedBedFromDataSource(bedDs)
          }
        }}
        onDataSourceStatusChange={(status) =>
        {
          setIsLoadingZones(status === DataSourceStatus.Loading)
        }}
        onCreateDataSourceFailed={(error) =>
        {
          setLoadError(error?.message || 'Failed to connect to GardenBeds_Active.')
          setHasLoadedBedRecords(false)
          setIsLoadingZones(false)
        }}
      >
        {() => null}
      </DataSourceComponent>

      {props.useMapWidgetIds && props.useMapWidgetIds.length > 0 && (
        <JimuMapViewComponent
          useMapWidgetId={props.useMapWidgetIds[0]}
          onActiveViewChange={(view) =>
          {
            setJimuMapView(view)
          }}
        />
      )}

      <div
        style={{
          flex: '0 0 auto',
          marginBottom: '0.75rem'
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>Plant Explorer</h3>
            <span style={{ fontSize: '0.78rem', color: SECONDARY_TEXT_COLOR }}>{WIDGET_VERSION}</span>
          </div>
          {timelinerContextLabel !== '' && (
            <div style={{ marginTop: '0.3rem', fontSize: '0.8rem', color: SECONDARY_TEXT_COLOR }}>
              {timelinerContextLabel}
            </div>
          )}
        </div>

      </div>

      <div style={{ flex: '0 0 auto', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.65rem' }}>
          <div style={{ width: '52%', minWidth: '11rem', maxWidth: '20rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <select
              id="plant-explorer-species-filter"
              value={selectedSpeciesUid}
              disabled={isLoadingSpeciesOptions}
              onChange={(event) =>
              {
                applySelectedSpeciesUid(event.target.value)
              }}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                padding: '0.5rem 0.65rem',
                border: '1px solid #d0d0d0',
                borderRadius: '4px',
                fontSize: '0.92rem',
                color: '#222',
                backgroundColor: '#fff'
            }}
          >
            <option value="">
                {isLoadingSpeciesOptions ? 'Loading species...' : 'Filter by species'}
            </option>
            {speciesOptions.map((speciesOption) =>
            {
                return (
                  <option key={speciesOption.speciesUid} value={speciesOption.speciesUid}>
                    {speciesOption.speciesName}
                  </option>
                )
              })}
            </select>
            <button
              type="button"
              className="btn btn-link p-0"
              style={{
                ...PLAIN_BUTTON_STYLE,
                color: selectedSpeciesUid !== '' ? ACCENT_COLOR : SECONDARY_TEXT_COLOR,
                textDecoration: selectedSpeciesUid !== '' ? 'underline' : 'none',
                cursor: selectedSpeciesUid !== '' ? 'pointer' : 'default',
                whiteSpace: 'nowrap'
              }}
              onClick={() =>
              {
                if (selectedSpeciesUid !== '')
                {
                  applySelectedSpeciesUid('')
                }
              }}
            >
              Clear
            </button>
          </div>
          {speciesLoadError !== '' && (
            <div style={{ marginTop: '0.3rem', fontSize: '0.8rem', color: DANGER_TEXT_COLOR }}>
              {speciesLoadError}
            </div>
          )}
          {selectedSpeciesUid !== '' && (
            <div style={{ marginTop: '0.3rem', fontSize: '0.8rem', color: SECONDARY_TEXT_COLOR }}>
              {isLoadingSpeciesBeds ? 'Filtering beds...' : 'Species filter is active.'}
            </div>
          )}
          </div>

          <div style={{ width: '34%', minWidth: '8.5rem', maxWidth: '14rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <input
              type="text"
              value={zoneFilterText}
              placeholder="Filter zones"
              onChange={(event) =>
              {
                setZoneFilterText(event.target.value)
              }}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                padding: '0.5rem 0.65rem',
                border: '1px solid #d0d0d0',
                borderRadius: '4px',
                fontSize: '0.92rem',
                color: '#222',
                backgroundColor: '#fff'
              }}
            />
            <button
              type="button"
              className="btn btn-link p-0"
              style={{
                ...PLAIN_BUTTON_STYLE,
                color: zoneFilterText !== '' ? ACCENT_COLOR : SECONDARY_TEXT_COLOR,
                textDecoration: zoneFilterText !== '' ? 'underline' : 'none',
                cursor: zoneFilterText !== '' ? 'pointer' : 'default',
                whiteSpace: 'nowrap'
              }}
              onClick={() =>
              {
                if (zoneFilterText !== '')
                {
                  setZoneFilterText('')
                }
              }}
            >
              Clear
            </button>
          </div>
        </div>
        <div style={{ whiteSpace: 'nowrap', fontSize: '0.9rem', marginTop: '0.45rem' }}>
          <button
            type="button"
            className="btn btn-link p-0"
            style={{
              ...PLAIN_BUTTON_STYLE,
              color: isolatedZones.length > 0 ? ACCENT_COLOR : SECONDARY_TEXT_COLOR,
              textDecoration: isolatedZones.length > 0 ? 'underline' : 'none',
              cursor: isolatedZones.length > 0 ? 'pointer' : 'default'
            }}
            onClick={() =>
            {
              if (isolatedZones.length > 0)
              {
                clearZoneIsolation()
              }
            }}
          >
            Clear Isolate
          </button>
          <span style={{ color: '#888', margin: '0 0.4rem' }}>|</span>
          <button
            type="button"
            className="btn btn-link p-0"
            style={{
              ...PLAIN_BUTTON_STYLE,
              color: selectedBedUid !== '' ? ACCENT_COLOR : SECONDARY_TEXT_COLOR,
              textDecoration: selectedBedUid !== '' ? 'underline' : 'none',
              cursor: selectedBedUid !== '' ? 'pointer' : 'default'
            }}
            onClick={() =>
            {
              if (selectedBedUid !== '')
              {
                clearSelectedBed()
              }
            }}
          >
            Clear Selection
          </button>
          <span style={{ color: '#888', margin: '0 0.4rem' }}>|</span>
          <button
            type="button"
            className="btn btn-link p-0"
            style={LINK_BUTTON_STYLE}
            onClick={collapseAll}
          >
            Collapse All
          </button>
          <span style={{ color: '#888', margin: '0 0.4rem' }}>|</span>
          <button
            type="button"
            className="btn btn-link p-0"
            style={LINK_BUTTON_STYLE}
            onClick={expandAll}
          >
            Expand All
          </button>
        </div>
      </div>

      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden'
        }}
      >
        {isLoadingZones && (
          <p style={{ color: MUTED_TEXT_COLOR }}>Loading zones...</p>
        )}

        {loadError !== '' && (
          <p style={{ color: DANGER_TEXT_COLOR }}>{loadError}</p>
        )}

        {/* The tree below is intentionally driven by the shared current-bed datasource
            so it reacts to filters applied by other widgets in the same app. */}
        {!isLoadingZones && loadError === '' && zoneGroups.length === 0 && (
          <div style={EMPTY_STATE_TEXT_STYLE}>
            <p style={{ marginBottom: '0.35rem' }}>
              {selectedSpeciesUid !== ''
                ? 'No garden beds match the current species filter.'
                : 'No garden beds are available from the configured current bed datasource.'}
            </p>
            <p style={EMPTY_STATE_DETAIL_STYLE}>
              {selectedSpeciesUid !== ''
                ? 'Clear or change the species filter to see more beds.'
                : hasLoadedBedRecords
                  ? 'The datasource loaded, but there were no zone or bed records to display.'
                  : 'Check the datasource settings if you expected beds to appear here.'}
            </p>
          </div>
        )}

        {!isLoadingZones && loadError === '' && zoneGroups.length > 0 && visibleZoneGroups.length === 0 && (
          <div style={EMPTY_STATE_TEXT_STYLE}>
            <p style={{ marginBottom: '0.35rem' }}>No zones match the current filter.</p>
            <p style={EMPTY_STATE_DETAIL_STYLE}>
              Try part of a zone name.
            </p>
          </div>
        )}

        {!isLoadingZones && loadError === '' && visibleZoneGroups.length > 0 && (
          <div>
            <div style={SECTION_LABEL_STYLE}>
              <div style={ZONE_ISOLATE_HEADER_STYLE}>Isolate</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', position: 'relative' }}>
                <span style={SECTION_TITLE_STYLE}>Zones</span>
                <button
                  type="button"
                  className="btn btn-link p-0"
                  style={HELP_BUTTON_STYLE}
                  aria-label="Help"
                  onClick={() =>
                  {
                    setShowHelp((previous) => !previous)
                  }}
                >
                  ?
                </button>
                {showHelp && (
                  <div style={HELP_POPOVER_STYLE}>
                    <div style={{ fontWeight: 700, marginBottom: '0.35rem' }}>How this works</div>
                    <div>Use the `Isolate` checkboxes to show only selected zones on the map.</div>
                    <div style={{ marginTop: '0.35rem' }}>Use the arrow controls to expand or collapse zones, beds, and species in the tree.</div>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2">
              {visibleZoneGroups.map((zoneGroup) => (
                <div key={zoneGroup.zone} className="mb-3">
                  <div style={ZONE_ROW_STYLE}>
                    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '0.1rem' }}>
                      <input
                        type="checkbox"
                        checked={isolatedZones.includes(zoneGroup.zone)}
                        onChange={() =>
                        {
                          toggleZoneIsolation(zoneGroup.zone)
                        }}
                        aria-label={`Isolate zone ${zoneGroup.zone}`}
                        style={CHECKBOX_STYLE}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn-link p-0"
                        style={{
                          ...TREE_TOGGLE_STYLE,
                          fontSize: '0.95rem',
                          color: '#555'
                        }}
                        onClick={() =>
                        {
                          toggleZone(zoneGroup.zone)
                        }}
                        aria-label={`${expandedZones.includes(zoneGroup.zone) ? 'Collapse' : 'Expand'} zone ${zoneGroup.zone}`}
                      >
                        {getTreeToggleIcon(expandedZones.includes(zoneGroup.zone))}
                      </button>
                      <strong style={{ fontSize: '0.98rem' }}>{zoneGroup.zone}</strong>
                    </div>
                  </div>

                  {expandedZones.includes(zoneGroup.zone) && (
                    <div className="mb-0 mt-1" style={{ marginLeft: '5.9rem' }}>
                      {zoneGroup.beds.map((bed) =>
                      {
                        const displayPlantLines = getDisplayPlantLines(bed.gardenUid)

                        return (
                        <div
                          key={bed.gardenUid}
                          ref={(element) =>
                          {
                            bedRowRefs.current[bed.gardenUid] = element
                          }}
                          style={getSelectedBedRowStyle(selectedBedUid === bed.gardenUid)}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <button
                              type="button"
                              className="btn btn-link p-0"
                              style={{
                                ...TREE_TOGGLE_STYLE,
                                fontSize: '0.95rem',
                                color: '#555'
                              }}
                              onClick={() =>
                              {
                                toggleBed(bed.gardenUid)
                              }}
                              aria-label={`${expandedBeds.includes(bed.gardenUid) ? 'Collapse' : 'Expand'} bed ${bed.bedNo}`}
                            >
                              {getTreeToggleIcon(expandedBeds.includes(bed.gardenUid))}
                            </button>
                            <span style={{ fontWeight: selectedBedUid === bed.gardenUid ? 700 : 500, color: selectedBedUid === bed.gardenUid ? '#0b4f79' : '#222' }}>
                              Bed {bed.bedNo} ({bed.area !== '' ? `${Math.round(Number(bed.area)).toLocaleString()} sq m` : 'Area not available'})
                            </span>
                            <span> - </span>
                            <button
                              type="button"
                              className="btn btn-link p-0"
                              style={{
                                ...LINK_BUTTON_STYLE,
                                fontWeight: selectedBedUid === bed.gardenUid ? 700 : 400
                              }}
                              onClick={() =>
                              {
                                selectBed(bed.gardenUid)
                              }}
                            >
                              Zoom
                            </button>
                          </div>

                          {expandedBeds.includes(bed.gardenUid) && (
                            <div style={{ marginLeft: '1.75rem' }}>
                              <div style={{ color: '#444' }}>
                                <button
                                  type="button"
                                  className="btn btn-link p-0"
                                  style={{
                                    ...PLAIN_BUTTON_STYLE,
                                    color: '#444',
                                    textDecoration: 'none',
                                    fontWeight: 400
                                  }}
                                  onClick={() =>
                                  {
                                    togglePlantTotals(bed.gardenUid)
                                  }}
                                >
                                  {getTreeToggleIcon(expandedPlantTotals.includes(bed.gardenUid))}
                                </button>
                                {' '}
                                Total Plants: {displayMode !== 'historical' && loadingBedTotals[bed.gardenUid]
                                  ? 'Loading...'
                                  : getDisplayPlantTotal(bed.gardenUid).toLocaleString()}
                              </div>
                              {expandedPlantTotals.includes(bed.gardenUid) && (
                                <div style={{ marginLeft: '1.35rem', marginTop: '0.15rem' }}>
                                  {!(displayMode !== 'historical' && loadingBedPlantLines[bed.gardenUid]) && displayPlantLines.some((plantLine) => plantLine.usedSpeciesUidFallback) && (
                                    <div
                                      style={{
                                        marginBottom: '0.45rem',
                                        padding: '0.45rem 0.55rem',
                                        border: `1px solid ${DANGER_TEXT_COLOR}`,
                                        borderRadius: '4px',
                                        backgroundColor: '#fff5f5',
                                        color: DANGER_TEXT_COLOR,
                                        fontSize: '0.78rem',
                                        lineHeight: 1.4
                                      }}
                                    >
                                      Species names could not be resolved for one or more plant lines in Bed {bed.bedNo}, so `species_uid` is being shown instead.
                                      {' '}
                                      This happens when the species lookup did not return a matching name for one or more `species_uid` values.
                                      <div style={{ marginTop: '0.3rem', wordBreak: 'break-all' }}>
                                        Unresolved `species_uid` values:
                                        {' '}
                                        {Array.from(new Set(displayPlantLines
                                          .filter((plantLine) => plantLine.usedSpeciesUidFallback)
                                          .map((plantLine) => plantLine.speciesUid)))
                                          .join(', ')}
                                      </div>
                                      <div style={{ marginTop: '0.3rem' }}>
                                      Please contact gis.properties@curtin.edu.au for assistance.
                                      </div>
                                    </div>
                                  )}
                                  {displayMode !== 'historical' && loadingBedPlantLines[bed.gardenUid] && (
                                    <div style={{ color: MUTED_TEXT_COLOR }}>Loading plant lines...</div>
                                  )}
                                  {!(displayMode !== 'historical' && loadingBedPlantLines[bed.gardenUid]) && displayPlantLines.length === 0 && (
                                    <div style={{ color: MUTED_TEXT_COLOR }}>No plant lines found.</div>
                                  )}
                                  {!(displayMode !== 'historical' && loadingBedPlantLines[bed.gardenUid]) && displayPlantLines.length > 0 && (
                                    <div>
                                      {groupPlantLinesBySpecies(displayPlantLines).map((speciesGroup) =>
                                      {
                                        const speciesGroupKey = `${bed.gardenUid}|||${speciesGroup.speciesUid}|||${speciesGroup.speciesName}`
                                        const isExpanded = expandedSpeciesGroups.includes(speciesGroupKey)
                                        const isSelectedSpecies = selectedSpeciesUid !== '' && speciesGroup.speciesUid === selectedSpeciesUid

                                        return (
                                          <div key={speciesGroupKey}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                              <button
                                                type="button"
                                                className="btn btn-link p-0"
                                                style={{
                                                  ...TREE_TOGGLE_STYLE,
                                                  fontSize: '0.95rem',
                                                  color: '#555'
                                                }}
                                                onClick={() =>
                                                {
                                                  toggleSpeciesGroup(speciesGroupKey)
                                                }}
                                                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} species ${speciesGroup.speciesName}`}
                                              >
                                                {getTreeToggleIcon(isExpanded)}
                                              </button>
                                              <div
                                                style={{
                                                  color: isSelectedSpecies ? '#007ac2' : 'inherit',
                                                  fontWeight: isSelectedSpecies ? 700 : 400
                                                }}
                                              >
                                                {formatNumber(speciesGroup.totalQuantity)} x {speciesGroup.speciesName}
                                              </div>
                                            </div>

                                            {isExpanded && (
                                              <div style={{ marginLeft: '1.75rem' }}>
                                                {speciesGroup.lines.map((plantLine, index) => (
                                                  <div
                                                    key={`${speciesGroupKey}-${index}-${plantLine.costPerUnit}-${plantLine.unitType}`}
                                                    style={{
                                                      color: isSelectedSpecies ? '#007ac2' : 'inherit',
                                                      fontWeight: isSelectedSpecies ? 700 : 400
                                                    }}
                                                  >
                                                    • {formatNumber(plantLine.quantity)} x {plantLine.speciesName} - ${formatNumber(plantLine.costPerUnit)} {plantLine.unitType}
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Widget
