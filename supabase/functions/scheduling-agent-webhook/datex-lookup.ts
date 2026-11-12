// RECONSTRUCTED 2026-11-10 (Dan Fritsch) -- see the header comment in
// sender-defaults.ts for why this file had to be rebuilt from scratch rather
// than recovered verbatim (accidental placeholder deploy wiped all 4 files;
// no Supabase version history; not in the GitHub repo). Rebuilt from
// index.ts's exact call sites (lookupDatexOrder) and the Notion Scheduling
// page's "Datex order lookup at intake -- 2026-10-18 (v36)" section. Not
// diffed byte-for-byte against the original -- treat as a faithful
// behavioral reconstruction and watch a few days of ai_appt_intake_log
// datexLookup entries after deploy to confirm it's matching as expected.

export type CandidateResult = { candidate: string; orders: any[]; error?: string }

export type DatexMatch =
  | { status: 'found'; ownerName: string; projectName: string | null; via: string; orders: any[] }
  | { status: 'none' }

const MAX_CANDIDATES = 5

// Reference-looking numbers in the email: the extraction's own PO numbers
// first (most reliable), then tokens in the subject and body, capped at 5
// total, de-duplicated case-insensitively.
export function extractCandidateReferences(subject: string, text: string, appointments: Array<{ poNumber?: string | null }>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | null | undefined) => {
    if (out.length >= MAX_CANDIDATES) return
    if (!raw) return
    const trimmed = raw.trim()
    if (!trimmed) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(trimmed)
  }
  for (const a of appointments || []) push(a?.poNumber)
  const tokenRe = /\b[A-Za-z]{0,4}\d{4,10}\b/g
  for (const src of [subject || '', text || '']) {
    if (out.length >= MAX_CANDIDATES) break
    let m: RegExpExecArray | null
    while (out.length < MAX_CANDIDATES && (m = tokenRe.exec(src))) {
      push(m[0])
    }
  }
  return out.slice(0, MAX_CANDIDATES)
}

// results: one CandidateResult per candidate, each already carrying whatever
// orders the scheduling-order-search lookup (lookup_code / owner_reference /
// vendor_reference against ACTIVE Datex orders) returned for it.
// warehouseShort: e.g. "CAL"/"KEN"/"MAD"/"WR"/"EC" -- orders tagged for a
// DIFFERENT warehouse are ignored; an order with a blank warehouse is kept
// (not every Datex order row carries one). Requires every remaining order to
// share exactly ONE owner (more than one distinct owner = ambiguous = no
// match); the project is returned only if those orders also share one.
export function pickDatexOrder(results: CandidateResult[], warehouseShort: string | null): DatexMatch {
  const allOrders: any[] = []
  for (const r of results) {
    for (const o of r.orders || []) {
      const orderWarehouse = o?.warehouse || o?.warehouse_short || null
      if (orderWarehouse && warehouseShort && orderWarehouse !== warehouseShort) continue
      allOrders.push(o)
    }
  }
  if (allOrders.length === 0) return { status: 'none' }

  const ownerNames = new Set<string>()
  for (const o of allOrders) {
    const name = o?.ownerName || o?.owner_name || o?.owner
    if (name) ownerNames.add(name)
  }
  if (ownerNames.size !== 1) return { status: 'none' }
  const ownerName = Array.from(ownerNames)[0]

  const projectNames = new Set<string>()
  for (const o of allOrders) {
    const name = o?.projectName || o?.project_name || o?.project
    if (name) projectNames.add(name)
  }
  const projectName = projectNames.size === 1 ? Array.from(projectNames)[0] : null

  const via = allOrders[0]?.matchedOn || allOrders[0]?.matched_on || 'reference'

  return { status: 'found', ownerName, projectName, via, orders: allOrders }
}

// Datex order lookup is a secondary signal, not an override of a trusted
// sender/learned default: if the Datex owner agrees with the current owner,
// its project gets applied; if it differs and the caller says the owner is
// already backed by a strong sender/learned default, the Datex owner is
// ignored (conflict just gets logged by the caller, not surfaced here); if
// it differs and there's no such default, the Datex owner (and project)
// replace whatever extraction guessed.
export function applyDatexOrder(
  currentOwner: string | null,
  ownerHasDefault: boolean,
  match: DatexMatch,
): { used: boolean; owner: string | null; project: string | null } {
  if (match.status !== 'found') return { used: false, owner: currentOwner, project: null }
  const agrees = !!currentOwner && currentOwner.toLowerCase().trim() === match.ownerName.toLowerCase().trim()
  if (agrees) return { used: true, owner: currentOwner, project: match.projectName }
  if (ownerHasDefault) return { used: false, owner: currentOwner, project: null }
  return { used: true, owner: match.ownerName, project: match.projectName }
}

// CSR-facing note when a Datex order lookup confirmed or changed Owner/Project.
export function formatDatexNote(match: Extract<DatexMatch, { status: 'found' }>, ownerChanged: boolean, project: string | null): string {
  const orderIds = (match.orders || []).map((o: any) => o?.orderId || o?.order_id).filter(Boolean)
  const orderRef = orderIds.length ? ` (Datex order ${orderIds.join(', ')})` : ''
  const ownerPart = ownerChanged
    ? `Owner set to "${match.ownerName}" from a matching Datex order${orderRef}`
    : `Owner confirmed against a matching Datex order ("${match.ownerName}")${orderRef}`
  const projectPart = project ? `; project set to "${project}"` : ''
  return `ℹ️ ${ownerPart}${projectPart} -- please verify.`
}
