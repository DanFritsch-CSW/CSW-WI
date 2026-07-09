import { useEffect, useMemo, useState } from 'react'
import { FACILITY_LIST } from '../../lib/constants.js'
import {
  fetchRevisionConversations,
  fetchRevisionComments,
  updateRevisionConversation,
  markResolved,
  markUnresolved,
  resolveAmbiguousMatch,
  dismissConversation,
  undismissConversation,
  setManualShipDate,
  effectiveMatch,
} from '../../lib/revisions.js'

// Revisions sub-tab, added 2026-07-09 — lives next to FEFO Rotation inside
// the Customers page. Day-slider + appointment matching added same day
// (Dan: "filter down to just today's ... shipments" + "cross reference
// and correlate them to each other").
//
// Date filtering and cross-conversation correlation both hang off the
// SAME join: revision-sync.cjs extracts numeric tokens from Front subject
// lines AND message bodies, and matches them against
// production_db.gold.truck_appointments (reference_number / lookup_code).
// A single match gives us a real scheduled_arrival to slide the
// day-stepper on, plus an appointment_id that's the natural correlation
// key — conversations that resolve to the same appointment_id are the
// "cross reference and correlate" ask, grouped together below instead of
// guessing at text similarity.
//
// Not every conversation resolves cleanly: the same reference number can
// belong to a different customer/appointment from a prior year (confirmed
// live — "517450" matched both a 2025 and a 2026 appointment). Those land
// as match_status='ambiguous' with every candidate stored, and sit in the
// "Needs Review" section until a manager picks the right one (writes to
// resolved_match — see src/lib/revisions.js effectiveMatch()). Needs
// Review is deliberately NOT subject to the day filter — an unresolved
// ambiguous or unmatched conversation has no confirmed date yet, so
// hiding it behind a day slider would just make it invisible.
//
// Recency split (2026-07-09, session 5): the Revision tag's history goes
// back to April 2026, and the vast majority of conversations that never
// resolved to an appointment are legitimately stale — threads about
// shipments from months ago that fall outside revision-sync.cjs's
// -14d/+45d matching window on purpose. Dumping all ~270 of those into
// "Needs Review" alongside the handful that are ACTUALLY actionable today
// made the section useless (confirmed with Dan: 252 of 268 unmatched were
// >7 days old). So Needs Review only shows unmatched/ambiguous items from
// the last 14 days by default; older ones sit behind a collapsed toggle.
//
// Front deep link (2026-07-09, session 6): subdomain inferred from
// attachment URLs seen in kb.messages during earlier investigation
// (central-storage-and-warehouse-co.api.frontapp.com) — the web app
// deep-link pattern swaps the api. host for the plain workspace subdomain.
// Not independently browser-tested; if it 404s, the subdomain guess is
// the first thing to check.
//
// Dismiss + manual ship date (2026-07-09, session 7): two real gaps found
// on cnv_1bue6oic ("Pallet needed back from CSW 07/10/2026") —
//   1. Front's "Revision" tag rule matches the keyword anywhere in the
//      thread, including CSW's OWN reply ("Yes, revision received.") even
//      when the customer never asked for a revision. Not fixable in our
//      sync (we only mirror whatever tag Front applied) — "Dismiss" lets
//      a manager mark it as never-really-a-revision, distinct from
//      "Resolved" (which implies a real issue got handled). Dismissed
//      conversations are hidden everywhere by default.
//   2. This thread has no Datex reference number at all (just a product
//      code and a plain-English date, "07/10/2026") — nothing for
//      revision-sync.cjs to match against MotherDuck. Manual ship date
//      lets a manager type the date in by hand so it still shows up in
//      the day-slider view. See effectiveMatch() in src/lib/revisions.js
//      for how it slots in as a fallback (source: 'manual', no
//      appointment_id — so it's never falsely grouped with other threads).

const RECENT_WINDOW_DAYS = 14
const FRONT_WORKSPACE_SUBDOMAIN = 'central-storage-and-warehouse-co'

const SLA_LABEL = { breach: 'SLA Breach', warning: 'SLA Warning', applies: 'SLA Applies' }
const SLA_COLOR = { breach: 'var(--red, #c0392b)', warning: 'var(--amber, #a07818)', applies: 'var(--text-dim, #9aaabb)' }

function facilityMeta(id) {
  return FACILITY_LIST.find((f) => f.id === id)
}

function timeAgo(iso) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const hrs = Math.floor(ms / 3600000)
  if (hrs < 1) return '<1h ago'
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function isSameLocalDay(iso, dayOffset) {
  if (!iso) return false
  const d = new Date(iso)
  const target = new Date()
  target.setDate(target.getDate() + dayOffset)
  return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth() && d.getDate() === target.getDate()
}

function isRecent(iso, days) {
  if (!iso) return false
  const ms = Date.now() - new Date(iso).getTime()
  return ms <= days * 86400000
}

function dayLabel(offset) {
  if (offset === 0) return 'Today'
  if (offset === -1) return 'Yesterday'
  if (offset === 1) return 'Tomorrow'
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function daySubLabel(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
}

function DayStepper({ offset, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 8px',
      background: 'var(--bg2, #f8f9fb)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md, 8px)',
    }}>
      <button
        type="button"
        onClick={() => onChange(offset - 1)}
        disabled={offset <= -7}
        style={{
          width: 24, height: 24, padding: 0, background: 'transparent',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm, 4px)',
          color: offset <= -7 ? 'var(--text-dim)' : 'var(--text-primary)',
          cursor: offset <= -7 ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600,
          opacity: offset <= -7 ? 0.4 : 1,
        }}
      >‹</button>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 130, lineHeight: 1.2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{dayLabel(offset)}</span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.06em', marginTop: 2 }}>
          {daySubLabel(offset)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => onChange(offset + 1)}
        disabled={offset >= 14}
        style={{
          width: 24, height: 24, padding: 0, background: 'transparent',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm, 4px)',
          color: offset >= 14 ? 'var(--text-dim)' : 'var(--text-primary)',
          cursor: offset >= 14 ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600,
          opacity: offset >= 14 ? 0.4 : 1,
        }}
      >›</button>
    </div>
  )
}

function CommentThread({ comments }) {
  if (!comments.length) {
    return <p style={{ fontSize: 12, color: 'var(--text-dim, #9aaabb)', margin: '8px 0' }}>No internal comments synced.</p>
  }
  return (
    <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
      {comments.map((c) => (
        <div key={c.id} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim, #9aaabb)' }}>
            <strong>{c.author_name || c.author_handle || 'Unknown'}</strong>
            {'  ·  '}
            {new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
        </div>
      ))}
    </div>
  )
}

function CandidatePicker({ conv, onResolved }) {
  const candidates = conv.match_candidates || []
  async function pick(cand) {
    await resolveAmbiguousMatch(conv.id, cand)
    onResolved()
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
        This reference number matches more than one appointment — pick the right one:
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {candidates.map((cand) => (
          <button
            key={cand.appointment_id}
            type="button"
            onClick={() => pick(cand)}
            style={{
              textAlign: 'left', padding: '8px 10px',
              background: 'var(--bg2, #f8f9fb)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm, 4px)', cursor: 'pointer', font: 'inherit', color: 'inherit',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>{cand.owner_name || 'Unknown owner'} · {cand.warehouse_name || 'unknown facility'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, monospace)', marginTop: 2 }}>
              ref {cand.reference_number} · {cand.scheduled_arrival ? new Date(cand.scheduled_arrival).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'no date'}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function ConversationCard({ conv, comments, onChange, relatedCount }) {
  const [expanded, setExpanded] = useState(false)
  const [orderNumber, setOrderNumber] = useState(conv.order_number || '')
  const [shipDate, setShipDate] = useState(conv.manual_ship_date || '')
  const meta = facilityMeta(conv.facility)
  const match = effectiveMatch(conv)

  async function handleFacilityChange(e) {
    await updateRevisionConversation(conv.id, { facility: e.target.value || null })
    onChange()
  }

  async function handleOrderBlur() {
    if (orderNumber === (conv.order_number || '')) return
    await updateRevisionConversation(conv.id, { order_number: orderNumber || null })
    onChange()
  }

  async function handleShipDateChange(e) {
    const val = e.target.value
    setShipDate(val)
    await setManualShipDate(conv.id, val)
    onChange()
  }

  async function toggleResolved() {
    if (conv.resolved) await markUnresolved(conv.id)
    else await markResolved(conv.id)
    onChange()
  }

  async function toggleDismissed() {
    if (conv.dismissed) await undismissConversation(conv.id)
    else await dismissConversation(conv.id)
    onChange()
  }

  return (
    <div
      style={{
        background: 'var(--bg1, #fff)',
        border: '1px solid var(--border)',
        borderLeft: `4px solid ${conv.sla_status ? SLA_COLOR[conv.sla_status] : 'var(--border)'}`,
        borderRadius: 'var(--r-md, 8px)',
        padding: 12,
        marginBottom: 10,
        opacity: conv.resolved || conv.dismissed ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{conv.subject || '(no subject)'}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            {conv.customer_name || 'Unknown customer'} · {conv.status} · {timeAgo(conv.last_message_at)}
            {match?.scheduled_arrival && (
              <> · ships {new Date(match.scheduled_arrival).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{match.source === 'manual' ? ' (manual)' : ''}</>
            )}
            {conv.front_id && (
              <>
                {' · '}
                <a
                  href={`https://${FRONT_WORKSPACE_SUBDOMAIN}.frontapp.com/open/${conv.front_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title="Open this conversation in Front"
                  style={{ color: 'var(--text-dim, #9aaabb)', fontFamily: 'var(--font-mono, monospace)', fontSize: 10, textDecoration: 'underline' }}
                >
                  {conv.front_id}
                </a>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {conv.dismissed && (
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dim, #9aaabb)', border: '1px solid var(--text-dim, #9aaabb)', borderRadius: 'var(--r-sm, 4px)', padding: '2px 6px', fontFamily: 'var(--font-mono, monospace)' }}>
              DISMISSED
            </span>
          )}
          {relatedCount > 1 && (
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--blue, #2a72b8)', border: '1px solid var(--blue, #2a72b8)', borderRadius: 'var(--r-sm, 4px)', padding: '2px 6px', fontFamily: 'var(--font-mono, monospace)' }}>
              {relatedCount} RELATED
            </span>
          )}
          {conv.sla_status && (
            <span style={{ fontSize: 10, fontWeight: 600, color: SLA_COLOR[conv.sla_status], border: `1px solid ${SLA_COLOR[conv.sla_status]}`, borderRadius: 'var(--r-sm, 4px)', padding: '2px 6px', fontFamily: 'var(--font-mono, monospace)' }}>
              {SLA_LABEL[conv.sla_status]}
            </span>
          )}
          {meta && (
            <span style={{ fontSize: 10, fontWeight: 600, color: meta.color, border: `1px solid ${meta.color}`, borderRadius: 'var(--r-sm, 4px)', padding: '2px 6px', fontFamily: 'var(--font-mono, monospace)' }}>
              {meta.code}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Facility{' '}
              <select value={conv.facility || ''} onChange={handleFacilityChange} style={{ marginLeft: 4 }}>
                <option value="">Unassigned</option>
                {FACILITY_LIST.map((f) => (
                  <option key={f.id} value={f.id}>{f.code}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Order / PO #{' '}
              <input
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                onBlur={handleOrderBlur}
                placeholder="not linked"
                style={{ marginLeft: 4, width: 120 }}
              />
            </label>
            {!match && (
              <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                Ship date (manual){' '}
                <input
                  type="date"
                  value={shipDate}
                  onChange={handleShipDateChange}
                  style={{ marginLeft: 4 }}
                />
              </label>
            )}
            <button
              type="button"
              onClick={toggleResolved}
              style={{
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
                padding: '4px 10px', background: 'var(--bg2, #f8f9fb)',
                border: '1px solid var(--border)', borderRadius: 'var(--r-sm, 4px)',
                color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)',
              }}
            >
              {conv.resolved ? 'REOPEN' : 'MARK RESOLVED'}
            </button>
            <button
              type="button"
              onClick={toggleDismissed}
              title="Use when Front tagged this as a Revision incorrectly (e.g. the keyword only appeared in CSW's own reply, not the customer's request)"
              style={{
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
                padding: '4px 10px', background: 'var(--bg2, #f8f9fb)',
                border: '1px solid var(--border)', borderRadius: 'var(--r-sm, 4px)',
                color: 'var(--text-dim, #9aaabb)', fontFamily: 'var(--font-mono, monospace)',
              }}
            >
              {conv.dismissed ? 'RESTORE' : 'DISMISS — NOT A REVISION'}
            </button>
          </div>
          {conv.match_status === 'ambiguous' && !conv.resolved_match && (
            <CandidatePicker conv={conv} onResolved={onChange} />
          )}
          <CommentThread comments={comments} />
        </div>
      )}
    </div>
  )
}

export default function RevisionsTab() {
  const [conversations, setConversations] = useState([])
  const [commentsByConv, setCommentsByConv] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [facilityFilter, setFacilityFilter] = useState('all')
  const [showResolved, setShowResolved] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)
  const [dayOffset, setDayOffset] = useState(0)
  const [showOlderBacklog, setShowOlderBacklog] = useState(false)

  async function load() {
    try {
      const convs = await fetchRevisionConversations()
      setConversations(convs)
      const comments = await fetchRevisionComments(convs.map((c) => c.id))
      const grouped = {}
      for (const c of comments) {
        if (!grouped[c.conversation_id]) grouped[c.conversation_id] = []
        grouped[c.conversation_id].push(c)
      }
      setCommentsByConv(grouped)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const baseFiltered = useMemo(() => {
    return conversations.filter((c) => {
      if (!showDismissed && c.dismissed) return false
      if (!showResolved && c.resolved) return false
      if (facilityFilter !== 'all' && c.facility !== facilityFilter) return false
      return true
    })
  }, [conversations, facilityFilter, showResolved, showDismissed])

  // Day-filtered: only conversations with a confirmed appointment match
  // (or a manager's manual ship date) whose date falls on the selected day.
  const dayFiltered = useMemo(() => {
    return baseFiltered.filter((c) => {
      const m = effectiveMatch(c)
      return m && isSameLocalDay(m.scheduled_arrival, dayOffset)
    })
  }, [baseFiltered, dayOffset])

  // Needs Review: ambiguous (unresolved) or genuinely unmatched — no
  // confirmed date, so day filter doesn't apply. Split by recency (see
  // header comment) — most of the historical backlog will never match
  // and shouldn't crowd out the handful that actually need eyes today.
  const needsReviewAll = useMemo(() => {
    return baseFiltered.filter((c) => {
      if (effectiveMatch(c)) return false
      return c.match_status === 'ambiguous' || c.match_status === 'none' || !c.match_status
    })
  }, [baseFiltered])

  const needsReviewRecent = useMemo(
    () => needsReviewAll.filter((c) => isRecent(c.last_message_at, RECENT_WINDOW_DAYS)),
    [needsReviewAll]
  )
  const needsReviewOlder = useMemo(
    () => needsReviewAll.filter((c) => !isRecent(c.last_message_at, RECENT_WINDOW_DAYS)),
    [needsReviewAll]
  )

  // Group the day-filtered list by appointment_id — the "correlate them
  // to each other" ask. Groups of >1 render with a shared "N related"
  // badge. Manual-ship-date entries have no real appointment_id (null),
  // so they're keyed by conversation id instead — otherwise every manually
  // dated conversation would incorrectly collapse into one fake group
  // together just because they all share a null key.
  const groups = useMemo(() => {
    const byAppt = new Map()
    for (const c of dayFiltered) {
      const m = effectiveMatch(c)
      const key = m.appointment_id != null ? m.appointment_id : `manual:${c.id}`
      if (!byAppt.has(key)) byAppt.set(key, [])
      byAppt.get(key).push(c)
    }
    return [...byAppt.values()].sort((a, b) => {
      const ma = effectiveMatch(a[0])
      const mb = effectiveMatch(b[0])
      return new Date(ma.scheduled_arrival) - new Date(mb.scheduled_arrival)
    })
  }, [dayFiltered])

  if (loading) {
    return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>Loading revisions…</div>
  }

  if (error) {
    return (
      <div style={{ padding: '20px 0', color: 'var(--red, #c0392b)', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {error}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <DayStepper offset={dayOffset} onChange={setDayOffset} />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={facilityFilter} onChange={(e) => setFacilityFilter(e.target.value)}>
            <option value="all">All facilities</option>
            <option value="">Unassigned</option>
            {FACILITY_LIST.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Show resolved
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
            Show dismissed
          </label>
          <span style={{ fontSize: 11, color: 'var(--text-dim, #9aaabb)', fontFamily: 'var(--font-mono, monospace)' }}>
            {dayFiltered.length} shipping {dayLabel(dayOffset).toLowerCase()}
          </span>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
          SHIPPING {dayLabel(dayOffset).toUpperCase()}
        </div>
        {groups.length === 0 ? (
          <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
            Nothing matched to a shipment on this day.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group[0].id}>
              {group.map((conv) => (
                <ConversationCard
                  key={conv.id}
                  conv={conv}
                  comments={commentsByConv[conv.id] || []}
                  onChange={load}
                  relatedCount={group.length}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {needsReviewRecent.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--amber, #a07818)', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
            NEEDS REVIEW · {needsReviewRecent.length} unmatched or ambiguous, last {RECENT_WINDOW_DAYS}d
          </div>
          {needsReviewRecent.map((conv) => (
            <ConversationCard
              key={conv.id}
              conv={conv}
              comments={commentsByConv[conv.id] || []}
              onChange={load}
              relatedCount={1}
            />
          ))}
        </div>
      )}

      {needsReviewOlder.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowOlderBacklog((v) => !v)}
            style={{
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              padding: '6px 12px', background: 'var(--bg2, #f8f9fb)',
              border: '1px solid var(--border)', borderRadius: 'var(--r-sm, 4px)',
              color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, monospace)',
              marginBottom: showOlderBacklog ? 8 : 0,
            }}
          >
            {showOlderBacklog ? '▾' : '▸'} {needsReviewOlder.length} OLDER, UNMATCHED (over {RECENT_WINDOW_DAYS}d — likely stale history)
          </button>
          {showOlderBacklog && needsReviewOlder.map((conv) => (
            <ConversationCard
              key={conv.id}
              conv={conv}
              comments={commentsByConv[conv.id] || []}
              onChange={load}
              relatedCount={1}
            />
          ))}
        </div>
      )}
    </div>
  )
}
