// Returns the first populated attribute value from a list of possible field names.
export const firstValue = (attributes: any, fieldNames: string[]): string =>
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
export const escapeSqlValue = (value: string): string =>
{
  return value.replace(/'/g, "''")
}

export const buildSqlInClause = (fieldName: string, values: string[]): string =>
{
  return `${fieldName} IN (${values.map((value) => `'${escapeSqlValue(value)}'`).join(', ')})`
}

export const getRecordAttributes = (record: any): any =>
{
  return record?.getData ? record.getData() : (record?.attributes || {})
}

export const getGardenUidFromRecord = (record: any): string =>
{
  return firstValue(getRecordAttributes(record), ['garden_uid', 'GARDEN_UID'])
}
