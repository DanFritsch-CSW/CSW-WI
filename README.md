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
| Database | Supabase (roster persistence) |
| Data | Omni Analytics API (csw.omniapp.co) |
| Hosting | Netlify (auto-deploy from `main`) |

---

## Facilities

| ID | Code | Name | Color |
|---|---|---|---|
| `cal` | CAL | Caledonia | `#e07b4d` |
| `mad` | MAD | Madison | `#4d9de0` |
| `ken` | KEN | Kenosha | `#3dba7e` |
| `wr` | WR | Wisconsin Rapids | `#d4b84a` |
| `ec` | EC | Eau Claire | `#c084fc` |

---

## Pages

| Route | Page | Status |
|---|---|---|
| `/` | Labor Planning | Live |
| `/orders` | Order Creator | Stub |
| `/analytics` | Analytics | Stub |
| `/settings` | Settings | Stub |

### Labor Planning (`/`)
- **ALL tab** — network overview with a grouped inbound/outbound bar chart and per-facility scorecards
- **Facility tabs** — per-facility view with:
  - KPI pills (appointments, inbound, outbound, labor available, utilization)
  - Insight chips (auto-generated status alerts)
  - Hourly chart (appointments bar + required/available labor lines)
  - Delta chart (labor surplus/deficit by hour)
  - Project throughput list
  - Shift roster board (drag-and-drop)

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
- On page load: fetches today's assignments from Supabase; falls back to `employees.default_lane`
- Labor Available KPI = count of employees in `shift1` + `shift2`

---

## Supabase Schema

```sql
-- Employees master list
create table employees (
  id           text primary key,
  facility     text not null,
  name         text not null,
  role         text,
  default_lane text
);

-- Daily shift assignments (upserted on drag-drop)
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

## Omni Analytics Integration

Base URL: `https://csw.omniapp.co`
Auth: `x-api-key` header

All calls are currently **stubbed** in `src/lib/omni.js`. Three functions ready for real query IDs:

| Function | Returns | Status |
|---|---|---|
| `fetchHourlyData(facility, date)` | `[{ h, req, avail, appts, inb, out }]` | Stubbed |
| `fetchProjectData(facility, date)` | `[{ name, inb, out, tot }]` | Stubbed |
| `fetchNetworkKpis(date)` | `{ [facilityId]: { appts, inb, out, labor, util } }` | Stubbed |

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in credentials
cp .env.example .env

# 3. Start dev server
npm run dev
```

### Environment Variables

```
VITE_SUPABASE_URL=       # Your Supabase project URL
VITE_SUPABASE_ANON_KEY=  # Your Supabase anon/public key
VITE_OMNI_API_KEY=       # Omni Analytics API key
```

The app runs fully without credentials — Supabase calls no-op gracefully and all data falls back to stubs.

---

## Project Structure

```
src/
├── lib/
│   ├── constants.js      # Facility config, lane config
│   ├── supabase.js       # Supabase client + roster helpers
│   └── omni.js           # Omni API helpers (stubbed)
├── components/
│   ├── TopNav.jsx        # Sticky nav + utility bar
│   ├── KpiPills.jsx      # Metric pill row
│   ├── InsightChips.jsx  # Auto status chips
│   ├── HourlyChart.jsx   # Mixed bar+line hourly chart
│   ├── DeltaChart.jsx    # Labor delta bar chart
│   ├── CompareChart.jsx  # Network grouped bar chart
│   ├── ProjectList.jsx   # Throughput table
│   ├── RosterBoard.jsx   # dnd-kit 4-lane board
│   └── EmployeeTile.jsx  # Draggable employee tile
└── pages/
    ├── LaborPlanning.jsx # Main page (facility tabs + day picker)
    ├── FacilityPanel.jsx # Per-facility view
    ├── AllFacilities.jsx # Network overview
    ├── OrderCreator.jsx  # Stub
    ├── Analytics.jsx     # Stub
    └── Settings.jsx      # Stub
```

---

## Deployment

Netlify auto-deploys from `main`. Build config in `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to   = "/index.html"
  status = 200
```

---

## Outstanding Integration Steps

1. **Supabase credentials** — add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to Netlify env vars
2. **Employee roster seed** — seed the `employees` table per facility (data to be provided)
3. **Omni query IDs** — swap stubs in `src/lib/omni.js` with real query IDs once provided
4. **OrderCreator page** — build out order management UI
5. **Analytics page** — historical performance and trend views
6. **Settings page** — facility config and user preferences
