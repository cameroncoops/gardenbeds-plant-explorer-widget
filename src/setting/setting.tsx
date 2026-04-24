/**
 * Plant Explorer settings
 * =======================
 *
 * This settings panel wires the widget to:
 * 1. the published current bed layer datasource (GardenBeds_Active), and
 * 2. the target map widget used for highlight/selection sync.
 */

import { React, Immutable, type UseDataSource, DataSourceTypes } from 'jimu-core'
import type { AllWidgetSettingProps } from 'jimu-for-builder'
import { DataSourceSelector } from 'jimu-ui/advanced/data-source-selector'
import { MapWidgetSelector } from 'jimu-ui/advanced/setting-components'

const Setting = (props: AllWidgetSettingProps<any>) => {
  const onDataSourceChange = (useDataSources: UseDataSource[]) => {
    props.onSettingChange({
      id: props.id,
      useDataSources
    })
  }

  const onMapWidgetSelected = (useMapWidgetIds: string[]) => {
    props.onSettingChange({
      id: props.id,
      useMapWidgetIds
    })
  }

  return (
    <div className="p-3">
      <h4>Plant Explorer Settings</h4>
      <p>Select the GardenBeds_Active data source and the target map widget.</p>

      <div className="mb-4">
        <div className="mb-2"><strong>GardenBeds_Active data source</strong></div>
        <DataSourceSelector
          mustUseDataSource
          types={Immutable([DataSourceTypes.FeatureLayer])}
          useDataSources={props.useDataSources}
          onChange={onDataSourceChange}
          widgetId={props.id}
        />
      </div>

      <div>
        <div className="mb-2"><strong>Map widget</strong></div>
        <MapWidgetSelector
          useMapWidgetIds={props.useMapWidgetIds}
          onSelect={onMapWidgetSelected}
        />
      </div>
    </div>
  )
}

export default Setting
