// RECONSTRUCTED 2026-11-10 (Dan Fritsch) -- see the header comment in
// sender-defaults.ts for why this file had to be rebuilt from scratch rather
// than recovered verbatim (accidental placeholder deploy wiped all 4 files;
// no Supabase version history; not in the GitHub repo). Rebuilt from
// index.ts's exact call sites (fetchOwnerModel / predictOwnerForAppointments)
// and the Notion Scheduling page's "CURRENT STATE -- facility-scoped learned
// Owner (2026-10-30 ... v49)" section. Not diffed byte-for-byte against the
// original -- treat as a faithful behavioral reconstruction and watch
// agent_field_accuracy corrections closely for a few days after deploy.

export const LEARNED_WINDOW_DAYS = 90
const LEARNED_MIN_ROWS = 3
const LEARNED_MIN_SHARE = 0.9
const GENERIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com', 'comcast.net',
])

function normOwnerKey(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()
}

// "first run of 4 digits + total digit count, e.g. 1161|17" -- a shape key
// for a reference number, used as a core signal independent of the exact
// digits (so TO481758 and TO481801 share a shape even though the numbers
// themselves differ).
function shapeKey(reference: string | null | undefined): string | null {
  if (!reference) return null
  const digitsOnly = reference.replace(/\D/g, '')
  if (!digitsOnly) return null
  const firstFour = digitsOnly.slice(0, 4)
  return `${firstFour}|${digitsOnly.length}`
}

function emailDomain(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null
  return email.split('@')[1]?.toLowerCase() || null
}

// Very small, cheap token extraction from the Notes field for the
// (off-by-default) notes fallback tier -- ship-to / item-code-looking
// alphanumeric tokens of 4+ characters.
function noteTokens(notes: string | null | undefined): string[] {
  if (!notes) return []
  const matches = notes.match(/\b[A-Za-z0-9][A-Za-z0-9-]{3,}\b/g)
  return matches ? Array.from(new Set(matches.map((t) => t.toUpperCase()))) : []
}

type OwnerVotes = Map<string, { owner: string; count: number }>
type IndexedBucket = Map<string, OwnerVotes>

export type OwnerModel = {
  bySender: IndexedBucket
  byShape: IndexedBucket
  byDomain: IndexedBucket
  byNoteToken: IndexedBucket
  totalRows: number
}

function vote(bucket: IndexedBucket, key: string | null, owner: string | null) {
  if (!key || !owner) return
  let votes = bucket.get(key)
  if (!votes) { votes = new Map(); bucket.set(key, votes) }
  const ownerKey = normOwnerKey(owner)
  const hit = votes.get(ownerKey)
  if (hit) hit.count++
  else votes.set(ownerKey, { owner, count: 1 })
}

function resolveSignal(bucket: IndexedBucket, key: string | null): { owner: string; count: number; total: number } | null {
  if (!key) return null
  const votes = bucket.get(key)
  if (!votes) return null
  let total = 0
  let best: { owner: string; count: number } | null = null
  for (const v of votes.values()) {
    total += v.count
    if (!best || v.count > best.count) best = v
  }
  if (!best || total < LEARNED_MIN_ROWS) return null
  if (best.count / total < LEARNED_MIN_SHARE) return null
  return { owner: best.owner, count: best.count, total }
}

// rows: every APPROVED submissions row for one facility in the last
// LEARNED_WINDOW_DAYS days (manual and agent rows alike; owner not null) --
// see index.ts fetchOwnerModel. Indexes by exact sender address,
// reference-number shape, sender domain, and note tokens.
export function buildOwnerModel(rows: Array<{ owner?: string | null; reference_number?: string | null; notes?: string | null; sender_email?: string | null }>): OwnerModel {
  const model: OwnerModel = {
    bySender: new Map(),
    byShape: new Map(),
    byDomain: new Map(),
    byNoteToken: new Map(),
    totalRows: rows.length,
  }
  for (const r of rows) {
    if (!r.owner) continue
    const sender = (r.sender_email || '').toLowerCase().trim() || null
    vote(model.bySender, sender, r.owner)
    vote(model.byShape, shapeKey(r.reference_number), r.owner)
    const domain = emailDomain(sender)
    if (domain && !GENERIC_MAIL_DOMAINS.has(domain)) vote(model.byDomain, domain, r.owner)
    for (const tok of noteTokens(r.notes)) vote(model.byNoteToken, tok, r.owner)
  }
  return model
}

export type OwnerPrediction = {
  status: 'agree' | 'conflict' | 'none'
  owner: string | null
  signals: Record<string, { owner: string; count: number; total: number } | null>
  tier: 'core' | 'domain' | 'notes' | null
}

// Predicts an owner for ONE appointment reference. index.ts's
// predictOwnerForAppointments wraps this per-reference for multi-appointment
// emails and only trusts a unanimous 'agree' across all of them.
export function predictOwner(
  model: OwnerModel | null,
  input: { senderEmail: string | null; reference: string | null; notes: string | null },
  opts: { domainTier: boolean; notesTier: boolean; extractedOwnerBlank: boolean; legacySender: string | null },
): OwnerPrediction {
  const none: OwnerPrediction = { status: 'none', owner: null, signals: {}, tier: null }
  if (!model) return none

  const senderKey = (input.senderEmail || '').toLowerCase().trim() || null
  const senderSignal = resolveSignal(model.bySender, senderKey)
  // The old all-time agent_field_accuracy sender default stands in for the
  // sender core signal when the 90-day window itself has nothing for this
  // sender yet.
  const effectiveSenderSignal = senderSignal || (opts.legacySender ? { owner: opts.legacySender, count: 0, total: 0 } : null)

  const shapeSignal = resolveSignal(model.byShape, shapeKey(input.reference))

  const signals: OwnerPrediction['signals'] = { sender: effectiveSenderSignal, shape: shapeSignal }

  if (effectiveSenderSignal && shapeSignal) {
    if (normOwnerKey(effectiveSenderSignal.owner) === normOwnerKey(shapeSignal.owner)) {
      return { status: 'agree', owner: effectiveSenderSignal.owner, signals, tier: 'core' }
    }
    return { status: 'conflict', owner: null, signals, tier: 'core' }
  }
  if (effectiveSenderSignal) return { status: 'agree', owner: effectiveSenderSignal.owner, signals, tier: 'core' }
  if (shapeSignal) return { status: 'agree', owner: shapeSignal.owner, signals, tier: 'core' }

  // Fallback tiers only apply when no core signal fired AND extraction left
  // Owner blank; they are fill-only, never a source of 'conflict'.
  if (!opts.extractedOwnerBlank) return none

  if (opts.domainTier) {
    const domain = emailDomain(senderKey)
    const domainSignal = domain ? resolveSignal(model.byDomain, domain) : null
    if (domainSignal) {
      signals.domain = domainSignal
      return { status: 'agree', owner: domainSignal.owner, signals, tier: 'domain' }
    }
  }
  if (opts.notesTier) {
    for (const tok of noteTokens(input.notes)) {
      const tokSignal = resolveSignal(model.byNoteToken, tok)
      if (tokSignal) {
        signals.notes = tokSignal
        return { status: 'agree', owner: tokSignal.owner, signals, tier: 'notes' }
      }
    }
  }
  return none
}

// CSR-facing note for the confirmation comment, covering both the 'agree'
// (owner set/changed from a learned pattern) and 'conflict' (left blank,
// signals disagree) cases.
export function formatLearnedOwnerNote(prediction: OwnerPrediction): string {
  if (prediction.status === 'conflict') {
    const sender = prediction.signals.sender
    const shape = prediction.signals.shape
    return `⚠️ Owner left blank -- learned signals disagree (sender history says "${sender?.owner ?? '?'}", reference-number pattern says "${shape?.owner ?? '?'}") -- please enter manually.`
  }
  const tierLabel = prediction.tier === 'domain' ? 'sender domain history' : prediction.tier === 'notes' ? 'notes pattern' : 'this facility\'s approved-appointment history'
  return `⚠️ Owner set to "${prediction.owner}" from ${tierLabel} (learned pattern, not stated in this email) -- please confirm.`
}
