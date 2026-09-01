import { useState, useEffect } from 'react'
import {
  fetchShortageReportEmailSettings, upsertShortageReportEmailSettings,
  fetchShortageReportEmailRecipients, saveShortageReportEmailRecipients,
  fetchShortageReportEmailFollowers, saveShortageReportEmailFollowers,
  fetchFrontChannels, triggerFrontChannelsSync,
  triggerShortageReportEmailTest,
} from '../../lib/shortageReportEmail.js'
import { fetchFrontTeammates } from '../../lib/supabase.js'

// Customer Shortage Report EMAIL draft editor — added 2026-09-01, MOVED
// same day from an earlier "Daily Discussion Email" location per Dan's
// explicit feedback: "I would've thought they would live within the
// Customer Shortage Report tab" + "this needs to live within the
// Customer Shortage Report [tab] for when we get more customers other
// than Pretzilla built within it."
//
// Content is the shortage table itself (Material/Needed/Active/Inactive/
// Allocated/Short) — see the backend function's header
// (netlify/functions/lib/shortage-report-email-shared.cjs) for the full
// query/design writeup.
//
// Self-contained: fetches its own teammates list (unlike the earlier
// Settings-tab version, which shared a parent's already-loaded list —
// there's no equivalent parent state here). Takes `reportKey` +
// `reportLabel` as props rather than a facility, so a future second
// customer report in this same tab can render another instance of this
// component with a different reportKey — no restructuring needed.

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
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {emails.map(email => (
          <span key={email} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 3,
            fontSize: 11, background: 'rgba(61,186,126,0.12)',
          }}>
            {email}
            <button
              onClick={() => removeEmail(email)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary, #9aa1ac)', fontSize: 12, lineHeight: 1, padding: 0 }}
              aria-label={`Remove ${email}`}
            >×</button>
          </span>
        ))}
        {emails.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', fontStyle: 'italic' }}>None added yet.</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="email"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEmail() } }}
          placeholder="name@example.com"
          style={{ flex: 1, background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 8px' }}
        />
        <button
          onClick={addEmail}
          style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}
        >Add</button>
      </div>
    </div>
  )
}

const btnStyle = { background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }
const subStyle = { fontSize: 11, color: 'var(--text-secondary, #9aa1ac)' }
const labelRowStyle = { fontSize: 11, color: 'var(--text-secondary, #9aa1ac)', marginBottom: 6 }

export default function ShortageReportEmailEditor({ reportKey, reportLabel }) {
  const [teammates, setTeammates] = useState([])
  const [channels, setChannels] = useState([])
  const [syncingChannels, setSyncingChannels] = useState(false)
  const [toEmails, setToEmails] = useState([])
  const [ccEmails, setCcEmails] = useState([])
  const [selectedFollowers, setSelectedFollowers] = useState(new Set())
  const [comment, setComment] = useState('')
  const [authorId, setAuthorId] = useState('')
  const [channelId, setChannelId] = useState('')
  const [notifyHour, setNotifyHour] = useState(18)
  const [notifyMinute, setNotifyMinute] = useState(0)
  const [notifyDays, setNotifyDays] = useState([1, 2, 3, 4, 5, 6, 7])
  const [active, setActive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [saveState, setSave] = useState(null)
  const [testState, setTestState] = useState(null)
  const [testDetail, setTestDetail] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [s, tms, chans, emails, followers] = await Promise.all([
        fetchShortageReportEmailSettings(reportKey),
        fetchFrontTeammates(),
        fetchFrontChannels(),
        fetchShortageReportEmailRecipients(reportKey),
        fetchShortageReportEmailFollowers(reportKey),
      ])
      if (cancelled) return
      setTeammates(tms)
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
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [reportKey])

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
      upsertShortageReportEmailSettings(reportKey, {
        notifyHour, notifyMinute, notifyDays, active,
        discussionComment: comment, authorTeammateId: authorId || null, fromChannelId: channelId || null,
      }),
      saveShortageReportEmailRecipients(reportKey, toEmails, ccEmails),
      saveShortageReportEmailFollowers(
        reportKey,
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
      await persist()
      const res = await triggerShortageReportEmailTest(reportKey)
      if (res?.success) {
        setTestState('ok')
        setTestDetail(`Draft created: "${res.subject}" — ${res.materialCount} material(s), ${res.shortCount} short, ${res.toCount} TO / ${res.ccCount} CC, ${res.followerCount} follower(s).`)
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
    return <div style={{ color: 'var(--text-secondary, #9aa1ac)', padding: '12px 0' }}>Loading…</div>
  }

  const DAY_LABELS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 7]]

  return (
    <div style={{ marginTop: 24, background: 'var(--bg2, #1a1d24)', border: '1px solid var(--border, #2a2e38)', borderRadius: 6, overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded(s => !s)}
        style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text-primary, #fff)', padding: '10px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>
          Email Draft{' '}
          <span style={subStyle}>({reportLabel} — TO/CC editable below)</span>
        </span>
        <span style={subStyle}>{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {expanded && (
        <div style={{ padding: '0 14px 16px', borderTop: '1px solid var(--border, #2a2e38)' }}>
          <p style={{ ...subStyle, marginTop: 12 }}>
            Creates a Front <strong>email draft</strong> (never sent automatically) with this shortage table's data
            for {reportLabel}. A human still reviews and sends it.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12, marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary, #9aa1ac)' }}>
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
              Auto-create nightly (for the next day)
            </label>
            <label style={labelRowStyle}>
              Send time (CT){' '}
              <select value={notifyHour} onChange={e => setNotifyHour(Number(e.target.value))} style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 4px' }}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}
              </select>
              <select value={notifyMinute} onChange={e => setNotifyMinute(Number(e.target.value))} style={{ background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '2px 4px', marginLeft: 4 }}>
                {[0, 15, 30, 45].map(m => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {DAY_LABELS.map(([label, day]) => (
              <button
                key={day}
                onClick={() => toggleDay(day)}
                style={{ ...btnStyle, padding: '4px 10px', fontSize: 11, background: notifyDays.includes(day) ? 'rgba(61,186,126,0.12)' : 'transparent' }}
              >
                {label}
              </button>
            ))}
          </div>

          <EmailListEditor label="TO (external — receives the draft)" emails={toEmails} onChange={setToEmails} />
          <EmailListEditor label="CC (external — receives the draft)" emails={ccEmails} onChange={setCcEmails} />

          <div style={{ marginBottom: 16 }}>
            <div style={labelRowStyle}>From (Front channel — the address the draft actually sends from)</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={channelId} onChange={e => setChannelId(e.target.value)} style={{ minWidth: 260, background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 8px' }}>
                <option value="">— CSW Main (default) —</option>
                {channels.map(c => (
                  <option key={c.channel_id} value={c.channel_id}>
                    {c.name}{c.address ? ` <${c.address}>` : ''}
                  </option>
                ))}
              </select>
              <button onClick={handleSyncChannels} disabled={syncingChannels} style={btnStyle}>
                {syncingChannels ? 'Syncing…' : 'Sync channels now'}
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={labelRowStyle}>Draft Author (Front teammate)</div>
            <select value={authorId} onChange={e => setAuthorId(e.target.value)} style={{ minWidth: 220, background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '4px 8px' }}>
              <option value="">— select —</option>
              {teammates.map(t => (
                <option key={t.teammate_id} value={t.teammate_id}>
                  {[t.first_name, t.last_name].filter(Boolean).join(' ') || t.email}
                </option>
              ))}
            </select>
            <p style={{ ...subStyle, marginTop: 4 }}>Required — Front needs an author to create the draft under.</p>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={labelRowStyle}>Internal discussion comment (posted on the draft, visible only to teammates below)</div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={3}
              placeholder="e.g. Flag anything that looks off before sending."
              style={{ width: '100%', background: 'var(--bg2, #1a1d24)', color: 'var(--text-primary, #fff)', border: '1px solid var(--border, #2a2e38)', borderRadius: 4, padding: '6px 8px', resize: 'vertical' }}
            />
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={labelRowStyle}>Internal discussion people (added as conversation followers — {teammates.length} available)</div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6,
              maxHeight: 220, overflowY: 'auto', padding: 8, border: '1px solid var(--border, #2a2e38)', borderRadius: 4,
            }}>
              {teammates.map(t => {
                const label = [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email
                const checked = selectedFollowers.has(t.teammate_id)
                return (
                  <label
                    key={t.teammate_id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 3,
                      fontSize: 11, cursor: 'pointer',
                      background: checked ? 'rgba(61,186,126,0.12)' : 'transparent',
                    }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleFollower(t.teammate_id)} />
                    <span>{label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={handleSave} disabled={saveState === 'saving'} style={btnStyle}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save'}
            </button>
            <button onClick={handleTest} disabled={testState === 'running' || !authorId} style={btnStyle}>
              {testState === 'running' ? 'Creating…' : testState === 'ok' ? 'Created ✓' : testState === 'error' ? 'Failed' : 'Create Draft Now (test)'}
            </button>
            {testDetail && (
              <span style={{ fontSize: 10, color: testState === 'error' ? '#e5484d' : 'var(--text-secondary, #9aa1ac)' }}>
                {testDetail}
              </span>
            )}
          </div>
          {!authorId && (
            <p style={{ ...subStyle, marginTop: 8, fontStyle: 'italic' }}>Select a Draft Author above to enable the test button.</p>
          )}
        </div>
      )}
    </div>
  )
}
