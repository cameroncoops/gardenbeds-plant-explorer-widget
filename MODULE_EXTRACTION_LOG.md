# Module Extraction Log

This log tracks reusable runtime modules being extracted from `gardenbeds-plant-explorer` so they can be reused by future widgets and retrofitted into older ones.

The goal is to separate:
- shared data/service/query logic
- field/value helper logic
- stable utility code

from:
- widget-specific UI
- map interaction behavior
- Experience Builder component wiring
- styling and layout

## Current Status

The first internal modularisation pass has been completed inside this widget.

Extracted local modules now live in:
- [src/runtime/lib/service-urls.ts](c:/dev/experience-builder/arcgis-experience-builder-1.14/ArcGISExperienceBuilder/client/your-extensions/widgets/gardenbeds-plant-explorer/src/runtime/lib/service-urls.ts)
- [src/runtime/lib/field-helpers.ts](c:/dev/experience-builder/arcgis-experience-builder-1.14/ArcGISExperienceBuilder/client/your-extensions/widgets/gardenbeds-plant-explorer/src/runtime/lib/field-helpers.ts)
- [src/runtime/lib/plant-types.ts](c:/dev/experience-builder/arcgis-experience-builder-1.14/ArcGISExperienceBuilder/client/your-extensions/widgets/gardenbeds-plant-explorer/src/runtime/lib/plant-types.ts)
- [src/runtime/lib/plant-queries.ts](c:/dev/experience-builder/arcgis-experience-builder-1.14/ArcGISExperienceBuilder/client/your-extensions/widgets/gardenbeds-plant-explorer/src/runtime/lib/plant-queries.ts)

These are still local to this repo for now. They are the staging area before we move to a shared cross-repo package.

## Extracted Modules

### `service-urls.ts`

Purpose:
- central place for shared service endpoint constants and storage keys

Currently contains:
- `PLANTS_IN_BED_LAYER_URL`
- `SPECIES_LAYER_URL`
- `SELECTED_SPECIES_UID_KEY`

Why it matters:
- endpoint fixes can be made once instead of being repeated in widget files
- avoids string duplication across widgets

Likely future use:
- any widget that needs garden bed stock/species lookups
- any widget that reads shared session keys written by another widget

### `field-helpers.ts`

Purpose:
- defensive helpers for reading ArcGIS and ExB record data safely

Currently contains:
- `firstValue(...)`
- `escapeSqlValue(...)`
- `buildSqlInClause(...)`
- `getRecordAttributes(...)`
- `getGardenUidFromRecord(...)`

Why it matters:
- ArcGIS attribute casing is not always consistent
- reduces repeated null/blank/case handling
- gives widgets one standard way to build simple query clauses

Likely future use:
- nearly every gardenbeds widget
- especially widgets reading datasource records or building REST queries

### `plant-types.ts`

Purpose:
- shared runtime type definitions for plant-related query results

Currently contains:
- `PlantLine`
- `SpeciesOption`

Why it matters:
- keeps query logic and widget rendering aligned
- makes future extraction into a shared package easier

Likely future use:
- plant explorer
- add/remove plant workflows
- stock/summary widgets

### `plant-queries.ts`

Purpose:
- shared lazy-load query logic for bed totals and species-enriched plant lines

Currently contains:
- `queryPlantsInBedTotal(gardenUid)`
- `queryPlantLinesForBed(gardenUid)`
- `querySpeciesOptions()`
- `queryGardenUidsForSpecies(speciesUid)`

What it does:
- queries `PlantsInBeds`
- resolves species names via the Species `FeatureServer`
- returns sorted plant rows ready for grouping/rendering
- loads reusable species dropdown options for widgets
- resolves matching `garden_uid` values for an internal species filter flow

Why it matters:
- this is the most valuable shared logic discovered so far
- it captures the species lookup pattern that actually works with the current services

Important note:
- Species lookup must use the `FeatureServer` endpoint, not the `MapServer` endpoint
- this was confirmed during debugging when the `MapServer` table query path failed and the `FeatureServer` path succeeded

Likely future use:
- plant explorer
- species filter follow-up logic
- stock and planting summary widgets

Recent update:
- Plant Explorer now has an integrated species filter using the same local query module
- this replaces the need for a separate standalone species-filter widget in simple deployments

## What Is Still Widget-Local

These parts are still intentionally left in `widget.tsx`:
- tree rendering
- zone grouping presentation
- map highlight/select logic
- zone isolate UI and behavior
- datasource component lifecycle wiring
- widget styling constants

These can be refactored later, but they are not yet good shared-library candidates.

## Candidate Next Extractions

### Near-term candidates

- ID helpers
  - purpose: stable local keys and reusable client-side ID generation helpers
  - note: keep generated app IDs separate from service UIDs

- species lookup wrapper
  - purpose: expose a cleaner reusable API around the current species enrichment logic
  - likely shape: `loadSpeciesByUid(...)` or `enrichPlantLinesWithSpecies(...)`

- formatting helpers
  - examples:
    - number formatting
    - quantity/cost display formatting
    - area display formatting

### Possible later candidates

- zone/bed grouping helpers
  - if multiple widgets need the same grouping shape

- datasource record mapping helpers
  - if multiple widgets rebuild garden bed trees from the same master datasource

- map selection sync helpers
  - only if the same interaction model repeats across widgets

## Refactor Targets In Other Widgets

Likely widgets to revisit once the shared logic stabilizes:
- `gardenbeds-plant-explorer`
- `gardenbeds-exb-widget`
- `gardenbeds-exb-species-filter-widget`
- any add/remove plant widget using the same services or field patterns

## Migration Approach

Recommended sequence:
1. prove the extraction inside one working widget
2. stabilize module names and exported function shapes
3. document assumptions and service dependencies
4. move the stable modules into a shared cross-repo package
5. refactor older widgets to consume the shared package gradually

## Notes For Future Us

- Do not extract UI too early.
- Keep service/query logic separate from Experience Builder component wiring.
- Prefer small boring modules over a large “widget framework”.
- If a helper is not reused or clearly reusable, keep it local.
- Preserve known-good service behavior when extracting logic, especially around species lookup.
