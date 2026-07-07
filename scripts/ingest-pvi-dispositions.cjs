#!/usr/bin/env node
/*
 * scripts/ingest-pvi-dispositions.cjs
 *
 * One-off bulk ingest: Palermo's bi-weekly At Risk / Quarantine / Expired
 * Excel workbook → pvi_lot_dispositions in Supabase.
 *
 * Hill's Slack (2026-07-07, follow-up to the disposition feature):
 *   "can you try to upload this spreadsheet to the app with owner and
 *    comments added and have it choose the best of the tags available
 *    based on the comment?"
 *
 * Dan's direction: no import UI. This is a legacy-data migration, not
 * an ongoing capability. Operators will edit dispositions in the drawer
 * going forward — the Excel workbook is a one-time source-of-truth for
 * seeding what's already been decided.
 *
 * What this script does:
 *   1. Reads every sheet in the workbook.
 *   2. Detects (Item, Lot, Owner, Comment) columns by header pattern.
 *   3. Parses each sheet name for a date (e.g. "At Risk 6-24" → Jun 24)
 *      and processes oldest-first so the LATEST observation for each
 *      (material_code, lot_code) wins.
 *   4. Classifies each row's comment into one of DISPOSITION_OPTIONS
 *      via ordered keyword rules (see CLASSIFIER_RULES).
 *   5. Upserts to pvi_lot_dispositions via the Supabase anon key.
 *   6. Prints a summary + full list of unclassified comments so a
 *      human can add keyword rules and rerun.
 *
 * Usage:
 *   node scripts/ingest-pvi-dispositions.cjs <xlsx-path> [--dry-run]
 *
 * Example:
 *   node scripts/ingest-pvi-dispositions.cjs \
 *     ~/Downloads/2026_FG_At_Risk_Report_vCSW.xlsx --dry-run
 *
 * Env (from .env.local via dotenv, or shell):
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY
 *
 * Iteration workflow:
 *   1. Run with --dry-run. Scan the "Unmatched comments" section.
 *   2. If a common pattern appears, add a regex to CLASSIFIER_RULES.
 *   3. Rerun --dry-run until the unclassified list is acceptable.
 *   4. Rerun without --dry-run to write. Upsert is idempotent, safe
 *      to run repeatedly.
 *
 * Repeatability: upserts on (material_code, lot_code) — the composite
 * PK. Rerunning overwrites the existing row (including cases where the
 * dashboard operator has already edited it). Add a --skip-existing
 * flag if that becomes a concern once operators are using the UI.
 */

const path = require('path')
const fs   = require('fs')

// dotenv is optional — falls back to shell env if not installed.
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') }) } catch (_) {}

const xlsx = require('xlsx')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.')
  console.error('Set them in .env.local at the repo root, or export them in your shell.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Classifier: keyword rules → 9-category disposition ────────────────
//
// Ordered by specificity — first rule that matches wins. Add new
// patterns as operators surface comment shapes not yet covered.
// Rules are grouped by disposition; within each group, patterns are
// checked in order.
//
// Design principles:
//   - Prefer word-boundary anchors (\b) so short tokens don't false-match
//     inside longer words.
//   - Case-insensitive across the board — operators write freeform.
//   - When two categories both plausibly match a comment (e.g. "Angelo
//     Approved - working to Donate" contains both "approved" and
//     "donate"), the FIRST rule wins. Donation is listed first because
//     the target-state ("donate") is the operational intent.
//   - "Approved" alone is dangerous — could be Disposal-Approved,
//     Customer-Approved, or something else. Rules require a co-signal
//     (dispose/donate/customer) or the very specific "Angelo Approved"
//     idiom Hill's team uses.

const CLASSIFIER_RULES = [
  { disposition: 'Donation', patterns: [
    /\bdonat(e|ion|ing|ed)\b/i,
    /\bfood\s*bank\b/i,
    /\bcharity\b/i,
  ]},

  { disposition: 'Disposal - Approved', patterns: [
    /\bapproved?\b[^.]{0,60}\b(dispose|disposal|dump|toss|write[\s-]?off|dispo)\b/i,
    /\b(dispose|disposal|dump|toss|write[\s-]?off|dispo)\b[^.]{0,60}\bapproved?\b/i,
    /\bangelo\s+approved\b/i,
    /\bapproved\s*[-:]\s*(dispose|disposal|donat)/i,
  ]},

  { disposition: 'Customer Acceptance - Approved', patterns: [
    /\bcustomer\s+(accepted|approved|took|confirmed|agreed|will\s+take|will\s+accept)\b/i,
    /\b(accepted|approved)\s+by\s+customer\b/i,
    /\bcustomer\s+ok(ay|'d)?\b/i,
  ]},

  { disposition: 'Sell-Through - DSD', patterns: [
    /\bDSD\b/,
    /\bsell[\s-]*through\b/i,
    /\bdirect\s+store\s+delivery\b/i,
  ]},

  { disposition: 'Ship - Scheduled', patterns: [
    /\bscheduled?\s+to\s+ship\b/i,
    /\b(will\s+ship|shipping\s+(on|this|next)|ship\s+date|shipment\s+scheduled)\b/i,
    /\bon\s+order\b/i,
    /\border\s+(entered|placed|in\s+system|on\s+the\s+books|received)\b/i,
    /\bPO\s+(entered|placed|received|in\s+system)\b/i,
  ]},

  { disposition: 'Claim / Reimbursement', patterns: [
    /\bclaim(s|ed|ing)?\b/i,
    /\breimburs(e|ed|ing|ement)\b/i,
    /\bcredit\s+(memo|issued|note|to\s+customer|from)\b/i,
  ]},

  { disposition: 'Disposal - Pending Approval', patterns: [
    /\b(sent|submitted|forwarded|escalat(ed|ing))\s+.*(approve|approval)/i,
    /\b(pending|awaiting|waiting\s+(on|for))\s+.*(approve|approval)/i,
    /\bneed(s|ed)?\s+approval\b/i,
    /\basked?\s+.*\bto\s+approve\b/i,
    /\b(dispose|disposal|dump|toss|write[\s-]?off)\b[^.]{0,60}\b(pending|approval)\b/i,
    /\b(pending|awaiting)\s+.*(dispose|disposal|write[\s-]?off)/i,
  ]},

  { disposition: 'Customer Acceptance - Pending', patterns: [
    /\bcheck(ing)?\s+(if|with|w\/)\s+customer\b/i,
    /\bcustomer\s+(review|considering|thinking|deciding)\b/i,
    /\b(asking|reached\s+out\s+to|contacted|waiting\s+on)\s+customer\b/i,
    /\bcustomer\s+(hasn'?t|has\s+not)\s+(responded|confirmed|accepted)/i,
    /\bpush\s+customer\b/i,        // "push customer to order" — pending consumption
    /\bwith\s+customer\b/i,        // "sent samples with customer", "review with customer"
  ]},

  { disposition: 'Quarantine / Loss', patterns: [
    /\bquarantine\b/i,
    /\bloss\b/i,
    /\bpull(ed|ing)?\s+(off|from)\s+shelf\b/i,
    /\boff\s+shelf\b/i,
    /\bhold\s+for\s+review\b/i,
  ]},
]

// Sheet-name fallback — when a comment is blank or doesn't match any
// rule but the sheet itself signals a terminal state. Only applied
// when the primary classifier returns nothing.
function inferFromSheetName(sheetName) {
  const n = String(sheetName || '').toLowerCase()
  if (n.includes('quarantine') || n.includes('expired')) return 'Quarantine / Loss'
  return null
}

function classify(comment, sheetName) {
  const text = String(comment || '').trim()
  if (text) {
    for (const rule of CLASSIFIER_RULES) {
      for (const pat of rule.patterns) {
        if (pat.test(text)) {
          return { disposition: rule.disposition, source: 'comment-match', pattern: pat.toString() }
        }
      }
    }
  }
  const inferred = inferFromSheetName(sheetName)
  if (inferred) return { disposition: inferred, source: 'sheet-name-fallback', pattern: null }
  return { disposition: null, source: 'unmatched', pattern: null }
}

// ── Sheet name → date ────────────────────────────────────────────────
//
// Sheet names look like "At Risk 6-24", "Quarantine & Expired 3-19",
// "Expired 5-6". Extract the M-D to order sheets chronologically. Year
// is inferred from the current shell date — if a parsed month is
// greater than the current month + 1, it's assumed to be last year.

function parseSheetDate(sheetName) {
  const m = /(\d{1,2})[-/](\d{1,2})/.exec(String(sheetName || ''))
  if (!m) return null
  const month = parseInt(m[1], 10)
  const day   = parseInt(m[2], 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const now   = new Date()
  const yr    = month > (now.getMonth() + 2) ? now.getFullYear() - 1 : now.getFullYear()
  return new Date(yr, month - 1, day)
}

// ── Column detection ─────────────────────────────────────────────────
//
// Column headers vary across sheets. Match by regex to accommodate
// variations like "Item Number" vs "Item #" vs "Item / SKU".

const COL_ITEM        = /^(item(\s|_)?(number|#|no|id)?|sku)$/i
const COL_LOT         = /^(lot(\s|_)?(number|#|no|code)?|batch)$/i
const COL_OWNER       = /^(owner|responsible|assigned(\s|_)?to|assignee)$/i
const COL_COMMENT_NEW = /^(new(\s|_)?comment|comment(\s|_)?(\/|_)?(\s)?action|current(\s|_)?comment|latest(\s|_)?comment|action|status)$/i
const COL_COMMENT_OLD = /^(prior(\s|_)?comment|old(\s|_)?comment|previous(\s|_)?comment)$/i
const COL_COMMENT_ANY = /^(comment(s)?|note(s)?)$/i

function detectColumns(headers) {
  const idx = { item: -1, lot: -1, owner: -1, commentNew: -1, commentOld: -1, commentAny: -1 }
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim()
    if (idx.item        === -1 && COL_ITEM.test(h))        idx.item        = i
    if (idx.lot         === -1 && COL_LOT.test(h))         idx.lot         = i
    if (idx.owner       === -1 && COL_OWNER.test(h))       idx.owner       = i
    if (idx.commentNew  === -1 && COL_COMMENT_NEW.test(h)) idx.commentNew  = i
    if (idx.commentOld  === -1 && COL_COMMENT_OLD.test(h)) idx.commentOld  = i
    if (idx.commentAny  === -1 && COL_COMMENT_ANY.test(h)) idx.commentAny  = i
  }
  return idx
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const xlsxPath = args.find(a => !a.startsWith('--'))

  if (!xlsxPath) {
    console.error('Usage: node scripts/ingest-pvi-dispositions.cjs <xlsx-path> [--dry-run]')
    process.exit(1)
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`)
    process.exit(1)
  }

  console.log(`Reading ${xlsxPath}${dryRun ? '  (DRY RUN)' : ''}`)
  const wb = xlsx.readFile(xlsxPath, { cellDates: true })

  // Sort sheets ASC by parsed date so later observations naturally
  // overwrite earlier ones in the latestByLot Map.
  const sheetsSorted = wb.SheetNames
    .map(name => ({ name, date: parseSheetDate(name) }))
    .sort((a, b) => {
      if (!a.date && !b.date) return 0
      if (!a.date) return -1     // undated sheets go first (get overwritten)
      if (!b.date) return 1
      return a.date - b.date
    })

  console.log(`\nSheet processing order (oldest → newest, latest wins per lot):`)
  for (const { name, date } of sheetsSorted) {
    console.log(`  ${date ? date.toISOString().slice(0, 10) : '        ??'}  ${name}`)
  }

  const latestByLot = new Map()  // "item|lot" → row snapshot
  const skippedSheets = []
  let totalRowsScanned = 0

  for (const { name, date } of sheetsSorted) {
    const ws = wb.Sheets[name]
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
    if (!rows.length) { skippedSheets.push({ name, reason: 'empty' }); continue }

    // Find header row — usually row 0 but some sheets have a title row.
    let headerRow = 0
    for (let i = 0; i < Math.min(4, rows.length); i++) {
      const candidate = rows[i].map(c => String(c || '').toLowerCase())
      if (candidate.some(c => /\bitem\b|\blot\b/.test(c))) { headerRow = i; break }
    }
    const headers = rows[headerRow]
    const cols = detectColumns(headers)
    if (cols.item < 0 || cols.lot < 0) {
      skippedSheets.push({ name, reason: `no item/lot columns (headers: ${headers.slice(0, 10).join(' | ')})` })
      continue
    }

    let sheetRowCount = 0
    for (let i = headerRow + 1; i < rows.length; i++) {
      const r = rows[i]
      const item = String(r[cols.item] || '').trim()
      const lot  = String(r[cols.lot]  || '').trim()
      if (!item || !lot) continue
      // Skip footer/summary rows
      if (/^total\b|^grand\s*total/i.test(item)) continue
      sheetRowCount++
      totalRowsScanned++

      const owner = cols.owner >= 0 ? String(r[cols.owner] || '').trim() : ''
      const commentNew = cols.commentNew >= 0 ? String(r[cols.commentNew] || '').trim() : ''
      const commentOld = cols.commentOld >= 0 ? String(r[cols.commentOld] || '').trim() : ''
      const commentAny = cols.commentAny >= 0 ? String(r[cols.commentAny] || '').trim() : ''
      // Prefer New > any generic Comment > Old
      const comment = commentNew || commentAny || commentOld

      const key = `${item}|${lot}`
      latestByLot.set(key, {
        material_code: item,
        lot_code:      lot,
        owner:         owner || null,
        comment:       comment || null,
        sheetName:     name,
        sheetDate:     date,
      })
    }
    console.log(`  read ${String(sheetRowCount).padStart(4)} rows from "${name}"`)
  }

  if (skippedSheets.length) {
    console.log(`\nSkipped ${skippedSheets.length} sheet(s):`)
    for (const s of skippedSheets) console.log(`  - ${s.name} (${s.reason})`)
  }

  console.log(`\nScanned ${totalRowsScanned} rows total → ${latestByLot.size} unique (item, lot) pairs after latest-wins collapse.`)

  // Classify + build upsert payloads.
  const upserts = []
  const unclassified = []
  const nowIso = new Date().toISOString()

  for (const row of latestByLot.values()) {
    const { disposition, source, pattern } = classify(row.comment, row.sheetName)

    // Track unclassified for the report even if we still write an
    // owner-only upsert.
    if (!disposition) {
      unclassified.push(row)
    }

    // Skip rows with NEITHER a disposition NOR an owner — nothing to write.
    if (!disposition && !row.owner) continue

    upserts.push({
      material_code: row.material_code,
      lot_code:      row.lot_code,
      disposition,
      owner:         row.owner,
      updated_by:    'excel-ingest',
      updated_at:    nowIso,
      _debug_source: source,
      _debug_pattern: pattern,
      _debug_comment: row.comment,
      _debug_sheet:  row.sheetName,
    })
  }

  // Summary counts by disposition.
  const counts = { '(owner only, no disposition)': 0 }
  for (const u of upserts) {
    const k = u.disposition || '(owner only, no disposition)'
    counts[k] = (counts[k] || 0) + 1
  }
  console.log('\nClassification summary:')
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  for (const [k, v] of sorted) {
    if (v === 0) continue
    console.log(`  ${String(v).padStart(4)}  ${k}`)
  }
  console.log(`  ${String(unclassified.length).padStart(4)}  (comments with no matching rule)`)

  if (unclassified.length > 0) {
    console.log('\nFirst 25 unmatched comments — add keyword rules if a pattern emerges:')
    for (const u of unclassified.slice(0, 25)) {
      const c = (u.comment || '(blank)').replace(/\s+/g, ' ').slice(0, 120)
      console.log(`  [${u.material_code} / ${u.lot_code}] "${c}"  (sheet: ${u.sheetName})`)
    }
  }

  // Write full report to disk for post-run review.
  const reportPath = `/tmp/pvi-ingest-report-${Date.now()}.txt`
  const reportLines = []
  reportLines.push(`PVI disposition ingest report — ${new Date().toISOString()}`)
  reportLines.push(`Source: ${xlsxPath}`)
  reportLines.push(`Dry run: ${dryRun ? 'YES' : 'no'}`)
  reportLines.push(`Sheets scanned: ${sheetsSorted.length - skippedSheets.length}`)
  reportLines.push(`Rows scanned:   ${totalRowsScanned}`)
  reportLines.push(`Unique lots:    ${latestByLot.size}`)
  reportLines.push(`Upsert payload: ${upserts.length}`)
  reportLines.push('')
  reportLines.push('Counts by disposition:')
  for (const [k, v] of sorted) {
    if (v === 0) continue
    reportLines.push(`  ${String(v).padStart(4)}  ${k}`)
  }
  reportLines.push('')
  reportLines.push(`All ${unclassified.length} unmatched rows:`)
  for (const u of unclassified) {
    const c = (u.comment || '(blank)').replace(/\s+/g, ' ').slice(0, 300)
    reportLines.push(`  [${u.material_code} / ${u.lot_code}] "${c}"  (sheet: ${u.sheetName})`)
  }
  reportLines.push('')
  reportLines.push('Sample matched rows (first 30):')
  for (const u of upserts.filter(x => x.disposition).slice(0, 30)) {
    const c = (u._debug_comment || '').replace(/\s+/g, ' ').slice(0, 100)
    reportLines.push(`  [${u.material_code}/${u.lot_code}] → ${u.disposition} | owner=${u.owner || '-'} | "${c}"`)
  }
  fs.writeFileSync(reportPath, reportLines.join('\n'))
  console.log(`\nFull report written to ${reportPath}`)

  if (dryRun) {
    console.log('\nDry-run — no writes. Review the classification counts above, add rules if needed, then rerun without --dry-run.')
    return
  }

  if (upserts.length === 0) {
    console.log('\nNothing to upsert. Exiting.')
    return
  }

  // Strip debug fields before writing.
  const payload = upserts.map(u => ({
    material_code: u.material_code,
    lot_code:      u.lot_code,
    disposition:   u.disposition,
    owner:         u.owner,
    updated_by:    u.updated_by,
    updated_at:    u.updated_at,
  }))

  console.log(`\nUpserting ${payload.length} rows to pvi_lot_dispositions…`)
  let batchNum = 0
  for (let i = 0; i < payload.length; i += 500) {
    batchNum++
    const batch = payload.slice(i, i + 500)
    const { error } = await supabase
      .from('pvi_lot_dispositions')
      .upsert(batch, { onConflict: 'material_code,lot_code', ignoreDuplicates: false })
    if (error) {
      console.error(`  batch ${batchNum} FAILED:`, error.message)
      console.error(`  first row in failing batch:`, batch[0])
      process.exit(1)
    }
    console.log(`  batch ${batchNum} — ${batch.length} rows ✓`)
  }
  console.log(`\nDone. ${payload.length} rows upserted.`)
  console.log('Verify in Supabase:  SELECT disposition, COUNT(*) FROM pvi_lot_dispositions GROUP BY 1 ORDER BY 2 DESC;')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
