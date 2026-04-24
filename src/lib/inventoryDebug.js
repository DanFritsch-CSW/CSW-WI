// ── Active Inventory ─────────────────────────────────────────────
// Definitive approach: include VIEW_LP_WH.warehouse_name as a FIELD (dimension),
// not just a filter. This forces Omni to group by warehouse, returning separate
// rows per warehouse+project. Client-side filter then isolates the target warehouse.
// Key in proxy row: `silver__datex_slv_warehouses.warehouse_name`
// Key in proxy row: `silver__datex_slv_projects.project_name`
// Key in proxy row: `silver__datex_slv_licenseplates.lookup_code_count_distinct`
export async function fetchActiveInventory(facilityId) {
  const wh = CSW_WAREHOUSE[facilityId]
  if (!wh) return []
  const rows = await omniQuery({
    modelId: GOLD_MODEL_ID,
    table: VIEW_LP,
    fields: [
      `${VIEW_LP_WH}.warehouse_name`,
      `${VIEW_LP_PROJ}.project_name`,
      `${VIEW_LP}.lookup_code_count_distinct`,
    ],
    filters: {
      [`${VIEW_LP}.status_name`]: { kind: 'EQUALS', type: 'string', values: ['Active'] },
    },
    sorts: [{ column_name: `${VIEW_LP}.lookup_code_count_distinct`, sort_descending: true }],
    limit: 500,
  })
  const projectMap = new Map()
  for (const r of rows) {
    // Try both possible key formats since Arrow field naming can vary
    const rowWh = (
      r[`${VIEW_LP_WH}.warehouse_name`] ||
      r[`${VIEW_LP}.warehouse_name`] ||
      ''
    ).trim()
    const project = (r[`${VIEW_LP_PROJ}.project_name`] || '').trim()
    const count   = Number(r[`${VIEW_LP}.lookup_code_count_distinct`]) || 0
    if (rowWh !== wh) continue
    if (!project) continue
    const name = stripWarehouseSuffix(project)
    projectMap.set(name, (projectMap.get(name) ?? 0) + count)
  }
  return [...projectMap.entries()]
    .map(([name, lps]) => ({ name, lps }))
    .filter(r => r.lps > 0)
    .sort((a, b) => b.lps - a.lps)
}
