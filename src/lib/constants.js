export const FACILITIES = {
  cal: { id: 'cal', code: 'CAL', name: 'Caledonia',         color: '#e07b4d' },
  mad: { id: 'mad', code: 'MAD', name: 'Madison',           color: '#4d9de0' },
  ken: { id: 'ken', code: 'KEN', name: 'Kenosha',           color: '#3dba7e' },
  wr:  { id: 'wr',  code: 'WR',  name: 'Wisconsin Rapids',  color: '#d4b84a' },
  ec:  { id: 'ec',  code: 'EC',  name: 'Eau Claire',        color: '#c084fc' },
}

export const FACILITY_LIST = Object.values(FACILITIES)

export const LANES = [
  { id: 'shift1', label: '1st Shift' },
  { id: 'mid',    label: 'Mid Shift' },
  { id: 'shift2', label: '2nd Shift' },
  { id: 'shift3', label: '3rd Shift' },
  { id: 'pto',    label: 'PTO'       },
  { id: 'callin', label: 'Call-In'   },
]

export const ACTIVE_LANES = ['shift1', 'mid', 'shift2', 'shift3']
