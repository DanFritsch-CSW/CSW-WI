import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  BUCKETS, BUCKET_COLORS, STAGES,
  fetchOnboardingCustomers, createOnboardingCustomer, updateCustomerStage,
  setCustomerArchived, deleteOnboardingCustomer,
  fetchTaskInstances, addTaskInstance, updateTaskInstance, deleteTaskInstance,
  completeTaskAndNotifyNext, fetchFrontTeammates,
} from '../../lib/onboarding.js'
import TemplateEditor from './TemplateEditor.jsx'
import TeammatePicker from './TeammatePicker.jsx'

// Customer Onboarding — v1 built 2026-07-08 for feedback/iteration, not a
// final design. Pulled forward from the 2026-06-05 mock session (real
// buckets/owners/template, not invented) rather than starting from scratch.
// See src/lib/onboarding.js header comment for the Front handoff mechanic.
//
// 2026-07-09: added ?customer=<id> URL state (same pattern as the parent
// Customers page's ?tab=) so a specific customer's checklist is directly
// linkable — e.g. to paste into the Front discussion thread for that
// customer. Sequential Supabase IDs are used as-is (option chosen over a
// non-guessable token) — flagged to Dan that this app has no auth layer, so
// anyone with a link can view AND act on that customer, and the ID is
// enumerable. Accepted as fine for an internal-only tool.
export default function OnboardingTab() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showNewForm, setShowNewForm] = useState(false)
  const [view, setView] = useState('customer') // 'customer' | 'template'
  const [urlInitDone, setUrlInitDone] = useState(false)

  const load = () => {
    setLoading(true)
    fetchOnboardingCustomers()
      .then(rows => { setCustomers(rows); setError(null) })
      .catch(err => setError(err?.message || 'Failed to load customers'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  // Honor a ?customer=<id> link once customers have loaded — runs exactly
  // once. If the linked customer is archived, also flip the Archived filter
  // so the link actually resolves instead of silently falling through to
  // the auto-select-first fallback below.
  useEffect(() => {
    if (urlInitDone || customers.length === 0) return
    const urlId = Number(searchParams.get('customer'))
    if (urlId) {
      const match = customers.find(c => c.id === urlId)
      if (match) {
        setSelectedId(urlId)
        if (match.archived) setShowArchived(true)
      }
    }
    setUrlInitDone(true)
  }, [customers, urlInitDone, searchParams])

  useEffect(() => {
    // Auto-select the first visible customer when none is selected, or when
    // the archived filter changes and the current selection drops out of
    // view. Gated on urlInitDone so it doesn't fight with honoring a
    // ?customer= link on first load.
    if (!urlInitDone) return
    const visible = customers.filter(c => !!c.archived === showArchived)
    if (!visible.find(c => c.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null)
    }
  }, [customers, showArchived, selectedId, urlInitDone])

  // selectCustomer — sets local state AND keeps ?customer= in the URL in
  // sync, so the address bar is always a valid link to whatever's selected
  // (merges with existing params rather than overwriting ?tab=onboarding).
  const selectCustomer = (id) => {
    setSelectedId(id)
    setView('customer')
    const next = new URLSearchParams(searchParams)
    if (id) next.set('customer', String(id))
    else next.delete('customer')
    setSearchParams(next)
  }

  const visibleCustomers = customers.filter(c => !!c.archived === showArchived)
  const selected = customers.find(c => c.id === selectedId) || null

  return (
    <div style={{ display: 'flex', gap: 20, minHeight: 500 }}>
      <Sidebar
        customers={visibleCustomers}
        selectedId={selectedId}
        onSelect={selectCustomer}
        showArchived={showArchived}
        onToggleArchived={setShowArchived}
        onNewCustomer={() => setShowNewForm(true)}
        onManageTemplate={() => setView('template')}
      />
      {view === 'template' ? (
        <TemplateEditor onClose={() => setView('customer')} />
      ) : (
        <div style={{ flex: 1, minWidth: 0 }}>
          {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</div>}
          {error && !loading && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 13 }}>{error}</div>}
          {!loading && !error && !selected && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
              {visibleCustomers.length === 0
                ? (showArchived ? 'No archived customers.' : 'No customers yet — click "+ New Customer" to start one.')
                : 'Select a customer.'}
            </div>
          )}
          {!loading && !error && selected && (
            <CustomerDetail
              customer={selected}
              onStageChange={(stage) => {
                updateCustomerStage(selected.id, stage)
                setCustomers(prev => prev.map(c => c.id === selected.id ? { ...c, stage } : c))
              }}
              onArchiveToggle={() => {
                const next = !selected.archived
                setCustomerArchived(selected.id, next)
                setCustomers(prev => prev.map(c => c.id === selected.id ? { ...c, archived: next } : c))
              }}
              onDelete={() => {
                if (!window.confirm(`Delete ${selected.name}? This removes all its onboarding tasks too.`)) return
                deleteOnboardingCustomer(selected.id)
                setCustomers(prev => prev.filter(c => c.id !== selected.id))
              }}
            />
          )}
        </div>
      )}
      {showNewForm && (
        <NewCustomerModal
          onClose={() => setShowNewForm(false)}
          onCreated={(customer) => {
            setCustomers(prev => [customer, ...prev])
            selectCustomer(customer.id)
            setShowNewForm(false)
          }}
        />
      )}
    </div>
  )
}

function Sidebar({ customers, selectedId, onSelect, showArchived, onToggleArchived, onNewCustomer, onManageTemplate }) {
  return (
    <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--border)', paddingRight: 16 }}>
      <button
        type="button"
        onClick={onNewCustomer}
        style={{
          width: '100%', padding: '8px 12px', marginBottom: 8,
          background: 'var(--brand, #a07818)', color: '#fff', border: 'none',
          borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}
      >
        + New Customer
      </button>

      <button
        type="button"
        onClick={onManageTemplate}
        style={{
          width: '100%', padding: '6px 12px', marginBottom: 12,
          background: 'transparent', color: 'var(--text-secondary)',
          border: '1px solid var(--border)', borderRadius: 6, fontSize: 11, cursor: 'pointer',
        }}
      >
        ⚙ Manage Template
      </button>

      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        <TabPill label="Active" active={!showArchived} onClick={() => onToggleArchived(false)} />
        <TabPill label="Archived" active={showArchived} onClick={() => onToggleArchived(true)} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {customers.map(c => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            style={{
              textAlign: 'left', padding: '8px 10px', borderRadius: 6,
              border: 'none', cursor: 'pointer',
              background: c.id === selectedId ? 'var(--brand-bg, #fef9ec)' : 'transparent',
              color: c.id === selectedId ? 'var(--brand, #a07818)' : 'var(--text-primary)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {c.facility ? `${c.facility.toUpperCase()} · ` : ''}{c.stage}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function TabPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: '4px 8px', fontSize: 11, fontWeight: 600,
        borderRadius: 4, border: 'none', cursor: 'pointer',
        background: active ? 'var(--brand-bg, #fef9ec)' : 'transparent',
        color: active ? 'var(--brand, #a07818)' : 'var(--text-secondary)',
      }}
    >
      {label}
    </button>
  )
}

function CustomerDetail({ customer, onStageChange, onArchiveToggle, onDelete }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState(null) // { text, tone } | null — transient handoff-result banner
  const [showAddTask, setShowAddTask] = useState(false)
  const [teammates, setTeammates] = useState([])
  const [linkCopied, setLinkCopied] = useState(false)

  const reload = () => {
    setLoading(true)
    fetchTaskInstances(customer.id).then(setTasks).finally(() => setLoading(false))
  }

  useEffect(() => { reload() }, [customer.id])
  useEffect(() => { fetchFrontTeammates().then(setTeammates) }, [])

  const handleComplete = async (task) => {
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'done' } : t))
    try {
      const result = await completeTaskAndNotifyNext(task.id)
      if (result.notified) {
        setNotice({ text: `Notified ${result.nextTask?.owner} — "${result.nextTask?.label}" is next.`, tone: 'ok' })
      } else {
        setNotice({ text: `Task completed. Front notification not sent: ${result.reason}.`, tone: 'warn' })
      }
    } catch (err) {
      setNotice({ text: `Task marked done, but the handoff check failed: ${err.message}`, tone: 'warn' })
    }
    reload()
  }

  const doneCount = tasks.filter(t => t.status === 'done').length

  const copyLink = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('customer', String(customer.id))
    navigator.clipboard.writeText(url.toString())
      .then(() => {
        setLinkCopied(true)
        setTimeout(() => setLinkCopied(false), 1500)
      })
      .catch(() => window.alert(`Copy failed — link is: ${url.toString()}`))
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>{customer.name}</h3>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            {doneCount} / {tasks.length} tasks complete
            {customer.source_conversation_id && ` · from Front ${customer.source_conversation_id}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" onClick={copyLink} style={smallBtnStyle}>
            {linkCopied ? 'Copied!' : 'Copy link'}
          </button>
          <select
            value={customer.stage}
            onChange={(e) => onStageChange(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)' }}
          >
            {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" onClick={onArchiveToggle} style={smallBtnStyle}>
            {customer.archived ? 'Unarchive' : 'Archive'}
          </button>
          <button type="button" onClick={onDelete} style={{ ...smallBtnStyle, color: 'var(--danger, #dc2626)' }}>
            Delete
          </button>
        </div>
      </div>

      {notice && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 12,
          background: notice.tone === 'ok' ? '#ecfdf5' : '#fffbeb',
          color: notice.tone === 'ok' ? '#059669' : '#b45309',
          border: `1px solid ${notice.tone === 'ok' ? '#a7f3d0' : '#fde68a'}`,
        }}>
          {notice.text}
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{ float: 'right', border: 'none', background: 'none', cursor: 'pointer', color: 'inherit' }}
          >
            ×
          </button>
        </div>
      )}

      {loading && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading tasks…</div>}

      {!loading && BUCKETS.map(bucket => {
        const bucketTasks = tasks.filter(t => t.bucket === bucket)
        if (!bucketTasks.length) return null
        return (
          <BucketSection
            key={bucket}
            bucket={bucket}
            tasks={bucketTasks}
            onComplete={handleComplete}
            onDelete={(taskId) => { deleteTaskInstance(taskId); setTasks(prev => prev.filter(t => t.id !== taskId)) }}
          />
        )
      })}

      <button
        type="button"
        onClick={() => setShowAddTask(true)}
        style={{ ...smallBtnStyle, marginTop: 8 }}
      >
        + Add task
      </button>

      {showAddTask && (
        <AddTaskInline
          customerId={customer.id}
          teammates={teammates}
          nextSortOrder={(tasks.at(-1)?.sort_order ?? 0) + 1}
          onClose={() => setShowAddTask(false)}
          onAdded={(task) => { setTasks(prev => [...prev, task]); setShowAddTask(false) }}
        />
      )}
    </div>
  )
}

function BucketSection({ bucket, tasks, onComplete, onDelete }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
        color: BUCKET_COLORS[bucket] || 'var(--text-secondary)',
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: BUCKET_COLORS[bucket] || '#999' }} />
        {bucket}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tasks.map(t => (
          <div
            key={t.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
              borderRadius: 6, background: 'var(--surface-2, #f8f8f8)',
              opacity: t.status === 'done' ? 0.55 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={t.status === 'done'}
              disabled={t.status === 'done'}
              onChange={() => onComplete(t)}
            />
            <span style={{
              flex: 1, fontSize: 13,
              textDecoration: t.status === 'done' ? 'line-through' : 'none',
            }}>
              {t.label}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {t.owner_name || 'unassigned'}
              {!t.owner_teammate_id && (
                <span title="No confirmed Front teammate ID — handoff notification won't fire for this owner" style={{ marginLeft: 4 }}>
                  ⚠
                </span>
              )}
            </span>
            {(t.notes || t.dependencies) && (
              <span
                title={[
                  t.dependencies ? `Depends on: ${t.dependencies}` : null,
                  t.notes || null,
                ].filter(Boolean).join('\n\n')}
                style={{ fontSize: 13, color: 'var(--text-secondary)', cursor: 'help', flexShrink: 0 }}
              >
                ⓘ
              </span>
            )}
            <button
              type="button"
              onClick={() => onDelete(t.id)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 13 }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function AddTaskInline({ customerId, teammates, nextSortOrder, onClose, onAdded }) {
  const [bucket, setBucket] = useState(BUCKETS[0])
  const [label, setLabel] = useState('')
  const [teammateId, setTeammateId] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!label.trim()) return
    setSaving(true)
    try {
      const tm = teammates.find(t => t.teammate_id === teammateId)
      const task = await addTaskInstance({
        customerId, bucket, label: label.trim(), sortOrder: nextSortOrder,
        ownerName: tm ? (tm.first_name || tm.username) : null,
        ownerTeammateId: teammateId || null,
      })
      onAdded(task)
    } catch (err) {
      window.alert(`Failed to add task: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      display: 'flex', gap: 6, marginTop: 8, padding: 10,
      border: '1px solid var(--border)', borderRadius: 6, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <select value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }}>
        {BUCKETS.map(b => <option key={b} value={b}>{b}</option>)}
      </select>
      <input
        placeholder="Task label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        style={{ fontSize: 12, padding: '4px 8px', flex: 1, minWidth: 140 }}
      />
      <TeammatePicker teammates={teammates} value={teammateId} onChange={setTeammateId} />
      <button type="button" onClick={submit} disabled={saving} style={smallBtnStyle}>
        {saving ? 'Adding…' : 'Add'}
      </button>
      <button type="button" onClick={onClose} style={smallBtnStyle}>Cancel</button>
    </div>
  )
}

function NewCustomerModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [facility, setFacility] = useState('')
  const [sourceConv, setSourceConv] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const customer = await createOnboardingCustomer({
        name: name.trim(),
        facility: facility.trim() || null,
        sourceConversationId: sourceConv.trim() || null,
      })
      onCreated(customer)
    } catch (err) {
      window.alert(`Failed to create customer: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }}>
      <div style={{ background: 'var(--surface, #fff)', borderRadius: 10, padding: 20, width: 340 }}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>New Customer</h3>
        <label style={labelStyle}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} autoFocus />
        <label style={labelStyle}>Facility (optional)</label>
        <input value={facility} onChange={(e) => setFacility(e.target.value)} placeholder="cal / mad / ken / wr / ec" style={inputStyle} />
        <label style={labelStyle}>Front conversation ID (optional)</label>
        <input value={sourceConv} onChange={(e) => setSourceConv(e.target.value)} placeholder="cnv_xxxxx" style={inputStyle} />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={smallBtnStyle}>Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !name.trim()}
            style={{ ...smallBtnStyle, background: 'var(--brand, #a07818)', color: '#fff' }}
          >
            {saving ? 'Creating…' : 'Create — clones the current template'}
          </button>
        </div>
      </div>
    </div>
  )
}

const smallBtnStyle = {
  padding: '4px 10px', fontSize: 12, borderRadius: 4,
  border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer',
}
const labelStyle = { display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginTop: 10, marginBottom: 4 }
const inputStyle = { width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 4, border: '1px solid var(--border)', boxSizing: 'border-box' }
