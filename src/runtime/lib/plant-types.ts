export interface PlantLine {
  speciesUid: string
  speciesName: string
  quantity: number
  costPerUnit: number
  unitType: string
  usedSpeciesUidFallback: boolean
}

export interface SpeciesOption {
  speciesUid: string
  speciesName: string
}
