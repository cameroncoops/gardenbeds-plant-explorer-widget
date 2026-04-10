import Query from 'esri/rest/support/Query'
import { executeQueryJSON } from 'esri/rest/query'
import { buildSqlInClause, escapeSqlValue, firstValue } from './field-helpers'
import { PlantLine } from './plant-types'
import { PLANTS_IN_BED_LAYER_URL, SPECIES_LAYER_URL } from './service-urls'

// Loads and sums all current_quantity values for a single bed.
// This is done lazily when a bed is expanded to keep the initial widget load fast.
export const queryPlantsInBedTotal = async (gardenUid: string): Promise<number> =>
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
export const queryPlantLinesForBed = async (gardenUid: string): Promise<PlantLine[]> =>
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
