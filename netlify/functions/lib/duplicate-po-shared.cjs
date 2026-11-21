/**
 * ADDED 2026-11-21 (Dan Fritsch, cnv_1cyh4jmc) -- duplicate-PO safeguard for
 * the Sam Rohde / Daren Peet (Palermo's) auto-push path.
 *
 * Problem: Sam's follow-up/move emails land in a NEW Front conversation, and
 * every existing duplicate check is per-conversation, so the agent pushed a
 * second Datex appointment for a PO that was already scheduled (6 POs
 * double-pushed 10/26-11/20, e.g. 505048 -> appts 386875 + 388498).
 *
 * Rule: if the PO already has a pending/processing/approved submission in the
 * same warehouse from a DIFFERENT conversation, do NOT auto-push or send the
 * carrier confirmation; leave the thread open for a CSR.
 *
 * Pure logic only (no network) so it can be unit-tested. KEEP IN SYNC with
 * supabase/functions/scheduling-agent-webhook/duplicate-po.ts (TS port used by
 * the Edge Function -- Deno can't import this CJS file).
 */

const DUP_PO_WINDOW_DAYS = 30
const DUP_PO_STATUSES = ['pending', 'processing', 'approved']

// "TO505048", "TO_505048", "1164489 (0124940375)", "49642477,2000010980",
// "PSH0099090 / 044923846" -> distinct comparable tokens. Tokens need at
// least 4 digits so generic references ("PZ COSTCO HOLD") never match.
function poTokens(ref) {
  if (!ref) return []
  const out = new Set()
  for (const raw of String(ref).split(/[\s,;/()|]+/)) {
    let t = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!t) continue
    t = t.replace(/^TO(?=\d)/, '')
    if ((t.match(/\d/g) || []).length < 4) continue
    out.add(t)
  }
  return Array.from(out)
}

function baseConversationId(id) {
  return id ? String(id).split('::')[0] : ''
}

function isCandidateStatus(s) {
  return DUP_PO_STATUSES.includes(s)
}

// Rows already fetched for the warehouse -> the existing scheduled
// submission this one would duplicate, or null. Prefers an already-pushed
// (datex_appointment_id) match, then the oldest.
function findDuplicateScheduledPo(rows, { poRefs, conversationId, selfId }) {
  const mine = new Set((poRefs || []).flatMap((r) => poTokens(r)))
  if (mine.size === 0) return null
  const myConv = baseConversationId(conversationId)
  const hits = []
  for (const r of rows || []) {
    if (selfId && r.id === selfId) continue
    if (!isCandidateStatus(r.status)) continue
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

// Push-time tiebreak for two emails seconds apart (neither saw the other at
// intake): block only if the other submission is already pushed/approved, or
// is older (created_at, then id). The oldest one goes through.
function shouldBlockAtPush(mine, other) {
  if (other.status === 'approved' || other.datex_appointment_id != null) return true
  const a = String(other.created_at)
  const b = String(mine.created_at)
  if (a !== b) return a < b
  return String(other.id) < String(mine.id)
}

function describeExisting(dup) {
  const where = dup.datex_appointment_id != null
    ? `Datex appointment ${dup.datex_appointment_id}`
    : `an earlier ${dup.status} submission`
  const when = dup.scheduled_arrival ? ` for ${String(dup.scheduled_arrival).replace('T', ' ').slice(0, 16)}` : ''
  const conv = dup.front_conversation_id ? ` (thread ${baseConversationId(dup.front_conversation_id)})` : ''
  return `${where}${when}${conv}`
}

module.exports = {
  DUP_PO_WINDOW_DAYS,
  DUP_PO_STATUSES,
  poTokens,
  baseConversationId,
  findDuplicateScheduledPo,
  shouldBlockAtPush,
  describeExisting,
}
