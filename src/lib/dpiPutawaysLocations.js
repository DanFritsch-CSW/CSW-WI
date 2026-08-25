// Rack-type classification for the DPI Putaways tab (F5 + F8, Madison).
// Duplicated from jdfPutawaysLocations.js 2026-08-25. Unlike JDF (F8 only,
// single zone), DPI spans two physically different racks that both use
// letters A-D/A-H for aisles — so every key here is a zone-qualified
// `${zone}-${aisle}` string (e.g. "F5-A", "F8-A"), matching the zone_aisle
// field motherduck-dpi-putaways.cjs returns. A bare letter key would
// silently merge F5's aisle A with F8's unrelated aisle A.
//
// F5: confirmed live 2026-08-25 — 4 aisles (A-D), all 4-deep per Dan.
// F8: same 7-deep/4-high (A,G,H) vs 2-deep/7-high (B-F) layout as JDF's
// existing F8 config, since it's the same physical building.
//
// No curated CUSTOMER_NAMES override list (JDF's version hand-labels a
// handful of known co-shared customers) -- not built for DPI yet since we
// don't know which customers regularly share F5/F8 racks with DPI. Falls
// back to Datex's raw project_name for now; add entries here if that gets
// noisy in practice.

export const RACK_TYPE = {
  'F5-A': '4-deep',
  'F5-B': '4-deep',
  'F5-C': '4-deep',
  'F5-D': '4-deep',
  'F8-A': '7-deep, 4-high',
  'F8-B': '2-deep, 7-high',
  'F8-C': '2-deep, 7-high',
  'F8-D': '2-deep, 7-high',
  'F8-E': '2-deep, 7-high',
  'F8-F': '2-deep, 7-high',
  'F8-G': '7-deep, 4-high',
  'F8-H': '7-deep, 4-high',
};

export const RACK_GROUP = {
  'F5-A': '4-deep', 'F5-B': '4-deep', 'F5-C': '4-deep', 'F5-D': '4-deep',
  'F8-A': '7-deep', 'F8-B': '2-deep', 'F8-C': '2-deep', 'F8-D': '2-deep',
  'F8-E': '2-deep', 'F8-F': '2-deep', 'F8-G': '7-deep', 'F8-H': '7-deep',
};

export const CUSTOMER_NAMES = {};
