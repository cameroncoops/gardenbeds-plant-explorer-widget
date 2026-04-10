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
import Query from 'esri/rest/support/Query'
import { executeQueryJSON } from 'esri/rest/query'

const { useEffect, useState } = React

// Shared service endpoints used to lazily load stock information for each bed.
const PLANTS_IN_BED_LAYER_URL = 'https://arcgis.curtin.edu.au/arcgis/rest/services/Parks_Gardens/PropGIS_SDE_GardenBedsTEST_PlantsInBeds_/MapServer/0'
const SPECIES_LAYER_URL = 'https://arcgis.curtin.edu.au/arcgis/rest/services/Parks_Gardens/PropGIS_SDE_GardenBedsTEST_Plant_Species_/FeatureServer/0'
const SELECTED_SPECIES_UID_KEY = 'gardenbeds:selectedSpeciesUid'
const MASTER_WHERE = "status = 'Active' OR status IS NULL"
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
  minWidth: '1rem'
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
const WIDGET_VERSION = 'v2026.04.10-1'

const getTreeToggleIcon = (isExpanded: boolean): string =>
{
  return isExpanded ? 'v' : '>'
}

// A single bed entry rendered under a zone.
interface BedItem {
  gardenUid: string
  bedNo: string
  area: string
}

// A lazily loaded stock line rendered under "Total Plants".
interface PlantLine {
  speciesUid: string
  speciesName: string
  quantity: number
  costPerUnit: number
  unitType: string
  usedSpeciesUidFallback: boolean
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

// Returns the first populated attribute value from a list of possible field names.
const firstValue = (attributes: any, fieldNames: string[]): string =>
{
  for (const fieldName of fieldNames)
  {
    const value = attributes?.[fieldName]

    if (value !== null && value !== undefined && String(value).trim() !== '')
    {
      return String(value).trim()
    }
  }

  return ''
}

// Escapes single quotes for REST where clauses.
const escapeSqlValue = (value: string): string =>
{
  return value.replace(/'/g, "''")
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

const getRecordAttributes = (record: any): any =>
{
  return record?.getData ? record.getData() : (record?.attributes || {})
}

const getGardenUidFromRecord = (record: any): string =>
{
  return firstValue(getRecordAttributes(record), ['garden_uid', 'GARDEN_UID'])
}

const buildSqlInClause = (fieldName: string, values: string[]): string =>
{
  return `${fieldName} IN (${values.map((value) => `'${escapeSqlValue(value)}'`).join(', ')})`
}

const isMasterLayerMatch = (layerLike: any, dataSourceId?: string): boolean =>
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
    String(layerTitle).toLowerCase().includes('gardenbedstest_master') ||
    String(layerTitle).toLowerCase().includes('gardenbeds master') ||
    String(layerUrl).toLowerCase().includes('gardenbedstest_master') ||
    String(layerUrl).toLowerCase().includes('gardenbeds_master')
  )
}

// Loads and sums all current_quantity values for a single bed.
// This is done lazily when a bed is expanded to keep the initial widget load fast.
const queryPlantsInBedTotal = async (gardenUid: string): Promise<number> =>
{
  try
  {
    const query = new Query({
      where: `garden_uid = '${escapeSqlValue(gardenUid)}'`,
      outFields: ['current_quantity'],
      returnGeometry: false
    })

    const data = await executeQueryJSON(PLANTS_IN_BED_LAYER_URL, query as any)
    const features = Array.isArray(data?.features) ? data.features : []

    return features.reduce((sum: number, feature: any) =>
    {
      const quantity = Number(feature?.attributes?.current_quantity ?? feature?.attributes?.CURRENT_QUANTITY)
      return sum + (Number.isFinite(quantity) ? quantity : 0)
    }, 0)
  }
  catch (error)
  {
    console.warn(`Failed to load plant total for garden_uid ${gardenUid}`, error)
    return 0
  }
}

// Loads the detailed stock rows for a single bed and enriches them with species names.
// This is done only when the "Total Plants" line is expanded.
const queryPlantLinesForBed = async (gardenUid: string): Promise<PlantLine[]> =>
{
  try
  {
    const plantsQuery = new Query({
      where: `garden_uid = '${escapeSqlValue(gardenUid)}'`,
      outFields: ['species_uid', 'current_quantity', 'cost_per_unit', 'unit_type'],
      returnGeometry: false
    })

    const plantsResult = await executeQueryJSON(PLANTS_IN_BED_LAYER_URL, plantsQuery as any)
    const features = Array.isArray(plantsResult?.features) ? plantsResult.features : []
    const speciesUids = Array.from(new Set(features
      .map((feature: any) => firstValue(feature?.attributes, ['species_uid', 'SPECIES_UID']))
      .filter((value: string) => value !== '')))
    const speciesNameByUid = new Map<string, string>()

    if (speciesUids.length > 0)
    {
      try
      {
        const speciesQuery = new Query({
          where: buildSqlInClause('species_uid', speciesUids),
          outFields: ['species_uid', 'species_name', 'common_name'],
          returnGeometry: false
        })

        const speciesResult = await executeQueryJSON(SPECIES_LAYER_URL, speciesQuery as any)

        ;(speciesResult?.features || []).forEach((feature: any) =>
        {
          const attributes = feature?.attributes || {}
          const speciesUid = firstValue(attributes, ['species_uid', 'SPECIES_UID'])
          const speciesName = firstValue(attributes, ['species_name', 'SPECIES_NAME', 'common_name', 'COMMON_NAME'])

          if (speciesUid !== '')
          {
            speciesNameByUid.set(speciesUid, speciesName || speciesUid)
          }
        })
      }
      catch (error)
      {
        console.warn(`Failed to load species lookup for garden_uid ${gardenUid}`, error)
      }
    }

    return features
      .map((feature: any) =>
      {
        const attributes = feature?.attributes || {}
        const speciesUid = firstValue(attributes, ['species_uid', 'SPECIES_UID'])
        const quantity = Number(attributes?.current_quantity ?? attributes?.CURRENT_QUANTITY)
        const costPerUnit = Number(attributes?.cost_per_unit ?? attributes?.COST_PER_UNIT)
        const speciesName = speciesNameByUid.get(speciesUid) || speciesUid

        return {
          speciesUid,
          speciesName,
          quantity: Number.isFinite(quantity) ? quantity : 0,
          costPerUnit: Number.isFinite(costPerUnit) ? costPerUnit : 0,
          unitType: firstValue(attributes, ['unit_type', 'UNIT_TYPE']) || '',
          usedSpeciesUidFallback: speciesName === speciesUid
        }
      })
      .sort((left, right) =>
      {
        const speciesCompare = left.speciesName.localeCompare(right.speciesName, undefined, { numeric: true, sensitivity: 'base' })

        if (speciesCompare !== 0)
        {
          return speciesCompare
        }

        if (right.quantity !== left.quantity)
        {
          return right.quantity - left.quantity
        }

        return left.unitType.localeCompare(right.unitType, undefined, { numeric: true, sensitivity: 'base' })
      })
  }
  catch (error)
  {
    console.warn(`Failed to load plant lines for garden_uid ${gardenUid}`, error)
    return []
  }
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
  const [masterDs, setMasterDs] = useState<DataSource | null>(null)
  const [jimuMapView, setJimuMapView] = useState<JimuMapView | null>(null)
  const [zoneGroups, setZoneGroups] = useState<ZoneGroup[]>([])
  const [hasLoadedMasterRecords, setHasLoadedMasterRecords] = useState(false)
  const [isLoadingZones, setIsLoadingZones] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [zoneFilterText, setZoneFilterText] = useState('')
  const [isolatedZones, setIsolatedZones] = useState<string[]>([])
  const [showHelp, setShowHelp] = useState(false)
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

  const highlightHandleRef = React.useRef<HighlightHandle | null>(null)
  const mapClickHandleRef = React.useRef<ViewEventHandle | null>(null)
  const bedRowRefs = React.useRef<Record<string, HTMLDivElement | null>>({})
  const normalizedZoneFilterText = normalizeFilterValue(zoneFilterText)

  // Reads the currently selected species written by the Species Filter widget.
  const syncSelectedSpeciesUidFromSession = () =>
  {
    setSelectedSpeciesUid(sessionStorage.getItem(SELECTED_SPECIES_UID_KEY) || '')
  }

  // Rebuilds the displayed hierarchy from the records currently loaded in the shared master datasource.
  // This makes Plant Explorer react to filters applied by other widgets, such as Species Filter.
  const rebuildZoneGroupsFromDataSource = (dataSource: DataSource) =>
  {
    const records = dataSource.getRecords ? dataSource.getRecords() : []
    setHasLoadedMasterRecords((records || []).length > 0)
    const zoneMap = new Map<string, BedItem[]>()

    ;(records || []).forEach((record: any) =>
    {
      const attributes = record.getData ? record.getData() : (record.attributes || {})
      const gardenUid = firstValue(attributes, ['garden_uid', 'GARDEN_UID'])
      const zoneValue = firstValue(attributes, ['zone', 'ZONE'])
      const bedNo = firstValue(attributes, ['bed_no', 'BED_NO'])
      const area = firstValue(attributes, ['Shape__Area'])

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

  // Clears shared datasource selection for the configured master layer.
  const clearMasterDataSourceSelection = () =>
  {
    const dataSourceLike = masterDs as any

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

  // Locates the configured master layer inside the connected map widget.
  const findMatchingJimuLayerView = () =>
  {
    if (!jimuMapView || !masterDs)
    {
      return null
    }

    const dataSourceId =
      (props.useDataSources && props.useDataSources[0] && (props.useDataSources[0] as any).dataSourceId) ||
      (masterDs as any)?.id

    if (!dataSourceId)
    {
      return null
    }

    const layerViewEntries = Object.values((jimuMapView as any).jimuLayerViews || {})

    return layerViewEntries.find((entry: any) => isMasterLayerMatch(entry, dataSourceId)) || null
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

    if (isolatedZones.length === 0)
    {
      jsApiLayerView.filter = null
      jsApiLayerView.featureEffect = null
      return
    }

    const layerFields = Array.isArray(jsApiLayer.fields) ? jsApiLayer.fields : []
    const zoneField =
      layerFields.find((field: any) => String(field?.name || '').toLowerCase() === 'zone')?.name ||
      layerFields.find((field: any) => String(field?.name || '').toLowerCase().endsWith('.zone'))?.name ||
      null

    if (!zoneField)
    {
      return
    }

    const zoneFilter = new FeatureFilter({
      where: buildSqlInClause(zoneField, isolatedZones)
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

  // Pushes a selected bed back into the shared ExB datasource selection state.
  const selectBedRecordInDataSource = (gardenUid: string) =>
  {
    if (!masterDs || gardenUid === '')
    {
      return
    }

    const records = masterDs.getRecords ? masterDs.getRecords() : []
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

    if (recordId !== '' && typeof (masterDs as any).selectRecordsByIds === 'function')
    {
      ;(masterDs as any).selectRecordsByIds([String(recordId)], [matchingRecord])
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
    clearMasterDataSourceSelection()
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
    clearMapViewSelectionState()
    setSelectedBedUid('')
  }

  // Finds the master layer inside the selected map widget, then highlights and zooms to the chosen bed.
  const syncMapToGardenBed = async (gardenUid: string) =>
  {
    if (!jimuMapView || !masterDs || gardenUid === '')
    {
      return
    }

    clearMasterDataSourceSelection()
    clearMapHighlight()
    clearMapViewSelectionState()
    applyZoneIsolationToMap()

    try
    {
      const matchingJimuLayerView = findMatchingJimuLayerView()

      const jsApiMapView = jimuMapView.view
      const jsApiLayerView = matchingJimuLayerView?.view
      const jsApiLayer = matchingJimuLayerView?.layer || jsApiLayerView?.layer

      if (!jsApiMapView || !jsApiLayerView || !jsApiLayer)
      {
        return
      }

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
      const features = featureSet?.features || []

      if (features.length === 0)
      {
        return
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

  // Loads the master datasource through DataSourceComponent, then rebuilds the tree from its current records.
  // Future enhancement: preserve expanded zones/beds across datasource refreshes when matching items still exist.
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
    .filter((zoneGroup) =>
    {
      return normalizedZoneFilterText === '' || normalizeFilterValue(zoneGroup.zone).includes(normalizedZoneFilterText)
    })

  // Loads bed-level plant totals only for beds that are currently expanded.
  useEffect(() =>
  {
    syncSelectedSpeciesUidFromSession()
  }, [])

  useEffect(() =>
  {
    const loadExpandedBedTotals = async () =>
    {
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
  }, [expandedBeds, bedPlantTotals, loadingBedTotals])

  // Loads detailed plant lines only for beds whose "Total Plants" section is expanded.
  useEffect(() =>
  {
    const loadExpandedPlantLines = async () =>
    {
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
  }, [expandedPlantTotals, bedPlantLines, loadingBedPlantLines])

  // Keeps map highlight in sync with the currently selected bed.
  useEffect(() =>
  {
    if (selectedBedUid === '')
    {
      clearMapHighlight()
      return
    }

    void syncMapToGardenBed(selectedBedUid)
  }, [selectedBedUid, jimuMapView, masterDs])

  // Applies zone isolate to the connected map only, leaving the tree unchanged.
  useEffect(() =>
  {
    applyZoneIsolationToMap()
  }, [isolatedZones, selectedBedUid, jimuMapView, masterDs])

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

    if (!jsApiMapView || !targetLayer || typeof jsApiMapView.on !== 'function')
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
        const matchingResult = results.find((result: any) =>
        {
          const resultLayer = result?.graphic?.layer
          const resultAttributes = result?.graphic?.attributes || {}
          const resultGardenUid = firstValue(resultAttributes, ['garden_uid', 'GARDEN_UID'])

          return (
            resultGardenUid !== '' &&
            (
              resultLayer === targetLayer ||
              isMasterLayerMatch(resultLayer) ||
              isMasterLayerMatch(result?.graphic) ||
              String(resultLayer?.url || '').toLowerCase() === String(targetLayer?.url || '').toLowerCase() ||
              String(resultLayer?.title || '').toLowerCase() === String(targetLayer?.title || '').toLowerCase()
            )
          )
        })

        const attributes = matchingResult?.graphic?.attributes || {}
        const gardenUid = firstValue(attributes, ['garden_uid', 'GARDEN_UID'])

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
  }, [jimuMapView, masterDs, zoneGroups, normalizedZoneFilterText])

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
        <p>Select the Master data source in widget settings.</p>
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
          where: MASTER_WHERE,
          outFields: ['*'],
          pageSize: 2000
        }}
        onDataSourceCreated={(dataSource) =>
        {
          setMasterDs(dataSource)
          syncSelectedSpeciesUidFromSession()
          rebuildZoneGroupsFromDataSource(dataSource)
          syncSelectedBedFromDataSource(dataSource)
        }}
        onDataSourceInfoChange={() =>
        {
          syncSelectedSpeciesUidFromSession()
          if (masterDs)
          {
            rebuildZoneGroupsFromDataSource(masterDs)
            syncSelectedBedFromDataSource(masterDs)
          }
        }}
        onSelectionChange={() =>
        {
          if (masterDs)
          {
            syncSelectedBedFromDataSource(masterDs)
          }
        }}
        onDataSourceStatusChange={(status) =>
        {
          setIsLoadingZones(status === DataSourceStatus.Loading)
        }}
        onCreateDataSourceFailed={(error) =>
        {
          setLoadError(error?.message || 'Failed to connect to GardenBeds_Master.')
          setHasLoadedMasterRecords(false)
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
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          marginBottom: '0.75rem'
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>Plant Explorer</h3>
            <span style={{ fontSize: '0.78rem', color: SECONDARY_TEXT_COLOR }}>{WIDGET_VERSION}</span>
          </div>
        </div>

        <div style={{ whiteSpace: 'nowrap', fontSize: '0.9rem', marginTop: '0.15rem' }}>
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

      <div style={{ flex: '0 0 auto', marginBottom: '0.75rem' }}>
        <input
          type="text"
          value={zoneFilterText}
          placeholder="Filter zones"
          onChange={(event) =>
          {
            setZoneFilterText(event.target.value)
          }}
          style={{
            width: '100%',
            padding: '0.5rem 0.65rem',
            border: '1px solid #d0d0d0',
            borderRadius: '4px',
            fontSize: '0.92rem',
            color: '#222',
            backgroundColor: '#fff'
          }}
        />
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

        {/* The tree below is intentionally driven by the shared master datasource records
            so it reacts to filters applied by other widgets in the same app. */}
        {!isLoadingZones && loadError === '' && zoneGroups.length === 0 && (
          <div style={EMPTY_STATE_TEXT_STYLE}>
            <p style={{ marginBottom: '0.35rem' }}>
              {selectedSpeciesUid !== ''
                ? 'No garden beds match the current species filter.'
                : 'No garden beds are available from the master datasource.'}
            </p>
            <p style={EMPTY_STATE_DETAIL_STYLE}>
              {selectedSpeciesUid !== ''
                ? 'Clear or change the species filter to see more beds.'
                : hasLoadedMasterRecords
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
                      {zoneGroup.beds.map((bed) => (
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
                                Total Plants: {loadingBedTotals[bed.gardenUid]
                                  ? 'Loading...'
                                  : (bedPlantTotals[bed.gardenUid] ?? 0).toLocaleString()}
                              </div>
                              {expandedPlantTotals.includes(bed.gardenUid) && (
                                <div style={{ marginLeft: '1.35rem', marginTop: '0.15rem' }}>
                                  {!loadingBedPlantLines[bed.gardenUid] && (bedPlantLines[bed.gardenUid] || []).some((plantLine) => plantLine.usedSpeciesUidFallback) && (
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
                                        {Array.from(new Set((bedPlantLines[bed.gardenUid] || [])
                                          .filter((plantLine) => plantLine.usedSpeciesUidFallback)
                                          .map((plantLine) => plantLine.speciesUid)))
                                          .join(', ')}
                                      </div>
                                      <div style={{ marginTop: '0.3rem' }}>
                                      Please contact gis.properties@curtin.edu.au for assistance.
                                      </div>
                                    </div>
                                  )}
                                  {loadingBedPlantLines[bed.gardenUid] && (
                                    <div style={{ color: MUTED_TEXT_COLOR }}>Loading plant lines...</div>
                                  )}
                                  {!loadingBedPlantLines[bed.gardenUid] && (bedPlantLines[bed.gardenUid] || []).length === 0 && (
                                    <div style={{ color: MUTED_TEXT_COLOR }}>No plant lines found.</div>
                                  )}
                                  {!loadingBedPlantLines[bed.gardenUid] && (bedPlantLines[bed.gardenUid] || []).length > 0 && (
                                    <div>
                                      {groupPlantLinesBySpecies(bedPlantLines[bed.gardenUid] || []).map((speciesGroup) =>
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
                      ))}
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
