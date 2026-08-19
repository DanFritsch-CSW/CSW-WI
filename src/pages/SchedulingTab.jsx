import { useState, useEffect, useCallback } from 'react'
import {
  fetchAllExceptionCategories, retryDatexPush, deleteSubmission, frontConversationUrl,
} from '../lib/schedulingExceptions.js'

// Scheduling Tab — Datex Exceptions view (2026-08-03, delete added
// 2026-08-18). First piece of the scheduling app
// (DanFritsch-CSW/front_netlify_datex) surfaced inside CSW-WI: gives
// visibility into carrier appointments stuck between Front and Datex,
// which previously had no view at all — Kay/CSRs had no way to see what
// was stuck without someone manually querying Supabase. Reads the
// `submissions` table directly (already in this Supabase project, no
// migration needed); retry and delete both go through Netlify functions —
// retry because it needs Datex's Azure AD client secret, which can never
// reach the browser; delete for one consistent write path even though no
// RLS policy currently gates it (confirmed RLS is disabled table-wide on
// `submissions`, so this isn't the usual silent-no-op risk).
//
// Four categories, each a different flavor of "stuck":
//   Failed               — push attempted, Datex returned an error
//   Stuck Processing     — push started, function never returned (orphaned)
//   Approved Unconfirmed — marked approved but no Datex appointment ID ever
//                          confirmed (silently unverified success)
//   Stale Pending (7d+)  — never approved at all; retry disabled (rows may
//                          never have captured the owner/project/dock
//                          door/carrier IDs a real push needs), but delete
//                          is available here too — this is where most of
//                          the backlog piles up (1000+ rows).
//
// Delete is available on all four categories. It's a hard delete with a
// confirm() prompt — no soft-delete/undo, so the prompt names the record
// being removed rather than a generic "are you sure?".

const CATEGORIES = [
  {
    key: 'failed', label: 'Failed', canRetry: true,
    blurb: 'Datex push was attempted and errored.',
  },
  {
    key: 'stuckProcessing', label: 'Stuck Processing', canRetry: true,
    blurb: 'Push started but never completed — orphaned mid-flight.',
  },
  {
    key: 'approvedUnconfirmed', label: 'Approved, Unconfirmed', canRetry: true,
    blurb: 'Marked approved but no Datex appointment ID was ever confirmed.',
  },
  {
    key: 'stalePending', label: 'Stale Pending (7+ days)', canRetry: false,
    blurb: 'Never approved — no push has been attempted. Retry is disabled here since required fields (owner/project/dock door/carrier) may never have been captured. Delete is still available for clearing out backlog.',
  },
]

function fmtAge(createdAt) {
  if (!createdAt) return '—'
  const ms = Date.now() - new Date(createdAt).getTime()
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days >= 1) return `${days}d`
  const hours = Math.floor(ms / (60 * 60 * 1000))
  if (hours >= 1) return `${hours}h`
  const mins = Math.floor(ms / (60 * 1000))
  return `${mins}m`
}

function RetryButton({ row, onDone }) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  async function handleClick() {
    setLoading(true)
    setErr(null)
    try {
      const result = await retryDatexPush(row.id)
      if (result?.success) {
        onDone(row.id, { removed: true })
      } else {
        setErr(result?.error || 'Push failed again — see error column.')
        if (result?.submission) onDone(row.id, { updated: result.submission })
      }
    } catch (e) {
      setErr(e.message)
      if (e.submission) onDone(row.id, { updated: e.submission })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        style={{
          padding: '4px 12px', borderRadius: 'var(--r-md)', fontSize: 11, fontWeight: 700,
          border: '1px solid var(--border-subtle)', cursor: loading ? 'default' : 'pointer',
          background: 'var(--bg3)', color: 'var(--text-primary, #fff)', whiteSpace: 'nowrap',
        }}
      >
        {loading ? 'Retrying…' : 'Retry Push'}
      </button>
      {err && (
        <div style={{ color: 'var(--red)', fontSize: 10, marginTop: 4, maxWidth: 220, whiteSpace: 'normal', wordBreak: 'break-word' }}>{err}</div>
      )}
    </div>
  )
}

function DeleteButton({ row, onDone }) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  async function handleClick() {
    const label = row.appointment_lookup_code || row.reference_number || row.id
    if (!window.confirm(`Permanently delete this record (${label})? This cannot be undone.`)) return
    setLoading(true)
    setErr(null)
    try {
      await deleteSubmission(row.id)
      onDone(row.id, { removed: true })
    } catch (e) {
      setErr(e.message)
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        style={{
          padding: '4px 12px', borderRadius: 'var(--r-md)', fontSize: 11, fontWeight: 700,
          border: '1px solid rgba(224,90,90,0.4)', cursor: loading ? 'default' : 'pointer',
          background: 'rgba(224,90,90,0.08)', color: '#c0392b', whiteSpace: 'nowrap',
        }}
      >
        {loading ? 'Deleting…' : 'Delete'}
      </button>
      {err && (
        <div style={{ color: 'var(--red)', fontSize: 10, marginTop: 4, maxWidth: 220, whiteSpace: 'normal', wordBreak: 'break-word' }}>{err}</div>
      )}
    </div>
  )
}

function ExceptionsTable({ rows, canRetry, onRowResolved }) {
  if (!rows.length) {
    return (
      <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '16px 0' }}>
        Nothing in this category.
      </div>
    )
  }
  return (
    <table className="appt-list-table" style={{ width: '100%', tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{ width: '9%' }}>Warehouse</th>
          <th style={{ width: '7%' }}>Type</th>
          <th style={{ width: '10%' }}>PO / Ref #</th>
          <th style={{ width: '7%' }}>Carrier</th>
          <th style={{ width: '13%' }}>Owner / Project</th>
          <th style={{ width: '5%' }}>Age</th>
          <th style={{ width: '20%' }}>Error</th>
          <th style={{ width: '13%' }}>Front Conversation ID</th>
          <th style={{ width: '16%' }}>Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const frontUrl = frontConversationUrl(r.front_conversation_id)
          return (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.warehouse || '—'}</td>
              <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.type || '—'}</td>
              <td style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.reference_number || '—'}</td>
              <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.carrier || '—'}</td>
              <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{[r.owner, r.project].filter(Boolean).join(' / ') || '—'}</td>
              <td>{fmtAge(r.created_at)}</td>
              <td style={{ color: r.datex_error ? 'var(--red)' : 'var(--text-dim)', fontSize: 11, whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                {r.datex_error || '—'}
              </td>
              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, whiteSpace: 'normal', wordBreak: 'break-all' }}>
                {r.front_conversation_id
                  ? (
                    <>
                      <div>{r.front_conversation_id}</div>
                      {frontUrl && (
                        <a href={frontUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-display)', fontSize: 11 }}>
                          Open ↗
                        </a>
                      )}
                    </>
                  )
                  : '—'}
              </td>
              <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                  {canRetry && <RetryButton row={r} onDone={onRowResolved} />}
                  <DeleteButton row={r} onDone={onRowResolved} />
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default function SchedulingTab() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [activeCat, setActiveCat] = useState('failed')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const result = await fetchAllExceptionCategories()
      setData(result)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleRowResolved = useCallback((id, patch) => {
    setData((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        if (patch.removed) {
          next[key] = next[key].filter((r) => r.id !== id)
        } else if (patch.updated) {
          next[key] = next[key].map((r) => (r.id === id ? { ...r, ...patch.updated } : r))
        }
      }
      return next
    })
  }, [])

  const categoryData = {
    failed: data?.failed ?? [],
    stuckProcessing: data?.stuckProcessing ?? [],
    approvedUnconfirmed: data?.approvedUnconfirmed ?? [],
    stalePending: data?.stalePending ?? [],
  }

  const activeMeta = CATEGORIES.find((c) => c.key === activeCat)

  return (
    <div className="page-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="page-title">
            Scheduling <span className="page-title-gold">Datex Exceptions</span>
          </div>
          <div className="page-subtitle">
            Carrier appointments stuck between Front and Datex — surfaced from the scheduling app's submission queue
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '6px 16px', borderRadius: 'var(--r-md)', background: 'var(--bg3)',
            border: '1px solid var(--border)', color: 'var(--text-secondary)',
            cursor: loading ? 'default' : 'pointer',
          }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {err && <div style={{ color: 'var(--red)', fontSize: 13, padding: '8px 0' }}>Error: {err}</div>}

      <div className="facility-tabs" style={{ marginTop: 12 }}>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={`fac-tab${activeCat === c.key ? ' active' : ''}`}
            onClick={() => setActiveCat(c.key)}
          >
            {c.label} ({categoryData[c.key].length})
          </button>
        ))}
      </div>

      <div className="chart-card" style={{ marginTop: 16 }}>
        <div className="chart-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span className="chart-title" style={{ fontWeight: 800, color: 'var(--text-primary, #fff)' }}>
            {activeMeta.label}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: 480 }}>{activeMeta.blurb}</span>
        </div>
        {loading && !data ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '16px 0' }}>Loading…</div>
        ) : (
          <ExceptionsTable
            rows={categoryData[activeCat]}
            canRetry={activeMeta.canRetry}
            onRowResolved={handleRowResolved}
          />
        )}
      </div>
    </div>
  )
}
