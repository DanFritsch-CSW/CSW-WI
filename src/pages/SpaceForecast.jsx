import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import {
  monthKeys, monthLabel, deriveFc, loadFacility, saveZone, saveCustomer, saveScenario,
  deleteRow, TABLES, seedMadisonStarter, fetchLive, loadProjectMap, addProjectMap, matchLive, GROUP_LABEL,
} from '../lib/spaceForecast.js'

// /spaceforecast — per-facility capacity vs. projected footprint, next 12 months.
// Not linked in TopNav (App.jsx NO_TOPNAV_ROUTES also hides the nav shell) — same
// unlisted, no-gate posture as /dan and /lens.
//
// This is NOT the Customers > Space Planning tab (current footprint, space_*
// tables). It shares nothing with spacePlanning.js. Persistence lives in
// space_forecast_* tables via lib/spaceForecast.js.
//
// Model: positions = pallets / stack factor. Customer forecast months with no
// explicit value inherit the previous explicit month (then "Now").
// Alerts: status() compares today's count to the current month's forecast.
// "Now": plan rows linked to a Datex project (space_forecast_project_map) show the live
// LP count from MotherDuck (netlify/functions/space-forecast-live.cjs) and display the
// Datex project name. Unlinked rows keep a manual Now. Live values are display-only and
// never written to space_forecast_customers.

const KEYS = monthKeys()
const MONTHS = KEYS.map(monthLabel)

const F = {
  cal: { name: 'Caledonia', color: 'var(--cal, #e07b4d)' },
  mad: { name: 'Madison', color: 'var(--mad, #4d9de0)' },
  ken: { name: 'Kenosha', color: 'var(--ken, #3dba7e)' },
  wr: { name: 'Wisconsin Rapids', color: 'var(--wr, #d4b84a)' },
  ec: { name: 'Eau Claire', color: 'var(--ec, #c084fc)' },
}
const FAC_ORDER = ['cal', 'mad', 'ken', 'wr', 'ec']

const band = (pct) => {
  if (pct == null || !isFinite(pct)) return { c: 'var(--text-dim, #9aaabb)', t: '—' }
  if (pct < 70) return { c: 'var(--green, #1a8a52)', t: 'OK' }
  if (pct < 85) return { c: 'var(--yellow, #a07818)', t: 'Watch' }
  if (pct < 95) return { c: 'var(--orange, #d4824a)', t: 'High' }
  return { c: 'var(--red, #c0392b)', t: 'Over' }
}
const n0 = (n) => Math.round(n || 0).toLocaleString()

// Trigger rule (digest should additionally require 3 consecutive days out of band
// and only announce state changes: on track -> above -> on track).
const status = (c, cur = c.current) => {
  const f = c.fc[0] || 0
  const d = cur - f
  if (d > 0 && cur > f * (1 + c.up / 100) && d >= c.gap) return { s: 'above', d, f }
  if (d < 0 && cur < f * (1 - c.down / 100) && -d >= c.gap) return { s: 'below', d, f }
  return { s: 'ok', d, f }
}
const STATUS_UI = {
  above: { t: 'Above forecast', c: 'var(--red, #c0392b)' },
  below: { t: 'Below forecast', c: 'var(--blue, #2a72b8)' },
  ok: { t: 'On track', c: 'var(--green, #1a8a52)' },
}


// ── tiny shared styles ──────────────────────────────────────────────────
const card = { background: 'var(--bg1, #fff)', border: '1px solid var(--border, #dce2ec)', borderRadius: 'var(--r-lg, 12px)' }
const mono = { fontFamily: "var(--font-mono, 'DM Mono', monospace)" }
const label = { fontSize: 11, color: 'var(--text-secondary, #4b5a72)', fontWeight: 600 }
const btn = (on, color) => ({
  padding: '6px 12px', borderRadius: 'var(--r-md, 8px)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  fontFamily: 'inherit',
  border: `1px solid ${on ? color || 'var(--brand, #a07818)' : 'var(--border, #dce2ec)'}`,
  background: on ? 'var(--brand-bg, #fef9ec)' : 'var(--bg1, #fff)',
  color: on ? color || 'var(--brand, #a07818)' : 'var(--text-secondary, #4b5a72)',
})
const numInput = (w = 64) => ({
  ...mono, width: w, padding: '4px 6px', fontSize: 12, textAlign: 'right',
  border: '1px solid var(--border, #dce2ec)', borderRadius: 'var(--r-sm, 4px)',
  background: 'var(--bg2, #f8f9fb)', color: 'var(--text-primary, #111827)',
})

const EMPTY = { zones: [], customers: [], scen: [] }
const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2))

export default function SpaceForecast() {
  const [fac, setFac] = useState('mad')
  const [store, setStore] = useState({})
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [sync, setSync] = useState({ state: 'idle', msg: '' })
  const [busy, setBusy] = useState(false)
  const [zoneSel, setZoneSel] = useState('all')
  const [m, setM] = useState(0)
  const [dflt, setDflt] = useState({ up: 10, down: 10, gap: 25 })
  const timers = useRef({})

  const loaded = !!store[fac]
  useEffect(() => {
    if (store[fac]) return undefined
    if (!supabase) { setStore((s) => ({ ...s, [fac]: EMPTY })); return undefined }
    let dead = false
    setLoading(true); setLoadErr('')
    loadFacility(fac, KEYS)
      .then((d) => { if (!dead) setStore((s) => ({ ...s, [fac]: d })) })
      .catch((e) => { if (!dead) { setLoadErr(e.message || String(e)); setStore((s) => ({ ...s, [fac]: EMPTY })) } })
      .finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
  }, [fac, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // live feed (Datex via MotherDuck) + project map, per facility
  const [liveStore, setLiveStore] = useState({})
  const [liveTick, setLiveTick] = useState(0)
  const [showUnmapped, setShowUnmapped] = useState(true)
  const [addZone, setAddZone] = useState('')
  useEffect(() => {
    if (!loaded) return undefined
    let dead = false
    setLiveStore((s) => ({ ...s, [fac]: { ...(s[fac] || {}), status: 'loading' } }))
    Promise.all([fetchLive(fac), loadProjectMap(fac).catch((e) => { throw new Error('project map: ' + (e.message || e)) })])
      .then(([lv, map]) => { if (!dead) setLiveStore((s) => ({ ...s, [fac]: { status: 'ok', asOf: lv.asOf, rows: lv.rows, map } })) })
      .catch((e) => { if (!dead) setLiveStore((s) => ({ ...s, [fac]: { status: 'error', err: e.message || String(e) } })) })
    return () => { dead = true }
  }, [fac, loaded, liveTick])
  const live = liveStore[fac] || { status: 'loading' }
  const liveOn = live.status === 'ok'
  const match = useMemo(() => (liveOn ? matchLive(live.map, live.rows) : { byCustomer: {}, unmapped: [] }), [liveOn, live.map, live.rows])
  const linkOf = (c) => (liveOn ? match.byCustomer[c.id] || null : null)
  const curOf = (c) => { const l = linkOf(c); return l ? Math.round(l.lps) : c.current }
  const nameOf = (c) => {
    const l = linkOf(c)
    if (!l || !l.projects.length) return c.name
    return l.projects.map((p) => (p.mg != null ? `${p.name} · ${GROUP_LABEL[p.mg] || 'group ' + p.mg}` : p.name)).filter((v, i, a) => a.indexOf(v) === i).join(' + ')
  }

  const cur = store[fac] || EMPTY
  const { zones, customers } = cur
  const facScen = cur.scen
  const zoneIds = zoneSel === 'all' ? zones.map((z) => z.id) : [zoneSel]

  const update = (fn) => setStore((s) => ({ ...s, [fac]: fn(s[fac] || EMPTY) }))
  const persist = (key, fn) => {
    clearTimeout(timers.current[key])
    setSync({ state: 'saving', msg: '' })
    timers.current[key] = setTimeout(async () => {
      try { await fn(); setSync({ state: 'saved', msg: '' }) } catch (e) { setSync({ state: 'error', msg: e.message || String(e) }) }
    }, 500)
  }
  const now = async (fn) => {
    setSync({ state: 'saving', msg: '' })
    try { await fn(); setSync({ state: 'saved', msg: '' }) } catch (e) { setSync({ state: 'error', msg: e.message || String(e) }) }
  }

  // customers
  const patchCust = (id, p, currentChanged = false) => {
    const c0 = cur.customers.find((x) => x.id === id)
    if (!c0) return
    const c = { ...c0, ...p }
    if (p.current !== undefined) c.fc = deriveFc(c.fcMap, c.current, KEYS)
    update((f) => ({ ...f, customers: f.customers.map((x) => (x.id === id ? c : x)) }))
    persist('c' + id, () => saveCustomer(fac, c, { currentChanged }))
  }
  const setCell = (id, i, v) => {
    const c0 = cur.customers.find((x) => x.id === id)
    if (!c0) return
    const fcMap = { ...c0.fcMap, [KEYS[i]]: v }
    patchCust(id, { fcMap, fc: deriveFc(fcMap, c0.current, KEYS) })
  }
  const fillRight = (id, i) => {
    const c0 = cur.customers.find((x) => x.id === id)
    if (!c0) return
    const fcMap = {}
    KEYS.forEach((k, j) => { if (j < i && c0.fcMap[k] != null) fcMap[k] = c0.fcMap[k] })
    fcMap[KEYS[i]] = c0.fc[i]
    patchCust(id, { fcMap, fc: deriveFc(fcMap, c0.current, KEYS) })
  }
  const addCustomer = () => {
    const c = { id: newId(), zone: zoneSel === 'all' ? zones[0].id : zoneSel, name: 'New customer', stack: 1, current: 0, fcMap: {}, fc: Array(KEYS.length).fill(0), ...dflt }
    update((f) => ({ ...f, customers: [...f.customers, c] }))
    now(() => saveCustomer(fac, c))
  }
  const removeCustomer = (id) => {
    update((f) => ({ ...f, customers: f.customers.filter((x) => x.id !== id) }))
    now(() => deleteRow(TABLES.customer, id))
  }
  const applyAll = () => {
    const next = cur.customers.map((c) => ({ ...c, ...dflt }))
    update((f) => ({ ...f, customers: next }))
    now(async () => { for (const c of next) await saveCustomer(fac, c) })
  }

  // promote an unmapped Datex project into the plan: new plan row (flat forecast at today's count)
  // + a project map row covering every material group of that project
  const addFromLive = (u) => {
    const zid = addZone && zones.some((z) => z.id === addZone) ? addZone : zoneSel !== 'all' ? zoneSel : zones[0]?.id
    if (!zid) return
    const lps = Math.round(u.lps)
    const c = { id: newId(), zone: zid, name: u.name, stack: 1, current: lps, fcMap: {}, fc: Array(KEYS.length).fill(lps), ...dflt }
    update((f) => ({ ...f, customers: [...f.customers, c] }))
    setLiveStore((s) => ({ ...s, [fac]: { ...s[fac], map: [...s[fac].map, { id: newId(), customer: c.id, wid: u.wid, pid: u.pid, mg: null, name: u.name }] } }))
    now(async () => {
      await saveCustomer(fac, c, { currentChanged: true })
      await addProjectMap(fac, { wid: u.wid, pid: u.pid, mg: null, name: u.name, customerId: c.id })
    })
  }

  // zones
  const patchZone = (id, p) => {
    const idx = cur.zones.findIndex((z) => z.id === id)
    if (idx < 0) return
    const z = { ...cur.zones[idx], ...p }
    update((f) => ({ ...f, zones: f.zones.map((x) => (x.id === id ? z : x)) }))
    persist('z' + id, () => saveZone(fac, z, idx))
  }
  const addFirstZone = () => {
    const z = { id: newId(), name: 'New zone', note: '', capacity: 0 }
    update((f) => ({ ...f, zones: [...f.zones, z] }))
    now(() => saveZone(fac, z, cur.zones.length))
  }

  // scenarios
  const addScen = () => {
    const s = { id: newId(), name: 'New scenario', zone: zones[0].id, pallets: 500, stack: 1, from: 1, to: 3, on: true }
    update((f) => ({ ...f, scen: [...f.scen, s] }))
    now(() => saveScenario(fac, s, KEYS))
  }
  const updScen = (id, p) => {
    const s0 = cur.scen.find((x) => x.id === id)
    if (!s0) return
    const s = { ...s0, ...p }
    update((f) => ({ ...f, scen: f.scen.map((x) => (x.id === id ? s : x)) }))
    persist('s' + id, () => saveScenario(fac, s, KEYS))
  }
  const rmScen = (id) => {
    update((f) => ({ ...f, scen: f.scen.filter((x) => x.id !== id) }))
    now(() => deleteRow(TABLES.scenario, id))
  }

  const importMadison = async () => {
    setBusy(true)
    try {
      await seedMadisonStarter()
      setStore((s) => { const n = { ...s }; delete n.mad; return n })
      setSync({ state: 'saved', msg: '' })
    } catch (e) { setSync({ state: 'error', msg: e.message || String(e) }) } finally { setBusy(false) }
  }

  const calc = useMemo(() => {
    const base = (z, i) => customers.filter((c) => c.zone === z).reduce((s, c) => s + (c.fc[i] || 0) / (c.stack || 1), 0)
    const extra = (z, i) => facScen.filter((s) => s.on && s.zone === z && i >= s.from && i <= s.to).reduce((a, s) => a + s.pallets / (s.stack || 1), 0)
    const cap = (z) => zones.find((x) => x.id === z)?.capacity || 0
    return { base, extra, cap }
  }, [customers, facScen, zones])

  const series = MONTHS.map((_, i) => {
    const b = zoneIds.reduce((s, z) => s + calc.base(z, i), 0)
    const e = zoneIds.reduce((s, z) => s + calc.extra(z, i), 0)
    return { b, e, t: b + e }
  })
  const capAll = zoneIds.reduce((s, z) => s + calc.cap(z), 0)
  const alerts = customers.map((c) => { const cu = curOf(c); return { c, cu, ...status(c, cu) } }).filter((a) => a.s !== 'ok')
  const unmappedTotal = match.unmapped.reduce((a, u) => a + u.lps, 0)
  const rows = customers.filter((c) => zoneSel === 'all' || c.zone === zoneSel)
  const peak = series.reduce((a, s, i) => (s.t > a.v ? { v: s.t, i } : a), { v: 0, i: 0 })
  const firstOver = series.findIndex((s) => capAll > 0 && s.t > capAll)

  const syncText = { idle: '', saving: 'Saving…', saved: 'Saved', error: 'Save failed: ' + sync.msg }[sync.state]

  return (
    <div style={{ fontFamily: "var(--font-body, 'DM Sans', system-ui, sans-serif)", color: 'var(--text-primary, #111827)', background: 'var(--bg0, #f3f5f8)', padding: 16, minHeight: '100vh' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display, 'Syne', sans-serif)", fontSize: 24, fontWeight: 700 }}>Space forecast</h1>
          <span style={{ fontSize: 12, color: 'var(--text-secondary, #4b5a72)' }}>Capacity vs. projected footprint, next 12 months. Edits save automatically.</span>
          <span style={{ fontSize: 12, marginLeft: 'auto', color: sync.state === 'error' ? 'var(--red, #c0392b)' : 'var(--text-dim, #9aaabb)' }}>{syncText}</span>
        </div>

        {!supabase && <Banner tone="warn">Supabase isn't configured in this build, so edits won't be saved.</Banner>}
        {loadErr && <Banner tone="err">Couldn't load saved data: {loadErr}. If this is the first deploy, the space_forecast_* migration hasn't been applied yet.</Banner>}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {FAC_ORDER.map((id) => (
            <button key={id} onClick={() => { setFac(id); setZoneSel('all') }} style={{ ...btn(fac === id), display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: F[id].color }} />
              {F[id].name}
            </button>
          ))}
        </div>

        {loading || !loaded ? (
          <div style={{ ...card, padding: 24, fontSize: 13, color: 'var(--text-secondary, #4b5a72)' }}>Loading {F[fac].name}…</div>
        ) : zones.length === 0 ? (
          <EmptyFacility name={F[fac].name} onAdd={addFirstZone} onSeed={fac === 'mad' ? importMadison : null} busy={busy} />
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10, marginBottom: 14 }}>
              <ZoneCard active={zoneSel === 'all'} onClick={() => setZoneSel('all')} name="All zones" note={MONTHS[m]}
                cap={zones.reduce((s, z) => s + z.capacity, 0)}
                used={zones.reduce((s, z) => s + calc.base(z.id, m) + calc.extra(z.id, m), 0)} />
              {zones.map((z) => (
                <ZoneCard key={z.id} active={zoneSel === z.id} onClick={() => setZoneSel(z.id)} name={z.name} note={z.note}
                  cap={z.capacity} used={calc.base(z.id, m) + calc.extra(z.id, m)}
                  onCap={(v) => patchZone(z.id, { capacity: v })} />
              ))}
            </div>

            <div style={{ ...card, padding: 14, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {zoneSel === 'all' ? 'All zones' : zones.find((z) => z.id === zoneSel)?.name}: positions by month
                </div>
                <div style={{ fontSize: 12, color: firstOver >= 0 ? 'var(--red, #c0392b)' : 'var(--text-secondary, #4b5a72)' }}>
                  {firstOver >= 0
                    ? `Over capacity from ${MONTHS[firstOver]}; peak ${MONTHS[peak.i]} at ${n0(peak.v)} vs ${n0(capAll)} (${n0(peak.v - capAll)} short)`
                    : `Peak ${n0(peak.v)} of ${n0(capAll)} positions in ${MONTHS[peak.i]}`}
                </div>
              </div>
              <Chart series={series} cap={capAll} sel={m} onSel={setM} color={F[fac].color} />
              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-secondary, #4b5a72)', marginTop: 6, flexWrap: 'wrap' }}>
                <Legend swatch={F[fac].color} text="Customer forecast" />
                <Legend swatch="url(#hatch)" text="What-if scenarios" hatch />
                <Legend dash text="Capacity" />
              </div>
            </div>

            <Scenarios zones={zones} list={facScen} onAdd={addScen} onUpdate={updScen} onRemove={rmScen} />

            <div style={{ height: 14 }} />
            <AlertsPanel alerts={alerts} zones={zones} dflt={dflt} setDflt={setDflt} month={MONTHS[0]} applyAll={applyAll} nameOf={nameOf} />

            <div style={{ ...card, overflow: 'hidden' }}>
              <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Customer forecast (pallets)</div>
                <button style={btn(false)} onClick={addCustomer}>Add customer</button>
              </div>
              <div style={{ padding: '0 14px 10px', fontSize: 11, color: 'var(--text-secondary, #4b5a72)' }}>
                {live.status === 'loading' && 'Loading live counts from Datex…'}
                {live.status === 'error' && <span style={{ color: 'var(--red, #c0392b)' }}>Live counts unavailable ({live.err}). “Now” shows the typed values on file.</span>}
                {liveOn && (
                  <>
                    <span style={{ ...mono, display: 'inline-block', padding: '0 6px', borderRadius: 4, background: 'var(--green-bg, #eaf6ef)', border: '1px solid var(--green, #1a8a52)', color: 'var(--green, #1a8a52)', marginRight: 6 }}>live</span>
                    “Now” = on-hand license plates from Datex as of <b>{live.asOf}</b>, for rows linked to a Datex project. Typed values are kept on file but not used for linked rows.
                    LPs are raw counts: Positions = LPs ÷ Stack, so rows imported in positions (Stack 1) can read high for stacked or bulk product until stackability overrides are set.
                    {' '}<button style={{ ...btn(false), padding: '1px 8px' }} onClick={() => setLiveTick((t) => t + 1)}>Refresh</button>
                  </>
                )}
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg3, #edf0f5)', color: 'var(--text-secondary, #4b5a72)' }}>
                      <th style={{ ...th('left', 210), ...stickyCol('var(--bg3, #edf0f5)'), zIndex: 3 }} title="Datex project name for rows linked to MotherDuck; the plan label otherwise">Customer</th>
                      {zoneSel === 'all' && <th style={th('left')}>Zone</th>}
                      <th style={th('right')}>Stack</th>
                      <th style={th('right')} title="Green = live LPs from Datex (MotherDuck). White = typed by hand.">Now</th>
                      <th style={th('left')}>Status</th>
                      {MONTHS.map((mo, i) => (
                        <th key={KEYS[i]} onClick={() => setM(i)} style={{ ...th('right'), cursor: 'pointer', color: i === m ? 'var(--brand, #a07818)' : undefined, background: i === m ? 'var(--brand-bg, #fef9ec)' : undefined }}>{mo}</th>
                      ))}
                      <th style={th('right')}>Pos @ {MONTHS[m]}</th>
                      <th style={th('right')}>Over %</th>
                      <th style={th('right')}>Under %</th>
                      <th style={th('right')}>Min gap</th>
                      <th style={th('right')} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} style={{ borderTop: '1px solid var(--border-subtle, #eceff5)' }}>
                        <td style={{ ...td(), ...stickyCol('var(--bg1, #fff)') }}>
                          {linkOf(c) ? (
                            <div title={`Datex project${linkOf(c).projects.length > 1 ? 's' : ''}: ${nameOf(c)}\nPlan label: ${c.name}`}>
                              <div style={{ ...numInput(190), textAlign: 'left', fontFamily: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'var(--bg3, #edf0f5)', cursor: 'default' }}>{nameOf(c)}</div>
                              {nameOf(c) !== c.name && <div style={{ fontSize: 10, color: 'var(--text-dim, #9aaabb)', maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis' }}>plan label: {c.name}</div>}
                            </div>
                          ) : (
                            <input value={c.name} onChange={(e) => patchCust(c.id, { name: e.target.value })} style={{ ...numInput(190), textAlign: 'left', fontFamily: 'inherit' }} />
                          )}
                        </td>
                        {zoneSel === 'all' && (
                          <td style={td()}>
                            <select value={c.zone} onChange={(e) => patchCust(c.id, { zone: e.target.value })} style={{ ...numInput(110), textAlign: 'left', fontFamily: 'inherit' }}>
                              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                            </select>
                          </td>
                        )}
                        <td style={td('right')}><input type="number" step="0.05" value={c.stack} onChange={(e) => patchCust(c.id, { stack: Number(e.target.value) || 1 })} style={numInput(52)} /></td>
                        <td style={td('right')}>
                          {linkOf(c) ? (
                            <span
                              title={`Live from Datex (MotherDuck), as of ${live.asOf}\nLPs: ${n0(linkOf(c).lps)}   Datex weighted: ${n0(linkOf(c).weighted)}\nTyped value on file (not used): ${n0(c.current)}\n` +
                                linkOf(c).projects.map((p) => '• ' + p.name + (p.mg != null ? ' · ' + (GROUP_LABEL[p.mg] || 'group ' + p.mg) : '')).join('\n')}
                              style={{ ...numInput(62), display: 'inline-block', background: 'var(--green-bg, #eaf6ef)', borderColor: 'var(--green, #1a8a52)', cursor: 'help' }}
                            >{n0(curOf(c))}</span>
                          ) : (
                            <input type="number" value={c.current} onChange={(e) => patchCust(c.id, { current: Number(e.target.value) || 0 }, true)} title="Today's pallet count, typed by hand (this row isn't linked to a Datex project)" style={{ ...numInput(62), background: 'var(--bg1, #fff)' }} />
                          )}
                        </td>
                        <td style={td()}><StatusChip c={c} cur={curOf(c)} /></td>
                        {c.fc.map((v, i) => (
                          <td key={KEYS[i]} style={{ ...td('right'), background: i === m ? 'var(--brand-bg, #fef9ec)' : undefined }}>
                            <input type="number" value={v} onChange={(e) => setCell(c.id, i, Number(e.target.value) || 0)} onDoubleClick={() => fillRight(c.id, i)}
                              title="Double-click to carry this value through all later months" style={{ ...numInput(58), borderColor: c.fcMap[KEYS[i]] != null ? 'var(--brand-dim, #ddc87c)' : undefined }} />
                          </td>
                        ))}
                        <td style={{ ...td('right'), ...mono, fontWeight: 600 }}>{n0((c.fc[m] || 0) / (c.stack || 1))}</td>
                        <td style={td('right')}><input type="number" value={c.up} onChange={(e) => patchCust(c.id, { up: Number(e.target.value) || 0 })} style={numInput(46)} /></td>
                        <td style={td('right')}><input type="number" value={c.down} onChange={(e) => patchCust(c.id, { down: Number(e.target.value) || 0 })} style={numInput(46)} /></td>
                        <td style={td('right')}><input type="number" value={c.gap} onChange={(e) => patchCust(c.id, { gap: Number(e.target.value) || 0 })} style={numInput(52)} /></td>
                        <td style={td('right')}>
                          <button onClick={() => removeCustomer(c.id)} style={{ ...btn(false), padding: '2px 8px', color: 'var(--red, #c0392b)' }}>Remove</button>
                        </td>
                      </tr>
                    ))}
                    {liveOn && match.unmapped.length > 0 && (
                      <tr style={{ borderTop: '2px solid var(--border, #dce2ec)', background: 'var(--bg2, #f8f9fb)' }}>
                        <td style={{ ...td(), ...stickyCol('var(--bg2, #f8f9fb)'), fontWeight: 600 }}>Not in plan ({match.unmapped.length} Datex projects, see below)</td>
                        <td colSpan={zoneSel === 'all' ? 2 : 1} />
                        <td style={{ ...td('right'), ...mono, fontWeight: 600 }}>{n0(unmappedTotal)}</td>
                        <td style={{ ...td(), fontSize: 11, color: 'var(--text-secondary, #4b5a72)' }}>unmapped</td>
                        <td colSpan={17} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--text-dim, #9aaabb)' }}>
                Positions = pallets / stack factor. Gold-outlined cells are explicit forecasts; other months inherit the month before. Double-click a cell to carry it through the later months.
                Status compares "Now" to this month's forecast. "Now" is live from Datex for rows linked to a project and typed by hand for the rest.
                {fac === 'mad' && ' Madison starter data came from an older workbook snapshot; update "Now" before trusting alerts.'}
              </div>
            </div>

            {liveOn && match.unmapped.length > 0 && (
              <div style={{ ...card, marginTop: 14, overflow: 'hidden' }}>
                <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Unmapped Datex inventory <span style={{ ...mono, fontWeight: 400, color: 'var(--text-secondary, #4b5a72)' }}>{n0(unmappedTotal)} LPs, {match.unmapped.length} projects</span></div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary, #4b5a72)' }}>On hand in Datex as of {live.asOf} but not linked to any plan row, so it is missing from the plan. “Add to plan” creates a row named for the Datex project, starting flat at today's count.</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Field l="Add to">
                      <select value={addZone && zones.some((z) => z.id === addZone) ? addZone : zoneSel !== 'all' ? zoneSel : zones[0]?.id} onChange={(e) => setAddZone(e.target.value)} style={{ ...numInput(120), textAlign: 'left', fontFamily: 'inherit' }}>
                        {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                      </select>
                    </Field>
                    <button style={btn(false)} onClick={() => setShowUnmapped((v) => !v)}>{showUnmapped ? 'Hide' : 'Show'}</button>
                  </div>
                </div>
                {showUnmapped && (
                  <div style={{ maxHeight: 360, overflowY: 'auto', borderTop: '1px solid var(--border-subtle, #eceff5)' }}>
                    {match.unmapped.map((u) => (
                      <div key={`${u.wid}:${u.pid}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 14px', borderTop: '1px solid var(--border-subtle, #eceff5)', fontSize: 12 }}>
                        <span style={{ fontWeight: 600, minWidth: 250 }}>{u.name}</span>
                        <span style={{ color: 'var(--text-secondary, #4b5a72)', flex: 1, fontSize: 11 }}>
                          {u.groups.map((g) => `${g.name} ${n0(g.lps)}`).join(' · ')}
                        </span>
                        <span style={{ ...mono, minWidth: 60, textAlign: 'right' }}>{n0(u.lps)}</span>
                        <button style={{ ...btn(false), padding: '2px 8px' }} onClick={() => addFromLive(u)}>Add to plan</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Banner({ tone, children }) {
  const c = tone === 'err' ? 'var(--red, #c0392b)' : 'var(--yellow, #a07818)'
  return <div style={{ ...card, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: c, borderColor: c }}>{children}</div>
}

const th = (align = 'left', minW) => ({ padding: '8px 8px', textAlign: align, fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap', minWidth: minW })
const td = (align = 'left') => ({ padding: '4px 8px', textAlign: align, whiteSpace: 'nowrap' })
// Frozen first column: stays put while the month columns scroll sideways (needs an opaque background)
const stickyCol = (bg) => ({ position: 'sticky', left: 0, zIndex: 2, background: bg, boxShadow: '1px 0 0 var(--border, #dce2ec)' })

function StatusChip({ c, cur }) {
  const st = status(c, cur)
  const u = STATUS_UI[st.s]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: u.c, fontWeight: 600 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: u.c }} />
      {st.s === 'ok' ? u.t : `${u.t} ${st.d > 0 ? '+' : ''}${n0(st.d)}`}
    </span>
  )
}

function AlertsPanel({ alerts, zones, dflt, setDflt, applyAll, month, nameOf }) {
  const zn = (id) => zones.find((z) => z.id === id)?.name || ''
  return (
    <div style={{ ...card, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Forecast alerts</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary, #4b5a72)' }}>Today's count vs. the {month} forecast. This is what the daily digest would announce.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Field l="Default over %"><input type="number" value={dflt.up} onChange={(e) => setDflt({ ...dflt, up: Number(e.target.value) || 0 })} style={numInput(46)} /></Field>
          <Field l="under %"><input type="number" value={dflt.down} onChange={(e) => setDflt({ ...dflt, down: Number(e.target.value) || 0 })} style={numInput(46)} /></Field>
          <Field l="min gap"><input type="number" value={dflt.gap} onChange={(e) => setDflt({ ...dflt, gap: Number(e.target.value) || 0 })} style={numInput(52)} /></Field>
          <button style={btn(false)} onClick={applyAll}>Apply to all</button>
        </div>
      </div>
      {alerts.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--green, #1a8a52)' }}>Every customer is within threshold.</div>
      ) : (
        alerts.map(({ c, cu, s, d, f }) => (
          <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--border-subtle, #eceff5)', fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_UI[s].c, flex: 'none', alignSelf: 'center' }} />
            <span style={{ fontWeight: 600, minWidth: 150 }}>{nameOf(c)}</span>
            <span style={{ color: 'var(--text-secondary, #4b5a72)' }}>{zn(c.zone)}</span>
            <span style={{ ...mono, marginLeft: 'auto' }}>
              {n0(cu)} vs {n0(f)} forecast ({d > 0 ? '+' : ''}{n0(d)}, {f ? ((d / f) * 100).toFixed(0) : '—'}%)
            </span>
          </div>
        ))
      )}
    </div>
  )
}

function ZoneCard({ name, note, cap, used, active, onClick, onCap }) {
  const pct = cap > 0 ? (used / cap) * 100 : null
  const b = band(pct)
  const free = cap - used
  return (
    <div onClick={onClick} style={{ ...card, padding: 12, cursor: 'pointer', borderColor: active ? 'var(--brand, #a07818)' : 'var(--border, #dce2ec)', background: active ? 'var(--brand-bg, #fef9ec)' : 'var(--bg1, #fff)' }}>
      <div style={{ fontSize: 12, fontWeight: 700 }}>{name}</div>
      <div style={{ fontSize: 10, color: 'var(--text-dim, #9aaabb)', minHeight: 14 }}>{note}</div>
      <div style={{ ...mono, fontSize: 22, fontWeight: 600, color: b.c, marginTop: 4 }}>{pct == null ? '—' : pct.toFixed(0) + '%'}</div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--bg4, #e2e7ef)', margin: '6px 0', overflow: 'hidden' }}>
        <div style={{ width: Math.min(100, pct || 0) + '%', height: '100%', background: b.c }} />
      </div>
      <div style={{ ...mono, fontSize: 11, color: 'var(--text-secondary, #4b5a72)' }}>
        {n0(used)} / {onCap ? (
          <input type="number" value={cap} onClick={(e) => e.stopPropagation()} onChange={(e) => onCap(Number(e.target.value) || 0)} style={{ ...numInput(60), padding: '1px 4px' }} />
        ) : n0(cap)}
      </div>
      <div style={{ fontSize: 11, color: free < 0 ? 'var(--red, #c0392b)' : 'var(--text-secondary, #4b5a72)' }}>
        {free < 0 ? `${n0(-free)} over` : `${n0(free)} open`}
      </div>
    </div>
  )
}

function Chart({ series, cap, sel, onSel, color }) {
  const W = 760, H = 230, L = 46, R = 10, T = 14, B = 26
  const max = Math.max(cap, ...series.map((s) => s.t), 1) * 1.12
  const y = (v) => T + (H - T - B) * (1 - v / max)
  const bw = (W - L - R) / series.length
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round((max / 1.12) * p))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Projected positions by month against capacity">
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--brand-bg, #fef9ec)" />
          <rect width="3" height="6" fill="var(--brand-light, #c9a227)" />
        </pattern>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border-subtle, #eceff5)" />
          <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-dim, #9aaabb)">{n0(t)}</text>
        </g>
      ))}
      {series.map((s, i) => {
        const x = L + i * bw + bw * 0.14
        const w = bw * 0.72
        const over = cap > 0 && s.t > cap
        return (
          <g key={i} onClick={() => onSel(i)} style={{ cursor: 'pointer' }}>
            <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill={i === sel ? 'var(--brand-bg, #fef9ec)' : 'transparent'} />
            <rect x={x} y={y(s.b)} width={w} height={Math.max(0, y(0) - y(s.b))} fill={color} opacity="0.9" rx="2" />
            {s.e > 0 && <rect x={x} y={y(s.t)} width={w} height={Math.max(0, y(s.b) - y(s.t))} fill="url(#hatch)" stroke="var(--brand-light, #c9a227)" strokeWidth="0.8" />}
            {over && <text x={x + w / 2} y={y(s.t) - 4} textAnchor="middle" fontSize="9" fontWeight="700" fill="var(--red, #c0392b)">+{n0(s.t - cap)}</text>}
            <text x={x + w / 2} y={H - 9} textAnchor="middle" fontSize="10" fontWeight={i === sel ? 700 : 400} fill={i === sel ? 'var(--brand, #a07818)' : 'var(--text-secondary, #4b5a72)'}>{MONTHS[i].split(' ')[0]}</text>
          </g>
        )
      })}
      {cap > 0 && (
        <g>
          <line x1={L} x2={W - R} y1={y(cap)} y2={y(cap)} stroke="var(--red, #c0392b)" strokeDasharray="5 4" strokeWidth="1.4" />
          <text x={W - R} y={y(cap) - 4} textAnchor="end" fontSize="10" fill="var(--red, #c0392b)">Capacity {n0(cap)}</text>
        </g>
      )}
    </svg>
  )
}

function Legend({ swatch, text, dash, hatch }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {dash ? <span style={{ width: 16, borderTop: '2px dashed var(--red, #c0392b)' }} />
        : hatch ? <svg width="14" height="10"><rect width="14" height="10" fill="var(--brand-light, #c9a227)" opacity="0.5" /></svg>
          : <span style={{ width: 12, height: 10, borderRadius: 2, background: swatch }} />}
      {text}
    </span>
  )
}

function Scenarios({ zones, list, onAdd, onUpdate, onRemove }) {
  const upd = onUpdate
  return (
    <div style={{ ...card, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>What-if scenarios</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary, #4b5a72)' }}>Test a new customer or a surge before committing space. Saved per facility.</div>
        </div>
        <button style={btn(false)} onClick={onAdd}>Add scenario</button>
      </div>
      {list.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-dim, #9aaabb)' }}>No scenarios for this facility.</div>}
      {list.map((s) => (
        <div key={s.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border-subtle, #eceff5)', opacity: s.on ? 1 : 0.5 }}>
          <input type="checkbox" checked={s.on} onChange={(e) => upd(s.id, { on: e.target.checked })} aria-label="Include scenario" />
          <input value={s.name} onChange={(e) => upd(s.id, { name: e.target.value })} style={{ ...numInput(170), textAlign: 'left', fontFamily: 'inherit' }} />
          <select value={s.zone} onChange={(e) => upd(s.id, { zone: e.target.value })} style={{ ...numInput(120), textAlign: 'left', fontFamily: 'inherit' }}>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <Field l="Pallets"><input type="number" value={s.pallets} onChange={(e) => upd(s.id, { pallets: Number(e.target.value) || 0 })} style={numInput(70)} /></Field>
          <Field l="Stack"><input type="number" step="0.05" value={s.stack} onChange={(e) => upd(s.id, { stack: Number(e.target.value) || 1 })} style={numInput(52)} /></Field>
          <Field l="From"><select value={s.from} onChange={(e) => upd(s.id, { from: Number(e.target.value) })} style={numInput(66)}>{MONTHS.map((mo, i) => <option key={i} value={i}>{mo}</option>)}</select></Field>
          <Field l="To"><select value={s.to} onChange={(e) => upd(s.id, { to: Number(e.target.value) })} style={numInput(66)}>{MONTHS.map((mo, i) => <option key={i} value={i}>{mo}</option>)}</select></Field>
          <span style={{ ...mono, fontSize: 11, color: 'var(--text-secondary, #4b5a72)' }}>{n0(s.pallets / (s.stack || 1))} pos</span>
          <button onClick={() => onRemove(s.id)} style={{ ...btn(false), padding: '2px 8px', color: 'var(--red, #c0392b)' }}>Remove</button>
        </div>
      ))}
    </div>
  )
}

const Field = ({ l, children }) => (
  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...label }}>{l}{children}</label>
)

function EmptyFacility({ name, onAdd, onSeed, busy }) {
  return (
    <div style={{ ...card, padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{name} has no zones yet</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary, #4b5a72)', margin: '0 auto 12px', maxWidth: 460 }}>
        Start with zone capacities, then add each customer's pallets and stack factor.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button style={btn(true)} onClick={onAdd} disabled={busy}>Add first zone</button>
        {onSeed && <button style={btn(false)} onClick={onSeed} disabled={busy}>{busy ? 'Importing…' : 'Import Madison workbook snapshot'}</button>}
      </div>
    </div>
  )
}
