// Fixed B-tier buffer positions for top-moving materials, WR Secondary
// Replenishments tab (added 2026-07-15). Ported verbatim from the standalone
// csw-secondary-replenishment repo's src/constants.js.
// These are standalone overflow slots not tied to P-slot assignments.
// Stays hardcoded -- this is a business decision, not WMS data.
export const SECONDARY_REPL_BUFFER_LOCS = [
  { loc: 'F029B', mat: '61002' },
  { loc: 'F031B', mat: '61002' },
  { loc: 'F033B', mat: '61019' },
  { loc: 'F035B', mat: '61019' },
  { loc: 'F037B', mat: '61003' },
  { loc: 'F039B', mat: '61003' },
  { loc: 'F055B', mat: '61015' },
  { loc: 'F057B', mat: '61015' },
  { loc: 'F069B', mat: '61010' },
  { loc: 'F073B', mat: '61010' },
  { loc: 'F083B', mat: '059' },
  { loc: 'F085B', mat: '059' },
  { loc: 'F087B', mat: '051' },
  { loc: 'F089B', mat: '051' },
  { loc: 'F091B', mat: '056' },
  { loc: 'F093B', mat: '056' },
  { loc: 'F095B', mat: '050' },
  { loc: 'F097B', mat: '050' },
]
