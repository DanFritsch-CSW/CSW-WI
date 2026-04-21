# CSW Operations Hub

Internal warehouse operations dashboard for Central Storage & Warehouse — a 3PL company operating 5 facilities across Wisconsin.

**Live:** [csw-wi.netlify.app](https://csw-wi.netlify.app)

---

## Notion Documentation

The Notion page is the living document for this app — every element, integration, and data model is catalogued there. It auto-updates on every push to `main`.

### What lives in Notion

- App overview and purpose
- Tech stack and dependency versions
- Facility table (IDs, Omni keys, brand colors)
- Pages and feature breakdown (live vs. stub)
- Omni Analytics integration details (tables, API functions, field mappings)
- Roster Board architecture and B2E sync details
- Supabase schema and migration history
- Deployment architecture and environment variables
- Outstanding and planned work
- **Changelog** — a timestamped toggle entry is appended automatically on every deploy

### One-time setup (initial page creation)

1. Create a Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations). Copy the `secret_...` token.
2. Share a parent Notion page with your integration (open the page → **Share** → add integration by name).
3. Copy that parent page's ID from its URL: `notion.so/<workspace>/<PAGE_ID>?v=...`
4. Install the Notion client and run the init script:

```bash
cd scripts && npm install && cd ..

NOTION_API_KEY=secret_xxx \
NOTION_PARENT_PAGE_ID=<parent-page-id> \
node scripts/notion-init.js
```

5. The script prints the new page ID. Add two secrets to the GitHub repo (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `NOTION_API_KEY` | Your `secret_xxx` integration token |
| `NOTION_PAGE_ID` | The page ID printed by the init script |

### How automatic updates work

A GitHub Action (`.github/workflows/notion-sync.yml`) fires on every push to `main`. It:

1. Runs `scripts/notion-update.js` with the commit SHA, message, and author injected as env vars.
2. **Updates** the "Last Deployed" banner at the top of the Notion page.
3. **Appends** a collapsible changelog entry at the bottom with the timestamp, short SHA, commit message, and author.

No Netlify configuration changes are needed — the Action is tied to the same `main` push that triggers the Netlify deploy.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite |
| Routing | React Router v6 |
| Charts | Chart.js + react-chartjs-2 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| Database | Supabase (roster persistence) |
| Analytics | Omni Analytics API (`csw.omniapp.co`) via Netlify proxy |
| Hosting | Netlify (auto-deploy from `main`) |

---

## Facilities

| ID | Code | Display Name | VIEW_H warehouse | VIEW_P warehouse | Color |
|---|---|---|---|---|---|
| `cal` | CAL | Caledonia | `franksville` | `CSW-Franksville` | `#e07b4d` |
| `mad` | MAD | Madison | `madison` | `CSW-Madison` | `#4d9de0` |
| `ken` | KEN | Kenosha | `kenosha` | `CSW-Kenosha` | `#3dba7e` |
| `wr` | WR | Wisconsin Rapids | `wisconsin rapids` | `CSW-Wisconsin Rapids` | `#d4b84a` |
| `ec` | EC | Eau Claire | `eau claire` | `CSW-Eau Claire` | `#c084fc` |

> **Note:** Caledonia (CAL) is stored as "Franksville" in both Omni tables.

---

## Pages

| Route | Page | Status |
|---|---|---|
| `/` | Labor Planning | Live |
| `/orders` | Order Creator | Stub |
| `/analytics` | Analytics | Stub |
| `/settings` | Settings | Stub |

### Labor Planning (`/`)

**ALL tab** — network overview with a grouped inbound/outbound bar chart and per-facility scorecards showing Appts, Inbound, Outbound, Labor, and Utilization.

**Facility tabs (CAL / MAD / KEN / WR / EC):**
- KPI pills: Appointments, Inbound, Outbound, Labor Avail, Utilization, Daily +/-
- Insight chips: auto-generated status alerts based on KPIs
- Hourly chart (appointments bar + required/available labor lines)
- Delta chart (labor surplus/deficit by hour)
- **Hourly Breakdown table** — 24-hour shift view matching Omni dashboard (Hour, Drops, Inb, Out, Appts, Labor Req, Labor Avail, Final +/-, Cumul +/-)
- Project throughput list (Inb / Out / Total per project)
- Shift roster board (drag-and-drop)

---

## Omni Analytics Integration

**Proxy:** All requests go through `/.netlify/functions/omni-query` to avoid CORS.
**Auth:** `OMNI_API_KEY` env var set in Netlify dashboard (Bearer token).
**Model ID:** `79a98af2-a904-4b5d-b25f-7f6a2c7ef467`

### Omni Tables

| Constant | Table name | Used for |
|---|---|---|
| `VIEW_H` | `labor_planning_app__hourly_labor_required_vs_available` | Hourly labor + appointment counts, util/delta KPIs |
| `VIEW_P` | `labor_planning_app__hourly_inbound_outbound_drops_summary` | Project-level appointment totals |

### API Functions (`src/lib/omni.js`)

| Function | Source | Returns |
|---|---|---|
| `fetchHourlyData(facility, date)` | VIEW_H | `[{ h, req, avail, drops, inb, out, appts }]` — 24 rows, one per shift hour |
| `fetchProjectData(facility, date)` | VIEW_P | `[{ name, inb, out, tot }]` — one row per project |
| `fetchNetworkKpis(date)` | VIEW_H + VIEW_P (parallel) | `{ [facilityId]: { appts, inb, out, labor, util, delta } }` |

### Key Field Names

| Display name (Omni) | API field |
|---|---|
| Hour Of Day Timestamp | `hour_of_day_timestamp` |
| Labor Required | `labor_required` |
| Labor Available (AW Update) | `labor_available_aw_update_` |
| Inbound Count | `inbound_count` |
| Outbound Count | `outbound_count` |
| Drops | `drops` |
| Shift Timestamp (5am-5am) | `labor_shift_timestamp` ← use this for VIEW_H date filter |
| Activity Date | `activity_date` ← use this for VIEW_P date filter |

> **Columns F, M, N in the Omni workbook are formulas** (Total Appts = Drops+Inb+Out, Final +/- = Avail−Req, Cumulative = running sum). We compute these client-side — do not fetch them as API fields.

### Netlify Function (`netlify/functions/omni-query.cjs`)

- Receives `{ query }` POST body from the frontend
- Calls `POST https://csw.omniapp.co/api/v1/query/run` with Bearer auth
- Parses NDJSON response, finds the `COMPLETE` job line
- Decodes base64 Apache Arrow IPC binary via `tableFromIPC`
- Returns `{ rows: [...] }` as plain JSON
- Arrow Decimal128 values come back as quoted strings (`"\"32\""`) — stripped in `arrowToRows`

---

## Roster Board

Built with `@dnd-kit`. Four lanes per facility:

| Lane ID | Label |
|---|---|
| `shift1` | 1st Shift |
| `shift2` | 2nd Shift |
| `pto` | PTO |
| `callin` | Call-In |

- Dragging a tile updates local state immediately (optimistic)
- On drop, upserts to `roster_assignments` in Supabase
- On load: fetches assignments from Supabase; falls back to `employees.default_lane`
- **Labor Avail KPI** = count of employees in `shift1` + `shift2`
- **Sync from B2E** button — pulls latest roster from Omni B2E model, seeds Supabase `employees` table, reloads board

### B2E Roster Sync

| Constant | Value |
|---|---|
| `B2E_MODEL_ID` | `f3aaca97-bb7c-405d-809b-efab83649ab3` |
| `ROSTER` table | `silver__b2e_slv_employeeroster` |
| `SCHEDULE` table | `silver__b2e_slv_futurescheduleentries` |

**Facility location paths** (`default_location_full_path`):

| Facility | Path |
|---|---|
| CAL | `019 - Caledonia` |
| MAD | `011 - Madison` |
| EC | `012 - Eau Claire` |
| KEN | `015 - Kenosha` |
| WR | `023 - Wisconsin Rapids` |

**Filters applied:** `employee_status = Active`, `default_job_code = 205`, facility location path, plus a hardcoded exclusion list of 30 manager/supervisor IDs.

**Shift mapping** (`scheduleToLane`): checks `work_schedule` text first ("1st Shift" / "2nd Shift"), falls back to `modified_start_time` (< 12:00 → `shift1`, ≥ 12:00 → `shift2`), defaults to `shift1` for Free Flow / unknown.

**Architecture:** Two parallel Omni queries (ROSTER + SCHEDULE joined client-side) to avoid Omni's implicit INNER JOIN dropping employees without recent ingestion. Exclusion filter applied client-side. Supabase `employees` table = baseline; `roster_assignments` = daily drag-drop overrides.

---

## Supabase Schema

```sql
create table employees (
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
```

---

## Local Development

```bash
npm install
npm run dev
```

### Environment Variables

```
VITE_SUPABASE_URL=        # Supabase project URL
VITE_SUPABASE_ANON_KEY=   # Supabase anon/public key
```

Netlify function environment (set in Netlify dashboard, not in .env):
```
OMNI_API_KEY=             # Omni Analytics Bearer token
```

---

## Project Structure

```
src/
├── lib/
│   ├── constants.js        # Facility config, lane config
│   ├── supabase.js         # Supabase client + roster helpers
│   └── omni.js             # Omni API helpers (live)
├── components/
│   ├── TopNav.jsx          # Sticky nav + utility bar
│   ├── KpiPills.jsx        # Metric pill row (Appts/Inb/Out/Labor/Util/Daily+/-)
│   ├── InsightChips.jsx    # Auto status chips
│   ├── HourlyChart.jsx     # Mixed bar+line hourly chart
│   ├── DeltaChart.jsx      # Labor delta bar chart
│   ├── HourlyTable.jsx     # 24-row hourly breakdown table
│   ├── CompareChart.jsx    # Network grouped bar chart
│   ├── ProjectList.jsx     # Project throughput table
│   ├── RosterBoard.jsx     # dnd-kit 4-lane board
│   └── EmployeeTile.jsx    # Draggable employee tile
└── pages/
    ├── LaborPlanning.jsx   # Main page (facility tabs + day picker)
    ├── FacilityPanel.jsx   # Per-facility view
    ├── AllFacilities.jsx   # Network overview
    ├── OrderCreator.jsx    # Stub
    ├── Analytics.jsx       # Stub
    └── Settings.jsx        # Stub

netlify/
└── functions/
    ├── omni-query.cjs      # Omni API proxy (Arrow IPC → JSON)
    └── package.json        # type: commonjs, apache-arrow dep

scripts/
├── notion-init.js          # One-time: creates the Notion documentation page
├── notion-update.js        # Per-deploy: updates banner + appends changelog entry
└── package.json            # @notionhq/client dependency

.github/
└── workflows/
    └── notion-sync.yml     # GitHub Action: runs notion-update.js on push to main
```

---

## Deployment

Netlify auto-deploys from `main`. Build config in `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[redirects]]
  from = "/*"
  to   = "/index.html"
  status = 200
```

---

## Outstanding / Planned Work

- **Hourly Breakdown** — current table is a baseline; full revamp planned
- **B2E exclusion list** — current list is CAL-derived; verify manager IDs apply across all 5 facilities
- **OrderCreator page** — order management UI
- **Analytics page** — historical performance and trend views
- **Settings page** — facility config and user preferences
- **Est Drops — per-project hourly breakdown (Option B)** — clicking a project row currently lets you edit a single daily EST drops total. A future upgrade would show a full 24-hour grid scoped to that project, letting planners distribute drops across hours. Requires a new Supabase table (`project_hourly_drops_forecast(facility, plan_date, project_name, hour, est_drops)`), new fetch/upsert helpers in `supabase.js`, updated auto-seeding logic in `fetchHistoricalProjectDrops` to produce per-project-per-hour estimates, and an expanded inline edit UI in `ProjectList.jsx`.
- **Est Drops — remaining project rules** — `PROJECT_DROP_RULES` in `src/lib/omni.js` currently covers CAL (Palermos CALEDONIA finished) and KEN (Crown, Pretzilla, Birchwood, Fair Oaks, Richelieu). All other projects default to 0 until their drop logic is confirmed. Add a one-liner per project to the config as rules are defined.

## Known Issues / Performance Notes

### Omni API concurrency limit (502 errors)
**Symptom:** `omni-query 502: {"error":"Omni query did not complete"}` appears in the Hourly Breakdown panel.

**Root cause:** The EST Drops auto-seed fires raw appointment queries (`gold__truck_appointments`) for every project that has a rule in `PROJECT_DROP_RULES`. With 7+ Kenosha rule-projects × 4 historical weeks, this was 28+ simultaneous Omni API calls on first load for an unseeded date — enough to overload the API alongside the regular hourly and project data fetches.

**Current fix:** Rule-project queries are now serialized (one project at a time, 4 weeks in parallel per project) in `fetchHistoricalProjectDrops`. This keeps concurrency manageable.

**Scaling concern:** As more projects are added to `PROJECT_DROP_RULES` across all 5 facilities, first-load seeding time will grow linearly. If load times become unacceptable with a larger audience, options include:
1. Move seeding to a Netlify background function triggered on date change (fire-and-forget, UI shows 0 until ready)
2. Pre-seed all facilities nightly via a scheduled Netlify function
3. Add a concurrency cap (e.g. max 3 in-flight Omni requests) using a semaphore pattern
