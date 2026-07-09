import { useEffect, useMemo, useState } from 'react'
import { FACILITY_LIST } from '../lib/constants.js'
import {
  fetchRevisionConversations,
  fetchRevisionComments,
  updateRevisionConversation,
  markResolved,
  markUnresolved,
} from '../lib/revisions.js'

const SLA_LABEL = { breach: 'SLA Breach', warning: 'SLA Warning', applies: 'SLA Applies' }
const SLA_COLOR = { breach: 'var(--red, #d9534f)', warning: 'var(--yellow, #d4b84a)', applies: 'var(--text-secondary, #999)' }

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

function CommentThread({ comments }) {
  if (!comments.length) {
    return <p style={{ fontSize: 12, color: 'var(--text-secondary, #999)', margin: '8px 0' }}>No internal comments synced.</p>
  }
  return (
    <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--border, #333)' }}>
      {comments.map((c) => (
        <div key={c.id} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary, #999)' }}>
            <strong>{c.author_name || c.author_handle || 'Unknown'}</strong>
            {'  ·  '}
            {new Date(c.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{c.body}</div>
        </div>
      ))}
    </div>
  )
}

function ConversationCard({ conv, comments, onChange }) {
  const [expanded, setExpanded] = useState(false)
  const [orderNumber, setOrderNumber] = useState(conv.order_number || '')
  const meta = facilityMeta(conv.facility)

  async function handleFacilityChange(e) {
    const facility = e.target.value || null
    await updateRevisionConversation(conv.id, { facility })
    onChange()
  }

  async function handleOrderBlur() {
    if (orderNumber === (conv.order_number || '')) return
    await updateRevisionConversation(conv.id, { order_number: orderNumber || null })
    onChange()
  }

  async function toggleResolved() {
    if (conv.resolved) await markUnresolved(conv.id)
    else await markResolved(conv.id)
    onChange()
  }

  return (
    <div
      style={{
        border: '1px solid var(--border, #333)',
        borderRadius: 'var(--r-md, 8px)',
        background: 'var(--bg2, #1a1a1a)',
        padding: 12,
        marginBottom: 10,
        opacity: conv.resolved ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{conv.subject || '(no subject)'}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary, #999)', marginTop: 2 }}>
            {conv.customer_name || 'Unknown customer'} · {conv.status} · {timeAgo(conv.last_message_at)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {conv.sla_status && (
            <span style={{ fontSize: 10, fontWeight: 600, color: SLA_COLOR[conv.sla_status], border: `1px solid ${SLA_COLOR[conv.sla_status]}`, borderRadius: 4, padding: '2px 6px' }}>
              {SLA_LABEL[conv.sla_status]}
            </span>
          )}
          {meta && (
            <span style={{ fontSize: 10, fontWeight: 600, color: meta.color, border: `1px solid ${meta.color}`, borderRadius: 4, padding: '2px 6px' }}>
              {meta.code}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #333)', paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary, #999)' }}>
              Facility{' '}
              <select value={conv.facility || ''} onChange={handleFacilityChange} style={{ marginLeft: 4 }}>
                <option value="">Unassigned</option>
                {FACILITY_LIST.map((f) => (
                  <option key={f.id} value={f.id}>{f.code}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 11, color: 'var(--text-secondary, #999)' }}>
              Order / PO #{' '}
              <input
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                onBlur={handleOrderBlur}
                placeholder="not linked"
                style={{ marginLeft: 4, width: 120 }}
              />
            </label>
            <button onClick={toggleResolved} style={{ fontSize: 11, cursor: 'pointer' }}>
              {conv.resolved ? 'Reopen' : 'Mark resolved'}
            </button>
          </div>
          <CommentThread comments={comments} />
        </div>
      )}
    </div>
  )
}

export default function Revisions() {
  const [conversations, setConversations] = useState([])
  const [commentsByConv, setCommentsByConv] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [facilityFilter, setFacilityFilter] = useState('all')
  const [showResolved, setShowResolved] = useState(false)

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

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      if (!showResolved && c.resolved) return false
      if (facilityFilter !== 'all' && c.facility !== facilityFilter) return false
      return true
    })
  }, [conversations, facilityFilter, showResolved])

  if (loading) {
    return (
      <div className="page-content">
        <p style={{ color: 'var(--text-secondary, #999)', fontSize: 13 }}>Loading revisions…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="page-content">
        <div className="stub-page">
          <h2>Revisions</h2>
          <p style={{ color: 'var(--red, #d9534f)', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Revisions</h2>
        <span style={{ fontSize: 11, color: 'var(--text-secondary, #999)' }}>
          {filtered.length} of {conversations.length} shown
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'center' }}>
        <select value={facilityFilter} onChange={(e) => setFacilityFilter(e.target.value)}>
          <option value="all">All facilities</option>
          <option value="">Unassigned</option>
          {FACILITY_LIST.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
      </div>

      {filtered.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-secondary, #999)' }}>Nothing here — either it's all resolved or the sync hasn't run yet.</p>
      ) : (
        filtered.map((conv) => (
          <ConversationCard
            key={conv.id}
            conv={conv}
            comments={commentsByConv[conv.id] || []}
            onChange={load}
          />
        ))
      )}
    </div>
  )
}
