// DPI Monthly Process — Phase 1 parser.
//
// Turns a raw FDP201W.csv (the state's monthly drop report) into the shape
// the dpi-import-push-background.cjs function expects. Pure functions only —
// no fetch, no Supabase, no Datex — so this is testable in isolation and
// reusable for both a "preview" pass (staging table) and the real push.
//
// Confirmed against a real September 2026 sample file (2026-09-05):
//   - Header row is preceded by two title rows; find it by first cell === 'txtSponsorNbr'
//   - txtDeliveryAddr is a 3-line block: "{Name}-DeliverySite\n{street}\n{City, ST zip}"
//   - txtDelivery carries "Delivery for the Month of: September 2026" — parse
//     month/year from here rather than from the upload date, since the file
//     could be uploaded on a different day than "this month".
//   - txtSumGrossWeight / txtRptWarehouses are present but NOT used for order
//     creation (per Dan: Datex materials are the weight source of truth;
//     NSLP/TEFAP split doesn't affect order creation — confirmed 2026-09-05).

const MONTH_ABBREV = {
  January: 'Jan', February: 'Feb', March: 'Mar', April: 'Apr',
  May: 'May', June: 'Jun', July: 'Jul', August: 'Aug',
  September: 'Sep', October: 'Oct', November: 'Nov', December: 'Dec',
}

/** Finds the header row index in the raw parsed rows (Papa.parse with header:false). */
function findHeaderRowIndex(rows) {
  return rows.findIndex((r) => r[0] === 'txtSponsorNbr')
}

/** "Delivery for the Month of: September 2026" -> { monthKey: '2026-09', lookupPrefix: 'Sep26' } */
function parseDeliveryMonth(txtDelivery) {
  const m = String(txtDelivery || '').match(/Delivery for the Month of:\s*(\w+)\s+(\d{4})/i)
  if (!m) return null
  const [, monthName, year] = m
  const abbrev = MONTH_ABBREV[monthName] || monthName.slice(0, 3)
  const yy = year.slice(-2)
  return {
    monthKey: `${year}-${String(Object.keys(MONTH_ABBREV).indexOf(monthName) + 1).padStart(2, '0')}`,
    lookupPrefix: `${abbrev}${yy}`,
  }
}

/**
 * "Cambria-Friesland School District-DeliverySite\n410 East Edgewater Street\nCambria, WI 53923"
 * -> { line1: '410 East Edgewater Street', city: 'Cambria', state: 'WI', postalCode: '53923' }
 * Handles addresses with a 2-line street (4 lines total) by joining the middle lines.
 */
function parseDeliveryAddress(txtDeliveryAddr) {
  const lines = String(txtDeliveryAddr || '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return { line1: null, city: null, state: null, postalCode: null }

  const lastLine = lines[lines.length - 1]
  const cityStateZip = lastLine.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5})/)

  const streetLines = lines.slice(1, lines.length - 1) // drop the "-DeliverySite" label line and the city/state/zip line
  return {
    line1: streetLines.join(', ') || null,
    city: cityStateZip ? cityStateZip[1] : null,
    state: cityStateZip ? cityStateZip[2] : null,
    postalCode: cityStateZip ? cityStateZip[3] : null,
  }
}

// Ordered abbreviation rules — applied only while the name still exceeds 32
// chars, stopping as soon as it fits. Agreed with Dan 2026-09-05.
const ABBREVIATION_RULES = [
  (s) => s.replace(/ and /gi, ' & '),
  (s) => s.replace(/School District/gi, 'Sch Dist'),
  (s) => s.replace(/\bfor the\b/gi, '').replace(/\bfor\b/gi, '').replace(/\s{2,}/g, ' ').trim(),
  (s) => s.replace(/District/gi, 'Dist').replace(/Community/gi, 'Comm'),
]

const MAX_NAME_LENGTH = 32

/** Returns { name, wasAbbreviated } — name is untouched if already <= 32 chars. */
function abbreviateAgencyName(name) {
  let result = name
  if (result.length <= MAX_NAME_LENGTH) return { name: result, wasAbbreviated: false }

  for (const rule of ABBREVIATION_RULES) {
    result = rule(result)
    if (result.length <= MAX_NAME_LENGTH) break
  }
  if (result.length > MAX_NAME_LENGTH) {
    result = result.slice(0, MAX_NAME_LENGTH) // last-resort hard truncate
  }
  return { name: result, wasAbbreviated: true }
}

/**
 * Groups raw CSV rows (as arrays, matching the header order) into one
 * agency order per unique txtSponsorNbr.
 *
 * @param {string[][]} rawRows - Papa.parse output with header:false, already
 *   sliced to start at the header row (row[0] included).
 * @returns {{ monthKey: string, agencies: object[] }}
 */
function parseFdp201w(rawRows) {
  const headerIdx = findHeaderRowIndex(rawRows)
  if (headerIdx === -1) throw new Error('Could not find header row (expected "txtSponsorNbr" as first column)')

  const header = rawRows[headerIdx]
  const col = (name) => header.indexOf(name)
  const idx = {
    sponsorNbr: col('txtSponsorNbr'),
    sponsorNme: col('txtSponsorNme'),
    delivery: col('txtDelivery'),
    deliveryAddr: col('txtDeliveryAddr'),
    productCde: col('ProductCde'),
    qtyOrd: col('QtyOrd'),
  }
  for (const [key, i] of Object.entries(idx)) {
    if (i === -1) throw new Error(`Expected column not found in CSV header: ${key}`)
  }

  const dataRows = rawRows.slice(headerIdx + 1).filter((r) => r.length > 1 && r[idx.sponsorNbr])

  let monthInfo = null
  const groups = new Map() // agencyNumber -> accumulator

  for (const row of dataRows) {
    const agencyNumber = String(row[idx.sponsorNbr]).trim()
    if (!agencyNumber) continue

    if (!monthInfo) {
      monthInfo = parseDeliveryMonth(row[idx.delivery])
      if (!monthInfo) throw new Error(`Could not parse delivery month from: "${row[idx.delivery]}"`)
    }

    if (!groups.has(agencyNumber)) {
      const address = parseDeliveryAddress(row[idx.deliveryAddr])
      const rawName = String(row[idx.sponsorNme]).trim()
      const { name: abbreviatedName, wasAbbreviated } = abbreviateAgencyName(rawName)
      groups.set(agencyNumber, {
        agencyNumber,
        agencyName: rawName,
        firstName: abbreviatedName,
        nameWasAbbreviated: wasAbbreviated,
        ...address,
        lookupCode: `${monthInfo.lookupPrefix} - ${agencyNumber}`,
        lines: [],
      })
    }

    groups.get(agencyNumber).lines.push({
      materialLookupCode: String(row[idx.productCde]).trim(),
      quantity: Number(row[idx.qtyOrd]) || 0,
    })
  }

  return {
    monthKey: monthInfo ? monthInfo.monthKey : null,
    agencies: [...groups.values()],
  }
}

export {
  findHeaderRowIndex,
  parseDeliveryMonth,
  parseDeliveryAddress,
  abbreviateAgencyName,
  parseFdp201w,
  MAX_NAME_LENGTH,
}
