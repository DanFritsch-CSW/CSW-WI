'use strict'

/**
 * Netlify Function: scheduling-omni-lookup
 * Ported from front_netlify_datex/functions/omni-lookup.js (2026-08-03).
 * The two live Omni calls (omniPost, queryTopCarriers) now proxy through
 * omni-query.cjs instead of calling Omni directly, per this project's
 * established Omni reliability pattern. Everything else — the hardcoded
 * per-warehouse dock door lists and PAIRS_FALLBACK data (owners, projects,
 * dock doors, carriers) — is unchanged verbatim; it's reference data, not
 * logic, and matches the source repo exactly as of 2026-04-11.
 *
 * UPDATED 2026-08-19 per Kay's long-standing "carriers disappearing"
 * feedback (cnv_1ayy4w9g, first raised June 2026, repeated four times
 * since). Root cause: carriers were ranked live by appointment count in a
 * ROLLING 6-month window and capped at the top 250 (queryTopCarriers
 * below) — a carrier falls out of that list just by losing ground in
 * recent volume, with nothing needing to change in Datex at all.
 *
 * Fix: carriers now read from Supabase's scheduling_carriers table first
 * — the COMPLETE distinct carrier list, synced weekly by
 * carriers-sync-run.cjs (see lib/carriers-sync-shared.cjs), with no
 * ranking cutoff. queryTopCarriers/the live-Omni carrier path below are
 * kept as a fallback for the (should-be-rare) case where the Supabase
 * table is empty — e.g. before the first sync has ever run — so a fresh
 * deploy never regresses to "no carriers at all."
 *
 * Returns sorted distinct values for Datex reference fields.
 *
 * GET /.netlify/functions/scheduling-omni-lookup?type=warehouses
 * GET /.netlify/functions/scheduling-omni-lookup?type=owners&with_ids=true  → [{name, id}]
 * GET /.netlify/functions/scheduling-omni-lookup?type=owners               → string[]
 */

const { createClient } = require('@supabase/supabase-js')

const MODEL_ID = '33204248-b6db-4630-ae34-11aa94347add'
const TOPIC = 'gold__truck_appointments'

// Maps ?type param → qualified OMNI name field
const LOOKUP_CONFIG = {
  warehouses: `${TOPIC}.warehouse_name`,
  types: `${TOPIC}.dock_appointment_type_name`,
  owners: `${TOPIC}.owner_name`,
  projects: `${TOPIC}.project_name`,
  dock_doors: `${TOPIC}.location_container_name`,
  carriers: `${TOPIC}.carrier_name`,
}

// Maps ?type param → qualified OMNI id field (only for types that have IDs)
const ID_CONFIG = {
  owners: `${TOPIC}.owner_id`,
  projects: `${TOPIC}.project_id`,
  dock_doors: `${TOPIC}.scheduled_location_container_id`,
  carriers: `${TOPIC}.carrier_id`,
}

const DOCK_DOOR_BLOCKLIST = /^(xx|xno longer|driver (left|issue)|labor intensive|yard$|covered dock-$)/i

// Per-warehouse dock door mapping — sourced from Omni on 2026-04-08.
const DOCK_DOORS_BY_WAREHOUSE = {
  'CSW-Eau Claire': [
    { name: 'DPI Dry', id: 43491 },
    { name: 'Door 01', id: 40450 },
    { name: 'Door 02', id: 40452 },
    { name: 'Door 03', id: 40453 },
    { name: 'Door 04', id: 40454 },
    { name: 'Door 05', id: 40455 },
    { name: 'Door 06', id: 40456 },
    { name: 'Door 07', id: 40457 },
    { name: 'Scedule 1', id: 43486 },
    { name: 'Scedule 2', id: 43487 },
    { name: 'Scedule 3', id: 43488 },
    { name: 'Scedule 4', id: 43489 },
    { name: 'Work ins', id: 43490 },
  ],
  'CSW-Franksville': [
    { name: 'Dock Door 1', id: 6346 },
    { name: 'Dock Door 2', id: 6347 },
    { name: 'Dock Door 3', id: 6348 },
    { name: 'Dock Door 4', id: 6349 },
    { name: 'Dock Door 5', id: 6350 },
    { name: 'Dock Door 6', id: 6351 },
    { name: 'Dock Door 7', id: 6352 },
    { name: 'Dock Door 8', id: 6353 },
    { name: 'Dock Door 9', id: 6354 },
    { name: 'Dock Door 10', id: 6355 },
    { name: 'Dock Door 11', id: 43370 },
    { name: 'Dock Door 12', id: 43364 },
    { name: 'Dock Door 13', id: 43365 },
    { name: 'Dock Door 14', id: 43366 },
    { name: 'Dock Door 15', id: 43367 },
    { name: 'Dock Door 16', id: 43368 },
    { name: 'Dock Door 17', id: 43369 },
    { name: 'Dock Door 18', id: 46125 },
    { name: 'Dock Door 19', id: 46127 },
    { name: 'Dock Door 20', id: 72541 },
    { name: 'Dock Door 21', id: 72543 },
    { name: 'Dock Door 22', id: 72545 },
    { name: 'Dock Door 23', id: 72547 },
    { name: 'Dock Door 24', id: 72549 },
    { name: 'Dock Door 25', id: 72551 },
    { name: 'Dock Door 26', id: 72553 },
    { name: 'Dock Door 27', id: 72555 },
    { name: 'Dock Door 28', id: 72557 },
    { name: 'Dock Door 29', id: 72559 },
    { name: 'Dock Door 30', id: 72561 },
    { name: 'Dock Door 31', id: 72563 },
    { name: 'Dock Door 32', id: 72565 },
    { name: 'Inbounds', id: 40434 },
    { name: 'Loading Dock', id: 40441 },
    { name: 'OUTBOUND PALERMO', id: 47465 },
    { name: 'Outbounds', id: 40435 },
    { name: 'Saputo Outbound', id: 40437 },
  ],
  'CSW-Kenosha': [
    { name: 'Fair Oaks Outbounds', id: 30024 },
    { name: 'LD003A', id: 18836 },
    { name: 'LD004A', id: 18838 },
    { name: 'LD005A', id: 18840 },
    { name: 'LD006A', id: 18842 },
    { name: 'LD007A', id: 18844 },
    { name: 'LD008A', id: 18846 },
    { name: 'LD009A', id: 18848 },
    { name: 'LD010A', id: 18850 },
    { name: 'LD011A', id: 18852 },
    { name: 'LD012A', id: 18854 },
    { name: 'LD013A', id: 18856 },
    { name: 'LD014A', id: 18858 },
    { name: 'LD015A', id: 18860 },
    { name: 'LD016A', id: 18862 },
    { name: 'LD017A', id: 18864 },
    { name: 'LD018A', id: 18866 },
    { name: 'LD019A', id: 18868 },
    { name: 'LD020A', id: 18870 },
    { name: 'LD021A', id: 18872 },
    { name: 'LD022A', id: 18874 },
    { name: 'LD023A', id: 18876 },
    { name: 'LD024A', id: 18878 },
    { name: 'LD025A', id: 40311 },
    { name: 'LD026A', id: 40315 },
    { name: 'LD027A', id: 40317 },
    { name: 'LD028A', id: 40319 },
    { name: 'LD029A', id: 40321 },
    { name: 'LD030A', id: 40323 },
    { name: 'LD031A', id: 40325 },
    { name: 'LD032A', id: 40327 },
    { name: 'LD033A', id: 40329 },
    { name: 'LD034A', id: 40331 },
    { name: 'LD035A', id: 40333 },
    { name: 'LD036A', id: 40335 },
    { name: 'Misc Inbounds', id: 43375 },
    { name: 'Misc. Outbound', id: 30028 },
    { name: "Palermo's / Richelieu Inbound (PO's)", id: 46129 },
    { name: "Palermo's DSD, TO's", id: 30027 },
    { name: 'Richelieu Outbound', id: 30025 },
    { name: "Z Palermo's Outbound FTL", id: 30026 },
  ],
  'CSW-Madison': [
    { name: '.Dock 8 -- Inbounds', id: 43379 },
    { name: '.Dock 8 -- Outbounds', id: 43386 },
    { name: '.East Dock -- Inbound', id: 43393 },
    { name: '.East Dock -- Outbound', id: 43394 },
    { name: '.West Dock -- Inbound', id: 43399 },
    { name: '.West Dock -- Outbound', id: 43400 },
    { name: 'Door 01-', id: 29671 },
    { name: 'Door 12-', id: 43391 },
    { name: 'Door 13-', id: 43380 },
    { name: 'Door 14-', id: 43382 },
    { name: 'Door 15-', id: 43383 },
    { name: 'Door 16-', id: 43384 },
    { name: 'Door 17-', id: 43385 },
    { name: 'Door 18-', id: 43395 },
    { name: 'Door 19-', id: 43396 },
    { name: 'Door 20-', id: 43397 },
    { name: 'Door 21-', id: 43398 },
    { name: 'Radford Appt', id: 43401 },
  ],
  'CSW-Wisconsin Rapids': [
    { name: 'C3 - Inbound Schedule', id: 47663 },
    { name: 'C3 - Outbound Schedule', id: 47664 },
    { name: 'C3 Door 01', id: 47665 },
    { name: 'C3 Door 02', id: 47667 },
    { name: 'C3 Door 03', id: 47669 },
    { name: 'C3 Door 04', id: 47672 },
    { name: 'C3 Door 05', id: 47674 },
    { name: 'C3 Door 06', id: 47676 },
    { name: 'C3 Door 07', id: 47678 },
    { name: 'C3 Door 08', id: 47680 },
    { name: 'C3 Door 09', id: 47682 },
    { name: 'C3 Door 10', id: 47684 },
    { name: 'C3 Door 11', id: 47686 },
    { name: 'C3 Door 12', id: 47688 },
    { name: 'C3 Door 13', id: 47690 },
    { name: 'C3 Door 14', id: 47692 },
    { name: 'C3 Door 15', id: 47694 },
    { name: 'C3 Door 16', id: 47696 },
    { name: 'C3 Door 17', id: 47698 },
    { name: 'C3 Door 18', id: 47700 },
    { name: 'C3 Door 19', id: 47702 },
    { name: 'C3 Door 20', id: 47704 },
  ],
}

// Hardcoded fallback pairs used when Omni is unreachable or returns empty.
// Sourced from Omni gold__truck_appointments on 2026-04-08.
const PAIRS_FALLBACK = {
  owners: [
    { name: 'ABBVIE', id: 838 }, { name: 'APPLE FARM MANAGEMENT', id: 742 }, { name: 'AUSTIN MEAT CO.', id: 1012 },
    { name: 'AgriDairy', id: 1057 }, { name: 'BRIDGET MORAN', id: 923 }, { name: 'BRIGHTON WOODS ORCHARD, INC', id: 743 },
    { name: 'BROOKLYN BRANDS INC', id: 997 }, { name: 'Bayer Research and Development', id: 871 }, { name: "Bernatello's Foods", id: 979 },
    { name: 'Birchwood Foods', id: 703 }, { name: 'C.H. Robinson', id: 1002 }, { name: 'CALUMET DIVERSIFIED MEATS', id: 766 },
    { name: 'CROWN BAKERIES', id: 741 }, { name: 'CSW Caledonia', id: 715 }, { name: 'CSW Madison', id: 738 },
    { name: 'CSW Pleasant Prairie', id: 907 }, { name: 'CYGNUS HOME DELIVERY', id: 772 }, { name: "Campbell's", id: 1063 },
    { name: "Chloe's Fruit", id: 919 }, { name: 'Chocolate Shoppe Ice Cream Co, Inc', id: 806 }, { name: 'Clofine Dairy & Food Products', id: 801 },
    { name: 'Colony Brands', id: 785 }, { name: 'Community Action Coalition for South Central WI, Inc', id: 844 }, { name: 'ConAgra Foods', id: 879 },
    { name: 'DD WILLIAMSON COLORS LLC', id: 798 }, { name: 'DDR MEAT SOLUTIONS', id: 839 }, { name: 'DSM FIRST CHOICE', id: 917 },
    { name: 'DSM FIRST CHOICE - Caledonia', id: 1026 }, { name: 'DSM FOOD SPECIALTIES USA, INC', id: 770 }, { name: 'DSM FOOD SPECIALTIES USA, INC. (EN)', id: 768 },
    { name: 'DSM PACKAGING', id: 767 }, { name: 'DSM-Firmenich Canada Inc - Eau Claire', id: 956 }, { name: 'Dairy Farmers of America', id: 885 },
    { name: 'Dairy Products Inc.', id: 786 }, { name: 'Darigold Inc.', id: 809 }, { name: 'Department of Public Instruction', id: 818 },
    { name: 'Echo Lake Foods, Inc.', id: 706 }, { name: 'FAIR OAKS FARMS', id: 763 }, { name: 'FLOUR POWER FOODS LLC', id: 1032 },
    { name: 'FUTURE FRUIT FARM', id: 843 }, { name: 'Far West Distributors, Inc', id: 791 }, { name: 'Firestone Pacific Foods', id: 870 },
    { name: 'GOOD FOODS GROUP', id: 759 }, { name: 'GORDON FOOD SERVICE, INC - XD', id: 762 }, { name: 'GRASSLAND DAIRY PRODUCTS, INC', id: 769 },
    { name: 'Gordon Food Service', id: 730 }, { name: 'Graceland Fruit', id: 1056 }, { name: 'Greater Green Bay Foundation - Eau Claire', id: 984 },
    { name: 'HAPPI FOODI', id: 890 }, { name: 'Home City Ice', id: 864 }, { name: 'Hoogwegt', id: 833 },
    { name: 'Infinity Beverages - Eau Claire', id: 944 }, { name: 'JELLY BELLY CANDY COMPANY', id: 747 }, { name: 'JENNIE-O Turkey Store Inc.', id: 828 },
    { name: 'Jones Dairy Farm', id: 1071 }, { name: "Kaufhold's Kurds, Inc.", id: 1018 }, { name: "Kemp's Ice Cream", id: 886 },
    { name: 'Kenover Marketing - KAYCO', id: 857 }, { name: 'Kerry', id: 990 }, { name: 'Kraft Foods', id: 816 },
    { name: "LaGrander's Hillside Dairy", id: 1017 }, { name: 'Lactalis', id: 881 }, { name: 'Lakeside Foods, Inc.', id: 702 },
    { name: 'Leinenkugel J Brewing Co. - Eau Claire', id: 947 }, { name: "MAMA BEV'S BAKERY LLC", id: 858 }, { name: 'Mark Anthony Brewing Inc. - Eau Claire', id: 948 },
    { name: 'McCain Foods', id: 1016 }, { name: 'Meijer', id: 723 }, { name: 'Milwaukee Pretzel', id: 931 },
    { name: 'Minocqua Brewing Co', id: 880 }, { name: 'MolsonCoors LLC USA', id: 877 }, { name: "Mom's Meals", id: 856 },
    { name: 'NEXT PHASE / FSBx LLC', id: 928 }, { name: 'National Food Group - Eau Claire', id: 954 }, { name: 'Nestle Food Co. - Eau Claire', id: 967 },
    { name: 'Nortera Foods Inc.', id: 820 }, { name: 'North Pasture Farms/ VDL Grassfed - Eau Claire', id: 968 }, { name: 'Northern Pelagic Group LLC', id: 842 },
    { name: 'Northern Pride', id: 727 }, { name: 'Northstar Bison LLC - Eau Claire', id: 957 }, { name: 'Novonesis', id: 792 },
    { name: 'O&H Danish Bakery', id: 717 }, { name: 'OCEAN SPRAY', id: 758 }, { name: "OWL'S BREW", id: 1003 },
    { name: 'Olympia Foods', id: 1059 }, { name: 'OmniFoods/Common Goods Trading USA,Inc', id: 909 }, { name: 'Osborne, Richard', id: 808 },
    { name: 'PERFORMANCE FOOD SERVICE', id: 1009 }, { name: 'POPCORN FACTORY', id: 756 }, { name: 'PRETZILLA, LLC', id: 735 },
    { name: 'Palermo Villa, Inc.', id: 704 }, { name: 'Pedone Pinsa', id: 1067 }, { name: 'Perishable Distribution Solutions - Eau Claire', id: 994 },
    { name: 'Perrigo Co / Perrigo Wisconsin LLC - Eau Claire', id: 965 }, { name: 'Pork King Good, LLC', id: 1013 }, { name: 'Prime International', id: 1062 },
    { name: 'Proactive Sales - Eau Claire', id: 973 }, { name: 'RACINE / KENOSHA COMM ACTION AGENCY', id: 751 }, { name: 'RACINE DANISH KRINGLES', id: 899 },
    { name: 'RANA MEAL SOLUTIONS', id: 740 }, { name: "Rao's Specialty Foods, Inc", id: 924 }, { name: 'Real Good Foods', id: 910 },
    { name: 'Rhodes Bread', id: 1035 }, { name: 'Richelieu', id: 892 }, { name: 'Rise Baking Co. - Best Maid Cookies', id: 951 },
    { name: 'Roundys / Kroger', id: 719 }, { name: 'SASTA BAZAAR INC.', id: 737 }, { name: 'SHANTY RESTAURANT', id: 752 },
    { name: 'SPF Noth America, Inc. - Eau Claire', id: 949 }, { name: 'SSF FOOD DISTRIBUTION', id: 914 }, { name: 'STOCK HOUSE BREWING CO.', id: 876 },
    { name: 'STRAUSS BRANDS, INC.', id: 761 }, { name: 'Saputo Cheese USA Inc', id: 774 }, { name: 'Sargento Cheese Inc.', id: 903 },
    { name: 'Scientific Protein Laboratories (SPL)', id: 1069 }, { name: 'Shorr Packaging Corp.', id: 1039 }, { name: 'Solaris-Gobal', id: 834 },
    { name: 'Spindrift Beverage Co, Inc', id: 887 }, { name: 'Spring Hill Family Farm - Eau Claire', id: 975 }, { name: "Stella & Chewy's LLC", id: 710 },
    { name: 'THE Good Company', id: 764 }, { name: 'The Honest Bison', id: 1064 }, { name: 'Third Generation Food Company - Eau Claire', id: 976 },
    { name: 'Thomas Foods', id: 1054 }, { name: 'Tribe 9 Foods', id: 1022 }, { name: 'UNFI', id: 878 },
    { name: 'Upper Cut Brands, LLC', id: 1070 }, { name: 'Vans Kitchen', id: 908 }, { name: 'Whitebridge Pet Brands LLC', id: 819 },
    { name: 'Wisconsin Brewing Co', id: 845 }, { name: 'ifiGOURMET', id: 760 },
  ],
  projects: [
    { name: 'A Good Company', id: 298 }, { name: 'ABBVIE', id: 143 }, { name: 'APPLE FARM MANAGEMENT', id: 37 },
    { name: 'AUSTIN MEAT CO', id: 312 }, { name: 'AgriDairy - Madison', id: 348 }, { name: 'BIRCHWOOD FOODS  KENOSHA', id: 242 },
    { name: 'BRIDGET MORAN', id: 245 }, { name: 'BRIGHTON WOODS ORCHARD', id: 39 }, { name: 'BROOKLYN BRANDS INC', id: 299 },
    { name: 'Bayer - CSW-Madison', id: 185 }, { name: "Bernatello's - CSW-Madison", id: 282 }, { name: 'Bernatello\'s - Wisconsin Rapids', id: 320 },
    { name: 'Birchwood Foods CAL MATERIALS', id: 6 }, { name: 'Birchwood Foods FINISHED GOODS', id: 4 }, { name: 'C.H. Robinson - CSW-Madison', id: 304 },
    { name: 'CALUMET DIVERSIFIED MEATS', id: 63 }, { name: 'COLONY BRANDS - KENOSHA', id: 228 }, { name: 'CROWN BAKERIES', id: 35 },
    { name: 'CROWN BAKERIES - Madison', id: 306 }, { name: 'CSW Caledonia', id: 11 }, { name: 'CSW Madison', id: 32 },
    { name: 'CSW Pleasant Prairie', id: 235 }, { name: 'CYGNUS HOME DELIVERY', id: 70 }, { name: 'Calumet Diversified Meats - Caledonia', id: 351 },
    { name: "Campbell's - Caledonia", id: 353 }, { name: "Chloe's Fruit Kenosha", id: 244 }, { name: 'Chocolate Shoppe - CSW-Madison', id: 104 },
    { name: 'Clofine Dairy - CSW-Madison', id: 98 }, { name: 'Colony Brands - CSW-Madison', id: 78 }, { name: 'Colony Brands-CALEDONIA', id: 227 },
    { name: 'ConAgra - CSW-Madison', id: 195 }, { name: 'DD WILLIAMSON - CSW-Madison', id: 207 }, { name: 'DD WILLIAMSON cooler caledonia', id: 309 },
    { name: 'DD WILLIAMSON freezer caledonia', id: 166 }, { name: 'DD WILLIAMSON- Kenosha', id: 95 }, { name: 'DDR Meat Solutions - CSW-Madison', id: 208 },
    { name: 'DDR Meat Solutions-CALEDONIA', id: 146 }, { name: 'DDW Louisville COOLER caledonia', id: 308 }, { name: 'DDW Louisville FREEZER caledonia', id: 189 },
    { name: 'DFA - CSW-Madison', id: 203 }, { name: 'DPI - CSW-Eau Claire', id: 253 }, { name: 'DPI - CSW-Madison', id: 122 },
    { name: 'DPI Offsite Storage - Eau Claire', id: 287 }, { name: 'DSM FIRST CHOICE', id: 243 }, { name: 'DSM FIRST CHOICE - Caledonia', id: 324 },
    { name: 'DSM FOOD SPECIALTIES USA, INC. (EN)', id: 66 }, { name: 'DSM FOOD SPECIALTIES, USA', id: 67 }, { name: 'DSM First Choice - CSW-Madison', id: 325 },
    { name: 'DSM PACKAGING', id: 64 }, { name: 'DSM-Firmenich Canada Inc - Eau Claire', id: 265 }, { name: 'Dairy Products Inc. - CSW-Madison', id: 101 },
    { name: 'Darigold - Cooler - CSW-Madison', id: 222 }, { name: 'Darigold - Frozen - CSW-Madison', id: 110 }, { name: "Disabled Palermo's Pizza", id: 273 },
    { name: 'Echo Lakes Foods Inc- KENOSHA', id: 128 }, { name: 'FAIR OAKS FARMS', id: 60 }, { name: 'FAIR OAKS FARMS WEST', id: 61 },
    { name: 'FLOUR POWER FOODS LLC', id: 327 }, { name: 'FUTURE FRUIT FARM', id: 150 }, { name: 'Firestone - CSW- Madison', id: 240 },
    { name: 'Firestone-CALEDONIA', id: 184 }, { name: 'GOOD FOODS Caledonia project', id: 204 }, { name: 'GOOD FOODS GROUP', id: 56 },
    { name: 'GORDON FOOD SERVICE, INC - XD', id: 59 }, { name: 'GORDON FOOD SERVICE-Caledonia', id: 25 }, { name: 'Graceland Fruit - Wisconsin Rapids', id: 347 },
    { name: "Grassland Sam's - Cooler - CSW-Madison", id: 301 }, { name: 'Grassland WM - Cooler - CSW-Madison', id: 181 }, { name: 'Grassland WM - Frozen - CSW-Madison', id: 65 },
    { name: 'Greater Green Bay Foundation', id: 288 }, { name: 'HAPPI FOODI', id: 211 }, { name: 'Home City Ice - CSW-Madison', id: 173 },
    { name: 'Hoogwegt - CSW-Madison', id: 138 }, { name: 'Infinity Beverages - Eau Claire', id: 257 }, { name: 'JELLY BELLY CANDY COMPANY', id: 45 },
    { name: 'JENNIE-O Caledonia', id: 134 }, { name: 'Jennie-O Turkey Store, Inc - Eau Claire', id: 248 }, { name: 'Jones Dairy Farm - CSW-Madison', id: 365 },
    { name: "Kaufhold's Kurds - Wisconsin Rapids", id: 318 }, { name: "Kemp's - CSW-Madison", id: 205 }, { name: 'Kenover/Kayco - CSW-Madison', id: 165 },
    { name: 'Kerry - CSW-Madison', id: 293 }, { name: 'Kraft - Butter - CSW-Madison', id: 119 }, { name: 'Kraft - Dry - CSW-Madison', id: 132 },
    { name: 'LaGrander - Wisconsin Rapids', id: 317 }, { name: "LaGrander's Hillside Dairy - Eau Claire", id: 359 }, { name: 'Lactalis - CSW-Madison', id: 199 },
    { name: 'Lakeside AWG', id: 24 }, { name: 'Lakeside Bulk - Wisconsin Rapids', id: 314 }, { name: 'Lakeside Bulk- Madison', id: 106 },
    { name: 'Lakeside Foods, Inc. - Bulk Eau Claire', id: 258 }, { name: 'Leinenkugel J Brewing Co. - Eau Claire', id: 283 }, { name: "MAMA BEV'S Caledonia", id: 167 },
    { name: 'MEIJER- Kenosha', id: 116 }, { name: 'Mark Anthony Brewing Inc. - Eau Claire', id: 260 }, { name: 'McCain Foods - Wisconsin Rapids', id: 315 },
    { name: 'McCain Foods FG - Wisconsin Rapids', id: 316 }, { name: 'Meijer- CALEDONIA', id: 19 }, { name: 'Milwaukee Pretzel', id: 252 },
    { name: 'Minocqua Brewing - CSW-Madison', id: 198 }, { name: 'MolsonCoors - CSW-Madison', id: 193 }, { name: "Mom's Meals - CSW-Madison", id: 163 },
    { name: 'NEXT PHASE / FSBx LLC', id: 251 }, { name: 'National Food Group - Eau Claire', id: 264 }, { name: 'Nestle Food Co - Eau Claire', id: 270 },
    { name: 'Next Phase/FSBx LLC - COOLER YELLOWSTONE', id: 268 }, { name: 'Nortera - Bulk - CSW-Madison', id: 124 }, { name: 'Nortera - Finished - CSW-Madison', id: 171 },
    { name: 'Nortera Foods Bulk - Eau Claire', id: 286 }, { name: 'Nortera Foods- CALEDONIA', id: 125 }, { name: 'North Pasture Farms/VDL Grassfed - Eau Claire', id: 271 },
    { name: 'Northern Pelagic-CALEDONIA', id: 149 }, { name: 'Northern Pride - Caledonia', id: 20 }, { name: 'Northstar Bison LLC - Eau Claire', id: 266 },
    { name: 'Novonesis - Dry - CSW-Madison', id: 89 }, { name: 'Novonesis - Frozen - CSW-Madison', id: 303 }, { name: 'O&H - CSW-Madison', id: 285 },
    { name: 'O&H -Caledonia', id: 13 }, { name: 'O&H DANISH BAKERY, INC', id: 153 }, { name: 'OCEAN SPRAY/KENOSHA', id: 55 },
    { name: 'Ocean Spray - CSW-Madison', id: 162 }, { name: 'Olympia Foods - Madison', id: 349 }, { name: 'OmniFoods - CSW-Madison', id: 237 },
    { name: "Owl's Brew - CSW- Madison", id: 305 }, { name: "PALERMO'S KENOSHA FINISHED", id: 140 }, { name: 'PERFORMANCE FOOD SERVICE', id: 311 },
    { name: 'POPCORN FACTORY  Kenosha', id: 53 }, { name: "Palermo's Caledonia DSD", id: 250 }, { name: "Palermo's KENOSHA raw materials", id: 141 },
    { name: "Palermo's Kenosha DSD", id: 247 }, { name: "Palermo's Madison", id: 36 }, { name: "Palermo's Pizza - Eau Claire", id: 274 },
    { name: 'Palermos CALEDONIA finished', id: 5 }, { name: 'Palermos CALEDONIA materials bulk', id: 8 }, { name: 'Pedone Pinsa', id: 357 },
    { name: 'Perishable Distribution - Eau Claire', id: 296 }, { name: 'Perrigo Co / Perrigo Wisconsin LLC - Eau Claire', id: 269 }, { name: 'Pork King - CSW-Madison', id: 313 },
    { name: 'Pretzilla - CSW-Madison', id: 297 }, { name: 'Pretzilla - Dry - CSW-Madison', id: 336 }, { name: 'Pretzilla COOLER Caledonia', id: 145 },
    { name: 'Pretzilla COOLER Kenosha', id: 342 }, { name: 'Pretzilla FROZEN Caledonia', id: 28 }, { name: 'Pretzilla Kenosha', id: 230 },
    { name: 'Prime International - CSW-Madison', id: 352 }, { name: 'Proactive Sales - Eau Claire', id: 275 }, { name: 'RACINE / KENOSHA COMM ACTION AGENCY', id: 48 },
    { name: 'RACINE DANISH KRINGLES', id: 225 }, { name: 'RANA MEAL SOLUTIONS KENOSHA', id: 34 }, { name: 'RICHELIEU KENOSHA', id: 219 },
    { name: 'RICHELIEU RAW MATERIALS KENOSHA', id: 224 }, { name: 'ROUNDYS / KROGER', id: 14 }, { name: 'ROUNDYS/KROGER-KENOSHA', id: 284 },
    { name: 'Rana - Cooler - CSW-Madison', id: 221 }, { name: 'Rana - Frozen - CSW-Madison', id: 197 }, { name: 'Rana-CALEDONIA', id: 170 },
    { name: "Rao's Specialty Foods, Inc", id: 246 }, { name: "Rao's Specialty Foods, Inc CALEDONIA", id: 267 }, { name: 'Real Good Foods', id: 238 },
    { name: 'Rhodes - CSW-Madison', id: 335 }, { name: 'Richelieu - Dry - CSW-Madison', id: 233 }, { name: 'Richelieu - Finished Goods - CSW-Madison', id: 217 },
    { name: 'Richelieu - Raw - CSW-Madison', id: 223 }, { name: 'Richelieu CALEDONIA', id: 218 }, { name: 'Rise Baking Co. - Best Maid Cookie - Eau Claire', id: 263 },
    { name: 'Rise Baking Co. - BestMaid Cookie - CSW-Madison', id: 302 }, { name: 'SASTA BAZAAR INC.', id: 31 }, { name: 'SPF North America, Inc. - Eau Claire', id: 261 },
    { name: 'SPL - CSW-Madison', id: 363 }, { name: 'SSF FOOD DISTRIBUTION', id: 241 }, { name: 'STOCK HOUSE BREWING CO.', id: 192 },
    { name: 'Saputo Cheese - CSW - Franksville', id: 290 }, { name: 'Saputo Cheese - CSW - Kenosha', id: 289 }, { name: 'Saputo Cheese - CSW-Madison', id: 73 },
    { name: 'Saputo Cheese USA - CSW - Eau Claire', id: 276 }, { name: 'Saputo Finished Goods - CSW-Madison', id: 220 }, { name: 'Sargento Cheese Inc-Caledonia', id: 234 },
    { name: 'Sargento Cheese Inc. - Kenosha', id: 231 }, { name: 'Shorr Packaging Corp. - Kenosha', id: 337 }, { name: 'Solaris-Global - CSW-Madison', id: 139 },
    { name: 'Spindrift - CSW-Madison', id: 206 }, { name: 'Spring Hill Family Farm - Eau Claire', id: 278 }, { name: "Stella & Chewy's - Madison", id: 154 },
    { name: "Stella & Chewy's CALEDONIA", id: 10 }, { name: 'Strauss Brands-KENOSHA', id: 58 }, { name: 'THE SHANTY RESTAURANT', id: 49 },
    { name: 'The GOOD COMPANY', id: 62 }, { name: 'The Good Company-Caledonia', id: 307 }, { name: 'The Honest Bison - CSW-Eau Claire', id: 354 },
    { name: 'Third Generation Food Company - Eau Claire', id: 279 }, { name: 'Thomas Foods - Kenosha', id: 345 }, { name: 'Tribe 9 Foods-CSW-Madison', id: 322 },
    { name: 'UNFI Caledonia', id: 194 }, { name: 'Upper Cut Brands - CSW-Madison', id: 364 }, { name: 'Vans Kitchen - CSW-Madison', id: 236 },
    { name: 'Whitebridge Pet - CSW-Madison', id: 123 }, { name: 'Wisconsin Brewing Company - CSW-Madison', id: 152 }, { name: 'ifiGOURMET', id: 57 },
  ],
  dock_doors: [
    { name: '.Dock 8 -- Inbounds', id: 43379 }, { name: '.Dock 8 -- Outbounds', id: 43386 }, { name: '.East Dock -- Inbound', id: 43393 },
    { name: '.East Dock -- Outbound', id: 43394 }, { name: '.West Dock -- Inbound', id: 43399 }, { name: '.West Dock -- Outbound', id: 43400 },
    { name: 'C3 - Inbound Schedule', id: 47663 }, { name: 'C3 - Outbound Schedule', id: 47664 }, { name: 'C3 Door 01', id: 47665 },
    { name: 'C3 Door 02', id: 47667 }, { name: 'C3 Door 03', id: 47669 }, { name: 'C3 Door 04', id: 47672 },
    { name: 'C3 Door 05', id: 47674 }, { name: 'C3 Door 06', id: 47676 }, { name: 'C3 Door 07', id: 47678 },
    { name: 'C3 Door 08', id: 47680 }, { name: 'C3 Door 09', id: 47682 }, { name: 'C3 Door 10', id: 47684 },
    { name: 'C3 Door 11', id: 47686 }, { name: 'C3 Door 12', id: 47688 }, { name: 'C3 Door 13', id: 47690 },
    { name: 'C3 Door 14', id: 47692 }, { name: 'C3 Door 15', id: 47694 }, { name: 'C3 Door 16', id: 47696 },
    { name: 'C3 Door 17', id: 47698 }, { name: 'C3 Door 18', id: 47700 }, { name: 'C3 Door 19', id: 47702 },
    { name: 'C3 Door 20', id: 47704 }, { name: 'DPI Dry', id: 43491 }, { name: 'Dock Door 1', id: 6346 },
    { name: 'Dock Door 2', id: 6347 }, { name: 'Dock Door 3', id: 6348 }, { name: 'Dock Door 4', id: 6349 },
    { name: 'Dock Door 5', id: 6350 }, { name: 'Dock Door 6', id: 6351 }, { name: 'Dock Door 7', id: 6352 },
    { name: 'Dock Door 8', id: 6353 }, { name: 'Dock Door 9', id: 6354 }, { name: 'Dock Door 10', id: 6355 },
    { name: 'Dock Door 11', id: 43370 }, { name: 'Dock Door 12', id: 43364 }, { name: 'Dock Door 13', id: 43365 },
    { name: 'Dock Door 14', id: 43366 }, { name: 'Dock Door 15', id: 43367 }, { name: 'Dock Door 16', id: 43368 },
    { name: 'Dock Door 17', id: 43369 }, { name: 'Dock Door 18', id: 46125 }, { name: 'Dock Door 19', id: 46127 },
    { name: 'Dock Door 20', id: 72541 }, { name: 'Dock Door 21', id: 72543 }, { name: 'Dock Door 22', id: 72545 },
    { name: 'Dock Door 23', id: 72547 }, { name: 'Dock Door 24', id: 72549 }, { name: 'Dock Door 25', id: 72551 },
    { name: 'Dock Door 26', id: 72553 }, { name: 'Dock Door 27', id: 72555 }, { name: 'Dock Door 28', id: 72557 },
    { name: 'Dock Door 29', id: 72559 }, { name: 'Dock Door 30', id: 72561 }, { name: 'Dock Door 31', id: 72563 },
    { name: 'Dock Door 32', id: 72565 }, { name: 'Door 01', id: 40450 }, { name: 'Door 01-', id: 29671 },
    { name: 'Door 02', id: 40452 }, { name: 'Door 03', id: 40453 }, { name: 'Door 04', id: 40454 },
    { name: 'Door 05', id: 40455 }, { name: 'Door 06', id: 40456 }, { name: 'Door 07', id: 40457 },
    { name: 'Door 12-', id: 43391 }, { name: 'Door 13-', id: 43380 }, { name: 'Door 14-', id: 43382 },
    { name: 'Door 15-', id: 43383 }, { name: 'Door 16-', id: 43384 }, { name: 'Door 17-', id: 43385 },
    { name: 'Door 18-', id: 43395 }, { name: 'Door 19-', id: 43396 }, { name: 'Door 20-', id: 43397 },
    { name: 'Door 21-', id: 43398 }, { name: 'Fair Oaks Outbounds', id: 30024 }, { name: 'Inbounds', id: 40434 },
    { name: 'LD003A', id: 18836 }, { name: 'LD004A', id: 18838 }, { name: 'LD005A', id: 18840 },
    { name: 'LD006A', id: 18842 }, { name: 'LD007A', id: 18844 }, { name: 'LD008A', id: 18846 },
    { name: 'LD009A', id: 18848 }, { name: 'LD010A', id: 18850 }, { name: 'LD011A', id: 18852 },
    { name: 'LD012A', id: 18854 }, { name: 'LD013A', id: 18856 }, { name: 'LD014A', id: 18858 },
    { name: 'LD015A', id: 18860 }, { name: 'LD016A', id: 18862 }, { name: 'LD017A', id: 18864 },
    { name: 'LD018A', id: 18866 }, { name: 'LD019A', id: 18868 }, { name: 'LD020A', id: 18870 },
    { name: 'LD021A', id: 18872 }, { name: 'LD022A', id: 18874 }, { name: 'LD023A', id: 18876 },
    { name: 'LD024A', id: 18878 }, { name: 'LD025A', id: 40311 }, { name: 'LD026A', id: 40315 },
    { name: 'LD027A', id: 40317 }, { name: 'LD028A', id: 40319 }, { name: 'LD029A', id: 40321 },
    { name: 'LD030A', id: 40323 }, { name: 'LD031A', id: 40325 }, { name: 'LD032A', id: 40327 },
    { name: 'LD033A', id: 40329 }, { name: 'LD034A', id: 40331 }, { name: 'LD035A', id: 40333 },
    { name: 'LD036A', id: 40335 }, { name: 'Loading Dock', id: 40441 }, { name: 'Misc Inbounds', id: 43375 },
    { name: 'Misc. Outbound', id: 30028 }, { name: 'OUTBOUND PALERMO', id: 47465 }, { name: 'Outbounds', id: 40435 },
    { name: "Palermo's / Richelieu Inbound (PO's)", id: 46129 }, { name: "Palermo's DSD, TO's", id: 30027 }, { name: 'Radford Appt', id: 43401 },
    { name: 'Richelieu Outbound', id: 30025 }, { name: 'Saputo Outbound', id: 40437 }, { name: 'Scedule 1', id: 43486 },
    { name: 'Scedule 2', id: 43487 }, { name: 'Scedule 3', id: 43488 }, { name: 'Scedule 4', id: 43489 },
    { name: 'Work ins', id: 43490 }, { name: "Z Palermo's Outbound FTL", id: 30026 },
  ],
  // Top carriers by appointment count (last 6 months), sourced 2026-04-11.
  carriers: [
    { name: 'ALLEN LUND', id: 6143 }, { name: 'ARRIVE', id: 237 }, { name: 'BERNATELLOS', id: 14206 },
    { name: 'BTI', id: 484 }, { name: 'CALUMET', id: 1055 }, { name: 'CH ROBINSON', id: 3723 },
    { name: 'CHR', id: 11 }, { name: 'CMM', id: 8170 }, { name: 'CPU', id: 811 },
    { name: 'DAVIS TRANS', id: 9338 }, { name: 'ERIC BAUER', id: 15617 }, { name: 'FOF', id: 16587 },
    { name: 'FORTUNE', id: 104 }, { name: 'Geneva Trans', id: 14462 }, { name: 'Good Foods', id: 1042 },
    { name: 'GRASSLAND', id: 1618 }, { name: 'J&J', id: 463 }, { name: 'J&W', id: 17236 },
    { name: 'JKC', id: 17 }, { name: 'K WAY', id: 17339 }, { name: 'Kreilkamp', id: 17224 },
    { name: 'LEONARDS', id: 18688 }, { name: 'LEONARDS EXPRESS', id: 11317 }, { name: 'Litchfield', id: 17343 },
    { name: 'Martin Milk', id: 765 }, { name: 'MEGACORP', id: 8418 }, { name: 'MIDWEST', id: 897 },
    { name: 'MIDWEST CARGO', id: 8766 }, { name: 'MIDWEST CARRIERS', id: 437 }, { name: 'MRS', id: 23 },
    { name: 'MWC', id: 11618 }, { name: 'PALERMOS', id: 289 }, { name: 'PCL', id: 869 },
    { name: 'Perron', id: 1088 }, { name: 'PETERS BROS', id: 12268 }, { name: 'PFG', id: 686 },
    { name: 'POPE', id: 85 }, { name: 'PRIME', id: 307 }, { name: 'ROEHL', id: 143 },
    { name: 'SARGENTO', id: 10194 }, { name: 'SCHILL', id: 17570 }, { name: 'SPARHAWK', id: 576 },
    { name: 'SPOT', id: 6656 }, { name: "STELLA & CHEWY'S", id: 11743 }, { name: 'TQL', id: 703 },
    { name: 'Triple T', id: 4452 }, { name: 'VALLEY COLD', id: 6374 }, { name: 'VETERANS', id: 659 },
    { name: 'WR Transport', id: 16116 }, { name: 'WUETHRICH', id: 710 }, { name: 'XTREME', id: 544 },
  ],
}

function omniProxyUrl() {
  const base = process.env.URL || process.env.DEPLOY_URL || ''
  return `${base}/.netlify/functions/omni-query`
}

// Reads the complete carrier list from Supabase (synced weekly by
// carriers-sync-run.cjs) — see this file's 2026-08-19 header note. Sorted
// by appointment_count DESC (most-used first, matching the old dropdown's
// UX) then name, but NEVER truncated — that's the entire point of this
// table existing. Returns null (not []) on any failure/empty-table
// condition so the caller can tell "no data yet" apart from "genuinely
// zero carriers" and fall through to the live-Omni path.
async function fetchCarriersFromSupabase(withIds) {
  const SUPA_URL = process.env.VITE_SUPABASE_URL
  const SUPA_KEY = process.env.VITE_SUPABASE_ANON_KEY
  if (!SUPA_URL || !SUPA_KEY) return null

  try {
    const supabase = createClient(SUPA_URL, SUPA_KEY)
    const { data, error } = await supabase
      .from('scheduling_carriers')
      .select('carrier_name, carrier_id, appointment_count')
      .order('appointment_count', { ascending: false })
      .order('carrier_name', { ascending: true })
    if (error) {
      console.warn('[scheduling-omni-lookup] scheduling_carriers read failed:', error.message)
      return null
    }
    if (!data || data.length === 0) return null

    if (withIds) {
      return data.map((r) => ({ name: r.carrier_name, id: r.carrier_id }))
    }
    return data.map((r) => r.carrier_name)
  } catch (err) {
    console.warn('[scheduling-omni-lookup] scheduling_carriers read threw:', err.message)
    return null
  }
}

// Proxies through omni-query.cjs instead of calling Omni directly.
async function omniPost(fields, table = TOPIC) {
  const res = await fetch(omniProxyUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { modelId: MODEL_ID, table, fields, limit: 5000 } }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`omni-query [${fields.join(',')}] → ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  return json.rows || []
}

// Returns a sorted deduped string[] of names
async function queryOmni(qualifiedField) {
  const rows = await omniPost([qualifiedField])
  return rows
    .map((row) => {
      for (const v of Object.values(row)) {
        if (v !== null && v !== undefined && v !== '') return String(v).trim()
      }
      return null
    })
    .filter(Boolean)
}

// Returns a sorted deduped [{name, id}] array. Uses value type to distinguish
// ID (integer/numeric) from name (non-numeric string) — key names are
// ignored since Omni returns fully-qualified keys.
async function queryOmniPairs(nameField, idField) {
  const rows = await omniPost([nameField, idField])
  const pairs = []
  for (const row of rows) {
    let name = null
    let id = null

    for (const v of Object.values(row)) {
      if (v === null || v === undefined) continue
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
        if (id === null) id = v
      } else if (typeof v === 'string') {
        const n = Number(v)
        if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
          if (id === null) id = n
        } else if (v.trim()) {
          name = v.trim()
        }
      }
    }

    if (name && id !== null) pairs.push({ name, id })
  }
  const seen = new Set()
  return pairs
    .filter((p) => {
      const key = p.name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

// Top-used carriers from the last `months` months, ranked by appointment
// count. Dedupes carriers sharing a display name with multiple Datex IDs,
// keeping the highest-frequency ID for each name.
async function queryTopCarriers(months = 6, max = 250) {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const res = await fetch(omniProxyUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        modelId: MODEL_ID,
        table: TOPIC,
        fields: [`${TOPIC}.carrier_name`, `${TOPIC}.carrier_id`, `${TOPIC}.count`],
        filters: { [`${TOPIC}.scheduled_arrival`]: { after: cutoffStr } },
        sorts: [{ column_name: `${TOPIC}.count`, sort_descending: true, null_sort: 'OMNI_DEFAULT' }],
        limit: 1000,
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`omni-query top carriers → ${res.status}: ${text.slice(0, 300)}`)
  }

  const json = await res.json()
  const rows = json.rows || []

  const byName = new Map()
  for (const row of rows) {
    let name = null
    let id = null
    let count = 0
    for (const [key, val] of Object.entries(row)) {
      if (val === null || val === undefined) continue
      const lk = key.toLowerCase()
      if (lk.includes('count')) {
        count = typeof val === 'number' ? val : (Number(val) || 0)
      } else if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
        if (id === null) id = val
      } else if (typeof val === 'string') {
        const n = Number(val)
        if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
          if (id === null) id = n
        } else if (val.trim()) {
          name = val.trim()
        }
      }
    }
    if (!name || !id) continue

    const key = name.toLowerCase()
    if (!byName.has(key)) {
      byName.set(key, { name, id, count })
    } else {
      byName.get(key).count += count
    }
  }

  return Array.from(byName.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map(({ name, id }) => ({ name, id }))
}

// Builds owner<->project name pairs using a grouped query (count measure
// forces GROUP BY owner_name + project_name — no row-limit problem).
async function queryOwnerProjectPairs() {
  const rows = await omniPost([`${TOPIC}.owner_name`, `${TOPIC}.project_name`], TOPIC)

  const pairs = []
  const seen = new Set()
  for (const row of rows) {
    let ownerName = null
    let projectName = null
    for (const [key, val] of Object.entries(row)) {
      if (val === null || val === undefined || val === '') continue
      const lk = key.toLowerCase()
      if (lk.includes('owner') && lk.includes('name')) ownerName = String(val).trim()
      else if (lk.includes('project') && lk.includes('name')) projectName = String(val).trim()
    }
    if (ownerName && projectName) {
      const key = `${ownerName.toLowerCase()}:${projectName.toLowerCase()}`
      if (!seen.has(key)) {
        seen.add(key)
        pairs.push({ owner_name: ownerName, project_name: projectName })
      }
    }
  }
  return pairs
}

exports.handler = async (event) => {
  // CDN edge cache: 5-minute TTL for lookup data (carriers, owners,
  // projects, dock doors). These lists change infrequently.
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
  }

  const params = event.queryStringParameters || {}
  const type = params.type
  const withIds = params.with_ids === 'true'
  const warehouse = params.warehouse || null

  // owner_project_map: returns all owner<->project pairs from Datex, used to
  // filter the Project dropdown based on the selected Owner.
  if (type === 'owner_project_map') {
    if (!process.env.OMNI_API_KEY) {
      console.warn('[scheduling-omni-lookup] owner_project_map: OMNI_API_KEY not set')
      return { statusCode: 200, headers, body: JSON.stringify({ values: [] }) }
    }
    try {
      const pairs = await queryOwnerProjectPairs()
      return { statusCode: 200, headers, body: JSON.stringify({ values: pairs }) }
    } catch (err) {
      console.error('[scheduling-omni-lookup] owner_project_map FAILED:', err.message)
      return { statusCode: 200, headers, body: JSON.stringify({ values: [], error: err.message }) }
    }
  }

  const qualifiedField = LOOKUP_CONFIG[type]
  if (!qualifiedField) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown type "${type}". Valid: ${Object.keys(LOOKUP_CONFIG).join(', ')}, owner_project_map` }) }
  }

  // Warehouse-specific dock door request — bypasses Omni entirely for reliability.
  if (type === 'dock_doors' && warehouse) {
    const whPairs = DOCK_DOORS_BY_WAREHOUSE[warehouse]
    if (whPairs) {
      const filtered = whPairs.filter((p) => !DOCK_DOOR_BLOCKLIST.test(p.name))
      const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      if (withIds) {
        return { statusCode: 200, headers, body: JSON.stringify({ type, values: sorted }) }
      }
      const names = sorted.map((p) => p.name)
      return { statusCode: 200, headers, body: JSON.stringify({ type, values: names }) }
    }
    console.warn('[scheduling-omni-lookup] Unknown warehouse for dock_doors filter:', warehouse)
  }

  // Carriers: read the complete list from Supabase first (see this file's
  // 2026-08-19 header note) — this doesn't need OMNI_API_KEY at all, so it
  // runs before that check below. Falls through to the live-Omni paths
  // further down only if the table is empty or unreachable (e.g. before
  // the first weekly sync has ever run).
  if (type === 'carriers') {
    const fromSupabase = await fetchCarriersFromSupabase(withIds)
    if (fromSupabase) {
      return { statusCode: 200, headers, body: JSON.stringify({ type, values: fromSupabase }) }
    }
    console.warn('[scheduling-omni-lookup] scheduling_carriers empty/unreachable — falling back to live Omni')
  }

  function fallbackResponse() {
    let pairs = PAIRS_FALLBACK[type]
    if (!pairs) return null
    if (type === 'dock_doors') {
      pairs = pairs.filter((p) => !DOCK_DOOR_BLOCKLIST.test(p.name))
    }
    if (withIds) {
      return { statusCode: 200, headers, body: JSON.stringify({ type, values: pairs, fallback: true }) }
    }
    const names = pairs.map((p) => p.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return { statusCode: 200, headers, body: JSON.stringify({ type, values: names, fallback: true }) }
  }

  if (!process.env.OMNI_API_KEY) {
    console.warn('[scheduling-omni-lookup] OMNI_API_KEY not configured — using hardcoded fallback for', type)
    return fallbackResponse() ?? { statusCode: 500, headers, body: JSON.stringify({ error: 'OMNI_API_KEY not configured' }) }
  }

  // Top-used carriers: date-filtered (last 6 months), frequency-ranked, max 250.
  if (type === 'carriers' && params.top_used === 'true') {
    try {
      const topCarriers = await queryTopCarriers(6, 250)
      if (topCarriers.length > 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ type, values: topCarriers }) }
      }
      console.warn('[scheduling-omni-lookup] queryTopCarriers returned empty — falling through to full list')
    } catch (err) {
      console.warn('[scheduling-omni-lookup] queryTopCarriers failed:', err.message, '— falling through to full list')
    }
  }

  // with_ids=true: return [{name, id}] for types that have ID fields.
  if (withIds && ID_CONFIG[type]) {
    try {
      let pairs = await queryOmniPairs(qualifiedField, ID_CONFIG[type])
      if (type === 'dock_doors') {
        pairs = pairs.filter((p) => !DOCK_DOOR_BLOCKLIST.test(p.name))
      }
      if (pairs.length > 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ type, values: pairs }) }
      }
      console.warn('[scheduling-omni-lookup] queryOmniPairs returned empty for', type, '— trying names-only')
    } catch (err) {
      console.warn('[scheduling-omni-lookup] queryOmniPairs threw for', type, '—', err.message, '— trying names-only')
    }
  }

  // Names-only path (default, and fallback from failed/empty pairs)
  try {
    let values = await queryOmni(qualifiedField)
    if (type === 'dock_doors') {
      values = values.filter((v) => !DOCK_DOOR_BLOCKLIST.test(v))
    }
    if (values.length === 0 && PAIRS_FALLBACK[type]) {
      console.warn('[scheduling-omni-lookup] queryOmni returned empty for', type, '— using hardcoded fallback')
      return fallbackResponse()
    }
    const sorted = [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return { statusCode: 200, headers, body: JSON.stringify({ type, values: sorted }) }
  } catch (err) {
    console.error('[scheduling-omni-lookup] queryOmni threw for', type, '—', err.message, '— using hardcoded fallback')
    return fallbackResponse() ?? { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
