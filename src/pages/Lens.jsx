import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  fetchContexts, saveContext, markContextReviewed, deleteContext, fetchContextHistory,
  fetchAccountMap, addAccountMap, deleteAccountMap,
  fetchRuns, rateRun, previewLensContext, runLensTest,
} from '../lib/lens.js'

// /lens — Customer Lens context editor + test bench. Not linked in TopNav
// (App.jsx's NO_TOPNAV_ROUTES also hides the nav shell here) — reached only by
// knowing the URL, same "URL obscurity is the only barrier" posture as /dan and
// /dpimonthly (Dan, 2026-10-08). NOTE: person notes and contract terms live in
// lens_context, which uses the app's open anon RLS pattern — keep notes factual.
//
// Layers: GLOBAL (one record) + FACILITY (site constraints, shared by every
// account at the site) + ACCOUNT (profile, people, open issues, never-promise).
// The server (lens-shared.cjs) assembles these at run time, so edits here take
// effect immediately with no redeploy. Phase 2 wires the Front @mention to the
// same assembly code; this page's Test tab runs it without touching Front.

const STALE_DAYS = 90
const SCOPE_LABEL = { global: 'Global', facility: 'Facilities', account: 'Accounts' }

const TEMPLATES = {
  account: `## Profile
- What they store/ship, volumes, which sites

## People
- Name: role, how they communicate, what they care about (facts only)

## Open issues
- (add a date to each line so stale items are easy to spot)

## Contract terms that affect replies
- Lead times, cutoffs, fees

## Never promise
- `,
  facility: `## Storage / layout constraints
- 

## Implication for customers
- 
`,
  global: '',
}

function daysSince(iso) {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

export default function Lens() {
  const [contexts, setContexts] = useState([])
  const [maps, setMaps] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState({ scope: 'global', key: 'global' })
  const [tab, setTab] = useState('editor')

  const load = useCallback(async () => {
    setLoading(true)
    const [c, m] = await Promise.all([fetchContexts(), fetchAccountMap()])
    setContexts(c)
    setMaps(m)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const grouped = useMemo(() => {
    const g = { global: [], facility: [], account: [] }
    contexts.forEach(c => { (g[c.scope] || []).push(c) })
    return g
  }, [contexts])

  const current = contexts.find(c => c.scope === sel.scope && c.key === sel.key) || null
  const accountKeys = grouped.account.map(a => a.key)
  const facilityKeys = grouped.facility.map(f => f.key)

  return (
    <div className="lens-root">
      <style>{STYLES}</style>
      <div className="lens-topbar">
        <div className="lens-badge">L</div>
        <div>
          <div className="lens-title">CUSTOMER LENS</div>
          <div className="lens-sub">csw-wi.netlify.app/lens</div>
        </div>
        <div className="lens-tabs">
          {['editor', 'test', 'runs'].map(t => (
            <button key={t} className={`lens-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
              {t === 'editor' ? 'Context' : t === 'test' ? 'Test' : 'Runs'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="lens-pad dim">Loading…</div>
      ) : tab === 'editor' ? (
        <div className="lens-split">
          <Sidebar grouped={grouped} sel={sel} setSel={setSel} onCreated={load} />
          <div className="lens-main">
            {current ? (
              <Editor
                key={`${current.scope}:${current.key}`}
                ctx={current}
                maps={maps.filter(m => m.account_key === current.key)}
                onChanged={load}
                onDeleted={() => { setSel({ scope: 'global', key: 'global' }); load() }}
              />
            ) : (
              <div className="lens-pad dim">Select a record on the left, or add one.</div>
            )}
          </div>
        </div>
      ) : tab === 'test' ? (
        <TestBench accountKeys={accountKeys} facilityKeys={facilityKeys} />
      ) : (
        <Runs />
      )}
    </div>
  )
}

function Sidebar({ grouped, sel, setSel, onCreated }) {
  const [adding, setAdding] = useState(null) // 'facility' | 'account' | null
  const [newKey, setNewKey] = useState('')
  const [err, setErr] = useState(null)

  async function create() {
    setErr(null)
    const key = newKey.trim()
    if (!key) { setErr('Enter a name.'); return }
    const normalized = adding === 'account' ? key.toLowerCase().replace(/\s+/g, '-') : key
    const r = await saveContext({ scope: adding, key: normalized, title: key, body: TEMPLATES[adding] })
    if (!r.success) { setErr(r.error); return }
    setSel({ scope: adding, key: normalized })
    setAdding(null); setNewKey('')
    onCreated()
  }

  return (
    <div className="lens-side">
      {['global', 'facility', 'account'].map(scope => (
        <div key={scope} className="lens-side-group">
          <div className="lens-side-head">
            <span>{SCOPE_LABEL[scope]}</span>
            {scope !== 'global' && (
              <button className="lens-mini" onClick={() => { setAdding(scope); setNewKey(''); setErr(null) }}>+ Add</button>
            )}
          </div>
          {grouped[scope].map(c => {
            const age = daysSince(c.reviewed_at)
            const stale = age != null && age > STALE_DAYS
            return (
              <button
                key={c.id}
                className={`lens-side-item ${sel.scope === c.scope && sel.key === c.key ? 'on' : ''}`}
                onClick={() => setSel({ scope: c.scope, key: c.key })}
              >
                <span>{c.title || c.key}</span>
                {stale && <span className="lens-stale">stale</span>}
              </button>
            )
          })}
          {adding === scope && (
            <div className="lens-add">
              <input
                className="lens-input"
                autoFocus
                placeholder={scope === 'account' ? 'Account name' : 'Facility name (as it appears in emails)'}
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && create()}
              />
              <button className="lens-btn save" onClick={create}>Create</button>
              <button className="lens-btn" onClick={() => setAdding(null)}>Cancel</button>
              {err && <div className="lens-err">{err}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function Editor({ ctx, maps, onChanged, onDeleted }) {
  const [title, setTitle] = useState(ctx.title || '')
  const [body, setBody] = useState(ctx.body || '')
  const [msg, setMsg] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [history, setHistory] = useState(null)

  const dirty = title !== (ctx.title || '') || body !== (ctx.body || '')
  const age = daysSince(ctx.reviewed_at)
  const stale = age != null && age > STALE_DAYS
  const words = body.trim() ? body.trim().split(/\s+/).length : 0

  async function save() {
    setSaving(true); setMsg(null)
    const r = await saveContext({ scope: ctx.scope, key: ctx.key, title, body })
    setSaving(false)
    setMsg(r.success ? { ok: true, text: 'Saved.' } : { ok: false, text: r.error })
    if (r.success) onChanged()
  }

  async function reviewed() {
    const r = await markContextReviewed(ctx.scope, ctx.key)
    setMsg(r.success ? { ok: true, text: 'Marked reviewed.' } : { ok: false, text: r.error })
    if (r.success) onChanged()
  }

  async function remove() {
    const r = await deleteContext(ctx.scope, ctx.key)
    if (r.success) onDeleted()
    else setMsg({ ok: false, text: r.error })
  }

  async function toggleHistory() {
    if (history) { setHistory(null); return }
    setHistory(await fetchContextHistory(ctx.scope, ctx.key))
  }

  return (
    <div className="lens-pad">
      <div className="lens-row-between">
        <div>
          <div className="lens-h">{SCOPE_LABEL[ctx.scope].replace(/s$/, '')}: {ctx.title || ctx.key}</div>
          <div className={`lens-meta ${stale ? 'warn' : ''}`}>
            key: {ctx.key} · last reviewed {age == null ? 'never' : `${age} day${age === 1 ? '' : 's'} ago`}
            {ctx.updated_by ? ` · by ${ctx.updated_by}` : ''}
            {stale ? ' · STALE, review it' : ''}
          </div>
        </div>
        <div className="lens-actions">
          <button className="lens-btn" onClick={reviewed}>Mark reviewed</button>
          <button className="lens-btn" onClick={toggleHistory}>{history ? 'Hide history' : 'History'}</button>
        </div>
      </div>

      <label className="lens-label">Display name</label>
      <input className="lens-input wide" value={title} onChange={e => setTitle(e.target.value)} />

      <label className="lens-label">Context (markdown; keep it under ~500 words) <span className="dim">· {words} words</span></label>
      <textarea className="lens-textarea" value={body} onChange={e => setBody(e.target.value)} rows={22} />
      {words > 500 && <div className="lens-err">Over 500 words. Long context dilutes the read and costs tokens on every run.</div>}

      <div className="lens-actions" style={{ marginTop: 10 }}>
        <button className="lens-btn save" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
        {ctx.scope !== 'global' && (
          confirmDel ? (
            <>
              <span className="dim">Delete this record?</span>
              <button className="lens-btn danger" onClick={remove}>Yes, delete</button>
              <button className="lens-btn" onClick={() => setConfirmDel(false)}>No</button>
            </>
          ) : (
            <button className="lens-btn danger" onClick={() => setConfirmDel(true)}>Delete</button>
          )
        )}
        {msg && <span className={msg.ok ? 'dim' : 'lens-err inline'}>{msg.text}</span>}
      </div>

      {ctx.scope === 'account' && <AccountMatchers accountKey={ctx.key} maps={maps} onChanged={onChanged} />}

      {history && (
        <div className="lens-box" style={{ marginTop: 16 }}>
          <div className="lens-label">Recent versions (click to load into the editor, then Save)</div>
          {history.length === 0 && <div className="dim">No history yet.</div>}
          {history.map(h => (
            <button key={h.id} className="lens-hist" onClick={() => { setTitle(h.title || ''); setBody(h.body || '') }}>
              {new Date(h.saved_at).toLocaleString()} · {h.updated_by || '?'} · {(h.body || '').length} chars
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AccountMatchers({ accountKey, maps, onChanged }) {
  const [type, setType] = useState('domain')
  const [value, setValue] = useState('')
  const [err, setErr] = useState(null)

  async function add() {
    setErr(null)
    if (!value.trim()) { setErr('Enter a value.'); return }
    const r = await addAccountMap(type, value, accountKey)
    if (!r.success) { setErr(r.error); return }
    setValue('')
    onChanged()
  }
  async function del(id) {
    await deleteAccountMap(id)
    onChanged()
  }

  return (
    <div className="lens-box" style={{ marginTop: 20 }}>
      <div className="lens-label">How the agent recognizes this account in Front</div>
      <div className="dim" style={{ marginBottom: 8 }}>
        External senders/recipients on the thread are matched here. Email beats domain. Example domain: example.com (no @).
      </div>
      {maps.length === 0 && <div className="lens-err">No matchers yet. Until you add one, the agent will report "account not identified" unless you type account:{accountKey} in the @mention.</div>}
      {maps.map(m => (
        <div key={m.id} className="lens-map-row">
          <span className="lens-pill">{m.match_type}</span>
          <span>{m.match_value}</span>
          <button className="lens-mini danger" onClick={() => del(m.id)}>Remove</button>
        </div>
      ))}
      <div className="lens-add" style={{ marginTop: 8 }}>
        <select className="lens-input" value={type} onChange={e => setType(e.target.value)}>
          <option value="domain">domain</option>
          <option value="email">email</option>
          <option value="front_account_id">front_account_id</option>
        </select>
        <input className="lens-input" placeholder="value" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} />
        <button className="lens-btn save" onClick={add}>Add</button>
        {err && <div className="lens-err">{err}</div>}
      </div>
    </div>
  )
}

function TestBench({ accountKeys, facilityKeys }) {
  const [account, setAccount] = useState('')
  const [facs, setFacs] = useState([])
  const [text, setText] = useState('')
  const [request, setRequest] = useState('How will this land with the customer, and how should we respond?')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [preview, setPreview] = useState(null)
  const [rated, setRated] = useState(null)

  const toggleFac = k => setFacs(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k])

  async function doPreview() {
    setPreview({ loading: true })
    try { setPreview(await previewLensContext(account, facs)) }
    catch (e) { setPreview({ ok: false, error: e.message }) }
  }

  async function run() {
    setRunning(true); setResult(null); setRated(null)
    try { setResult(await runLensTest({ text, requestText: request, accountKey: account || null, facilityKeys: facs })) }
    catch (e) { setResult({ ok: false, error: e.message }) }
    setRunning(false)
  }

  async function rate(r) {
    if (!result?.runId) return
    await rateRun(result.runId, r)
    setRated(r)
  }

  return (
    <div className="lens-pad" style={{ maxWidth: 900 }}>
      <div className="lens-h">Test bench</div>
      <div className="dim" style={{ marginBottom: 12 }}>
        Paste an email or thread, pick the account and site, and run the Lens. Nothing is written to Front.
      </div>

      <div className="lens-add">
        <label className="lens-label" style={{ margin: 0 }}>Account</label>
        <select className="lens-input" value={account} onChange={e => setAccount(e.target.value)}>
          <option value="">(none / unknown)</option>
          {accountKeys.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <label className="lens-label" style={{ margin: '0 0 0 12px' }}>Sites</label>
        {facilityKeys.map(k => (
          <label key={k} className="lens-check"><input type="checkbox" checked={facs.includes(k)} onChange={() => toggleFac(k)} /> {k}</label>
        ))}
      </div>

      <label className="lens-label">Email / thread</label>
      <textarea className="lens-textarea" rows={12} value={text} onChange={e => setText(e.target.value)} placeholder="Paste the customer email or whole thread here…" />

      <label className="lens-label">Your question (what you'd type after @agent)</label>
      <input className="lens-input wide" value={request} onChange={e => setRequest(e.target.value)} />

      <div className="lens-actions" style={{ marginTop: 10 }}>
        <button className="lens-btn" onClick={doPreview}>Preview context</button>
        <button className="lens-btn save" onClick={run} disabled={running || !text.trim()}>{running ? 'Running…' : 'Run Lens'}</button>
      </div>

      {preview && (
        <div className="lens-box" style={{ marginTop: 14 }}>
          <div className="lens-label">Assembled context (exactly what the model gets)</div>
          {preview.loading ? <div className="dim">Loading…</div>
            : preview.ok === false ? <div className="lens-err">{preview.error}</div>
            : <pre className="lens-pre">{preview.assembledContext || '(empty)'}</pre>}
        </div>
      )}

      {result && (
        <div className="lens-box" style={{ marginTop: 14 }}>
          <div className="lens-label">Lens output</div>
          {result.ok === false
            ? <div className="lens-err">{result.error}{/timeout|502|504/i.test(result.error || '') ? ' (looks like a function timeout)' : ''}</div>
            : <pre className="lens-pre">{result.output}</pre>}
          {result.ok !== false && (
            <div className="lens-actions" style={{ marginTop: 8 }}>
              <button className={`lens-btn ${rated === 'up' ? 'save' : ''}`} onClick={() => rate('up')}>Useful</button>
              <button className={`lens-btn ${rated === 'down' ? 'danger' : ''}`} onClick={() => rate('down')}>Missed</button>
              {rated && <span className="dim">Logged.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Runs() {
  const [runs, setRuns] = useState(null)
  const [open, setOpen] = useState(null)
  const load = useCallback(async () => setRuns(await fetchRuns(30)), [])
  useEffect(() => { load() }, [load])

  async function rate(id, r) { await rateRun(id, r); load() }

  if (!runs) return <div className="lens-pad dim">Loading…</div>
  return (
    <div className="lens-pad" style={{ maxWidth: 900 }}>
      <div className="lens-h">Recent runs</div>
      {runs.length === 0 && <div className="dim">No runs yet.</div>}
      {runs.map(r => (
        <div key={r.id} className="lens-box" style={{ marginBottom: 8 }}>
          <div className="lens-row-between">
            <button className="lens-hist" onClick={() => setOpen(open === r.id ? null : r.id)}>
              {new Date(r.created_at).toLocaleString()} · {r.source}{r.account_key ? ` · ${r.account_key}` : ''}{r.facility_key ? ` · ${r.facility_key}` : ''}{r.error ? ' · ERROR' : ''}
            </button>
            <div className="lens-actions">
              <button className={`lens-mini ${r.rating === 'up' ? 'on' : ''}`} onClick={() => rate(r.id, 'up')}>Useful</button>
              <button className={`lens-mini ${r.rating === 'down' ? 'on danger' : ''}`} onClick={() => rate(r.id, 'down')}>Missed</button>
            </div>
          </div>
          {open === r.id && (
            <>
              {r.request_text && <div className="dim" style={{ margin: '6px 0' }}>Q: {r.request_text}</div>}
              {r.error ? <div className="lens-err">{r.error}</div> : <pre className="lens-pre">{r.output}</pre>}
              {r.front_conversation_id && <div className="dim">Front: {r.front_conversation_id}</div>}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

const STYLES = `
  .lens-root * { box-sizing: border-box; }
  .lens-root { background: var(--bg0); color: var(--text-primary); font-family: var(--font-display); font-size: 14px; line-height: 1.5; min-height: 100vh; padding-bottom: 60px; }
  .lens-topbar { display: flex; align-items: center; gap: 12px; padding: 0 24px; height: 56px; background: var(--bg1); border-bottom: 2px solid var(--brand-dim); }
  .lens-badge { width: 34px; height: 34px; border-radius: var(--r-sm); background: var(--brand); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 800; font-size: 15px; }
  .lens-title { font-weight: 800; font-size: 16px; letter-spacing: 0.10em; color: var(--brand); }
  .lens-sub { font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.12em; color: var(--text-dim); text-transform: uppercase; }
  .lens-tabs { margin-left: auto; display: flex; gap: 6px; }
  .lens-tab { font-family: var(--font-mono); font-size: 11px; padding: 5px 14px; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--bg2); color: var(--text-secondary); cursor: pointer; }
  .lens-tab.on { background: var(--brand); color: #fff; border-color: var(--brand); }
  .lens-split { display: grid; grid-template-columns: 250px 1fr; min-height: calc(100vh - 56px); }
  .lens-side { background: var(--bg1); border-right: 1px solid var(--border-subtle); padding: 14px 10px; }
  .lens-side-group { margin-bottom: 18px; }
  .lens-side-head { display: flex; justify-content: space-between; align-items: center; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim); padding: 0 6px 6px; }
  .lens-side-item { display: flex; justify-content: space-between; width: 100%; text-align: left; font-size: 13px; padding: 6px 8px; border-radius: var(--r-sm); border: 1px solid transparent; background: transparent; color: var(--text-primary); cursor: pointer; }
  .lens-side-item:hover { background: var(--bg3); }
  .lens-side-item.on { background: var(--brand-bg); border-color: var(--brand-dim); color: var(--brand); font-weight: 600; }
  .lens-stale { font-family: var(--font-mono); font-size: 9px; color: var(--red); text-transform: uppercase; }
  .lens-main { min-width: 0; }
  .lens-pad { padding: 20px 24px; }
  .lens-h { font-size: 17px; font-weight: 800; letter-spacing: 0.03em; }
  .lens-meta { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); margin-top: 2px; }
  .lens-meta.warn { color: var(--red); }
  .lens-row-between { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .lens-label { display: block; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); margin: 14px 0 4px; }
  .lens-input { font-family: var(--font-mono); font-size: 12px; background: var(--bg1); border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--text-primary); padding: 6px 8px; }
  .lens-input.wide { width: 100%; }
  .lens-textarea { width: 100%; font-family: var(--font-mono); font-size: 12px; line-height: 1.55; background: var(--bg1); border: 1px solid var(--border); border-radius: var(--r-md); color: var(--text-primary); padding: 10px; resize: vertical; }
  .lens-textarea:focus, .lens-input:focus { outline: none; border-color: var(--brand); }
  .lens-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lens-btn { font-family: var(--font-mono); font-size: 11px; padding: 5px 12px; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--bg2); color: var(--text-primary); cursor: pointer; }
  .lens-btn:hover { background: var(--bg3); }
  .lens-btn.save { border-color: var(--brand-dim); color: var(--brand); background: var(--brand-bg); }
  .lens-btn.danger { border-color: #f0aaaa; color: var(--red); background: transparent; }
  .lens-btn:disabled { opacity: 0.5; cursor: default; }
  .lens-mini { font-family: var(--font-mono); font-size: 10px; padding: 2px 8px; border-radius: var(--r-sm); border: 1px solid var(--border); background: var(--bg1); color: var(--text-secondary); cursor: pointer; }
  .lens-mini.danger { border-color: #f0aaaa; color: var(--red); }
  .lens-mini.on { background: var(--brand-bg); color: var(--brand); border-color: var(--brand-dim); }
  .lens-box { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 12px 14px; }
  .lens-pre { white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 12px; line-height: 1.55; margin: 6px 0 0; color: var(--text-primary); }
  .lens-add { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 6px 0; }
  .lens-check { font-family: var(--font-mono); font-size: 11px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
  .lens-pill { font-family: var(--font-mono); font-size: 10px; background: var(--bg3); border: 1px solid var(--border); border-radius: 20px; padding: 1px 8px; }
  .lens-map-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-family: var(--font-mono); font-size: 12px; }
  .lens-hist { display: block; text-align: left; font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); background: transparent; border: none; padding: 3px 0; cursor: pointer; }
  .lens-hist:hover { color: var(--brand); }
  .lens-err { color: var(--red); font-family: var(--font-mono); font-size: 11px; margin-top: 4px; }
  .lens-err.inline { margin: 0; }
  .dim { color: var(--text-dim); font-family: var(--font-mono); font-size: 11px; }
`
