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

// Diagnostic mirror tabs — pull straight from Omni with no App-side computation.
// Used for reconciling App numbers against Omni's dashboard view.
// These do NOT appear in network-level rollups (AllFacilities, est-drops queries)
// — they live only in LaborPlanning's tab strip.
export const DIAGNOSTIC_TABS = [
  { id: 'ken_v2', code: 'KEN v2', name: 'Kenosha (Omni Mirror)', color: '#7da5e6', mirrors: 'ken' },
]

export const LANES = [
  { id: 'shift1', label: '1st Shift' },
  { id: 'mid',    label: 'Mid Shift' },
  { id: 'shift2', label: '2nd Shift' },
  { id: 'shift3', label: '3rd Shift' },
  { id: 'pto',    label: 'PTO'       },
  { id: 'callin', label: 'Call-In'   },
]

// CAL split lanes — 1-2 side and 3.5 side each with 4 shift lanes + shared PTO/Call-In
export const LANES_CAL2 = [
  { id: 'side12_shift1', label: '1-2 · 1st' },
  { id: 'side12_mid',    label: '1-2 · Mid'  },
  { id: 'side12_shift2', label: '1-2 · 2nd'  },
  { id: 'side12_shift3', label: '1-2 · 3rd'  },
  { id: 'side35_shift1', label: '3.5 · 1st'  },
  { id: 'side35_mid',    label: '3.5 · Mid'  },
  { id: 'side35_shift2', label: '3.5 · 2nd'  },
  { id: 'side35_shift3', label: '3.5 · 3rd'  },
  { id: 'pto',           label: 'PTO'         },
  { id: 'callin',        label: 'Call-In'     },
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
