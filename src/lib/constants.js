// CAL v2 split view is now the canonical CAL tab.
// The old single-panel 'cal' view has been removed.
export const FACILITIES = {
  cal: { id: 'cal', code: 'CAL', name: 'Caledonia',        color: '#e07b4d' },
  ken: { id: 'ken', code: 'KEN', name: 'Kenosha',          color: '#3dba7e' },
  wr:  { id: 'wr',  code: 'WR',  name: 'Wisconsin Rapids', color: '#d4b84a' },
  mad: { id: 'mad', code: 'MAD', name: 'Madison',          color: '#4d9de0' },
  ec:  { id: 'ec',  code: 'EC',  name: 'Eau Claire',       color: '#c084fc' },
}

export const FACILITY_LIST = Object.values(FACILITIES)

// No diagnostic tabs active.
export const DIAGNOSTIC_TABS = []

export const LANES = [
  { id: 'shift1',         label: '1st Shift'       },
  { id: 'mid',            label: 'Mid Shift'       },
  { id: 'shift2',         label: '2nd Shift'       },
  { id: 'shift3',         label: '3rd Shift'       },
  { id: 'pto',            label: 'PTO'             },
  { id: 'callin',         label: 'Call-In'         },
  { id: 'specialProject', label: 'Special Project' },
]

// CAL split lanes — 1-2 side and 3.5 side each with 4 shift lanes + shared PTO/Call-In/Special Project
export const LANES_CAL2 = [
  { id: 'side12_shift1',  label: '1-2 · 1st'       },
  { id: 'side12_mid',     label: '1-2 · Mid'        },
  { id: 'side12_shift2',  label: '1-2 · 2nd'        },
  { id: 'side12_shift3',  label: '1-2 · 3rd'        },
  { id: 'side35_shift1',  label: '3.5 · 1st'        },
  { id: 'side35_mid',     label: '3.5 · Mid'        },
  { id: 'side35_shift2',  label: '3.5 · 2nd'        },
  { id: 'side35_shift3',  label: '3.5 · 3rd'        },
  { id: 'pto',            label: 'PTO'              },
  { id: 'callin',         label: 'Call-In'          },
  { id: 'specialProject', label: 'Special Project'  },
]

export const ACTIVE_LANES = ['shift1', 'mid', 'shift2', 'shift3']

export const ACTIVE_LANES_CAL2 = [
  'side12_shift1', 'side12_mid', 'side12_shift2', 'side12_shift3',
  'side35_shift1', 'side35_mid', 'side35_shift2', 'side35_shift3',
]

export const CAL2_DOCK_MAP = {
  // 3.5 side
  'Calvieon Howard':           'side35_shift1',
  'Ethan Lindsey':             'side35_shift1',
  'Jose Cuevas':               'side35_shift1',
  'Nicholas J. Free':          'side35_shift1',
  'Zarious Brinner':           'side35_shift1',
  'Juan Bido':                 'side35_shift1',
  'Eduardo Ramon':             'side35_shift1',
  'Eduardo Ramon, III':        'side35_shift1',
  // 1-2 side (explicit)
  'Austin Berger':             'side12_shift1',
  'Karelys Vega-Cartagena':    'side12_shift1',
  'Karelys N. Vega-Cartagena': 'side12_shift1',
}

// Priority customers/carriers for the Pre-Picked Order Status feature
// (Madison Daily view, added 2026-07-12). Matching orders are pinned to
// the top of the list regardless of sort mode. Edit freely — no other
// code changes needed to add/remove names.
export const PRIORITY_CUSTOMERS = ['Walmart']

// Facility-wide OT button (Madison, added 2026-07-16). When OT is called
// for the day, every active-lane employee gets an extra N hours added to
// their shift — but which side of the shift it's added to depends on the
// lane, so shifts extend AWAY from the changeover gap instead of everyone
// just clocking in later:
//   shift1 (1st) / mid  → extend the END   (stay later)
//   shift2 (2nd) / shift3 (3rd) → extend the START (come in earlier)
// Matches Dan's examples: 1st 6:00–2:30 → 6:00–3:30 (end +1h), 2nd
// 1:30–10:00 → 12:30–10:00 (start −1h). Mid follows the 1st-shift pattern
// per Dan (8:00–4:30 → 8:00–5:30, once Mid launches at MAD) — MAD doesn't
// have a 3rd shift yet, so the 'start' direction for shift3 is inferred
// from the 2nd-shift pattern and should be confirmed once one exists.
export const OT_LANE_DIRECTION = {
  shift1: 'end',
  mid:    'end',
  shift2: 'start',
  shift3: 'start',
}
