// netlify/functions/motherduck-exp-check.cjs
//
// EXP Check — math-reconciliation only. Multi-customer (added 2026-08-02,
// Dan's ask to add customers beyond Pretzilla, starting with Bernatello's).
//
// What this catches:
//   - no_shelf_life: material has shelf_life_span = 0 (or null), so Datex has no real
//     dating for it at all — EXP silently ends up equal to MFG. This is a data-setup gap,
//     not a one-off entry mistake (e.g. lookup_code 60613/60624 — packaging/film materials).
//   - mismatch: expiration_date on the vendor lot doesn't reconcile with
//     manufacture_date + material.shelf_life_span (more than 1 day off). This is a real
//     math discrepancy — could mean the MFG date was mis-keyed (Julian misread), or the
//     lot was manually overridden without a lookup_code "A" suffix.
//   - relabeled: lookup_code ends in "A" — Pretzilla's convention for a pallet that was
//     taken back and relabeled with an extended expiration date. NOT an error — flagged
//     separately for a human to eyeball, per standing convention with Sadie/Billie Jo.
//     Bernatello's has no equivalent convention observed live (no "A"-suffix lots found),
//     so this bucket will naturally stay empty for that customer — not a bug.
//
// What this does NOT catch (confirmed with Dan, scoped out on purpose):
//   - A misread Julian code that's internally consistent (MFG entered wrong, but EXP
//     still auto-computes correctly off that wrong MFG date). Datex has no way to know
//     the MFG date itself is wrong — only a human comparing against the physical
//     case label/BOL can catch that. This tab is math-reconciliation only.
//
// Scope: last N days by vendor lot CREATED date (default 45) — NOT all-time. Verified live
// that scanning all historical Pretzilla lots produces ~9,400 "mismatches" alone, almost all
// of which are legitimate: a material's shelf_life_span was changed at some point, and old
// lots' already-computed EXP correctly reflects whatever shelf life was configured when
// THEY were created, not today's value. Scoping to recent lots avoids drowning real,
// actionable anomalies in that historical noise.
//
// Bernatello's, added 2026-08-02: project_id 282 (Madison, BERNA1) and 320 (Wisconsin
// Rapids, BERNA3 — same project_id already used by the WR Pick Location Lot Check tab).
// Two real things found live before shipping:
//   1. Madison (282) has been inactive since 2025-09-08 (last lot created then) — will
//      show nothing at the default 45-day window, which is correct/expected, not a bug.
//   2. Non-food/equipment SKUs (lookup_code starting "99", e.g. "991005" Pizza Oven #421)
//      carry junk shelf_life_span values (one was 49,050 days — ~134 years), which would
//      otherwise produce nonsense diff_days. Same exclusion already used in
//      motherduck-wr-pick-check.cjs (lookup_code NOT ILIKE '99%'). Verified live that zero
//      Pretzilla materials match this prefix, so applying it globally (not per-customer) is
//      safe and doesn't accidentally exclude anything real for Pretzilla.
// Real, recurring pattern also found in Bernatello's data (documented here, not silently
// dropped): several "HV Tavern Style Breakfast/Supreme" lots consistently show diff_days of
// exactly -60 across many lots — looks like the material's configured shelf_life_span (240)
// doesn't match what's actually used for that item, a systematic config issue rather than
// scattered entry errors. Left as a real `mismatch` — worth a follow-up with Dan on whether
// that material's shelf_life_span needs correcting in Datex itself.
//
// createdBy: the vendor lot row's own created_sys_user -- who/what created THIS specific
// vendor lot record. Confirmed live that the same lookup_code can have multiple distinct
// vendor_lot_id rows over time (re-received/re-created lots sharing a code) -- this is the
// creator of the exact row being flagged, not necessarily "the one true original creation
// event" for that lot code across its whole history. Also confirmed live that this field is
// sometimes a person (e.g. "mdile@csw-wi.com", "FOOTPRINT\\csw-fpservice") and sometimes
// "SmartUp API" (automated creation, not a person) -- passed through as-is rather than
// normalized, so the UI can distinguish human vs. system-created rows.

const duckdb = require('duckdb');

const CUSTOMERS = {
  pretzilla: {
    label: 'Pretzilla',
    projectIds: [230, 342, 28, 145, 297, 336],
  },
  bernatellos: {
    label: "Bernatello's",
    projectIds: [282, 320],
  },
};

const PROJECT_FACILITY = {
  230: 'ken', // Pretzilla Kenosha (PRETZ5)
  342: 'ken', // Pretzilla COOLER Kenosha (PRTZL5)
  28: 'cal',  // Pretzilla FROZEN Caledonia (PRETZ9)
  145: 'cal', // Pretzilla COOLER Caledonia (PRTZL9)
  297: 'mad', // Pretzilla - CSW-Madison (PRETZ1)
  336: 'mad', // Pretzilla - Dry - CSW-Madison (PRETD1)
  282: 'mad', // Bernatello's - CSW-Madison (BERNA1)
  320: 'wr',  // Bernatello's - Wisconsin Rapids (BERNA3)
};

const PROJECT_CUSTOMER_KEY = {};
for (const [key, cfg] of Object.entries(CUSTOMERS)) {
  for (const pid of cfg.projectIds) PROJECT_CUSTOMER_KEY[pid] = key;
}

function getDb() {
  process.env.HOME = '/tmp';
  return new duckdb.Database(':memory:');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let dayWindow = 45;
  let customerKey = 'pretzilla';
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (body.dayWindow && Number.isFinite(Number(body.dayWindow))) {
      dayWindow = Math.max(1, Math.min(365, Number(body.dayWindow)));
    }
    if (body.customer && CUSTOMERS[body.customer]) {
      customerKey = body.customer;
    }
  } catch (_) {
    // ignore, use defaults
  }

  const projectIds = CUSTOMERS[customerKey].projectIds;

  const db = getDb();
  const conn = db.connect();

  const runQuery = (sql) =>
    new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    await runQuery(`ATTACH 'md:production_db' (READ_ONLY)`);

    const sql = `
      SELECT
        vl.lookup_code            AS lot_code,
        m.lookup_code             AS material_code,
        m.material_name           AS material_name,
        p.project_id              AS project_id,
        p.project_name            AS project_name,
        m.shelf_life_span         AS shelf_life_span,
        vl.manufacture_date       AS manufacture_date,
        vl.expiration_date        AS expiration_date,
        vl.manufacture_date + INTERVAL (COALESCE(m.shelf_life_span, 0)) DAY AS expected_expiration,
        DATE_DIFF(
          'day',
          vl.manufacture_date + INTERVAL (COALESCE(m.shelf_life_span, 0)) DAY,
          vl.expiration_date
        )                          AS diff_days,
        vl.created_sys_date_time  AS created_sys_date_time,
        vl.created_sys_user       AS created_by,
        CASE
          WHEN m.shelf_life_span IS NULL OR m.shelf_life_span = 0 THEN 'no_shelf_life'
          WHEN vl.lookup_code ILIKE '%A' THEN 'relabeled'
          WHEN ABS(DATE_DIFF(
            'day',
            vl.manufacture_date + INTERVAL (COALESCE(m.shelf_life_span, 0)) DAY,
            vl.expiration_date
          )) <= 1 THEN 'clean'
          ELSE 'mismatch'
        END                        AS verdict
      FROM production_db.silver.datex_slv_vendorlots vl
      JOIN production_db.silver.datex_slv_materials m ON vl.material_id = m.material_id
      JOIN production_db.silver.datex_slv_projects p ON m.project_id = p.project_id
      WHERE p.project_id IN (${projectIds.join(',')})
        AND m.lookup_code NOT ILIKE '99%'
        AND vl.manufacture_date IS NOT NULL
        AND vl.expiration_date IS NOT NULL
        AND vl.created_sys_date_time >= CURRENT_DATE - INTERVAL ${dayWindow} DAY
      ORDER BY
        CASE verdict WHEN 'mismatch' THEN 0 WHEN 'no_shelf_life' THEN 1 WHEN 'relabeled' THEN 2 ELSE 3 END,
        vl.created_sys_date_time DESC
    `;

    const rows = await runQuery(sql);

    const lots = rows.map((r) => ({
      lotCode: r.lot_code,
      materialCode: r.material_code,
      materialName: r.material_name,
      facility: PROJECT_FACILITY[r.project_id] || null,
      projectName: r.project_name,
      shelfLifeSpan: r.shelf_life_span === null ? null : Number(r.shelf_life_span),
      manufactureDate: r.manufacture_date,
      expirationDate: r.expiration_date,
      expectedExpiration: r.expected_expiration,
      diffDays: r.diff_days === null ? null : Number(r.diff_days),
      createdAt: r.created_sys_date_time,
      createdBy: r.created_by,
      verdict: r.verdict,
    }));

    const summary = lots.reduce(
      (acc, l) => {
        acc[l.verdict] = (acc[l.verdict] || 0) + 1;
        return acc;
      },
      { clean: 0, mismatch: 0, no_shelf_life: 0, relabeled: 0 }
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lots,
        summary,
        dayWindow,
        customer: customerKey,
        customerLabel: CUSTOMERS[customerKey].label,
        fetchedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  } finally {
    conn.close();
    db.close(() => {});
  }
};
