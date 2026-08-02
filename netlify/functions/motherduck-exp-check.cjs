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
//     relabeled lots, stripped before decoding. Verified against 12,127
//     real lots with shelf_life_span > 0: 99% exact match (0-1 day off,
//     the 1-day cases look like a UTC/Central day-boundary artifact on
//     timestamps, not real errors), ~1% real mismatches -- the Julian
//     misread errors this feature exists to catch.
//   - Bernatello's: 4-digit YDDD (1-digit year + 3-digit day-of-year,
//     year base 2020), e.g. "6119" = day 119 of '26 = 4/29/26. Verified
//     against 1,943 real lots: 96% exact/near match, ~4% real mismatches.
//   - Both formats confirmed by testing against real stored
//     manufacture_date values, not assumed from a spec doc.
//   - Filtered to shelf_life_span > 0 when validating the format, since
//     packaging/film materials (shelf_life_span = 0) don't follow either
//     Julian convention at all (their lot codes are internal sequence
//     numbers, unrelated to a production date) -- including them produced
//     nonsense multi-year "mismatches" that aren't real.
//   - The Julian check itself is NOT gated on shelf_life_span > 0 in the
//     query below (a lot with no shelf life can still have a real,
//     checkable MFG-vs-lot-code relationship) -- only lots whose
//     lookup_code actually matches the customer's Julian pattern get a
//     julianVerdict at all; everything else reports 'not_applicable'.
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
//     manufacture_date + material.shelf_life_span (more than 1 day off).
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
// Bernatello's, added 2026-08-02: project_id 282 (Madison, BERNA1, inactive since
// 2025-09-08 -- will show nothing at the default window, expected) and 320 (Wisconsin
// Rapids, BERNA3, same project_id the WR Pick Location Lot Check tab already uses).
// Non-food/equipment SKUs (lookup_code prefix "99", e.g. pizza ovens) carry junk
// shelf_life_span values and are excluded globally (verified zero Pretzilla materials
// match that prefix, so this is safe for both customers).
//
// createdBy: the vendor lot row's own created_sys_user -- who/what created THIS specific
// vendor lot record. Confirmed live that the same lookup_code can have multiple distinct
// vendor_lot_id rows over time (re-received/re-created lots sharing a code) -- this is the
// creator of the exact row being flagged, not necessarily "the one true original creation
// event" for that lot code across its whole history. Sometimes a person, sometimes
// "SmartUp API" -- passed through as-is so the UI can distinguish the two.

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

  const customerCfg = CUSTOMERS[customerKey];
  const projectIds = customerCfg.projectIds;
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
        julianVerdict = Math.abs(julianDiff) <= 1 ? 'match' : 'mismatch';
      }
      return {
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
