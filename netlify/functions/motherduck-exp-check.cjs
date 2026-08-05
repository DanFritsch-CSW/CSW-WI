// netlify/functions/motherduck-exp-check.cjs
//
// EXP Check — two independent reconciliations, per customer:
//
//   1. Julian check (added 2026-08-02, Dan's ask): decodes the LOT CODE
//      ITSELF as a Julian manufacture-date code and compares it to the
//      manufacture_date already stored in Datex. This is the actual
//      "did the human read the Julian code off the case label correctly"
//      check -- catches a misread Julian code even when it's internally
//      consistent with a correctly-computed EXP (which the EXP check
//      below cannot catch, since it only checks Datex's own MFG+shelf
//      life math against Datex's own stored EXP, never against the
//      physical label).
//
//   2. EXP check (original build): does stored expiration_date reconcile
//      with stored manufacture_date + material.shelf_life_span. Catches
//      missing shelf-life config and math discrepancies, but NOT a
//      misread MFG date that's internally consistent with its own EXP.
//
// Real discovery that made the Julian check possible: confirmed live that
// each customer's lot lookup_code IS itself the Julian-encoded manufacture
// date, not just an arbitrary lot number:
//   - Pretzilla: 5-digit YYDDD (2-digit year + 3-digit day-of-year), e.g.
//     "26210" = day 210 of '26 = 7/29/26. Optional trailing "A" for
//     relabeled lots, stripped before decoding.
//   - Bernatello's: 4-digit YDDD (1-digit year + 3-digit day-of-year,
//     year base 2020), e.g. "6119" = day 119 of '26 = 4/29/26.
//   - Both formats confirmed by testing against real stored
//     manufacture_date values, not assumed from a spec doc.
//   - The Julian check itself is NOT gated on shelf_life_span > 0 in the
//     query below (a lot with no shelf life can still have a real,
//     checkable MFG-vs-lot-code relationship) -- only lots whose
//     lookup_code actually matches the customer's Julian pattern get a
//     julianVerdict at all; everything else reports 'not_applicable'.
//
// Julian check tolerance is EXACT MATCH, zero tolerance (fixed 2026-08-05,
// Billie Jo's manual audit): originally shipped with an "off by <=1 day
// counts as match" tolerance, on the theory that a 1-day gap was usually
// a UTC/Central timestamp-boundary artifact rather than a real error.
// Billie Jo's own manual spreadsheet audit (Lot Converted vs Man Date,
// zero tolerance) caught real 1-day discrepancies our app was silently
// swallowing as "match" -- including at least one (lot 26212, five
// materials, Pretzilla Kenosha) where the underlying timestamp was
// exactly midnight Central, so it wasn't even a timezone artifact, just a
// real 1-day gap between the lot code and the recorded MFG date. The
// team's actual working standard is exact equality, not a tolerance band
// -- confirmed by checking the live impact before changing this (in the
// current 45-day Pretzilla window: 85 exact matches, 4 one-day-off lots
// that now correctly flip to 'mismatch', 1 lot already >1 day off -- a
// small, safe increase, not a reopening of the original all-time-noise
// problem that motivated the day-window scoping below).
//
// What the Julian check does NOT do: it does not read the physical case
// label or BOL -- it only has the lot_code Datex already has on file. If
// BOTH the lot_code and the MFG date were mis-keyed the same wrong way,
// this still shows a match. That residual case still needs a human
// comparing against the actual printed label.
//
// --- Everything below this line is the original EXP-check design ---
//
// What the EXP check catches:
//   - no_shelf_life: material has shelf_life_span = 0 (or null), so Datex has no real
//     dating for it at all — EXP silently ends up equal to MFG. This is a data-setup gap,
//     not a one-off entry mistake (e.g. lookup_code 60613/60624 — packaging/film materials).
//   - mismatch: expiration_date on the vendor lot doesn't reconcile with
//     manufacture_date + material.shelf_life_span (more than 1 day off). This tolerance is
//     UNCHANGED (still <=1 day = clean) -- Billie Jo's audit was specifically about the
//     Julian check (lot code vs MFG date), not this EXP-vs-shelf-life check, and this
//     tolerance has its own separate live validation (99% match rate on real data) backing it.
//   - relabeled: lookup_code ends in "A" — Pretzilla's convention for a pallet that was
//     taken back and relabeled with an extended expiration date. NOT an error — flagged
//     separately for a human to eyeball. Bernatello's has no equivalent convention observed
//     live, so this bucket naturally stays empty for that customer — not a bug.
//
// Scope: last N days by vendor lot CREATED date (default 45) — NOT all-time. Verified live
// that scanning all historical Pretzilla lots produces ~9,400 EXP "mismatches" alone, almost
// all of which are legitimate: a material's shelf_life_span was changed at some point, and
// old lots' already-computed EXP correctly reflects whatever shelf life was configured when
// THEY were created, not today's value. Scoping to recent lots avoids drowning real,
// actionable anomalies in that historical noise.
//
// On-hand filter (added 2026-08-02, Billie Jo's feedback via Front on Bernatello's WR):
// lot 6168/material 120 showed up flagged even though it had already fully shipped out on
// 7/13 -- confirmed live via gold.available_inventory_by_lp (SUM(available_amount) = 0
// across every warehouse for that vendor_lot_id) that there was zero remaining inventory
// anywhere. A shipped-out lot isn't operationally actionable (nothing left to correct/pull),
// so it's noise. Now hard-filtered via an INNER JOIN against an on-hand CTE (only lots with
// SUM(available_amount) > 0 survive); confirmed gold.available_inventory_by_lp has coverage
// across all 5 warehouses, so this filter applies safely to Pretzilla too, not just
// Bernatello's/WR.
//
// Bernatello's, added 2026-08-02: project_id 282 (Madison, BERNA1, inactive since
// 2025-09-08 -- will show nothing at the default window, expected) and 320 (Wisconsin
// Rapids, BERNA3, same project_id the WR Pick Location Lot Check tab already uses).
// Non-food/equipment SKUs (lookup_code prefix "99", e.g. pizza ovens) carry junk
// shelf_life_span values and are excluded globally (verified zero Pretzilla materials
// match that prefix, so this is safe for both customers).
//
// createdBy: the vendor lot row's own created_sys_user -- who/what created THIS specific
// vendor lot record. Sometimes a person, sometimes "SmartUp API" -- passed through as-is so
// the UI can distinguish the two. Confirmed live (Front feedback thread, 2026-08-02) this
// field is accurate to Datex's own record even when the named person is surprised to see it
// -- not a display bug on our end.
//
// projectId (added 2026-08-02, for the per-project Notify digest): optionally scopes the
// query to exactly ONE project_id instead of a whole customer's project list. Still resolves
// the right customer's Julian format automatically via PROJECT_TO_CUSTOMER, so the caller
// only needs to pass projectId, not customer+projectId.

const duckdb = require('duckdb');

const CUSTOMERS = {
  pretzilla: {
    label: 'Pretzilla',
    projectIds: [230, 342, 28, 145, 297, 336],
    // 5-digit YYDDD, optional trailing "A" (relabeled) stripped before decode
    julian: { totalDigits: 5, yearDigits: 2, yearBase: 2000, allowTrailingA: true },
  },
  bernatellos: {
    label: "Bernatello's",
    projectIds: [282, 320],
    // 4-digit YDDD, single-digit year
    julian: { totalDigits: 4, yearDigits: 1, yearBase: 2020, allowTrailingA: false },
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

const PROJECT_NAME = {
  230: 'Pretzilla Kenosha',
  342: 'Pretzilla COOLER Kenosha',
  28: 'Pretzilla FROZEN Caledonia',
  145: 'Pretzilla COOLER Caledonia',
  297: "Pretzilla - CSW-Madison",
  336: 'Pretzilla - Dry - CSW-Madison',
  282: "Bernatello's - CSW-Madison",
  320: "Bernatello's - Wisconsin Rapids",
};

const PROJECT_TO_CUSTOMER = {};
for (const [key, cfg] of Object.entries(CUSTOMERS)) {
  for (const pid of cfg.projectIds) PROJECT_TO_CUSTOMER[pid] = key;
}

function getDb() {
  process.env.HOME = '/tmp';
  return new duckdb.Database(':memory:');
}

// Builds the SQL fragments for a customer's Julian lot-code format:
// a boolean "does this lookup_code match the pattern" expression, and a
// "decoded calendar date" expression (both operate on the raw lot_code
// column reference passed in).
function julianSqlFor(colExpr, fmt) {
  const dayDigits = fmt.totalDigits - fmt.yearDigits;
  const numericPattern = fmt.allowTrailingA
    ? `^[0-9]{${fmt.totalDigits}}A?$`
    : `^[0-9]{${fmt.totalDigits}}$`;
  // Strip a trailing "A" (if allowed) before parsing year/day substrings.
  const codeForParse = fmt.allowTrailingA
    ? `regexp_replace(${colExpr}, 'A$', '')`
    : colExpr;
  const yearExpr = `CAST(SUBSTR(${codeForParse}, 1, ${fmt.yearDigits}) AS INTEGER)`;
  const dayExpr = `CAST(SUBSTR(${codeForParse}, ${fmt.yearDigits + 1}, ${dayDigits}) AS INTEGER)`;
  const matchExpr = `regexp_matches(${colExpr}, '${numericPattern}')`;
  const decodedDateExpr = `(DATE '${fmt.yearBase}-01-01' + INTERVAL (${yearExpr}) YEAR + INTERVAL (${dayExpr} - 1) DAY)`;
  return { matchExpr, decodedDateExpr };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let dayWindow = 45;
  let customerKey = 'pretzilla';
  let singleProjectId = null;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (body.dayWindow && Number.isFinite(Number(body.dayWindow))) {
      dayWindow = Math.max(1, Math.min(365, Number(body.dayWindow)));
    }
    if (body.customer && CUSTOMERS[body.customer]) {
      customerKey = body.customer;
    }
    if (body.projectId && PROJECT_TO_CUSTOMER[Number(body.projectId)]) {
      singleProjectId = Number(body.projectId);
      customerKey = PROJECT_TO_CUSTOMER[singleProjectId];
    }
  } catch (_) {
    // ignore, use defaults
  }

  const customerCfg = CUSTOMERS[customerKey];
  const projectIds = singleProjectId ? [singleProjectId] : customerCfg.projectIds;
  const { matchExpr, decodedDateExpr } = julianSqlFor('vl.lookup_code', customerCfg.julian);

  const db = getDb();
  const conn = db.connect();

  const runQuery = (sql) =>
    new Promise((resolve, reject) => {
      conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  try {
    await runQuery(`ATTACH 'md:production_db' (READ_ONLY)`);

    const sql = `
      WITH onhand AS (
        SELECT vendor_lot_id, SUM(available_amount) AS qty
        FROM production_db.gold.available_inventory_by_lp
        GROUP BY vendor_lot_id
        HAVING SUM(available_amount) > 0
      )
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
        oh.qty                     AS on_hand_qty,
        ${matchExpr}               AS julian_applicable,
        CASE WHEN ${matchExpr} THEN ${decodedDateExpr} ELSE NULL END AS julian_decoded_date,
        CASE WHEN ${matchExpr} THEN
          DATE_DIFF('day', ${decodedDateExpr}, CAST(vl.manufacture_date AS DATE))
        ELSE NULL END              AS julian_diff_days,
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
      JOIN onhand oh ON vl.vendor_lot_id = oh.vendor_lot_id
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

    const lots = rows.map((r) => {
      const julianApplicable = !!r.julian_applicable;
      const julianDiff = r.julian_diff_days === null || r.julian_diff_days === undefined ? null : Number(r.julian_diff_days);
      let julianVerdict = 'not_applicable';
      if (julianApplicable) {
        // Zero tolerance (fixed 2026-08-05) -- see file header. Exact
        // equality only; even a 1-day gap is a real mismatch worth
        // surfacing, per Billie Jo's manual audit standard.
        julianVerdict = julianDiff === 0 ? 'match' : 'mismatch';
      }
      return {
        lotCode: r.lot_code,
        materialCode: r.material_code,
        materialName: r.material_name,
        facility: PROJECT_FACILITY[r.project_id] || null,
        projectId: r.project_id,
        projectName: r.project_name,
        shelfLifeSpan: r.shelf_life_span === null ? null : Number(r.shelf_life_span),
        manufactureDate: r.manufacture_date,
        expirationDate: r.expiration_date,
        expectedExpiration: r.expected_expiration,
        diffDays: r.diff_days === null ? null : Number(r.diff_days),
        createdAt: r.created_sys_date_time,
        createdBy: r.created_by,
        onHandQty: r.on_hand_qty === null || r.on_hand_qty === undefined ? null : Number(r.on_hand_qty),
        verdict: r.verdict,
        julianApplicable,
        julianDecodedDate: r.julian_decoded_date || null,
        julianDiffDays: julianDiff,
        julianVerdict,
      };
    });

    const summary = lots.reduce(
      (acc, l) => {
        acc[l.verdict] = (acc[l.verdict] || 0) + 1;
        return acc;
      },
      { clean: 0, mismatch: 0, no_shelf_life: 0, relabeled: 0 }
    );

    const julianSummary = lots.reduce(
      (acc, l) => {
        acc[l.julianVerdict] = (acc[l.julianVerdict] || 0) + 1;
        return acc;
      },
      { match: 0, mismatch: 0, not_applicable: 0 }
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lots,
        summary,
        julianSummary,
        dayWindow,
        customer: customerKey,
        customerLabel: customerCfg.label,
        projectId: singleProjectId,
        projectName: singleProjectId ? (PROJECT_NAME[singleProjectId] || lots[0]?.projectName || null) : null,
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
