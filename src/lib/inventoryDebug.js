// ── Active Inventory ─────────────────────────────────────────────
// Source of truth: Omni LP topic (silver__datex_slv_licenseplates)
// Filter: archived = false (boolean is_negative:true) + warehouse CONTAINS "CSW-Madison"
// Measure: lookup_code_count_distinct grouped by project_name
// This exactly matches the Omni workbook screenshot baseline.
export async function fetchActiveInventory(facilityId) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_LP,
    fields: [
      `${VIEW_LP_PROJ}.project_name`,
      `${VIEW_LP}.lookup_code_count_distinct`,
    ],
    filters: {
      [`${VIEW_LP}.archived`]: { type: 'boolean', is_negative: true, treat_nulls_as_false: false },
      [`${VIEW_LP_WH}.warehouse_name`]: { kind: 'CONTAINS', type: 'string', values: [wh], is_negative: false, case_insensitive: true },
    },
    sorts: [{ column_name: `${VIEW_LP}.lookup_code_count_distinct`, sort_descending: true }],
    limit: 200,
  })
  return rows
    .map(r => ({
      name: stripWarehouseSuffix(r[`${VIEW_LP_PROJ}.project_name`] || ''),
      lps:  Number(r[`${VIEW_LP}.lookup_code_count_distinct`]) || 0,
    }))
    .filter(r => r.name && r.name.trim() !== '' && r.lps > 0)
}
