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
// REBUILT 2026-09-02, per Dan's explicit ask: "the automatic scheduling
// of the email does not always correlate to the timing of the processing
// of the orders" -- a fixed daily send time can catch orders
// mid-processing regardless of whether the schedule fires reliably (see
// the Netlify support ticket filed the same day for the separate
// reliability problem). Manual generation is now the ONLY path:
//
//   - The old "Create Draft Now (test)" button is now the PRIMARY action,
//     renamed "Generate Email Draft" and moved to the top of the
//     component -- not a secondary/test control anymore.
//   - Auto-create checkbox, send-time picker, and day-of-week toggles are
//     REMOVED from this UI entirely. The schedule itself was removed from
//     netlify.toml (shortage-report-email-run.cjs has no `schedule` key
//     anymore and is fully inert) -- there is no automatic path left to
//     configure, so no controls for it.
//   - The component is no longer collapsed-by-default -- it's the
//     primary way this feature gets used, so it's always expanded.
//   - Settings still persisted: TO/CC, From channel, Draft Author,
//     internal comment, internal followers. `active`/`notify_hour`/
//     `notify_minute`/`notify_days` are still written to
//     prepick_notify_settings (schema unchanged) but hardcoded to inert
//     defaults (active=false, hour/minute=0) on every save -- defensive,
//     so a schedule can never accidentally fire off stale saved values if
//     the function's schedule key were ever restored without updating
//     this file.
//
// Content is the shortage table itself (Material/Needed/Active/Inactive/
// Allocated/Short) -- see the backend function's header
// (netlify/functions/lib/shortage-report-email-shared.cjs) for the full
// query/design writeup.
//
// Self-contained: fetches its own teammates list. Takes `reportKey` +
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
const primaryBtnStyle = { background: '#38a169', color: '#fff', border: '1px solid #38a169', borderRadius: 6, padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600 }
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
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [saveState, setSave] = useState(null)
  const [generateState, setGenerateState] = useState(null)
  const [generateDetail, setGenerateDetail] = useState(null)

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
        setComment(s.discussion_comment ?? '')
        setAuthorId(s.author_teammate_id ?? '')
        setChannelId(s.from_channel_id ?? '')
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [reportKey])

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

  // notify_hour/notify_minute/active are hardcoded to inert defaults on
  // every save -- see file header. This feature has no scheduled path.
  async function persist() {
    await Promise.all([
      upsertShortageReportEmailSettings(reportKey, {
        notifyHour: 0, notifyMinute: 0, notifyDays: [], active: false,
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

  async function handleGenerate() {
    setGenerateState('running')
    setGenerateDetail(null)
    try {
      await persist()
      const res = await triggerShortageReportEmailTest(reportKey)
      if (res?.success) {
        setGenerateState('ok')
        setGenerateDetail(`Draft created: "${res.subject}" — ${res.materialCount} material(s), ${res.shortCount} short, ${res.toCount} TO / ${res.ccCount} CC, ${res.followerCount} follower(s).`)
      } else {
        setGenerateState('error')
        setGenerateDetail(res?.reason || 'No result returned.')
      }
    } catch (err) {
      setGenerateState('error')
      setGenerateDetail(err.message)
    }
    setTimeout(() => { setGenerateState(null); setGenerateDetail(null) }, 10000)
  }

  if (loading) {
    return <div style={{ color: 'var(--text-secondary, #9aa1ac)', padding: '12px 0' }}>Loading…</div>
  }

  return (
    <div style={{ marginTop: 24, background: 'var(--bg2, #1a1d24)', border: '1px solid var(--border, #2a2e38)', borderRadius: 6, padding: '16px 14px' }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #fff)', marginBottom: 4 }}>Email Draft</div>
        <p style={{ ...subStyle, margin: 0 }}>
          Creates a Front <strong>email draft</strong> (never sent automatically) with this shortage table's data
          for {reportLabel}, exactly as shown above right now. A human still reviews and sends it. There's no
          automatic schedule for this anymore — generate it manually once orders have finished processing for the day.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={handleGenerate} disabled={generateState === 'running' || !authorId || toEmails.length === 0} style={primaryBtnStyle}>
          {generateState === 'running' ? 'Generating…' : generateState === 'ok' ? 'Generated ✓' : generateState === 'error' ? 'Failed — see below' : 'Generate Email Draft'}
        </button>
        {!authorId && <span style={{ ...subStyle, fontStyle: 'italic' }}>Set a Draft Author below first.</span>}
        {authorId && toEmails.length === 0 && <span style={{ ...subStyle, fontStyle: 'italic' }}>Add at least one TO recipient below first.</span>}
      </div>

      {generateDetail && (
        <div style={{ fontSize: 12, color: generateState === 'error' ? '#e5484d' : 'var(--text-secondary, #9aa1ac)', marginBottom: 16, padding: '8px 10px', background: 'rgba(0,0,0,0.15)', borderRadius: 4 }}>
          {generateDetail}
        </div>
      )}

      <button
        onClick={() => setShowSettings(s => !s)}
        style={{ ...btnStyle, marginBottom: showSettings ? 16 : 0 }}
      >
        {showSettings ? 'Hide' : 'Show'} recipients & settings
      </button>

      {showSettings && (
        <div style={{ borderTop: '1px solid var(--border, #2a2e38)', paddingTop: 16 }}>
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
              {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'error' ? 'Error' : 'Save recipients & settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
