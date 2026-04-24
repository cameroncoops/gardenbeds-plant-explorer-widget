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

export interface DataLoadSuccess<T> {
  ok: true
  data: T
}

export interface DataLoadFailure {
  ok: false
  errorMessage: string
}

export type DataLoadResult<T> = DataLoadSuccess<T> | DataLoadFailure
