// RECONSTRUCTED 2026-11-10 (Dan Fritsch) -- this file, along with
// learned-owner.ts and datex-lookup.ts, was wiped from the live
// scheduling-agent-webhook Edge Function by an accidental placeholder-content
// deploy (all 4 files replaced with the literal string "PLACEHOLDER").
// Supabase exposes no version history/rollback for Edge Functions and this
// function's source was never committed to the CSW-WI GitHub repo, so the
// original bytes are not recoverable. This is a from-scratch rebuild based on:
//  - the exact exported names/signatures index.ts imports and calls
//  - every call site in index.ts showing inputs/outputs expected
//  - the Notion "CSW-WI Architecture > Scheduling" page's documented
//    behavior for the 2026-10-18/10-21 sender-default features (v35/v37)
// It has NOT been diffed against the original byte-for-byte -- treat it as a
// faithful behavioral reconstruction, not a recovered original, and watch
// agent_field_accuracy / CSR corrections closely for a few days after deploy.

export type SenderDefault = { value: string; count: number; total: number }
export type SenderDefaults = {
  owner?: SenderDefault
  carrier?: SenderDefault
  dockDoor?: SenderDefault
}

const SENDER_DEFAULT_MIN_ROWS = 3
const SENDER_DEFAULT_MIN_SHARE = 0.9

// Case/period/whitespace-insensitive comparison key, used throughout
// index.ts (owner/carrier/dock-door agreement checks) as well as here.
export function normKey(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function computeFieldDefault(values: Array<string | null | undefined>, opts?: { ignoreDotPlaceholder?: boolean }): SenderDefault | undefined {
  const counts = new Map<string, { original: string; count: number }>()
  let total = 0
  for (const raw of values) {
    if (!raw) continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (opts?.ignoreDotPlaceholder && trimmed === '.') continue
    total++
    const key = normKey(trimmed)
    const hit = counts.get(key)
    if (hit) hit.count++
    else counts.set(key, { original: trimmed, count: 1 })
  }
  if (total < SENDER_DEFAULT_MIN_ROWS) return undefined
  let best: { original: string; count: number } | null = null
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v
  }
  if (!best) return undefined
  if (best.count / total < SENDER_DEFAULT_MIN_SHARE) return undefined
  return { value: best.original, count: best.count, total }
}

// rows: agent_field_accuracy rows for one sender_email, selected as
// owner_actual, carrier_actual, dock_door_actual (see index.ts
// fetchSenderDefaults). Returns a default per field only when that sender
// has >= SENDER_DEFAULT_MIN_ROWS approved values and >= 90% of them agree
// (case/period/whitespace-insensitive); the returned value is the CSR's own
// most common spelling, not a normalized form.
export function computeSenderDefaults(rows: Array<{ owner_actual?: string | null; carrier_actual?: string | null; dock_door_actual?: string | null }>): SenderDefaults {
  const out: SenderDefaults = {}
  const owner = computeFieldDefault(rows.map((r) => r.owner_actual))
  if (owner) out.owner = owner
  const carrier = computeFieldDefault(rows.map((r) => r.carrier_actual), { ignoreDotPlaceholder: true })
  if (carrier) out.carrier = carrier
  const dockDoor = computeFieldDefault(rows.map((r) => r.dock_door_actual))
  if (dockDoor) out.dockDoor = dockDoor
  return out
}

// Owner: applied right after owner resolution: OVERRIDES whatever
// extraction/alias/fuzzy-matching produced whenever a sender default exists
// (per the Notion doc: "overrides whatever extraction/alias/fuzzy produced").
export function applySenderOwnerDefault(
  currentOwner: string | null,
  def: SenderDefault | undefined,
): { owner: string | null; changed: boolean; llmOwner: string | null } {
  const llmOwner = currentOwner
  if (!def) return { owner: currentOwner, changed: false, llmOwner }
  const changed = normKey(currentOwner) !== normKey(def.value)
  return { owner: def.value, changed, llmOwner }
}

// Carrier: applied AFTER fuzzy matching, never on the Palermo override path
// (index.ts only calls this when !carrierOverride). Keeps the existing
// canonical match if it already agrees with the sender default; otherwise
// uses the default, looking up its Datex carrier_id by normalized name
// against the (already-fetched) carrier list -- id is null if the CSR's own
// spelling isn't found there.
export function applySenderCarrierDefault(
  resolution: { matched: boolean; name: string | null; id: number | null; attempted?: string; bestGuess?: { name: string; score: number } | null },
  def: SenderDefault | undefined,
  carriers: Array<{ carrier_name: string; carrier_id: number }>,
): { resolution: typeof resolution; changed: boolean } {
  if (!def) return { resolution, changed: false }
  if (resolution.matched && resolution.name && normKey(resolution.name) === normKey(def.value)) {
    return { resolution, changed: false }
  }
  const hit = carriers.find((c) => normKey(c.carrier_name) === normKey(def.value))
  const newResolution = {
    matched: true,
    name: def.value,
    id: hit ? hit.carrier_id : null,
  }
  return { resolution: newResolution, changed: true }
}

// Dock Door: FILL-ONLY. Runs after extraction AND the Project/Dock Door map
// lookup; only fills a Dock Door that is still blank, never overrides one
// that's already set. Not applied on the Palermo override path (index.ts
// doesn't call it there either way, since extracted.dockDoor is already set).
export function applySenderDockDoorDefault(
  currentDockDoor: string | null,
  def: SenderDefault | undefined,
): { dockDoor: string | null; changed: boolean } {
  if (currentDockDoor) return { dockDoor: currentDockDoor, changed: false }
  if (!def) return { dockDoor: currentDockDoor, changed: false }
  return { dockDoor: def.value, changed: true }
}

// CSR-facing note appended to the confirmation comment whenever a field was
// filled/overridden from this exact sender's own approval history.
export function formatSenderFillNote(fieldLabel: string, appliedValue: string | null, def: SenderDefault): string {
  return `⚠️ ${fieldLabel} set to "${appliedValue}" from this sender's own history (${def.count} of ${def.total} approved appointments agree) -- please confirm.`
}
