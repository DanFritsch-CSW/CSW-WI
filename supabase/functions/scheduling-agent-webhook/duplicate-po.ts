// ADDED 2026-11-21 (Dan Fritsch, cnv_1cyh4jmc) -- duplicate-PO safeguard for
// the Sam Rohde / Daren Peet (Palermo's) auto-push path.
//
// Sam's follow-up/move emails land in a NEW Front conversation, and every
// existing duplicate check is per-conversation, so the agent pushed a second
// Datex appointment for a PO that was already scheduled (6 POs double-pushed
// 10/26-11/20, e.g. 505048 -> appts 386875 + 388498).
//
// Rule: if the PO already has a pending/processing/approved submission in the
// same warehouse from a DIFFERENT conversation, do NOT auto-push or send the
// carrier confirmation; leave the thread open for a CSR.
//
// Pure logic only (no network). KEEP IN SYNC with
// netlify/functions/lib/duplicate-po-shared.cjs (CJS twin used by the push
// function -- Deno can't import it).

export const DUP_PO_WINDOW_DAYS = 30
export const DUP_PO_STATUSES = ['pending', 'processing', 'approved']

export type DupCandidateRow = {
  id: string
  created_at: string
  status: string
  reference_number: string | null
  front_conversation_id: string | null
  scheduled_arrival: string | null
  datex_appointment_id: number | null
}

export type DuplicatePo = DupCandidateRow & { matchedPo: string }

// "TO505048", "TO_505048", "1164489 (0124940375)", "49642477,2000010980",
// "PSH0099090 / 044923846" -> distinct comparable tokens. Tokens need at
// least 4 digits so generic references ("PZ COSTCO HOLD") never match.
export function poTokens(ref: string | null | undefined): string[] {
  if (!ref) return []
  const out = new Set<string>()
  for (const raw of String(ref).split(/[\s,;/()|]+/)) {
    let t = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!t) continue
    t = t.replace(/^TO(?=\d)/, '')
    if ((t.match(/\d/g) || []).length < 4) continue
    out.add(t)
  }
  return Array.from(out)
}

export function baseConversationId(id: string | null | undefined): string {
  return id ? String(id).split('::')[0] : ''
}

// Rows already fetched for the warehouse -> the existing scheduled
// submission this one would duplicate, or null. Prefers an already-pushed
// (datex_appointment_id) match, then the oldest.
export function findDuplicateScheduledPo(
  rows: DupCandidateRow[] | null | undefined,
  opts: { poRefs: Array<string | null | undefined>; conversationId: string; selfId?: string | null },
): DuplicatePo | null {
  const mine = new Set((opts.poRefs || []).flatMap((r) => poTokens(r)))
  if (mine.size === 0) return null
  const myConv = baseConversationId(opts.conversationId)
  const hits: Array<{ row: DupCandidateRow; shared: string[] }> = []
  for (const r of rows || []) {
    if (opts.selfId && r.id === opts.selfId) continue
    if (!DUP_PO_STATUSES.includes(r.status)) continue
    if (myConv && baseConversationId(r.front_conversation_id) === myConv) continue
    const shared = poTokens(r.reference_number).filter((t) => mine.has(t))
    if (shared.length === 0) continue
    hits.push({ row: r, shared })
  }
  if (hits.length === 0) return null
  hits.sort((a, b) => {
    const ap = a.row.datex_appointment_id != null ? 0 : 1
    const bp = b.row.datex_appointment_id != null ? 0 : 1
    if (ap !== bp) return ap - bp
    return String(a.row.created_at).localeCompare(String(b.row.created_at))
  })
  return { ...hits[0].row, matchedPo: hits[0].shared[0] }
}

export function describeExisting(dup: DuplicatePo): string {
  const where = dup.datex_appointment_id != null
    ? `Datex appointment ${dup.datex_appointment_id}`
    : `an earlier ${dup.status} submission`
  const when = dup.scheduled_arrival ? ` for ${String(dup.scheduled_arrival).replace('T', ' ').slice(0, 16)}` : ''
  const conv = dup.front_conversation_id ? ` (thread ${baseConversationId(dup.front_conversation_id)})` : ''
  return `${where}${when}${conv}`
}
