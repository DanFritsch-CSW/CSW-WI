import { useState, useEffect } from 'react'
import {
  fetchDailyDiscussionEmailSettings, upsertDailyDiscussionEmailSettings,
  fetchDailyDiscussionEmailRecipients, saveDailyDiscussionEmailRecipients,
  fetchDailyDiscussionEmailFollowers, saveDailyDiscussionEmailFollowers,
  fetchFrontChannels, triggerFrontChannelsSync,
  triggerDailyDiscussionEmailTest,
} from '../../lib/dailyDiscussionEmail.js'

// Daily Discussion EMAIL draft editor — added 2026-09-01 per Dan's ask
// ("I would love for this to create an email draft from the APP...
// editable TO:/CC: fields"). Deliberately a SEPARATE component from
// DailyDiscussionsEditor (Settings.jsx), not a section grafted into it —
// Settings.jsx is already 59.9KB, at the documented ~50-60KB
// fragile-push threshold, so new UI surface goes in a companion file,
// same pattern as PviAccountsTab.jsx.
//
// Rendered BELOW the existing internal-discussion recipient picker in
// Settings.jsx, sharing that component's `facility` state (passed down
// as a prop) and its already-loaded `teammates` list (also passed down,
// avoiding a duplicate fetch) — this is what makes facility "editable
// based on the UI" per Dan's explicit ask, reusing the dropdown that was
// already there rather than adding a second one.
//
// This is a completely separate capability from the internal Front
// discussion above it — no shared settings row, no shared recipient
// list, nothing overwritten. Structure mirrors CmmOutboundApptsEditor
// (Settings.jsx) exactly: settings (send time/days/active), TO/CC email
// lists, From channel + Draft Author pickers, internal comment +
// follower picker, Save + Create Draft Now (test).

function EmailListEditor({ label, emails, onChange }) {
  const [draft, setDraft] = useState('')

  function addEmail() {
    const trimmed = draft.trim().toLowerCase()
    if (!trimmed) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      alert(`"${trimmed}" doesn't look like a valid email address.`)
      return
    }
    if (emails.includes(trimmed)) { setDraft(''); return }
    onChange([...emails, trimmed])
    setDraft('')
  }

  function removeEmail(email) {
    onChange(emails.filter(e => e !== email))
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {emails.map(email => (
          <span key={email} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 3,
            fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--brand-bg, rgba(61,186,126,0.12))',
          }}>
            {email}
            <button
              onClick={() => removeEmail(email)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12, lineHeight: 1, padding: 0 }}
              aria-label={`Remove ${email}`}
            >×</button>
          </span>
        ))}
        {emails.length === 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>None added yet.</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="email"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEmail() } }}
          placeholder="name@example.com"
          className="est-drops-select"
          style={{ flex: 1 }}
        />
        <button className="settings-save-btn" onClick={addEmail}>Add</button>
      </div>
    </div>
  )
}

export default function DailyDiscussionEmailEditor({ facility, teammates }) {
  const [settings, setSettings]   = useState(null)
  const [channels, setChannels]   = useState([])
  const [syncingChannels, setSyncingChannels] = useState(false)
  const [toEmails, setToEmails]   = useState([])
  const [ccEmails, setCcEmails]   = useState([])
  const [selectedFollowers, setSelectedFollowers] = useState(new Set())
  const [comment, setComment]     = useState('')
  const [authorId, setAuthorId]   = useState('')
  const [channelId, setChannelId] = useState('')
  const [notifyHour, setNotifyHour] = useState(18)
  const [notifyMinute, setNotifyMinute] = useState(0)
  const [notifyDays, setNotifyDays] = useState([1, 2, 3, 4, 5, 6, 7])
  const [active, setActive]       = useState(false)
  const [loading, setLoading]     = useState(true)
  const [saveState, setSave]      = useState(null)
  const [testState, setTestState] = useState(null)
  const [testDetail, setTestDetail] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const [s, chans, emails, followers] = await Promise.all([
        fetchDailyDiscussionEmailSettings(facility),
        fetchFrontChannels(),
        fetchDailyDiscussionEmailRecipients(facility),
        fetchDailyDiscussionEmailFollowers(facility),
      ])
      if (cancelled) return
      setSettings(s)
      setChannels(chans)
      setToEmails((emails.to || []).map(r => r.email))
      setCcEmails((emails.cc || []).map(r => r.email))
      setSelectedFollowers(new Set(followers.filter(r => r.front_teammate_id).map(r => r.front_teammate_id)))
      if (s) {
        setNotifyHour(s.notify_hour ?? 18)
        setNotifyMinute(s.notify_minute ?? 0)
        setNotifyDays(s.notify_days ?? [1, 2, 3, 4, 5, 6, 7])
        setActive(!!s.active)
        setComment(s.discussion_comment ?? '')
        setAuthorId(s.author_teammate_id ?? '')
        setChannelId(s.from_channel_id ?? '')
      } else {
        // No settings row yet for this facility — reset to defaults
        // rather than carrying over the previously-selected facility's
        // values (this component is re-mounted per facility switch via
        // the `key` prop in Settings.jsx, but defensive reset here too).
        setNotifyHour(18); setNotifyMinute(0); setNotifyDays([1, 2, 3, 4, 5, 6, 7])
        setActive(false); setComment(''); setAuthorId(''); setChannelId('')
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [facility])

  function toggleDay(day) {
    setNotifyDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort())
  }

  function toggleFollower(teammateId) {
    setSelectedFollowers(prev => {
      const next = new Set(prev)
      if (next.has(teammateId)) next.delete(teammateId)
      else next.add(teammateId)
      return next
    })
  }

  async function handleSyncChannels() {
    setSyncingChannels(true)
    try {
      await triggerFrontChannelsSync()
      setChannels(await fetchFrontChannels())
    } catch (err) {
      alert(`Failed to sync channels: ${err.message}`)
    } finally {
      setSyncingChannels(false)
    }
  }

  async function persist() {
    await Promise.all([
      upsertDailyDiscussionEmailSettings(facility, {
        notifyHour, notifyMinute, notifyDays, active,
        discussionComment: comment, authorTeammateId: authorId || null, fromChannelId: channelId || null,
      }),
      saveDailyDiscussionEmailRecipients(facility, toEmails, ccEmails),
      saveDailyDiscussionEmailFollowers(
        facility,
        teammates.filter(t => selectedFollowers.has(t.teammate_id))
      ),
    ])
  }

  async function handleSave() {
    setSave('saving')
    try {
      await persist()
      setSave('ok')
      setTimeout(() => setSave(null), 2500)
    } catch (err) {
      setSave('error')
      setTimeout(() => setSave(null), 3000)
    }
  }

  async function handleTest() {
    setTestState('running')
    setTestDetail(null)
    try {
      // Save current state first — same reasoning as CMM Outbound's
      // handleTest: a freshly-edited field that hasn't been saved yet
      // would otherwise produce a confusing result that doesn't match
      // what's on screen.
      await persist()
      const res = await triggerDailyDiscussionEmailTest(facility)
      if (res?.success) {
        setTestState('ok')
        setTestDetail(`Draft created: "${res.subject}" — ${res.apptCount} appt(s), ${res.toCount} TO / ${res.ccCount} CC, ${res.followerCount} follower(s).`)
      } else {
        setTestState('error')
        setTestDetail(res?.reason || 'No result returned.')
      }
    } catch (err) {
      setTestState('error')
      setTestDetail(err.message)
    }
    setTimeout(() => { setTestState(null); setTestDetail(null) }, 8000)
  }

  if (loading) {
    return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', padding: '24px 0' }}>Loading…</div>
  }

  const DAY_LABELS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 7]]

  return (
    <div className="daily-discussion-email-editor" style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
      <h4 style={{ margin: '0 0 4px' }}>Email Draft</h4>
      <p className="settings-page-sub" style={{ marginBottom: 16 }}>
        Creates a Front <strong>email draft</strong> (never sent automatically) listing tomorrow's full appointment
        list for the facility selected above — every customer, both directions. Completely separate from the
        internal discussion above; a human still reviews and sends it.
      </p>

      <div className="break-schedule-controls" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          Auto-create nightly (for the next day)
        </label>
        <div className="break-schedule-warehouse">
          <span className="break-schedule-warehouse-label">Send time (CT)</span>
          <select className="est-drops-select" value={notifyHour} onChange={e => setNotifyHour(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
          <select className="est-drops-select" value={notifyMinute} onChange={e => setNotifyMinute(Number(e.target.value))}>
            {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {DAY_LABELS.map(([label, day]) => (
          <button
            key={day}
            onClick={() => toggleDay(day)}
            className="settings-save-btn"
            style={{
              padding: '4px 10px', fontSize: 11,
              background: notifyDays.includes(day) ? 'var(--brand-bg, rgba(61,186,126,0.12))' : 'transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <EmailListEditor label="TO (external — receives the draft)" emails={toEmails} onChange={setToEmails} />
      <EmailListEditor label="CC (external — receives the draft)" emails={ccEmails} onChange={setCcEmails} />

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
          From (Front channel — the address the draft actually sends from)
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="est-drops-select" value={channelId} onChange={e => setChannelId(e.target.value)} style={{ minWidth: 280 }}>
            <option value="">— CSW Main (default) —</option>
            {channels.map(c => (
              <option key={c.channel_id} value={c.channel_id}>
                {c.name}{c.address ? ` <${c.address}>` : ''}
              </option>
            ))}
          </select>
          <button className="settings-save-btn" onClick={handleSyncChannels} disabled={syncingChannels}>
            {syncingChannels ? 'Syncing…' : 'Sync channels now'}
          </button>
        </div>
        <p className="settings-page-sub" style={{ marginTop: 4, fontSize: 10 }}>
          Front ties the From address to the channel a draft is created on, not to the Draft Author below —
          pick the actual inbox/address you want this to send from. {channels.length} channel(s) available.
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>Draft Author (Front teammate)</div>
        <select className="est-drops-select" value={authorId} onChange={e => setAuthorId(e.target.value)} style={{ minWidth: 240 }}>
          <option value="">— select —</option>
          {teammates.map(t => (
            <option key={t.teammate_id} value={t.teammate_id}>
              {[t.first_name, t.last_name].filter(Boolean).join(' ') || t.email}
            </option>
          ))}
        </select>
        <p className="settings-page-sub" style={{ marginTop: 4, fontSize: 10 }}>
          Required — Front needs an author to create the draft under. Controls who Front shows as the draft's
          owner, not the From address (that's the picker above).
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Internal discussion comment (posted on the draft, visible only to teammates below)
        </div>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          rows={3}
          placeholder="e.g. Flag anything that looks off before sending."
          className="est-drops-select"
          style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
        />
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Internal discussion people (added as conversation followers — {teammates.length} available)
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6,
          maxHeight: 260, overflowY: 'auto', padding: 8, border: '1px solid var(--border)', borderRadius: 4,
        }}>
          {teammates.map(t => {
            const label = [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email
            const checked = selectedFollowers.has(t.teammate_id)
            return (
              <label
                key={t.teammate_id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 3,
                  fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer',
                  background: checked ? 'var(--brand-bg, rgba(61,186,126,0.12))' : 'transparent',
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleFollower(t.teammate_id)} />
                <span>{label}</span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="settings-card-footer" style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="settings-save-btn" onClick={handleSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
        </button>
        <button className="settings-save-btn" onClick={handleTest} disabled={testState === 'running' || !authorId}>
          {testState === 'running' ? 'Creating…' : testState === 'ok' ? 'Created ✓' : testState === 'error' ? 'Failed' : 'Create Draft Now (test)'}
        </button>
        {testDetail && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: testState === 'error' ? '#e05a5a' : 'var(--text-dim)' }}>
            {testDetail}
          </span>
        )}
      </div>
      {!authorId && (
        <p className="settings-page-sub" style={{ marginTop: 8, fontStyle: 'italic' }}>
          Select a Draft Author above to enable the test button.
        </p>
      )}
    </div>
  )
}
