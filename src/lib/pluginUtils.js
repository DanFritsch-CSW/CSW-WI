// Shared pure constants and helper functions for the Plugin views.
// Extracted from front_netlify_datex/src/views/PluginView.jsx (2026-08-03)
// as part of splitting that 125KB file into companion files — these are
// pure/stateless, so pulling them out here avoids duplicating them across
// PluginView.jsx, PluginLoadContainerTab.jsx, and PluginMultiApptTab.jsx.

// Maps Front inbox names (and legacy short codes) → canonical CSW warehouse names
export const WAREHOUSE_MAP = {
  'KEN Appointments': 'CSW-Kenosha',
  'CAL Appointments': 'CSW-Franksville',
  'MAD Appointments': 'CSW-Madison',
  'WR Appointments': 'CSW-Wisconsin Rapids',
  'EC Appointments': 'CSW-Eau Claire',
  KEN: 'CSW-Kenosha',
  CAL: 'CSW-Franksville',
  MAD: 'CSW-Madison',
  WR: 'CSW-Wisconsin Rapids',
  EC: 'CSW-Eau Claire',
}

// Fallback constants — used when OMNI lookup is unavailable
export const WAREHOUSE_FALLBACK = ['CSW-Eau Claire', 'CSW-Franksville', 'CSW-Kenosha', 'CSW-Madison', 'CSW-Wisconsin Rapids']

export const TYPE_FALLBACK = [
  'Inbound',
  'Inbound/Drop',
  'Inbound/Lump',
  'Inbound/Reload',
  'Inbound/Work-In',
  'Outbound',
  'Outbound/Drop',
  'Outbound/Lump',
  'Outbound/Reload',
  'Outbound/Work-In',
]

// Default template for the Front confirmation draft.
export const DEFAULT_DRAFT_TEMPLATE = [
  'Your appointment {{lookup_code}} is confirmed for {{arrival}}',
  '',
  'PICKUP/DELIVERY ADDRESS: {{address}}',
  '',
  'Please note that due to high volume, if your requested time is not available we will confirm the next available appointment to ensure that you receive a confirmation. If the appointment provided will not work, please reach out and we will do our best to find an alternative that fits your needs.',
  '',
  "Please ensure if picking up for Fair Oaks Farms or Palermo's that the driver arrives with two load bars, as Fair Oaks Farms / Palermo's requires them upon check-in. Drivers will not be checked in without the proper equipment for securing the load.",
  '',
  'No reply is necessary, thank you!',
].join('\n')

export const DEFAULT_MULTI_DRAFT_TEMPLATE = [
  'The following appointments have been confirmed:',
  '',
  '{{appointments}}',
  '',
  'PICKUP/DELIVERY ADDRESS: {{address}}',
  '',
  'Please note that due to high volume, if your requested time is not available we will confirm the next available appointment to ensure that you receive a confirmation. If the appointment provided will not work, please reach out and we will do our best to find an alternative that fits your needs.',
  '',
  "Please ensure if picking up for Fair Oaks Farms or Palermo's that the driver arrives with two load bars, as Fair Oaks Farms / Palermo's requires them upon check-in. Drivers will not be checked in without the proper equipment for securing the load.",
  '',
  'No reply is necessary, thank you!',
].join('\n')

// Default customer keyword → abbreviation mapping for appointment codes.
export const DEFAULT_ABBREVIATIONS = [
  { keyword: 'Fair Oaks Farms', abbr: 'FOF' },
  { keyword: 'Richelieu', abbr: 'RICH' },
  { keyword: 'Crown Bakeries', abbr: 'CB' },
  { keyword: 'Pretzilla', abbr: 'PZ' },
  { keyword: 'Echo Lake', abbr: 'ELF' },
  { keyword: 'Miller Baking', abbr: 'PZ' },
  { keyword: 'O&H', abbr: 'OH' },
  { keyword: 'Birchwood', abbr: 'BW' },
  { keyword: 'Calumet', abbr: 'CDM' },
  { keyword: 'DSM Food Specialties', abbr: 'DSM' },
  { keyword: 'ABBVIE', abbr: 'ABBVIE' },
  { keyword: 'Thomas Foods', abbr: 'TF' },
  { keyword: 'Pedone Pinsa', abbr: 'PP' },
  { keyword: 'DDW', abbr: 'DDW' },
  { keyword: 'Palermo', abbr: 'PVI' },
  { keyword: 'Sargento', abbr: 'SARG' },
  { keyword: 'Stella & Chewy', abbr: 'S+C' },
  { keyword: 'Performance Food', abbr: 'PFG' },
  { keyword: 'PFG', abbr: 'PFG' },
  { keyword: 'Brooklyn Brands', abbr: 'BB' },
  { keyword: 'Flour Power', abbr: 'FP' },
]

// Default dock-door auto-select rules.
export const DEFAULT_DOCK_DOOR_RULES = []

// Hour / minute options for the 2-part arrival time picker (24-hour / military time)
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
export const MINUTE_OPTIONS = ['00', '15', '30', '45']

export const EDITABLE_FIELDS = [
  { label: 'Warehouse', key: 'warehouse' },
  { label: 'Type', key: 'type' },
  { label: 'Scheduled Arrival', key: 'scheduled_arrival' },
  { label: 'Scheduled Departure', key: 'scheduled_departure' },
  { label: 'Dock Door', key: 'scheduled_dock_door' },
  { label: 'Carrier', key: 'carrier' },
  { label: 'Reference #', key: 'reference_number' },
  { label: 'Appointment Code', key: 'appointment_lookup_code' },
  { label: 'Owner / Customer', key: 'owner' },
  { label: 'Project', key: 'project' },
  { label: 'Notes', key: 'notes' },
  { label: 'Appt Duration', key: 'appt_duration' },
]

// Required fields for a Datex push (notes intentionally excluded).
export const PUSH_REQUIRED = [
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'type', label: 'Type' },
  { key: 'owner', label: 'Owner' },
  { key: 'project', label: 'Project' },
  { key: 'scheduled_dock_door', label: 'Dock Door' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'reference_number', label: 'Reference #' },
  { key: 'appointment_lookup_code', label: 'Appointment Code' },
]

// Required fields for a Load Container push (same as appointment + container code).
export const LC_PUSH_REQUIRED = [
  { key: 'container_lookup_code', label: 'Container Code' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'type', label: 'Type' },
  { key: 'owner', label: 'Owner' },
  { key: 'project', label: 'Project' },
  { key: 'scheduled_dock_door', label: 'Dock Door' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'reference_number', label: 'Reference #' },
  { key: 'appointment_lookup_code', label: 'Appointment Code' },
]

/** Parse a 24-hour "HH:MM" string into military-time parts. */
export function parseTime24(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return { h24: '', min: '' }
  const [h, m] = timeStr.split(':').map(Number)
  return { h24: String(h).padStart(2, '0'), min: String(m).padStart(2, '0') }
}

/** Combine military-time parts back into a 24-hour "HH:MM" string. */
export function buildTime24(h24Str, minStr) {
  if (!h24Str || !minStr) return null
  return `${String(h24Str).padStart(2, '0')}:${minStr}`
}

/** Returns the abbreviation for a project name, or null if none matches. */
export function findAbbreviation(projectName, abbreviations) {
  if (!projectName || !abbreviations?.length) return null
  const lower = projectName.toLowerCase()
  for (const { keyword, abbr } of abbreviations) {
    if (keyword && abbr && lower.includes(keyword.toLowerCase())) return abbr
  }
  return null
}

/** Returns the dock door name for a matching rule, or null if none matches. */
export function findDockDoorRule(warehouse, project, type, rules) {
  if (!project || !type || !rules?.length) return null
  const warehouseLower = (warehouse ?? '').toLowerCase()
  const projectLower = project.toLowerCase()
  const typeLower = type.toLowerCase()
  for (const rule of rules) {
    if (!rule.project || !rule.type_contains || !rule.dock_door) continue
    if (rule.warehouse && rule.warehouse.toLowerCase() !== warehouseLower) continue
    if (rule.project.toLowerCase() === projectLower && typeLower.includes(rule.type_contains.toLowerCase())) {
      return rule.dock_door
    }
  }
  return null
}

export function normalizeWarehouse(raw) {
  if (!raw) return ''
  return WAREHOUSE_MAP[raw] ?? raw
}

export function validateForPush(draftData) {
  const missing = []
  for (const { key, label } of PUSH_REQUIRED) {
    if (!draftData[key] || !String(draftData[key]).trim()) missing.push(label)
  }
  if (draftData.owner && draftData.owner_datex_id == null) missing.push('Owner (ID not resolved — please re-select from the list)')
  if (draftData.project && draftData.project_datex_id == null) missing.push('Project (ID not resolved — please re-select from the list)')
  const arrival = draftData.scheduled_arrival || ''
  if (!arrival.split('T')[0]) missing.push('Arrival Date')
  if (!arrival.includes('T') || !arrival.split('T')[1]) missing.push('Arrival Time')
  return missing
}

/** Maps the appointment Type string to Datex orderTypeId for the load container payload. */
export function deriveOrderTypeId(type) {
  if (!type) return 1
  return type.toLowerCase().includes('inbound') ? 1 : 2
}

export function validateForLCPush(draftData) {
  const missing = []
  for (const { key, label } of LC_PUSH_REQUIRED) {
    if (!draftData[key] || !String(draftData[key]).trim()) missing.push(label)
  }
  if (draftData.owner && draftData.owner_datex_id == null) missing.push('Owner (ID not resolved — please re-select from the list)')
  if (draftData.project && draftData.project_datex_id == null) missing.push('Project (ID not resolved — please re-select from the list)')
  const arrival = draftData.scheduled_arrival || ''
  if (!arrival.split('T')[0]) missing.push('Arrival Date')
  if (!arrival.includes('T') || !arrival.split('T')[1]) missing.push('Arrival Time')
  return missing
}

// Resolves Datex numeric IDs from name→id maps for owner, project, dock_door, carrier.
export function computeIdEdits(draftData, maps) {
  const ids = {}
  const ownerKey = draftData.owner?.toLowerCase()
  const projectKey = draftData.project?.toLowerCase()
  const dockDoorKey = draftData.scheduled_dock_door?.toLowerCase()
  const carrierKey = draftData.carrier?.toLowerCase()
  if (ownerKey && maps.owners?.[ownerKey] != null) ids.owner_datex_id = maps.owners[ownerKey]
  if (projectKey && maps.projects?.[projectKey] != null) ids.project_datex_id = maps.projects[projectKey]
  if (dockDoorKey && maps.dock_doors?.[dockDoorKey] != null) ids.dock_door_datex_id = maps.dock_doors[dockDoorKey]
  if (carrierKey && maps.carriers?.[carrierKey] != null) ids.carrier_datex_id = maps.carriers[carrierKey]
  return ids
}

export function computeEdits(draftData, sub) {
  if (!sub) return {}
  return EDITABLE_FIELDS.reduce((acc, { key }) => {
    if ((draftData[key] ?? '') !== (sub[key] ?? '')) acc[key] = draftData[key]
    return acc
  }, {})
}

export function buildEmptyDraft(warehouseOptions = WAREHOUSE_FALLBACK, typeOptions = TYPE_FALLBACK) {
  return EDITABLE_FIELDS.reduce((acc, { key }) => {
    acc[key] = key === 'warehouse' ? warehouseOptions[0] ?? '' : key === 'type' ? typeOptions[0] ?? '' : key === 'appt_duration' ? '30' : ''
    return acc
  }, {})
}

// Per-slot fields for Multi APPT. owner/project are optional overrides — if
// blank, the shared-level values are used at push time.
export function buildEmptySlot() {
  return {
    scheduled_arrival: '',
    scheduled_dock_door: '',
    carrier: '',
    reference_number: '',
    appointment_lookup_code: '',
    notes: '',
    appt_duration: '30',
    owner: '',
    owner_datex_id: null,
    project: '',
    project_datex_id: null,
  }
}

export function buildDraft(sub) {
  return EDITABLE_FIELDS.reduce((acc, { key }) => {
    const raw = sub[key] ?? ''
    acc[key] = key === 'warehouse' ? normalizeWarehouse(raw) : key === 'appt_duration' ? raw || '30' : raw
    return acc
  }, {})
}

/**
 * Merges shared + slot fields for a single Multi APPT appointment.
 * Slot-level owner/project override shared if set; otherwise shared values
 * are used. Empty string slot values fall back to shared — never send
 * blank to Datex.
 */
export function buildMergedSlot(slot, shared, nameToId) {
  return {
    ...shared,
    ...slot,
    owner: slot.owner || shared.owner,
    project: slot.project || shared.project,
    owner_datex_id: slot.owner ? slot.owner_datex_id : nameToId.owners?.[shared.owner?.toLowerCase()] ?? null,
    project_datex_id: slot.project ? slot.project_datex_id : nameToId.projects?.[shared.project?.toLowerCase()] ?? null,
  }
}
