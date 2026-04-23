# CSW Operations Hub — Labor Planning App

Internal warehouse operations dashboard for Central Storage & Warehouse, a 3PL operating 5 facilities across Wisconsin.

**Live:** [csw-wi.netlify.app](https://csw-wi.netlify.app)  
**Repo:** [DanFritsch-CSW/CSW-WI](https://github.com/DanFritsch-CSW/CSW-WI)

---

## What It Does

The Labor Planning app gives warehouse managers a real-time view of staffing coverage against incoming appointment volume — by facility, by hour, by project, and (for Caledonia) by building side. It replaces manual spreadsheets with a live dashboard that pulls from B2E (workforce scheduling), Omni Analytics (appointment data), and Supabase (daily roster overrides and EST drops).

**Core workflow:**
1. Load a date — the app fetches hourly appointment data and labor forecasts from Omni
2. The roster board shows who is scheduled and on which shift, seeded from B2E
3. EST Drops are auto-calculated from a 4-week same-weekday average and can be manually adjusted
4. Labor Required and Available are computed hourly — gaps surface immediately in the chart and table

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite |
| Routing | React Router v6 (URL-based tab/date state) |
| Charts | Chart.js + react-chartjs-2 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| Database | Supabase (PostgreSQL) |
| Analytics | Omni Analytics API (`csw.omniapp.co`) via Netlify proxy |
| Hosting | Netlify (auto-deploy from `main`) |

---

## Facilities

| ID | Code | Name | Omni warehouse_name | Color |
|---|---|---|---|---|
| `cal` | CAL | Caledonia | `franksville` / `CSW-Franksville` | `#e07b4d` |
| `cal2` | CAL v2 | Caledonia v2 | `franksville` / `CSW-Franksville` | `#e07b4d` |
| `mad` | MAD | Madison | `madison` / `CSW-Madison` | `#4d9de0` |
| `ken` | KEN | Kenosha | `kenosha` / `CSW-Kenosha` | `#3dba7e` |
| `wr` | WR | Wisconsin Rapids | `wisconsin rapids` / `CSW-Wisconsin Rapids` | `#d4b84a` |
| `ec` | EC | Eau Claire | `eau claire` / `CSW-Eau Claire` | `#c084fc` |

> `cal2` is a split view of Caledonia — same Omni data as `cal`, but the roster is divided into 1-2 Side and 3.5 Side. Merge into `cal` once validated.

---

## Pages

| Route | Page | Status |
|---|---|---|
| `/` | Labor Planning | Live |
| `/settings` | Settings | Live |
| `/orders` | Order Creator | Stub |
| `/analytics` | Analytics | Stub |

---

## Labor Planning (`/`)

### ALL Tab
Network overview across all facilities. Shows:
- Per-facility scorecards: Appts, Inbound, Outbound, Est Drops, Labor Req, Labor Avail
- Grouped inbound / outbound / EST drops bar chart

### Facility Tabs (CAL / MAD / KEN / WR / EC / CAL v2)

Each facility tab shows:

**KPI Pills** — Appointments, Inbound, Outbound, EST Drops, Labor Avail, Utilization %, Daily +/-

**Project List** — read-only table of all projects with Inbound / EST Drops / Outbound / Total. Totals always match the Hourly Breakdown table sums (single source of truth).

**Hourly Chart** — mixed bar+line chart. Bars = appointment volume per hour. Lines = Labor Required (red) and Labor Available (green).

**Hourly Breakdown Table** — 24-row table showing per-hour: EST Drops, Inbound, Outbound, Appts, Labor Req, Labor Avail, Adj, Final +/-, Cumulative +/-
- EST Drops column is expandable (▸/▾) to show one editable column per project
- Clicking any project-hour cell opens an inline editor — saves immediately to Supabase
- **Adj column** — manual labor adjustment per hour (e.g. +2 for a temporary boost)
- **↺ Reset EST Drops** — recalculates from the 4-week same-weekday historical average, overwriting manual edits

**Shift Roster Board** — drag-and-drop employee tiles across shift lanes. See [Roster Board](#roster-board) section.

### CAL v2 Tab — Split Building View

CAL v2 is a prototype split view of Caledonia with **All / 1-2 Side / 3.5 Side** sub-tabs:

- **All** — full facility view, identical to the standard CAL tab
- **1-2 Side** — filters KPIs, projects, and hourly table to all non-Palermo's Finished projects; avail counts only `side12_*` lane employees
- **3.5 Side** — filters to Palermo's Caledonia Finished only; avail counts only `side35_*` lane employees

The sub-tabs filter all data panels above the roster. **The roster always shows all 10 lanes** regardless of which sub-tab is active — employees can be dragged between sides freely at any time.

**Per-side hourly appointment data** is fetched via `fetchProjectHourlyAppointments()` which queries `gold__truck_appointments` filtered by project name list for accurate inb/out per side per hour.

---

## Roster Board

Built with `@dnd-kit`. Standard facilities use 6 lanes:

| Lane ID | Label |
|---|---|
| `shift1` | 1st Shift |
| `mid` | Mid Shift |
| `shift2` | 2nd Shift |
| `shift3` | 3rd Shift |
| `pto` | PTO |
| `callin` | Call-In |

CAL v2 uses 10 lanes — 4 per side + shared PTO/Call-In:

| Lane ID | Label |
|---|---|
| `side12_shift1` | 1-2 · 1st |
| `side12_mid` | 1-2 · Mid |
| `side12_shift2` | 1-2 · 2nd |
| `side12_shift3` | 1-2 · 3rd |
| `side35_shift1` | 3.5 · 1st |
| `side35_mid` | 3.5 · Mid |
| `side35_shift2` | 3.5 · 2nd |
| `side35_shift3` | 3.5 · 3rd |
| `pto` | PTO |
| `callin` | Call-In |

**Behavior:**
- Dragging a tile = optimistic local update + Supabase upsert on drop
- On load: reads `roster_assignments` for the date; auto-seeds from B2E if no assignments exist yet
- Employees are grouped within lanes by start time (sub-bucket headers show when 2+ distinct start times exist)
- **Sync from B2E** — pulls latest roster from Omni B2E model, upserts `employees`, seeds `roster_assignments`
- **Reset to B2E** — clears all non-temp assignments for the date and re-seeds from B2E
- **+ Add Temp** — adds a one-day temp employee to any lane
- **Sort** button cycles: Default → A–Z First Name → A–Z Last Name
- **Saving…** indicator pulses while any write is in flight

### Employee Tile Shift Edit

Clicking an employee tile opens a shift time editor with Start and End time fields. On save, duration is computed (handles overnight), rounded to nearest 15 min, and saved to `roster_assignments`.

### B2E Roster Sync

Two parallel Omni queries (ROSTER + SCHEDULE) joined client-side. ROSTER provides the active employee gate (termination filter); SCHEDULE provides names, job codes, and shift times for the target date.

Filters: `employee_status = Active`, `default_job_code IN (205, 209)`, facility location path, plus `B2E_EXCLUDED_IDS` (hardcoded supervisor/manager IDs).

Shift-to-lane mapping (`scheduleToLane`): reads `work_schedule` text first, falls back to start-time bucketing (< 10am → shift1, 10–2pm → mid, 2–8pm → shift2, 8pm+ → shift3).

**CAL v2 dock assignment:** On B2E sync for `cal2`, each employee's saved `default_lane` in Supabase is read first. The side prefix is preserved (`side12` or `side35`) while the shift bucket updates from B2E. New employees not yet in Supabase fall back to a name-based assignment list (`CAL2_DOCK_NAMES_35`).

---

## Settings (`/settings`)

Three tabs:

### Labor Planning
Per-facility **Hours / Appt** setting — the multiplier used to convert appointment count to labor hours required. Shift start times and durations are hardcoded constants in `laborCalc.js` (not user-configurable).

### Break Assumptions
Per-facility per-shift-hour availability percentage. 8 fields (shift hours 1–8), defaulting to `[83, 100, 75, 100, 50, 100, 75, 100]`. Applied in `buildRosterAvailability` to reduce each employee's contribution during break/lunch hours.

### CAL v2 Dock Assignment
Two-column editor (1-2 Side / 3.5 Side) showing all CAL v2 employees. Click `1-2` or `3.5` next to any employee to reassign their default side — saves immediately to `employees.default_lane` in Supabase. Persists across B2E syncs.

> Run a B2E sync from the CAL v2 roster tab first to populate employees before using this editor.

---

## Labor Calculation

### `applySettings(hourlyData, settings)`
Overrides `req` per hour: `req = appts × hours_per_appt`. Takes the full hourly array and facility settings.

### `buildRosterAvailability(employees, laneMap, settings, assignmentMap, laneFilter?)`
Builds a 24-element array of available labor hours indexed by clock hour.

Per employee priority chain:
1. `assignmentMap[id].shift_start` / `.shift_hours` — day-specific tile edit
2. `emp.shift_start` — B2E schedule data
3. Hardcoded `SHIFT_DEFAULTS` for the employee's shift bucket

Break multipliers from `settings.break_hour_1…8` are applied per shift-hour position (not clock hour).

`laneFilter` (optional `Set<string>`) — when provided, only employees in those lane IDs are counted. Used by CAL v2 side tabs.

---

## EST Drops Architecture

### Single Source of Truth

```
project_hourly_drops_forecast (Supabase)
  └── projectHourlyDrops state (FacilityPanel)
        ├── projectDrops (computed memo) → ProjectList totals
        ├── estDrops (computed memo, per-hour sums) → labor calc + HourlyTable
        └── HourlyTable (editable columns, writes back to Supabase)
```

ProjectList totals always equal HourlyTable column sums — there is no separate day-level EST drops state.

### Auto-Seeding
On first load for a facility + date with no rows: calls `fetchHistoricalProjectHourlyDrops` (4-week same-weekday average), bulk-upserts to Supabase, sets local state. Idempotent — only fires when zero rows exist.

### PROJECT_DROP_RULES
Keyed by project display name. Each rule specifies:
- `facility` — scopes the rule to prevent cross-facility pollution
- `method` — `inbound_all`, `inbound_exclude_lookup`, or `inbound_include_lookup`

| Project | Facility | Method |
|---|---|---|
| Palermos CALEDONIA finished | CAL | exclude PUR+CMM and PUR+Peter Brothers |
| Crown Bakeries | KEN | all inbounds |
| Pretzilla Kenosha | KEN | all inbounds |
| Birchwood Foods Kenosha | KEN | all inbounds |
| Fair Oaks Farms | KEN | all inbounds |
| Fair Oaks Farms West | KEN | all inbounds |
| Richelieu Kenosha | KEN | include TOP or PSH lookup codes only |
| Richelieu Raw Materials Kenosha | KEN | include TOP or PSH lookup codes only |

---

## Omni Analytics Integration

**Proxy:** `/.netlify/functions/omni-query` (CORS proxy + Arrow IPC → JSON)  
**Auth:** `OMNI_API_KEY` env var (Netlify dashboard)

### Tables

| Constant | Omni table | Used for |
|---|---|---|
| `VIEW_H` | `labor_planning_app__hourly_labor_required_vs_available` | Hourly labor req/avail, appointment counts |
| `GOLD` | `gold__truck_appointments` | Per-project appointment data, EST drops history, per-side hourly appts |

> `VIEW_P` (`labor_planning_app__hourly_inbound_outbound_drops_summary`) is no longer used. The underlying dbt model has a broken `activity_date` aggregation that drops newer projects. All appointment queries now use `gold__truck_appointments` directly.

### Key API Functions (`src/lib/omni.js`)

| Function | Returns |
|---|---|
| `fetchHourlyData(facilityId, date)` | `[{ h, req, avail, drops, inb, out, appts }]` — 24 rows |
| `fetchProjectData(facilityId, date)` | `[{ name, inb, out, tot }]` — per project |
| `fetchProjectHourlyAppointments(facilityId, date, projectNames)` | `{ [hour]: { inb, out } }` — per-side hourly appts for CAL v2 |
| `fetchNetworkKpis(date)` | `{ [facilityId]: { appts, inb, out, labor, avail, util, delta } }` |
| `fetchHistoricalProjectHourlyDrops(facilityId, date, weeksBack=4)` | `{ [projectName]: { [hour]: avgDrops } }` |
| `fetchB2eRoster(facilityId, date)` | Employee array with lane, shift_start, shift_hours |
| `isRuleProject(facilityId, projectName)` | `boolean` |

### B2E Model

| Constant | Value |
|---|---|
| `B2E_MODEL_ID` | `f3aaca97-bb7c-405d-809b-efab83649ab3` |
| `ROSTER` | `silver__b2e_slv_employeeroster` |
| `SCHEDULE` | `silver__b2e_slv_futurescheduleentries` |

---

## Supabase Schema

**Project ID:** `ppsbqekabtbwsmvdiyga`

```sql
-- Employee baseline (populated by B2E sync)
create table employees (
  id           text primary key,
  facility     text not null,
  name         text not null,
  role         text,
  default_lane text,     -- lane ID; for cal2 includes side prefix (side12_shift1, side35_mid, etc.)
  job_code     text,
  shift_start  text
);

-- Daily drag-drop overrides (keyed by facility + employee + date)
create table roster_assignments (
  id            uuid primary key default gen_random_uuid(),
  facility      text not null,
  employee_id   text not null,
  employee_name text,
  role          text,
  lane          text not null,
  shift_start   integer,    -- hour 0-23
  shift_hours   numeric,    -- duration in hours
  plan_date     date not null,
  is_temp       boolean default false,
  updated_at    timestamptz default now(),
  unique (facility, employee_id, plan_date)
);

-- Per-project per-hour EST drops (single source of truth)
create table project_hourly_drops_forecast (
  facility     text not null,
  plan_date    date not null,
  project_name text not null,
  hour         int  not null,   -- 0-23
  est_drops    int  not null default 0,
  primary key (facility, plan_date, project_name, hour)
);

-- Per-hour manual labor adjustments
create table hourly_labor_adjustments (
  facility   text not null,
  plan_date  date not null,
  hour       int  not null,
  adjustment numeric not null default 0,
  primary key (facility, plan_date, hour)
);

-- Facility-level settings
create table facility_settings (
  facility       text primary key,
  hours_per_appt numeric,
  break_hour_1   numeric, break_hour_2 numeric, break_hour_3 numeric, break_hour_4 numeric,
  break_hour_5   numeric, break_hour_6 numeric, break_hour_7 numeric, break_hour_8 numeric,
  updated_at     timestamptz default now()
);
```

---

## Project Structure

```
src/
├── lib/
│   ├── constants.js        # Facility config, LANES, LANES_CAL2, ACTIVE_LANES, CAL2_DOCK_MAP
│   ├── supabase.js         # All Supabase helpers
│   ├── omni.js             # All Omni API helpers + B2E roster + PROJECT_DROP_RULES
│   └── laborCalc.js        # applySettings, computeDailyKpis, buildRosterAvailability
├── hooks/
│   └── useSettings.js      # Loads facility settings from Supabase
├── components/
│   ├── TopNav.jsx
│   ├── KpiPills.jsx
│   ├── HourlyChart.jsx
│   ├── HourlyTable.jsx     # Expandable per-project EST drops, inline editing, Adj column
│   ├── CompareChart.jsx
│   ├── ProjectList.jsx
│   ├── RosterBoard.jsx     # dnd-kit board (6 lanes standard, 10 lanes CAL v2)
│   ├── EmployeeTile.jsx    # Draggable tile with shift time editor
│   └── AddTempModal.jsx
└── pages/
    ├── LaborPlanning.jsx   # Facility tabs + date picker (URL state via useSearchParams)
    ├── FacilityPanel.jsx   # Per-facility data + CAL v2 side tab logic
    ├── AllFacilities.jsx   # Network overview
    └── Settings.jsx        # Labor / Break Assumptions / CAL v2 Dock Assignment tabs

netlify/
└── functions/
    ├── omni-query.cjs      # Omni proxy (Arrow IPC → JSON)
    └── package.json

supabase/
└── migrations/             # All DDL migrations
```

---

## Local Development

```bash
npm install
npm run dev
```

**Environment variables** (`.env.local`):
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

Netlify function env (set in Netlify dashboard):
```
OMNI_API_KEY=
```

---

## Deployment

Netlify auto-deploys from `main`. `netlify.toml`:

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

## Pending / Planned

- **Merge CAL v2 → CAL** — replace original CAL tab once dock assignments and side tabs are validated
- **PROJECT_DROP_RULES** — add rules for MAD, WR, EC facilities as drop logic is confirmed
- **B2E exclusion list** — verify supervisor IDs are complete across all 5 facilities
- **EST Drops pre-seeding** — nightly Netlify scheduled function to pre-seed all facilities (eliminate first-load delay)
- **OrderCreator page** — order management UI
- **Analytics page** — historical performance and trend views

---

## Known Issues

### Omni 502 errors on first load
**Cause:** EST Drops auto-seed fires multiple `gold__truck_appointments` queries (one per rule project × 4 weeks). With 7+ Kenosha projects this can produce 28+ simultaneous requests.  
**Current fix:** Queries are serialized in `fetchHistoricalProjectHourlyDrops` (one project at a time).  
**Long-term fix:** Pre-seed nightly via scheduled Netlify function.

### CAL v2 side hourly data loads after projects
The `fetchProjectHourlyAppointments` call for side tabs fires after `projects` state loads (it needs the project name list). Expect a brief moment of zero inb/out values on first tab switch before the data arrives.
