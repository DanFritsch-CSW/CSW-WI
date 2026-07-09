import { useEffect, useState } from 'react'
import {
  BUCKETS, BUCKET_COLORS, STAGES,
  fetchOnboardingCustomers, createOnboardingCustomer, updateCustomerStage,
  setCustomerArchived, deleteOnboardingCustomer,
  fetchTaskInstances, addTaskInstance, updateTaskInstance, deleteTaskInstance,
  completeTaskAndNotifyNext,
} from '../../lib/onboarding.js'
import TemplateEditor from './TemplateEditor.jsx'

// Customer Onboarding — v1 built 2026-07-08 for feedback/iteration, not a
// final design. Pulled forward from the 2026-06-05 mock session (real
// buckets/owners/template, not invented) rather than starting from scratch.
// See src/lib/onboarding.js header comment for the Front handoff mechanic.
export default function OnboardingTab() {
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showNewForm, setShowNewForm] = useState(false)
  const [view, setView] = useState('customer') // 'customer' | 'template'

  const load = () => {
    setLoading(true)
    fetchOnboardingCustomers()
      .then(rows => { setCustomers(rows); setError(null) })
      .catch(err => setError(err?.message || 'Failed to load customers'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    // Auto-select the first visible customer when none is selected, or when
    // the archived filter changes and the current selection drops out of view.
    const visible = customers.filter(c => !!c.archived === showArchived)
    if (!visible.find(c => c.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null)
    }
  }, [customers, showArchived, selectedId])

  const visibleCustomers = customers.filter(c => !!c.archived === showArchived)
  const selected = customers.find(c => c.id === selectedId) || null

  return (
    <div style={{ display: 'flex', gap: 20, minHeight: 500 }}>
      <Sidebar
        customers={visibleCustomers}
        selectedId={selectedId}
        onSelect={(id) => { setSelectedId(id); setView('customer') }}
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
            setSelectedId(customer.id)
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

  const reload = () => {
    setLoading(true)
    fetchTaskInstances(customer.id).then(setTasks).finally(() => setLoading(false))
  }

  useEffect(() => { reload() }, [customer.id])

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

function AddTaskInline({ customerId, nextSortOrder, onClose, onAdded }) {
  const [bucket, setBucket] = useState(BUCKETS[0])
  const [label, setLabel] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!label.trim()) return
    setSaving(true)
    try {
      const task = await addTaskInstance({
        customerId, bucket, label: label.trim(), sortOrder: nextSortOrder,
        ownerName: ownerName.trim() || null, ownerTeammateId: null,
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
      <input
        placeholder="Owner name (optional)"
        value={ownerName}
        onChange={(e) => setOwnerName(e.target.value)}
        style={{ fontSize: 12, padding: '4px 8px', width: 140 }}
      />
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
