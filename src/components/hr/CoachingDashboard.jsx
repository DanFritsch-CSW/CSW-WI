/**
 * CoachingDashboard.jsx
 * -----------------------------------------------------------------------------
 * Manager coaching dashboard. Built by Tim Morris with Claude's help,
 * sent via Front (cnv_1c58erkk, 2026-08-14) for incorporation into the
 * HR tab. Design and logic are UNCHANGED from Tim's original — the only
 * edit is removing the build-time `import coachingData from
 * './coaching-data.json'` static import, since data now arrives live via
 * CoachingTab.jsx -> netlify/functions/sharepoint-coaching.cjs instead of
 * Tim's original xlsx -> python script -> committed JSON pipeline.
 *
 * 2026-09-04 — Tim flagged "alignment of column titles little wacky" after
 * seeing real data (screenshot via Front). Rendered the real component
 * with real Alex Andino data at Tim's exact screenshot width to diagnose
 * before touching anything: headers DO align correctly with their columns
 * (verified via headless Chromium render) — the actual issue is that each
 * LOE cell's status Chip used to render AFTER the goal text, so its
 * vertical position drifted depending on how long that particular goal's
 * wording was. Scanning LOE 1 -> LOE 2 -> LOE 3 status across a row looked
 * jagged since the three chips rarely lined up on the same line. Fixed by
 * moving the Chip to the top of each LoeCell, before the goal text, so all
 * three chips now always sit on the same horizontal line regardless of
 * goal length — confirmed via a second render before shipping.
 *
 * Usage:
 *   import CoachingDashboard from './CoachingDashboard';
 *   <CoachingDashboard data={data} />   // data always passed in now
 *
 * No dependencies beyond React. All styling is scoped to .csw-dash.
 */
import React, { useMemo, useState } from 'react';

/* ---------------------------------------------------------------- status --- */

const STATUS = {
  'complete':    { key: 'good',     label: 'Complete',    icon: '✓', rank: 0 },
  'on track':    { key: 'good',     label: 'On Track',    icon: '●', rank: 1 },
  'at risk':     { key: 'warning',  label: 'At Risk',     icon: '▲', rank: 3 },
  'off track':   { key: 'critical', label: 'Off Track',   icon: '■', rank: 4 },
  'not started': { key: 'neutral',  label: 'Not Started', icon: '○', rank: 2 },
};

const statusOf = (s) => STATUS[String(s || '').toLowerCase()] ||
  { key: 'neutral', label: s || 'Not Started', icon: '○', rank: 2 };

const HW = {
  'complete':     { key: 'good',     label: 'Complete',     icon: '✓' },
  'partial':      { key: 'warning',  label: 'Partial',      icon: '▲' },
  'not complete': { key: 'critical', label: 'Not Complete', icon: '■' },
  'no':           { key: 'critical', label: 'Not Complete', icon: '■' },
  'yes':          { key: 'good',     label: 'Complete',     icon: '✓' },
  'n/a':          { key: 'neutral',  label: 'N/A',          icon: '–' },
};

const hwOf = (v) => HW[String(v || '').toLowerCase()] || null;

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const daysSince = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((Date.now() - d.getTime()) / 86400000);
};

const roleLine = (m) => [m.title, m.team].filter(Boolean).join(', ');

/* ------------------------------------------------------------ primitives --- */

function Chip({ status }) {
  const s = statusOf(status);
  return (
    <span className={`chip chip--${s.key}`}>
      <span className="chip__icon" aria-hidden="true">{s.icon}</span>
      {s.label}
    </span>
  );
}

function HwChip({ value }) {
  const h = hwOf(value);
  if (!h) return <span className="muted">—</span>;
  return (
    <span className={`chip chip--${h.key}`}>
      <span className="chip__icon" aria-hidden="true">{h.icon}</span>
      {h.label}
    </span>
  );
}

function StatTile({ label, value, sub, tone = 'neutral' }) {
  return (
    <div className={`tile tile--${tone}`}>
      <div className="tile__label">{label}</div>
      <div className="tile__value">{value}</div>
      {sub ? <div className="tile__sub">{sub}</div> : null}
    </div>
  );
}

function LoeCell({ loe }) {
  if (!loe) return <td className="cell cell--loe"><span className="muted">—</span></td>;
  return (
    <td className="cell cell--loe">
      <Chip status={loe.status} />
      <div className="loe__goal">{loe.goal || <span className="muted">No goal set</span>}</div>
      {loe.notes
        ? <p className="loe__notes">{loe.notes}</p>
        : <p className="loe__notes loe__notes--empty">Notes not written yet</p>}
    </td>
  );
}

/* ------------------------------------------------------------- component --- */

export default function CoachingDashboard({ data }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [openManager, setOpenManager] = useState(null);
  const [sortBy, setSortBy] = useState('name');

  const managers = data?.managers ?? [];

  const rows = useMemo(() => {
    let out = managers.filter((m) => m.active !== false);

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((m) =>
        m.name.toLowerCase().includes(q) ||
        (m.title || '').toLowerCase().includes(q) ||
        (m.team || '').toLowerCase().includes(q) ||
        (m.latest?.recap || '').toLowerCase().includes(q) ||
        (m.latest?.overallComment || '').toLowerCase().includes(q) ||
        (m.latest?.lastHomework || '').toLowerCase().includes(q) ||
        (m.latest?.loes || []).some((l) =>
          (l.goal || '').toLowerCase().includes(q) || (l.notes || '').toLowerCase().includes(q)));
    }
    if (statusFilter !== 'all') {
      out = out.filter((m) =>
        (m.latest?.loes || []).some((l) => String(l.status).toLowerCase() === statusFilter));
    }
    if (pendingOnly) {
      out = out.filter((m) => (m.sessions || []).some(
        (s) => String(s.processingStatus).toLowerCase() === 'needs processing'));
    }

    const worstRank = (m) =>
      Math.max(0, ...(m.latest?.loes || []).map((l) => statusOf(l.status).rank));

    const sorters = {
      name: (a, b) => a.name.localeCompare(b.name),
      recent: (a, b) => (b.latest?.date || '').localeCompare(a.latest?.date || ''),
      risk: (a, b) => worstRank(b) - worstRank(a) || a.name.localeCompare(b.name),
    };
    return [...out].sort(sorters[sortBy] || sorters.name);
  }, [managers, query, statusFilter, pendingOnly, sortBy]);

  const stats = useMemo(() => {
    const active = managers.filter((m) => m.active !== false);
    const withLatest = active.filter((m) => m.latest);
    const allLoes = withLatest.flatMap((m) => m.latest.loes || []);
    const flagged = allLoes.filter((l) =>
      ['at risk', 'off track'].includes(String(l.status).toLowerCase()));
    const rated = withLatest
      .map((m) => hwOf(m.latest.hwCompletion))
      .filter((h) => h && h.label !== 'N/A');
    const hwDone = rated.filter((h) => h.label === 'Complete').length;
    const stale = withLatest.filter((m) => (daysSince(m.latest.date) ?? 0) > 30).length;

    return {
      managers: active.length,
      sessions: active.reduce((n, m) => n + (m.sessionCount || 0), 0),
      flagged: flagged.length,
      totalLoes: allLoes.length,
      hwDone,
      hwRated: rated.length,
      stale,
      pending: data?.pendingProcessing ?? 0,
    };
  }, [managers, data]);

  return (
    <div className="csw-dash">
      <style>{CSS}</style>

      <header className="head">
        <div>
          <h1 className="head__title">Manager Coaching Dashboard</h1>
          <p className="head__sub">
            Lines of Effort, session recaps and homework — sourced from{' '}
            <code>{data?.source || 'coaching-data.json'}</code>
            {data?.generatedAt ? ` · refreshed ${fmtDate(String(data.generatedAt).slice(0, 10))}` : ''}
          </p>
        </div>
        {stats.pending > 0 && (
          <div className="banner">
            <span aria-hidden="true">▲</span>
            {stats.pending} session{stats.pending === 1 ? '' : 's'} with a Fathom link still needs processing
          </div>
        )}
      </header>

      <section className="tiles" aria-label="Summary">
        <StatTile label="Managers coached" value={stats.managers}
          sub={`${stats.sessions} session${stats.sessions === 1 ? '' : 's'} logged`} />
        <StatTile label="LOEs tracked" value={stats.totalLoes}
          sub="Across each manager's latest session" />
        <StatTile label="LOEs needing attention" value={stats.flagged}
          sub="At risk or off track"
          tone={stats.flagged > 0 ? 'warning' : 'good'} />
        <StatTile label="Homework completed"
          value={stats.hwRated ? `${stats.hwDone} of ${stats.hwRated}` : '—'}
          sub={stats.hwRated ? 'Latest session per manager' : 'No ratings yet'}
          tone={stats.hwRated && stats.hwDone < stats.hwRated ? 'warning' : 'neutral'} />
        <StatTile label="Overdue check-ins" value={stats.stale}
          sub="No session in the last 30 days"
          tone={stats.stale > 0 ? 'critical' : 'good'} />
      </section>

      <section className="filters" aria-label="Filters">
        <input
          className="input"
          type="search"
          placeholder="Search manager, goal, note or recap…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
        />
        <label className="field">
          <span>LOE status</span>
          <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="on track">On Track</option>
            <option value="at risk">At Risk</option>
            <option value="off track">Off Track</option>
            <option value="complete">Complete</option>
            <option value="not started">Not Started</option>
          </select>
        </label>
        <label className="field">
          <span>Sort by</span>
          <select className="select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="name">Manager name</option>
            <option value="recent">Most recent session</option>
            <option value="risk">Needs attention first</option>
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
          <span>Needs processing only</span>
        </label>
        <span className="count">{rows.length} of {stats.managers} shown</span>
      </section>

      <section className="tablewrap" aria-label="Coaching roster">
        <table className="grid">
          <thead>
            <tr>
              <th className="col-mgr" scope="col">Manager</th>
              <th scope="col">Last session</th>
              <th scope="col">LOE 1</th>
              <th scope="col">LOE 2</th>
              <th scope="col">LOE 3</th>
              <th scope="col">Last homework</th>
              <th scope="col">HW completion</th>
              <th scope="col">Tim overall comment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const s = m.latest;
              const loes = s?.loes || [];
              const byN = (n) => loes.find((l) => l.n === n) || loes[n - 1] || null;
              const d = daysSince(s?.date);
              const isOpen = openManager === m.name;
              return (
                <React.Fragment key={m.name}>
                  <tr className={isOpen ? 'row row--open' : 'row'}>
                    <th scope="row" className="col-mgr">
                      <button
                        className="mgr"
                        onClick={() => setOpenManager(isOpen ? null : m.name)}
                        aria-expanded={isOpen}
                      >
                        <span className="mgr__caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                        <span>
                          <span className="mgr__name">{m.name}</span>
                          {roleLine(m) && <span className="mgr__meta">{roleLine(m)}</span>}
                        </span>
                      </button>
                    </th>
                    <td className="cell cell--date">
                      {s ? (
                        <>
                          <div>{fmtDate(s.date)}</div>
                          <div className={d !== null && d > 30 ? 'muted warn' : 'muted'}>
                            {d === null ? '' : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'} ago`}
                          </div>
                        </>
                      ) : <span className="muted">No sessions yet</span>}
                    </td>
                    <LoeCell loe={byN(1)} />
                    <LoeCell loe={byN(2)} />
                    <LoeCell loe={byN(3)} />
                    <td className="cell cell--hw">
                      {s?.lastHomework
                        ? (s.lastHomeworkItems?.length > 1
                          ? <ul className="hwlist hwlist--tight">
                              {s.lastHomeworkItems.map((h, i) => <li key={i}>{h}</li>)}
                            </ul>
                          : <span>{s.lastHomework}</span>)
                        : <span className="muted">—</span>}
                    </td>
                    <td className="cell cell--hwstatus"><HwChip value={s?.hwCompletion} /></td>
                    <td className="cell cell--comment">
                      {s?.overallComment || <span className="muted">—</span>}
                    </td>
                  </tr>

                  {isOpen && s && (
                    <tr className="detailrow">
                      <td className="col-mgr detailrow__spacer" />
                      <td colSpan={7}>
                        <div className="detail">
                          <div className="detail__col">
                            <h3 className="detail__h">
                              Meeting recap<span className="detail__date">{fmtDate(s.date)}</span>
                            </h3>
                            <p className="detail__body">
                              {s.recap || <span className="muted">Not filled in yet.</span>}
                            </p>
                            {s.fathomUrl && (
                              <a className="btn" href={s.fathomUrl} target="_blank" rel="noreferrer">
                                <span aria-hidden="true">▶</span> Watch the call on Fathom
                              </a>
                            )}
                            {String(s.processingStatus).toLowerCase() === 'needs processing' && (
                              <span className="pill pill--warning">Awaiting transcript processing</span>
                            )}
                          </div>

                          <div className="detail__col">
                            <h3 className="detail__h">
                              Last homework<HwChip value={s.hwCompletion} />
                            </h3>
                            {s.lastHomeworkItems?.length ? (
                              <ul className="hwlist">
                                {s.lastHomeworkItems.map((h, i) => (
                                  <li key={i}><span className="hwlist__box" aria-hidden="true">☐</span>{h}</li>
                                ))}
                              </ul>
                            ) : <p className="detail__body"><span className="muted">Nothing recorded.</span></p>}
                          </div>

                          <div className="detail__col">
                            <h3 className="detail__h">Session history</h3>
                            {m.sessions.length > 1 ? (
                              <table className="mini">
                                <thead>
                                  <tr><th>Date</th><th>HW</th><th>Comment</th><th>Call</th></tr>
                                </thead>
                                <tbody>
                                  {m.sessions.map((ss) => (
                                    <tr key={ss.row}>
                                      <td>{fmtDate(ss.date)}</td>
                                      <td>{hwOf(ss.hwCompletion)?.label || '—'}</td>
                                      <td>{ss.overallComment || '—'}</td>
                                      <td>{ss.fathomUrl
                                        ? <a href={ss.fathomUrl} target="_blank" rel="noreferrer">Open</a>
                                        : <span className="muted">—</span>}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : <p className="detail__body"><span className="muted">First session on record.</span></p>}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr><td className="empty" colSpan={8}>No managers match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="foot">
        <span className="legend" aria-label="Status legend">
          {['Complete', 'On Track', 'Not Started', 'At Risk', 'Off Track'].map((s) => (
            <Chip key={s} status={s} />
          ))}
        </span>
        <span className="muted">
          LOE = Line of Effort. Data refreshes live from SharePoint on page load.
        </span>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ CSS --- */

const CSS = `
.csw-dash {
  color-scheme: light;
  --surface-1:#fcfcfb; --plane:#f9f9f7;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --ring:rgba(11,11,11,0.10);
  --good:#0ca30c; --warning:#fab219; --critical:#d03b3b; --neutral:#898781;
  --good-track:#dff2df; --warning-track:#fdf0d4; --critical-track:#f7dcdc; --neutral-track:#ebeae5;
  --accent:#2a78d6;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text-primary);
  background: var(--plane);
  padding: 24px;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .csw-dash {
    color-scheme: dark;
    --surface-1:#1a1a19; --plane:#0d0d0d;
    --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
    --good-track:#12301a; --warning-track:#3a2f10; --critical-track:#3a1c1c; --neutral-track:#2c2c2a;
    --accent:#3987e5;
  }
}
:root[data-theme="dark"] .csw-dash {
  color-scheme: dark;
  --surface-1:#1a1a19; --plane:#0d0d0d;
  --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
  --good-track:#12301a; --warning-track:#3a2f10; --critical-track:#3a1c1c; --neutral-track:#2c2c2a;
  --accent:#3987e5;
}

.csw-dash * { box-sizing: border-box; }
.csw-dash code { font-size: 0.92em; background: var(--grid); padding: 1px 5px; border-radius: 4px; }
.csw-dash .muted { color: var(--text-muted); }
.csw-dash .warn { color: var(--critical); }

.head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
.head__title { margin:0; font-size:24px; font-weight:650; letter-spacing:-0.01em; }
.head__sub { margin:6px 0 0; font-size:13px; color: var(--text-secondary); }
.banner { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:550;
  color: var(--text-primary); background: var(--warning-track);
  border:1px solid var(--warning); border-radius:8px; padding:8px 12px; }

.tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:12px; margin-bottom:20px; }
.tile { background: var(--surface-1); border:1px solid var(--ring); border-radius:10px; padding:14px 16px; }
.tile__label { font-size:12px; color: var(--text-secondary); margin-bottom:6px; }
.tile__value { font-size:30px; font-weight:650; line-height:1.05; letter-spacing:-0.02em; }
.tile__sub { font-size:11.5px; color: var(--text-muted); margin-top:6px; }
.tile--good { border-left:3px solid var(--good); }
.tile--warning { border-left:3px solid var(--warning); }
.tile--critical { border-left:3px solid var(--critical); }

.filters { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:14px; }
.input, .select { font:inherit; font-size:13px; color:var(--text-primary); background:var(--surface-1);
  border:1px solid var(--axis); border-radius:8px; padding:8px 10px; }
.input { min-width:280px; flex:1 1 280px; }
.input:focus-visible, .select:focus-visible, .mgr:focus-visible, .btn:focus-visible {
  outline:2px solid var(--accent); outline-offset:2px; }
.field { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:var(--text-secondary); }
.toggle { display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text-secondary); padding-bottom:8px; }
.count { margin-left:auto; font-size:12px; color:var(--text-muted); padding-bottom:8px; }

.tablewrap { background:var(--surface-1); border:1px solid var(--ring); border-radius:10px;
  overflow:auto; max-height:74vh; }
.grid { border-collapse:separate; border-spacing:0; width:100%; font-size:13px; }
.grid thead th { position:sticky; top:0; z-index:3; background:var(--surface-1);
  text-align:left; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:0.06em;
  color:var(--text-secondary); padding:10px 12px; border-bottom:1px solid var(--axis); white-space:nowrap; }
.grid thead th.col-mgr { z-index:4; }
.col-mgr { position:sticky; left:0; background:var(--surface-1); z-index:2;
  border-right:1px solid var(--grid); min-width:200px; }
.row td, .row th { border-bottom:1px solid var(--grid); vertical-align:top; padding:12px; }
.row--open > * { background:var(--plane); }

.mgr { display:flex; gap:8px; align-items:flex-start; background:none; border:0; padding:0;
  font:inherit; text-align:left; cursor:pointer; color:var(--text-primary); }
.mgr__caret { color:var(--text-muted); font-size:11px; line-height:1.5; }
.mgr__name { display:block; font-weight:650; }
.mgr__meta { display:block; font-size:11.5px; color:var(--text-muted); margin-top:2px; }

.cell--date { white-space:nowrap; font-size:12.5px; }
.cell--loe { min-width:210px; max-width:250px; }
.cell--hw { min-width:190px; max-width:230px; font-size:12.5px; line-height:1.45; }
.cell--hwstatus { white-space:nowrap; }
.cell--comment { min-width:210px; max-width:270px; font-size:12.5px; line-height:1.45; }

.loe__goal { font-size:12.5px; font-weight:600; line-height:1.35; margin-top:6px; margin-bottom:6px;
  color:var(--text-primary); }
.loe__notes { margin:8px 0 0; font-size:12px; line-height:1.45; color:var(--text-secondary);
  border-left:2px solid var(--grid); padding-left:8px; }
.loe__notes--empty { color:var(--text-muted); font-style:italic; }

.chip { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600;
  padding:2px 8px 2px 6px; border-radius:999px; border:1px solid; white-space:nowrap;
  color:var(--text-primary); }
.chip__icon { font-size:9px; line-height:1; }
.chip--good { background:var(--good-track); border-color:var(--good); }
.chip--good .chip__icon { color:var(--good); }
.chip--warning { background:var(--warning-track); border-color:var(--warning); }
.chip--warning .chip__icon { color:var(--warning); }
.chip--critical { background:var(--critical-track); border-color:var(--critical); }
.chip--critical .chip__icon { color:var(--critical); }
.chip--neutral { background:var(--neutral-track); border-color:var(--axis); }
.chip--neutral .chip__icon { color:var(--neutral); }

.detailrow > td { background:var(--plane); border-bottom:1px solid var(--grid); padding:0 12px 18px; }
.detailrow__spacer { position:sticky; left:0; background:var(--plane); border-right:1px solid var(--grid); }
.detail { display:grid; grid-template-columns: 1.4fr 1fr 1fr; gap:24px; padding-top:4px; }
@media (max-width: 900px) { .detail { grid-template-columns:1fr; } }
.detail__h { margin:0 0 8px; font-size:11px; font-weight:650; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--text-secondary); display:flex; align-items:center;
  justify-content:space-between; gap:12px; }
.detail__date { font-weight:500; text-transform:none; letter-spacing:0; color:var(--text-muted); }
.detail__h .chip { text-transform:none; letter-spacing:0; }
.detail__body { margin:0 0 12px; font-size:13px; line-height:1.55; color:var(--text-primary); max-width:62ch; }
.btn { display:inline-flex; align-items:center; gap:7px; font-size:12.5px; font-weight:600;
  color:#fff; background:var(--accent); border-radius:8px; padding:7px 12px; text-decoration:none; }
.btn:hover { filter:brightness(1.08); }
.pill { display:inline-block; margin-left:8px; font-size:11.5px; font-weight:600; padding:5px 10px;
  border-radius:999px; border:1px solid var(--warning); background:var(--warning-track); }

.hwlist { margin:0; padding:0; list-style:none; }
.hwlist li { display:flex; gap:8px; font-size:13px; line-height:1.5; padding:5px 0;
  border-bottom:1px solid var(--grid); }
.hwlist li:last-child { border-bottom:0; }
.hwlist--tight li { font-size:12.5px; padding:2px 0; border-bottom:0; }
.hwlist--tight li::before { content:"·"; color:var(--text-muted); }
.hwlist__box { color:var(--text-muted); }

.mini { width:100%; border-collapse:collapse; font-size:12px; }
.mini th { text-align:left; font-weight:600; color:var(--text-secondary); padding:4px 8px 4px 0;
  border-bottom:1px solid var(--axis); }
.mini td { padding:5px 8px 5px 0; border-bottom:1px solid var(--grid); vertical-align:top; }
.mini a { color:var(--accent); }

.empty { padding:32px; text-align:center; color:var(--text-muted); }
.foot { display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap;
  margin-top:14px; font-size:12px; color:var(--text-muted); }
.legend { display:flex; gap:6px; flex-wrap:wrap; }
`;
