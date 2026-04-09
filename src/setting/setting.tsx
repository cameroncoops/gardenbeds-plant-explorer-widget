import { React, Immutable, type AllWidgetSettingProps, type UseDataSource, DataSourceTypes } from 'jimu-core'
import { DataSourceSelector } from 'jimu-ui/advanced/data-source-selector'
import { MapWidgetSelector } from 'jimu-ui/advanced/setting-components'

const Setting = (props: AllWidgetSettingProps<any>) =>
{
  const onDataSourceChange = (useDataSources: UseDataSource[]) =>
  {
    props.onSettingChange({
      id: props.id,
      useDataSources
    })
  }

  const onMapWidgetSelected = (useMapWidgetIds: string[]) =>
  {
    props.onSettingChange({
      id: props.id,
      useMapWidgetIds
    })
  }

  return (
    <div className="p-3">
      <h4>Widget Template Settings</h4>
      <p>Select a feature layer data source and a target map widget.</p>

      <div className="mb-4">
        <div className="mb-2"><strong>Feature layer data source</strong></div>
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