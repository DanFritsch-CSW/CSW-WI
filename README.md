# CSW Operations Hub

Internal warehouse operations dashboard for Central Storage & Warehouse — a 3PL company operating 5 facilities across Wisconsin.

**Live:** [csw-wi.netlify.app](https://csw-wi.netlify.app)

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite |
| Routing | React Router v6 |
| Charts | Chart.js + react-chartjs-2 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| Database | Supabase (roster + EST drops persistence) |
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

**ALL tab** — network overview with a grouped inbound / outbound / EST drops bar chart and per-facility scorecards showing Appts, Inbound, Outbound, Est Drops, Labor Req (hrs), and Labor Avail (headcount).

**Facility tabs (CAL / MAD / KEN / WR / EC):**
- KPI pills: Appointments (inb + out + est drops), Inbound, Outbound, Labor Avail, Utilization, Daily +/-
- Hourly chart (appointments bar + required/available labor lines)
- Project list (read-only; Inb / Est Drops / Out / Total per project — totals always match HourlyTable column sums)
- **Hourly Breakdown table** — per-hour view with collapsible per-project EST drop columns:
  - Collapsed: single "EST Drops" column (sum across all projects)
  - Expanded (▸/▾ toggle): one editable column per project + a summed Total column
  - Inline editing: click any project-hour cell to update; saves immediately to Supabase
  - **↺ Reset EST Drops** button — recalculates all hourly EST drops from the last 4-week same-weekday average, overwriting manual edits
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
| `APPT` | `gold__truck_appointments` | Raw appointments — used to compute historical per-project hourly EST drops |

### API Functions (`src/lib/omni.js`)

| Function | Source | Returns |
|---|---|---|
| `fetchHourlyData(facility, date)` | VIEW_H | `[{ h, req, avail, drops, inb, out, appts }]` — 24 rows, one per shift hour |
| `fetchProjectData(facility, date)` | VIEW_P | `[{ name, inb, out, tot }]` — one row per project |
| `fetchNetworkKpis(date)` | VIEW_H + VIEW_P (parallel) | `{ [facilityId]: { appts, inb, out, labor, avail, util, delta } }` |
| `fetchHistoricalProjectHourlyDrops(facility, date, weeksBack=4)` | APPT (×projects×weeks) | `{ [projectName]: { [hour]: avgDrops } }` — 4-week same-weekday average, per-project per-hour |
| `isRuleProject(facilityId, projectName)` | `PROJECT_DROP_RULES` | `boolean` — true if project has a rule scoped to that facility |

### PROJECT_DROP_RULES

Each entry in `PROJECT_DROP_RULES` (in `omni.js`) is keyed by project display name and contains:
- `facility` — which facility the rule applies to (prevents cross-facility pollution)
- `filter` — Omni APPT query filter to identify appointments belonging to this project

Currently defined rules:

| Project | Facility | Notes |
|---|---|---|
| Crown Bakeries (various) | KEN | Kenosha only |
| Pretzilla Kenosha | KEN | |
| Birchwood Foods | KEN | |
| Fair Oaks Farms | KEN | |
| Richelieu Foods | KEN | |
| Palermos CALEDONIA finished | CAL | |

> Rules for MAD, WR, EC and remaining CAL/KEN projects should be added to `PROJECT_DROP_RULES` as their drop logic is confirmed.

### Key Field Names

| Display name (Omni) | API field |
|---|---|
| Hour Of Day Timestamp | `hour_of_day_timestamp` |
| Labor Required | `labor_required` |
| Labor Available (AW Update) | `labor_available_aw_update_` |
| Inbound Count | `inbound_count` |
| Outbound Count | `outbound_count` |
| Drops | `drops` |
| Scheduled Arrival | `scheduled_arrival` ← used to extract hour for EST drops |
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

## EST Drops Architecture

### Single Source of Truth

Per-project hourly EST drops are the **only** place EST drop numbers live. The flow is:

```
project_hourly_drops_forecast (Supabase)
  └── projectHourlyDrops state (FacilityPanel)
        ├── projectDrops (computed memo) → ProjectList totals
        ├── estDrops (computed memo, per-hour sums) → labor calc
        └── HourlyTable (editable columns, writes back to Supabase)
```

This guarantees ProjectList totals always equal HourlyTable column sums — there is no separate day-level state.

### Auto-Seeding

On first load for a facility + date with no existing rows, FacilityPanel automatically:
1. Calls `fetchHistoricalProjectHourlyDrops` → 4-week same-weekday average from raw APPT data
2. Bulk-upserts rows to `project_hourly_drops_forecast`
3. Sets local state (no second DB round-trip)

Auto-seeding is idempotent: it only fires when zero rows exist for that facility + date.

### Reset Button

The **↺ Reset EST Drops** button in the Hourly Breakdown header re-runs the same historical seeding on demand, overwriting any manual edits for that facility + date.

---

## Roster Board

Built with `@dnd-kit`. Lanes per facility:

| Lane ID | Label |
|---|---|
| `shift1` | 1st Shift |
| `mid` | Mid Shift |
| `shift2` | 2nd Shift |
| `shift3` | 3rd Shift |
| `pto` | PTO |
| `callin` | Call-In |

- Dragging a tile updates local state immediately (optimistic)
- On drop, upserts to `roster_assignments` in Supabase
- On load: fetches assignments from Supabase; falls back to `employees.default_lane`
- **Labor Avail KPI** = count of employees in `shift1` + `mid` + `shift2` + `shift3`
- **Sync from B2E** button — pulls latest roster from Omni B2E model, seeds Supabase `employees` table, reloads board

### Employee Tile Shift Edit

Clicking an employee tile reveals a shift editor with **Start** and **End** time pickers (`HH:MM`). On save:
- Duration = end − start (handles overnight: if end < start, adds 24h)
- Rounded to nearest 15 min
- Saved to `roster_assignments` via upsert

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

**Filters applied:** `employee_status = Active`, `default_job_code = 205`, facility location path, plus a hardcoded exclusion list of supervisor/manager IDs (`B2E_EXCLUDED_IDS` in `omni.js`).

**Shift mapping** (`scheduleToLane`): checks `work_schedule` text first ("1st Shift" / "2nd Shift"), falls back to `modified_start_time` (< 12:00 → `shift1`, ≥ 12:00 → `shift2`), defaults to `shift1` for Free Flow / unknown.

**Architecture:** Two parallel Omni queries (ROSTER + SCHEDULE joined client-side) to avoid Omni's implicit INNER JOIN dropping employees without recent schedule entries. Exclusion filter applied client-side. Supabase `employees` table = baseline; `roster_assignments` = daily drag-drop overrides keyed on `plan_date`.

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
  shift_start   numeric,   -- decimal hours, e.g. 6.0 = 6:00 AM
  shift_hours   numeric,   -- duration in hours
  plan_date     date not null,
  updated_at    timestamptz default now(),
  unique (facility, employee_id, plan_date)
);

-- Per-project per-hour estimated drops (single source of truth for EST Drops)
create table project_hourly_drops_forecast (
  facility     text not null,
  plan_date    date not null,
  project_name text not null,
  hour         int  not null,   -- 0–23 shift hour
  est_drops    int  not null default 0,
  primary key (facility, plan_date, project_name, hour)
);
```

### Supabase Helpers (`src/lib/supabase.js`)

| Function | Returns |
|---|---|
| `fetchRosterAssignments(facility, date)` | Employee lane/shift assignments for a facility+date |
| `upsertRosterAssignment(facility, date, row)` | Save single employee assignment |
| `fetchProjectHourlyDrops(facility, date)` | `{ [projectName]: { [hour]: estDrops } }` |
| `upsertProjectHourlyDrops(facility, date, rows)` | Bulk upsert `[{ project_name, h, est_drops }]` rows |
| `fetchAllFacilitiesEstDrops(date)` | `{ [facilityId]: totalEstDrops }` — sum across all projects+hours |
| `fetchAllFacilitiesLaborCounts(date)` | `{ [facilityId]: activeHeadcount }` — employees in productive lanes |

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
│   ├── supabase.js         # Supabase client + roster + EST drops helpers
│   ├── omni.js             # Omni API helpers (live + historical)
│   ├── laborCalc.js        # applySettings, computeDailyKpis, buildRosterAvailability
│   └── ...
├── hooks/
│   └── useSettings.js      # Facility settings (break%, req formula) from Supabase
├── components/
│   ├── TopNav.jsx          # Sticky nav + utility bar
│   ├── KpiPills.jsx        # Metric pill row (Appts/Inb/Out/Labor/Util/Daily+/-)
│   ├── HourlyChart.jsx     # Mixed bar+line hourly chart
│   ├── HourlyTable.jsx     # 24-row hourly table with collapsible per-project EST drop columns
│   ├── CompareChart.jsx    # Network grouped bar chart (Inb / Out / Est Drops)
│   ├── ProjectList.jsx     # Project throughput table (read-only; totals from hourly sums)
│   ├── RosterBoard.jsx     # dnd-kit 6-lane board
│   └── EmployeeTile.jsx    # Draggable employee tile with start/end time editor
└── pages/
    ├── LaborPlanning.jsx   # Main page (facility tabs + day picker)
    ├── FacilityPanel.jsx   # Per-facility view (EST drops state + seeding logic)
    ├── AllFacilities.jsx   # Network overview (scorecards + compare chart)
    ├── OrderCreator.jsx    # Stub
    ├── Analytics.jsx       # Stub
    └── Settings.jsx        # Stub

netlify/
└── functions/
    ├── omni-query.cjs      # Omni API proxy (Arrow IPC → JSON)
    └── package.json        # type: commonjs, apache-arrow dep

supabase/
└── migrations/
    ├── ...                 # Earlier migrations
    └── 20260421_project_hourly_drops_forecast.sql  # Per-project hourly EST drops table
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

> **Data safety:** Netlify deploys only build and publish frontend assets — they never touch the Supabase database. All roster assignments and EST drops are stored per `plan_date` in Supabase and persist across deploys indefinitely.

---

## Outstanding / Planned Work

- **PROJECT_DROP_RULES** — add rules for MAD, WR, EC facilities and any remaining CAL/KEN projects as their drop logic is confirmed
- **B2E exclusion list** — current list is CAL-derived; verify supervisor IDs apply across all 5 facilities
- **OrderCreator page** — order management UI
- **Analytics page** — historical performance and trend views
- **Settings page** — facility config and user preferences

---

## Known Issues / Performance Notes

### Omni API concurrency limit (502 errors)
**Symptom:** `omni-query 502: {"error":"Omni query did not complete"}` appears in the Hourly Breakdown panel.

**Root cause:** The EST Drops auto-seed fires raw appointment queries (`gold__truck_appointments`) for every project that has a rule in `PROJECT_DROP_RULES`. With 7+ Kenosha rule-projects × 4 historical weeks, this can produce 28+ simultaneous Omni API calls on first load for an unseeded date — enough to overload the API alongside the regular hourly and project data fetches.

**Current fix:** Rule-project queries are serialized (one project at a time, 4 weeks in parallel per project) in `fetchHistoricalProjectHourlyDrops`. This keeps concurrency manageable.

**Scaling concern:** As more projects are added to `PROJECT_DROP_RULES` across all 5 facilities, first-load seeding time will grow linearly. If load times become unacceptable, options include:
1. Move seeding to a Netlify background function triggered on date change (fire-and-forget, UI shows 0 until ready)
2. Pre-seed all facilities nightly via a scheduled Netlify function
3. Add a concurrency cap (e.g. max 3 in-flight Omni requests) using a semaphore pattern
