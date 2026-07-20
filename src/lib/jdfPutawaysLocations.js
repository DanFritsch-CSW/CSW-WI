// Aisle rack-type classification + curated customer-name overrides for F8.
// RAW_LOCATIONS (the per-location on-hand snapshot) moved to a live
// MotherDuck query — see netlify/functions/motherduck-jdf-putaways.cjs —
// as of 2026-07-20. This file now holds only the static facility-layout
// config that doesn't come from a query: which aisles are 7-deep vs
// 2-deep, and curated short names for customers sharing F8 racks with
// JDF (the live query also returns project names, but these hand-picked
// labels read better than Datex's raw project_name for the ones we know).

export const RACK_TYPE = {
  A: "7-deep, 4-high",
  B: "2-deep, 7-high",
  C: "2-deep, 7-high",
  D: "2-deep, 7-high",
  E: "2-deep, 7-high",
  F: "2-deep, 7-high",
  G: "7-deep, 4-high",
  H: "7-deep, 4-high",
};

export const RACK_GROUP = { A: "7-deep", B: "2-deep", C: "2-deep", D: "2-deep", E: "2-deep", F: "2-deep", G: "7-deep", H: "7-deep" };

export const CUSTOMER_NAMES = {
  SAPFG1: "Saputo",
  GRALA1: "Grassland",
  DDWIL1: "DD Williamson",
  SPL1: "SPL",
  BAYER1: "Bayer",
  TR9FO1: "Tribe 9 Foods",
};
