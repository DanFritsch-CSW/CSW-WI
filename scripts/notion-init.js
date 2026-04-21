/**
 * One-time script to create the CSW Operations Hub documentation page in Notion.
 *
 * Usage:
 *   NOTION_API_KEY=secret_xxx NOTION_PARENT_PAGE_ID=<page-id> node scripts/notion-init.js
 *
 * After running, save the printed page ID as the NOTION_PAGE_ID GitHub secret.
 */

import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const parentPageId = process.env.NOTION_PARENT_PAGE_ID;

if (!process.env.NOTION_API_KEY || !parentPageId) {
  console.error('Required env vars: NOTION_API_KEY, NOTION_PARENT_PAGE_ID');
  process.exit(1);
}

// ─── Block builder helpers ──────────────────────────────────────────────────

const rt = (text, opts = {}) => {
  const base = { type: 'text', text: { content: text } };
  if (opts.bold) base.annotations = { bold: true };
  if (opts.code) base.annotations = { ...(base.annotations || {}), code: true };
  return [base];
};

const h1 = (text) => ({ type: 'heading_1', heading_1: { rich_text: rt(text) } });
const h2 = (text) => ({ type: 'heading_2', heading_2: { rich_text: rt(text) } });
const h3 = (text) => ({ type: 'heading_3', heading_3: { rich_text: rt(text) } });
const para = (text) => ({ type: 'paragraph', paragraph: { rich_text: rt(text) } });
const divider = () => ({ type: 'divider', divider: {} });
const bullet = (text) => ({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(text) } });

const callout = (text, emoji = '📌', color = 'blue_background') => ({
  type: 'callout',
  callout: { rich_text: rt(text), icon: { type: 'emoji', emoji }, color }
});

const tableRow = (...cells) => ({
  type: 'table_row',
  table_row: { cells: cells.map((c) => rt(String(c))) }
});

const table = (headers, rows) => ({
  type: 'table',
  table: {
    table_width: headers.length,
    has_column_header: true,
    has_row_header: false,
    children: [tableRow(...headers), ...rows.map((r) => tableRow(...r))]
  }
});

const code = (content, language = 'sql') => ({
  type: 'code',
  code: { rich_text: rt(content), language }
});

const toggle = (summary, children) => ({
  type: 'toggle',
  toggle: { rich_text: rt(summary), children }
});

// ─── Page content ───────────────────────────────────────────────────────────

const now = new Date().toISOString();

const blocks = [
  // Status banner — always the first block; notion-update.js updates this
  {
    type: 'callout',
    callout: {
      rich_text: [
        { type: 'text', text: { content: 'Last Deployed: ' }, annotations: { bold: true } },
        { type: 'text', text: { content: `${now} — (initial page creation)` } }
      ],
      icon: { type: 'emoji', emoji: '🚀' },
      color: 'green_background'
    }
  },
  {
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: 'Live app: ' } },
        { type: 'text', text: { content: 'csw-wi.netlify.app', link: { url: 'https://csw-wi.netlify.app' } } }
      ]
    }
  },
  divider(),

  // ── Overview ──
  h1('Overview'),
  para(
    'CSW Operations Hub is an internal warehouse operations dashboard for Central Storage & Warehouse (CSW), ' +
    'a 3PL company operating 5 facilities across Wisconsin. It gives managers real-time labor planning, ' +
    'drag-and-drop roster management, and network-wide appointment visibility across all distribution centers.'
  ),
  divider(),

  // ── Tech Stack ──
  h2('Tech Stack'),
  table(
    ['Layer', 'Technology', 'Version'],
    [
      ['Frontend', 'React + Vite', '18.3.1 / 5.2.11'],
      ['Routing', 'React Router v6', '6.23.1'],
      ['Charts', 'Chart.js + react-chartjs-2', '4.4.3 / 5.2.0'],
      ['Drag & Drop', '@dnd-kit/core + @dnd-kit/sortable', '6.1.0 / 8.0.0'],
      ['Database', 'Supabase (PostgreSQL)', '2.43.4'],
      ['Analytics API', 'Omni Analytics (csw.omniapp.co)', '—'],
      ['Hosting', 'Netlify (auto-deploy from main)', '—'],
      ['Serverless', 'Netlify Functions (Node.js + esbuild)', '—'],
      ['Binary protocol', 'Apache Arrow IPC', '17.0.0']
    ]
  ),
  divider(),

  // ── Facilities ──
  h2('Facilities'),
  table(
    ['ID', 'Code', 'Display Name', 'VIEW_H Key', 'VIEW_P Key', 'Brand Color'],
    [
      ['cal', 'CAL', 'Caledonia', 'franksville', 'CSW-Franksville', '#e07b4d'],
      ['mad', 'MAD', 'Madison', 'madison', 'CSW-Madison', '#4d9de0'],
      ['ken', 'KEN', 'Kenosha', 'kenosha', 'CSW-Kenosha', '#3dba7e'],
      ['wr', 'WR', 'Wisconsin Rapids', 'wisconsin rapids', 'CSW-Wisconsin Rapids', '#d4b84a'],
      ['ec', 'EC', 'Eau Claire', 'eau claire', 'CSW-Eau Claire', '#c084fc']
    ]
  ),
  para('Caledonia (CAL) is stored as "Franksville" in both Omni tables.'),
  divider(),

  // ── Pages & Features ──
  h2('Pages & Features'),
  table(
    ['Route', 'Page', 'Status'],
    [
      ['/', 'Labor Planning', '✅ Live'],
      ['/orders', 'Order Creator', '🔲 Stub'],
      ['/analytics', 'Analytics', '🔲 Stub'],
      ['/settings', 'Settings', '🔲 Stub']
    ]
  ),

  h3('Labor Planning — ALL Tab'),
  para(
    'Network overview: grouped inbound/outbound bar chart (CompareChart) and per-facility KPI scorecards ' +
    'showing Appointments, Inbound, Outbound, Labor, and Utilization for the selected date.'
  ),

  h3('Labor Planning — Facility Tabs (CAL / MAD / KEN / WR / EC)'),
  bullet('KPI Pills — Appointments, Inbound, Outbound, Labor Avail, Utilization, Daily +/-'),
  bullet('Insight Chips — auto-generated status alerts based on KPI thresholds'),
  bullet('Hourly Chart — mixed bar (appointments) + dual line (labor required vs. available) per shift hour'),
  bullet('Delta Chart — labor surplus/deficit bar chart by hour'),
  bullet('Hourly Breakdown Table — 24-hour shift view: Hour, Drops, Inb, Out, Appts, Labor Req, Labor Avail, Final +/-, Cumul +/-'),
  bullet('Project Throughput List — per-project Inb / Out / Total with editable estimated drops'),
  bullet('Roster Board — drag-and-drop 4-lane (1st Shift / Mid Shift / 2nd Shift / 3rd Shift + PTO + Call-In) assignment'),
  divider(),

  // ── Omni Analytics Integration ──
  h2('Omni Analytics Integration'),
  callout(
    'All requests go through /.netlify/functions/omni-query (CORS proxy). ' +
    'Auth: OMNI_API_KEY Bearer token set only in the Netlify dashboard.',
    '🔗',
    'blue_background'
  ),

  h3('Data Tables'),
  table(
    ['Constant', 'Omni Table Name', 'Used For'],
    [
      ['VIEW_H', 'labor_planning_app__hourly_labor_required_vs_available', 'Hourly labor + appointment counts, util/delta KPIs'],
      ['VIEW_P', 'labor_planning_app__hourly_inbound_outbound_drops_summary', 'Project-level appointment totals']
    ]
  ),

  h3('API Functions (src/lib/omni.js)'),
  table(
    ['Function', 'Source', 'Returns'],
    [
      ['fetchHourlyData(facility, date)', 'VIEW_H', '24 rows — { h, req, avail, drops, inb, out, appts }'],
      ['fetchProjectData(facility, date)', 'VIEW_P', '1 row per project — { name, inb, out, tot }'],
      ['fetchNetworkKpis(date)', 'VIEW_H + VIEW_P parallel', '{ [facilityId]: { appts, inb, out, labor, util, delta } }']
    ]
  ),

  h3('Arrow IPC Deserialization'),
  para(
    'The Netlify function receives NDJSON from Omni, locates the COMPLETE job line, decodes the base64 ' +
    'Apache Arrow IPC binary via tableFromIPC, and returns plain JSON rows. ' +
    'Arrow Decimal128 values come back as double-quoted strings and are stripped in arrowToRows.'
  ),
  divider(),

  // ── Roster Board ──
  h2('Roster Board'),
  para('Built with @dnd-kit. Each facility has four shift lanes (plus PTO and Call-In):'),
  table(
    ['Lane ID', 'Label', 'Counts Toward Labor Avail KPI'],
    [
      ['shift1', '1st Shift', 'Yes'],
      ['mid', 'Mid Shift', 'Yes'],
      ['shift2', '2nd Shift', 'Yes'],
      ['shift3', '3rd Shift', 'Yes'],
      ['pto', 'PTO', 'No'],
      ['callin', 'Call-In', 'No']
    ]
  ),
  bullet('Dragging a tile updates local state immediately (optimistic UI)'),
  bullet('On drop, upserts to roster_assignments in Supabase'),
  bullet('On load: fetches Supabase assignments first; falls back to employees.default_lane'),
  bullet('Sync from B2E button: pulls latest roster from Omni B2E model, seeds employees table, reloads board'),

  h3('B2E Roster Sync'),
  table(
    ['Constant', 'Value'],
    [
      ['B2E_MODEL_ID', 'f3aaca97-bb7c-405d-809b-efab83649ab3'],
      ['ROSTER table', 'silver__b2e_slv_employeeroster'],
      ['SCHEDULE table', 'silver__b2e_slv_futurescheduleentries']
    ]
  ),
  para(
    'Filters: employee_status = Active, default_job_code = 205, facility path match, plus a hardcoded ' +
    'exclusion list of ~30 manager/supervisor IDs. ' +
    'Two parallel Omni queries (ROSTER + SCHEDULE joined client-side) prevent implicit INNER JOINs from ' +
    'dropping employees who lack recent schedule ingestion.'
  ),
  divider(),

  // ── Database Schema ──
  h2('Database Schema (Supabase)'),
  code(
    `create table employees (
  id           text primary key,
  facility     text not null,
  name         text not null,
  role         text,
  default_lane text
);

create table roster_assignments (
  id            uuid primary key default gen_random_uuid(),
  facility      text not null,
  employee_id   text not null,
  employee_name text,
  role          text,
  lane          text not null,
  plan_date     date not null,
  updated_at    timestamptz default now(),
  unique (facility, employee_id, plan_date)
);

create table facility_settings (
  facility              text primary key,
  hours_per_appt        numeric default 1.5,
  break_multipliers     jsonb,
  shift_config          jsonb,
  updated_at            timestamptz default now()
);`,
    'sql'
  ),
  divider(),

  // ── Deployment Architecture ──
  h2('Deployment Architecture'),
  callout('Every push to main auto-triggers a Netlify build + deploy. No manual step required.', '⚡', 'yellow_background'),
  table(
    ['Config Key', 'Value'],
    [
      ['Build command', 'npm run build'],
      ['Publish directory', 'dist'],
      ['Functions directory', 'netlify/functions'],
      ['Function bundler', 'esbuild'],
      ['SPA redirect rule', '/* → /index.html (HTTP 200)']
    ]
  ),

  h3('Environment Variables'),
  table(
    ['Variable', 'Where Set', 'Purpose'],
    [
      ['VITE_SUPABASE_URL', '.env (local) / Netlify env', 'Supabase project URL'],
      ['VITE_SUPABASE_ANON_KEY', '.env (local) / Netlify env', 'Supabase anon/public key'],
      ['OMNI_API_KEY', 'Netlify dashboard only', 'Omni Analytics Bearer token (server-side only)'],
      ['NOTION_API_KEY', 'GitHub Secrets', 'Notion integration token (for doc sync)'],
      ['NOTION_PAGE_ID', 'GitHub Secrets', 'ID of this documentation page']
    ]
  ),
  divider(),

  // ── Supabase Migrations ──
  h2('Database Migrations'),
  para('Migrations live in supabase/migrations/ and are applied manually via the Supabase dashboard or CLI.'),
  table(
    ['Migration File', 'Purpose'],
    [
      ['20260417_hourly_drops_forecast.sql', 'Hourly drops forecast table'],
      ['20260420_project_drops_forecast.sql', 'Project-level drops forecast table'],
      ['20260420_roster_shift_override.sql', 'Roster shift override table']
    ]
  ),
  divider(),

  // ── Outstanding Work ──
  h2('Outstanding & Planned Work'),
  bullet('Hourly Breakdown table — current version is a baseline; full revamp planned'),
  bullet('B2E exclusion list — verify ~30 manager IDs cover all 5 facilities (currently CAL-derived)'),
  bullet('OrderCreator page — order management UI (/orders)'),
  bullet('Analytics page — historical performance and trend views (/analytics)'),
  bullet('Settings page — per-facility config and user preferences (/settings)'),
  bullet('Est Drops: per-project hourly breakdown (24-hour grid, new Supabase table project_hourly_drops_forecast)'),
  bullet('Est Drops: remaining PROJECT_DROP_RULES — currently only CAL + KEN facilities covered'),
  divider(),

  // ── Known Issues ──
  h2('Known Issues'),
  callout('Omni API Concurrency — 502 errors on first load for unseeded dates', '⚠️', 'red_background'),
  para(
    'Symptom: omni-query 502 {"error":"Omni query did not complete"} in Hourly Breakdown panel. ' +
    'Root cause: EST Drops auto-seed fires raw appointment queries for every project with a rule (7+ KEN projects × 4 weeks = 28+ parallel calls). ' +
    'Current fix: Queries serialized — one project at a time, 4 weeks in parallel. ' +
    'Scaling options if load time grows: (1) background Netlify function on date change, (2) nightly pre-seed, (3) semaphore concurrency cap.'
  ),
  divider(),

  // ── Changelog ──
  h2('Changelog'),
  para('Each push to main appends a new entry below via the notion-sync GitHub Action.'),
  toggle(`🚀 ${now.split('T')[0]} — Page Created`, [
    para('Initial CSW Operations Hub documentation page created via scripts/notion-init.js.')
  ])
];

// ─── Create page ────────────────────────────────────────────────────────────

async function init() {
  console.log('Creating Notion documentation page...');

  const page = await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: 'CSW Operations Hub — App Documentation' } }]
      }
    },
    children: blocks.slice(0, 100)
  });

  const pageId = page.id;
  console.log(`\nPage created: ${pageId}`);

  // Notion API limit: 100 blocks per request
  for (let i = 100; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + 100)
    });
  }

  console.log('\n─────────────────────────────────────────────────');
  console.log('✅  Done! Add these to GitHub Secrets:');
  console.log(`    NOTION_PAGE_ID = ${pageId}`);
  console.log(`    Notion URL     = https://www.notion.so/${pageId.replace(/-/g, '')}`);
  console.log('─────────────────────────────────────────────────\n');
}

init().catch((err) => {
  console.error('Error:', err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
