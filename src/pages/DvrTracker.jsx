import { useState, useMemo, useCallback } from 'react'

// ─── Seed data: open incidents last 30 days ───────────────────────────────
// Source: Cal CSW INV CTRL -DVRS- + Ken CSW INV CTRL -DVRS tabs
// Open = adjustment not completed OR (coaching required AND not completed)
// Replace with live Supabase query once LoadProof → Zapier → Supabase is wired

const SEED_CAL = [{"id":"DVR-1107","date":"2026-03-08","orderNum":"202340","customer":"PALERMOS FINISHED","employee":"usman","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":60,"lotNum":"wc104255","materialNum":"30358","licensePlate":"mfg0438410","incidentNotes":"extra pallet","investigationNotes":"","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false},{"id":"DVR-1130","date":"2026-03-09","orderNum":"509847","customer":"PALERMOS FINISHED","employee":"Sergio","responsibleParty":"Customer / Carrier","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":-36,"lotNum":"WC101501","materialNum":"22832","licensePlate":"MFG0197349","incidentNotes":"received as 84 but physically shipped 48 last 36 cs don't exist","investigationNotes":"This was received by icampuzano - needs coaching on receiving properly","adjDate":"2026-03-09","adjBy":"Collin R. Perales","adjNotes":"36 cases did not exist.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Icampuzano","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1140","date":"2026-03-10","orderNum":"Don't Know","customer":"Palermos Finished","employee":"Joe","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":6,"lotNum":"WC102986","materialNum":"31186","licensePlate":"MFG0315102","incidentNotes":"Missing","investigationNotes":"Mvilla picked this pallet, all the way in the back of the aisle but you can see him grab the pallet off the floor but does not take 12cs off the pallet.","adjDate":"2026-03-10","adjBy":"Joe R. Kasdorf","adjNotes":"We can not locate this pallet. Adjusted out 6cs.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1159","date":"2026-03-12","orderNum":"0","customer":"PALERMOS RAW","employee":"juan s","responsibleParty":"CSW","incidentType":"Outbound","reason":"Damaged","damageType":"Tip","cases":12,"lotNum":"wc103152","materialNum":"15100","licensePlate":"mfg0375001","incidentNotes":"12 damage cases","investigationNotes":"Last picked By E. Lindsey. His pick task only called for 11 cases. he threw 13.","adjDate":"2026-03-12","adjBy":"Collin R. Perales","adjNotes":"12 cases adjusted out. 36 remain.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Ethan Lindsey","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1160","date":"2026-03-12","orderNum":"510641","customer":"PALERMOS FINISHED","employee":"German","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":84,"lotNum":"wj100505","materialNum":"30896","licensePlate":"mfg0390741","incidentNotes":"missing","investigationNotes":"MFG0431198 was not loaded onto the trailer, the order shipped short.","adjDate":"2026-03-12","adjBy":"Collin R. Perales","adjNotes":"moved to C9 MIA","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Samuel Hardesty","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1162","date":"2026-03-12","orderNum":"","customer":"PALERMOS FINISHED","employee":"Collin p","responsibleParty":"Customer / Carrier","incidentType":"Warehouse Ops Damage","reason":"Shipping Error","damageType":"No Damage","cases":0,"lotNum":"wc104066","materialNum":"30890","licensePlate":"mfg0421651","incidentNotes":"tagged as 30890/wc104066. physically 30889/wc104065/84cs in location bf007a","investigationNotes":"Picker Amadrigal went to this location and took the whole pallet and brought it to the 3.5 dock.","adjDate":"2026-03-12","adjBy":"Collin R. Perales","adjNotes":"corrected to right Item / Lot.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Alejandro Perez Madrigal","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1165","date":"2026-03-12","orderNum":"","customer":"PALERMOS FINISHED","employee":"Collin p","responsibleParty":"Customer / Carrier","incidentType":"Warehouse Ops Damage","reason":"Receiving Error","damageType":"No Damage","cases":84,"lotNum":"WC103297","materialNum":"30898","licensePlate":"MFG0406086","incidentNotes":"no scan. located middle x-over BE. placed in location BE071A","investigationNotes":"INVESTIGATE","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false},{"id":"DVR-1166","date":"2026-03-12","orderNum":"","customer":"PALERMOS FINISHED","employee":"Berger","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Damaged","damageType":"Tip","cases":8,"lotNum":"WC103639","materialNum":"31116","licensePlate":"MFG0426134","incidentNotes":"8cs tossed, adjust qty to 40cs","investigationNotes":"Llanes put the partner pallet in same location.","adjDate":"2026-03-13","adjBy":"Collin R. Perales","adjNotes":"8 cases adjusted out. 40 remain","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Llanes","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1172","date":"2026-03-13","orderNum":"510790","customer":"PALERMOS FINISHED","employee":"Sergio","responsibleParty":"Customer / Carrier","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":-36,"lotNum":"WC103344","materialNum":"31189","licensePlate":"MFG0402593","incidentNotes":"received as 84","investigationNotes":"Received by shardesty","adjDate":"2026-03-13","adjBy":"Collin R. Perales","adjNotes":"36 cases adjusted out as they did not exist.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"shardesty","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1193","date":"2026-03-17","orderNum":"na","customer":"PALERMOS FINISHED","employee":"Francisco","responsibleParty":"Customer / Carrier","incidentType":"Warehouse Ops Damage","reason":"Receiving Error","damageType":"No Damage","cases":84,"lotNum":"wc103504","materialNum":"30895","licensePlate":"mfg0419708","incidentNotes":"physically a 30900/WC102594/84CS","investigationNotes":"Franny over shipped 10 cases.","adjDate":"2026-03-18","adjBy":"Collin R. Perales","adjNotes":"Corrected to right Item / Lot.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Abdallah M. Shehadeh / Francisco Garibay","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1197","date":"2026-03-17","orderNum":"510496","customer":"PALERMOS FINISHED","employee":"Sergio","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":-96,"lotNum":"WJ100573","materialNum":"31160","licensePlate":"MFG0415593 / MFG0415669","incidentNotes":"both should be 30623 WJ100580 QTY 48","investigationNotes":"Received by Oliver","adjDate":"2026-03-18","adjBy":"Collin R. Perales","adjNotes":"Corrected 2 pallets to their correct Item / Lot.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Oliver Che","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1259","date":"2026-03-27","orderNum":"0","customer":"PALERMOS FINISHED","employee":"Tom","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Damaged","damageType":"Tip","cases":8,"lotNum":"WC104110","materialNum":"30358","licensePlate":"MFG0476291","incidentNotes":"pallet snapped while putting away","investigationNotes":"E.Mercado left 19 cases on the dock and D.Schlesser brought the pallet into the AR aisle.","adjDate":"2026-03-27","adjBy":"Collin R. Perales","adjNotes":"Adjusted out 8 cases and disposed of","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"E.Mercado / D.Schlesser","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1272","date":"2026-03-27","orderNum":"10288939","customer":"SARGENTO","employee":"Collin p","responsibleParty":"CSW","incidentType":"Outbound","reason":"Shipping Error","damageType":"No Damage","cases":10,"lotNum":"2370518","materialNum":"10001354","licensePlate":"905408071","incidentNotes":"cases are missing — we over shipped 10 cases","investigationNotes":"Campuzano helps Mercado throw his cases but failed to do a proper case count.","adjDate":"2026-03-31","adjBy":"Collin R. Perales","adjNotes":"10 cases were adjusted out. OVERSHIPPED","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"I.Campuzano / E.Mercado","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1277","date":"2026-03-30","orderNum":"0010291286","customer":"SARGENTO","employee":"eddie","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":2,"lotNum":"46100351062","materialNum":"10001734","licensePlate":"csw253764","incidentNotes":"pallet scanned as 25 but had 27 cases. in AI cubby","investigationNotes":"Mercado virtually picks 60 cases and fails to throw 2 more. Campuzano fails to check pallet quantities. UNDERSHIPPED.","adjDate":"2026-03-31","adjBy":"Collin R. Perales","adjNotes":"Adjusted 2 cases BACK into inventory. WE UNDERSHIPPED","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"I.Campuzano / E.Mercado","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1300","date":"2026-04-01","orderNum":"510048","customer":"PALERMOS FINISHED","employee":"Collin p","responsibleParty":"CSW","incidentType":"Outbound","reason":"Shipping Error","damageType":"No Damage","cases":84,"lotNum":"WC103297","materialNum":"30898","licensePlate":"MFG0406026","incidentNotes":"no scan. located in FRONT BE X-OVER. placing in BE010A","investigationNotes":"Nfree picked this full pallet of 84 cases for PO 510048 on 3/03, loaded by egonzalez on 3/4. Pallet still at CSW.","adjDate":"2026-04-03","adjBy":"Collin R. Perales","adjNotes":"Adjusted pallet back into inventory","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Nicholas J. Free","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1315","date":"2026-04-03","orderNum":"511904","customer":"PALERMOS FINISHED","employee":"Collin p","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":17,"lotNum":"wj100607","materialNum":"30898","licensePlate":"mfg0434227","incidentNotes":"received as 84. physically 17. PVI even wrote on tag '17'","investigationNotes":"","adjDate":"2026-04-03","adjBy":"Collin R. Perales","adjNotes":"adjusted 67 cases out. 17 remain","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Raymond Rojas","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1319","date":"2026-04-03","orderNum":"511451","customer":"PALERMOS FINISHED","employee":"Collin p","responsibleParty":"Customer / Carrier","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":48,"lotNum":"WJ100686","materialNum":"15103","licensePlate":"mfg0465903","incidentNotes":"tagged as 15103.","investigationNotes":"","adjDate":"2026-04-03","adjBy":"Collin R. Perales","adjNotes":"Corrected to right Item / Lot.","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"alwilliams","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"DVR-1320","date":"2026-04-03","orderNum":"na","customer":"PALERMOS RAW","employee":"Collin p","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Receiving Error","damageType":"No Damage","cases":0,"lotNum":"34025","materialNum":"1003096","licensePlate":"multi","incidentNotes":"no scan. kept in location AM042A","investigationNotes":"","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false}]

const SEED_KEN = [{"id":"KEN-1975","date":"2026-03-09","orderNum":"sh 03092026","customer":"Shanty","employee":"JG","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":2,"lotNum":"082725","materialNum":"5512","licensePlate":"na","incidentNotes":"missing","investigationNotes":"Pallet still needs to be located.","adjDate":"","adjBy":"","adjNotes":"Investigating","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false},{"id":"KEN-1980","date":"2026-03-10","orderNum":"na","customer":"Crown - CSW Kenosha","employee":"NW","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Damaged","damageType":"Rubbing","cases":1,"lotNum":"PPW02122026","materialNum":"4250329","licensePlate":"9000565363","incidentNotes":"Case was left on the dock for days","investigationNotes":"Adjustment done - per Nate.","adjDate":"2026-03-09","adjBy":"Nathan T. Williams","adjNotes":"1 case adjusted out","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-1988","date":"2026-03-12","orderNum":"4500409921","customer":"Crown - CSW Kenosha","employee":"joshg","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":1,"lotNum":"PPW02222026","materialNum":"4210314","licensePlate":"9000585385","incidentNotes":"pallet in system as 27 cases but only 26 cases on pallet","investigationNotes":"This was G Franco. He put the case on top of the machine and swung and crushed the box.","adjDate":"","adjBy":"","adjNotes":"No inventory to adjust","adjOpen":true,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-1992","date":"2026-03-16","orderNum":"203621200","customer":"Crown - CSW Kenosha","employee":"jc","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Damaged","damageType":"Forked While Loading/Unloading","cases":2,"lotNum":"PPW03112026","materialNum":"3050038","licensePlate":"9000625745","incidentNotes":"2 damaged cases","investigationNotes":"Jcabanas had his forks way too high and stabbed the boxes.","adjDate":"2026-03-19","adjBy":"Nathan T. Williams","adjNotes":"Email sent","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-1997","date":"2026-03-17","orderNum":"Na","customer":"Birchwood","employee":"GF","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":1,"lotNum":"0224121372","materialNum":"015841","licensePlate":"0224121372","incidentNotes":"the case is in AD018a","investigationNotes":"Jsanchez mispicked.","adjDate":"2026-03-20","adjBy":"Nathan T. Williams","adjNotes":"Picking error on order 788459","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-2004","date":"2026-03-19","orderNum":"K530829","customer":"Richelieu - CSW Kenosha","employee":"Alejandro Luna","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Damaged","damageType":"Forked While Loading/Unloading","cases":2,"lotNum":"11072026","materialNum":"419207103","licensePlate":"K530829","incidentNotes":"","investigationNotes":"Alejandro Luna backed up too far and came down with the forks and crushed the boxes.","adjDate":"2026-03-24","adjBy":"Nathan T. Williams","adjNotes":"2 cases adjusted out","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-2018","date":"2026-03-26","orderNum":"778868","customer":"Birchwood Finished Goods","employee":"kb","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":4,"lotNum":"0309132892","materialNum":"016573","licensePlate":"0100044375165735112603093008010000309132892","incidentNotes":"short 4 cs","investigationNotes":"Juan received this as a full pallet of 84 cases, but was only physically 80 cases.","adjDate":"2026-03-27","adjBy":"Nathan T. Williams","adjNotes":"Adjusted to correct qty","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Juan R. Ramirez","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-2020","date":"2026-03-27","orderNum":"791561","customer":"Birchwood Finished Goods","employee":"GF","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":0,"lotNum":"0128097919","materialNum":"015639","licensePlate":"0100044375156399112601283020810000128097919","incidentNotes":"short a layer","investigationNotes":"jjohnson received the pallet in as 208 but the pallet is missing a layer","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-2022","date":"2026-03-27","orderNum":"791006","customer":"Birchwood Finished Goods","employee":"GF","responsibleParty":"CSW","incidentType":"Outbound","reason":"Shipping Error","damageType":"No Damage","cases":1,"lotNum":"0313137797","materialNum":"Bk Woopers","licensePlate":"0313137797","incidentNotes":"one case in ad028a","investigationNotes":"Ramiro's order called for 34 cases, Ramiro only physically picked 33 cases.","adjDate":"2026-03-27","adjBy":"Nathan T. Williams","adjNotes":"1 case adjusted in","adjOpen":false,"coachingRequired":"Yes","employeeResponsible":"Ramiro Leon","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true},{"id":"KEN-2037","date":"2026-04-03","orderNum":"0","customer":"Crown - CSW Kenosha","employee":"Manny","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Damaged","damageType":"Rubbing","cases":1,"lotNum":"PPW04022026","materialNum":"3050011","licensePlate":"9000678793","incidentNotes":"was sitting in aisle already damaged","investigationNotes":"","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false}]

// ─── Helpers ──────────────────────────────────────────────────────────────
const PAGE_SIZE = 25

function fmtDate(d) {
  if (!d) return '—'
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) }
  catch { return d }
}

function ageInDays(d) {
  if (!d) return 0
  return Math.floor((Date.now() - new Date(d + 'T12:00:00')) / 86400000)
}

function ageColor(d) {
  const a = ageInDays(d)
  if (a > 21) return 'var(--red)'
  if (a > 14) return '#e09a2a'
  return 'var(--text-primary)'
}

function topN(arr, key, n = 5) {
  const counts = {}
  arr.forEach(i => { const v = (i[key] || 'Unknown').trim() || 'Unknown'; counts[v] = (counts[v] || 0) + 1 })
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n)
}

// ─── Sub-components ───────────────────────────────────────────────────────
function TypePill({ type }) {
  const t = (type || '').toLowerCase().trim()
  let bg = 'var(--bg3)', color = 'var(--text-secondary)'
  if (t === 'inbound')    { bg = 'rgba(37,99,235,0.12)'; color = '#3b82f6' }
  if (t === 'outbound')   { bg = 'rgba(22,163,74,0.12)'; color = '#16a34a' }
  if (t.includes('warehouse')) { bg = 'rgba(217,119,6,0.12)'; color = '#d97706' }
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, padding: '2px 8px',
      borderRadius: 20, fontWeight: 600, background: bg, color,
      fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
    }}>
      {type || '—'}
    </span>
  )
}

function StatusBadge({ label, variant }) {
  const styles = {
    adj:    { bg: 'rgba(217,119,6,0.12)',  color: '#d97706' },
    coach:  { bg: 'rgba(220,38,38,0.12)', color: 'var(--red)' },
    done:   { bg: 'rgba(22,163,74,0.12)', color: '#16a34a' },
    na:     { bg: 'var(--bg3)',            color: 'var(--text-secondary)' },
  }
  const s = styles[variant] || styles.na
  return (
    <span style={{
      display: 'inline-block', fontSize: 10, padding: '2px 8px',
      borderRadius: 20, fontWeight: 600, background: s.bg, color: s.color,
      fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function BarChart({ entries, max, color = '#3b82f6' }) {
  return (
    <div>
      {entries.map(([label, count]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', width: 130, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</div>
          <div style={{ flex: 1, height: 7, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 4, background: color, width: `${Math.round(count / max * 100)}%`, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 28, textAlign: 'right' }}>{count}</div>
        </div>
      ))}
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6, fontFamily: 'var(--font-mono)' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

function FacilityCompare({ cal, ken }) {
  const calAdj   = cal.filter(i => i.adjOpen).length
  const calCoach = cal.filter(i => i.coachingOpen).length
  const kenAdj   = ken.filter(i => i.adjOpen).length
  const kenCoach = ken.filter(i => i.coachingOpen).length
  const col = (fac) => fac === 'cal' ? '#1d4ed8' : '#15803d'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
      {[['cal', 'Caledonia', cal, calAdj, calCoach], ['ken', 'Kenosha', ken, kenAdj, kenCoach]].map(([id, name, data, adj, coach]) => (
        <div key={id} style={{ border: `1px solid var(--border)`, borderTop: `3px solid ${col(id)}`, borderRadius: 8, padding: 16, background: 'var(--bg0)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: col(id), marginBottom: 12 }}>{name}</div>
          {[['Total open', data.length, 'var(--red)'], ['Adj. needed', adj, '#d97706'], ['Coaching pending', coach, 'var(--red)'], ['Top reason', topN(data, 'reason', 1)[0]?.[0] || '—', 'var(--text-primary)']].map(([lbl, val, c]) => (
            <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13 }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{lbl}</span>
              <span style={{ fontWeight: 600, color: c, fontSize: typeof val === 'number' ? 15 : 12 }}>{val}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ─── Detail Modal ─────────────────────────────────────────────────────────
function DetailModal({ incident, fac, onClose, onUpdate, onDelete }) {
  const [fields, setFields] = useState({ ...incident })

  const set = (k, v) => {
    const next = { ...fields, [k]: v }
    // Recompute open flags
    next.adjOpen = !(next.adjDate || next.adjBy)
    next.coachingOpen = next.coachingRequired === 'Yes' && !next.coachingDate
    setFields(next)
  }

  const handleSave = () => { onUpdate(incident.id, fac, fields); onClose() }
  const handleDelete = () => { if (window.confirm('Delete this incident?')) { onDelete(incident.id, fac); onClose() } }
  const handleMarkResolved = () => {
    if (!window.confirm('Mark fully resolved? Removes from open queue.')) return
    const today = new Date().toISOString().split('T')[0]
    const next = { ...fields }
    if (!next.adjDate) next.adjDate = today
    next.adjOpen = false
    if (next.coachingRequired === 'Yes' && !next.coachingDate) next.coachingDate = today
    next.coachingOpen = false
    onUpdate(incident.id, fac, next, true)
    onClose()
  }

  const facColor = fac === 'cal' ? '#1d4ed8' : '#15803d'
  const facLabel = fac === 'cal' ? 'Caledonia' : 'Kenosha'

  const inp = (override = {}) => ({
    width: '100%', padding: '7px 10px', fontSize: 13,
    border: '1px solid var(--border)', borderRadius: 6,
    background: 'var(--bg1)', color: 'var(--text-primary)',
    fontFamily: 'inherit', boxSizing: 'border-box',
    ...override,
  })
  const lbl = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.4px', fontFamily: 'var(--font-mono)' }
  const row = (label, children) => <div style={{ marginBottom: 12 }}><label style={lbl}>{label}</label>{children}</div>
  const two = (children) => <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>
  const sectionHead = (label) => <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--text-secondary)', borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14, marginBottom: 10, fontFamily: 'var(--font-mono)' }}>{label}</div>

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 12, width: 640, maxWidth: '95vw', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>{incident.id}</span>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600, background: fac === 'cal' ? 'rgba(29,78,216,0.12)' : 'rgba(21,128,61,0.12)', color: facColor }}>{facLabel}</span>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{incident.customer}</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {/* Info grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
            {[['Date', fmtDate(incident.date)], ['Age', `${ageInDays(incident.date)} days`], ['Type', incident.incidentType], ['Reason', incident.reason], ['Customer', incident.customer], ['Responsible party', incident.responsibleParty], ['Order #', incident.orderNum || '—'], ['Material # / Lot', `${incident.materialNum || '—'} / ${incident.lotNum || '—'}`], ['License plate', incident.licensePlate || '—'], ['Cases', incident.cases || '—']].map(([l, v]) => (
              <div key={l} style={{ background: 'var(--bg1)', borderRadius: 7, padding: '8px 12px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</div>
              </div>
            ))}
          </div>
          {incident.incidentNotes && <div style={{ background: 'var(--bg1)', borderRadius: 7, padding: 12, marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid var(--border-subtle)' }}>{incident.incidentNotes}</div>}
          {incident.investigationNotes && <>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-secondary)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>Investigation notes</div>
            <div style={{ background: 'var(--bg1)', borderRadius: 7, padding: 12, marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid var(--border-subtle)' }}>{incident.investigationNotes}</div>
          </>}

          {/* Adjustment */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: fields.adjOpen ? '#d97706' : '#16a34a', display: 'inline-block' }} />
              Adjustment — {fields.adjOpen ? <span style={{ color: '#d97706' }}>Needed</span> : <span style={{ color: '#16a34a' }}>Complete</span>}
            </div>
            {two(<>
              {row('Completed date', <input type="date" style={inp()} value={fields.adjDate || ''} onChange={e => set('adjDate', e.target.value)} />)}
              {row('Completed by', <input type="text" style={inp()} value={fields.adjBy || ''} onChange={e => set('adjBy', e.target.value)} placeholder="Name" />)}
            </>)}
            {row('Adjustment notes', <input type="text" style={inp()} value={fields.adjNotes || ''} onChange={e => set('adjNotes', e.target.value)} placeholder="LP, Datex ref..." />)}
          </div>

          {/* Coaching */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: fields.coachingOpen ? 'var(--red)' : '#16a34a', display: 'inline-block' }} />
              Coaching — {fields.coachingRequired === 'Yes' ? (fields.coachingOpen ? <span style={{ color: 'var(--red)' }}>Pending</span> : <span style={{ color: '#16a34a' }}>Complete</span>) : <span style={{ color: 'var(--text-secondary)' }}>N/A</span>}
            </div>
            {two(<>
              {row('Required?', <select style={inp()} value={fields.coachingRequired || 'No'} onChange={e => set('coachingRequired', e.target.value)}><option value="No">No</option><option value="Yes">Yes</option></select>)}
              {row('Employee responsible', <input type="text" style={inp()} value={fields.employeeResponsible || ''} onChange={e => set('employeeResponsible', e.target.value)} placeholder="Name" />)}
            </>)}
            {two(<>
              {row('Coaching completed date', <input type="date" style={inp()} value={fields.coachingDate || ''} onChange={e => set('coachingDate', e.target.value)} />)}
              {row('Completed by', <input type="text" style={inp()} value={fields.coachingBy || ''} onChange={e => set('coachingBy', e.target.value)} placeholder="Supervisor" />)}
            </>)}
            {row('Coaching notes', <textarea style={{ ...inp(), minHeight: 56, resize: 'vertical' }} value={fields.coachingNotes || ''} onChange={e => set('coachingNotes', e.target.value)} placeholder="What was covered..." />)}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, background: 'var(--bg1)' }}>
          <button onClick={handleDelete} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--red)', fontSize: 13, fontFamily: 'inherit' }}>Delete</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleMarkResolved} style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', fontWeight: 600 }}>Mark resolved</button>
            <button onClick={handleSave} style={{ background: 'var(--text-primary)', border: '1px solid var(--text-primary)', borderRadius: 6, padding: '6px 16px', cursor: 'pointer', color: 'var(--bg0)', fontSize: 13, fontFamily: 'inherit', fontWeight: 600 }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Add Incident Modal ───────────────────────────────────────────────────
function AddModal({ defaultFac, onClose, onAdd }) {
  const today = new Date().toISOString().split('T')[0]
  const [f, setF] = useState({ fac: defaultFac === 'ken' ? 'ken' : 'cal', date: today, orderNum: '', customer: '', employee: '', responsibleParty: '', incidentType: 'Outbound', reason: 'Damaged', damageType: 'No Damage', cases: '', lotNum: '', materialNum: '', licensePlate: '', incidentNotes: '', investigationNotes: '', adjDate: '', adjBy: '', adjNotes: '', coachingRequired: 'No', employeeResponsible: '', coachingDate: '', coachingBy: '', coachingNotes: '' })
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const inp = { width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg1)', color: 'var(--text-primary)', fontFamily: 'inherit', boxSizing: 'border-box' }
  const lbl = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.4px', fontFamily: 'var(--font-mono)' }
  const row = (label, el) => <div style={{ marginBottom: 12 }}><label style={lbl}>{label}</label>{el}</div>
  const two = (ch) => <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{ch}</div>
  const sdiv = (t) => <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--text-secondary)', borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14, marginBottom: 10, fontFamily: 'var(--font-mono)' }}>{t}</div>

  const handleSave = () => {
    const prefix = f.fac === 'cal' ? 'DVR' : 'KEN'
    const adjOpen = !(f.adjDate || f.adjBy)
    const coachingOpen = f.coachingRequired === 'Yes' && !f.coachingDate
    if (adjOpen && !coachingOpen && f.coachingRequired !== 'Yes') {
      // Fine — just adj open
    }
    onAdd(f.fac, { ...f, adjOpen, coachingOpen })
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--bg0)', border: '1px solid var(--border)', borderRadius: 12, width: 640, maxWidth: '95vw', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Add new incident</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {sdiv('Incident details')}
          {two(<>
            {row('Facility', <select style={inp} value={f.fac} onChange={e => set('fac', e.target.value)}><option value="cal">Caledonia</option><option value="ken">Kenosha</option></select>)}
            {row('Date', <input type="date" style={inp} value={f.date} onChange={e => set('date', e.target.value)} />)}
          </>)}
          {two(<>
            {row('Order #', <input type="text" style={inp} value={f.orderNum} onChange={e => set('orderNum', e.target.value)} />)}
            {row('Customer', <input type="text" style={inp} value={f.customer} onChange={e => set('customer', e.target.value)} />)}
          </>)}
          {two(<>
            {row('Responsible party', <input type="text" style={inp} value={f.responsibleParty} onChange={e => set('responsibleParty', e.target.value)} />)}
            {row('Incident type', <select style={inp} value={f.incidentType} onChange={e => set('incidentType', e.target.value)}><option>Inbound</option><option>Outbound</option><option>Warehouse Ops Damage</option><option>Disposal</option><option>Transfer</option></select>)}
          </>)}
          {two(<>
            {row('Reason', <select style={inp} value={f.reason} onChange={e => set('reason', e.target.value)}><option>Damaged</option><option>Missing</option><option>Receiving Error</option><option>Shipping Error</option><option>Mislabeled Pallet</option><option>Cycle Count</option><option>Hold</option></select>)}
            {row('# Cases', <input type="number" style={inp} value={f.cases} onChange={e => set('cases', e.target.value)} min="0" />)}
          </>)}
          {two(<>
            {row('Lot #', <input type="text" style={inp} value={f.lotNum} onChange={e => set('lotNum', e.target.value)} />)}
            {row('Material #', <input type="text" style={inp} value={f.materialNum} onChange={e => set('materialNum', e.target.value)} />)}
          </>)}
          {row('License plate', <input type="text" style={inp} value={f.licensePlate} onChange={e => set('licensePlate', e.target.value)} />)}
          {row('Incident notes', <textarea style={{ ...inp, minHeight: 60, resize: 'vertical' }} value={f.incidentNotes} onChange={e => set('incidentNotes', e.target.value)} placeholder="Describe what happened..." />)}
          {row('Investigation notes', <textarea style={{ ...inp, minHeight: 56, resize: 'vertical' }} value={f.investigationNotes} onChange={e => set('investigationNotes', e.target.value)} placeholder="Findings, root cause..." />)}
          {sdiv('Adjustment')}
          {two(<>
            {row('Completed date', <input type="date" style={inp} value={f.adjDate} onChange={e => set('adjDate', e.target.value)} />)}
            {row('Completed by', <input type="text" style={inp} value={f.adjBy} onChange={e => set('adjBy', e.target.value)} placeholder="Name" />)}
          </>)}
          {row('Adjustment notes', <input type="text" style={inp} value={f.adjNotes} onChange={e => set('adjNotes', e.target.value)} placeholder="LP, Datex ref..." />)}
          {sdiv('Coaching')}
          {two(<>
            {row('Required?', <select style={inp} value={f.coachingRequired} onChange={e => set('coachingRequired', e.target.value)}><option value="No">No</option><option value="Yes">Yes</option></select>)}
            {row('Employee responsible', <input type="text" style={inp} value={f.employeeResponsible} onChange={e => set('employeeResponsible', e.target.value)} placeholder="Name" />)}
          </>)}
          {two(<>
            {row('Coaching completed date', <input type="date" style={inp} value={f.coachingDate} onChange={e => set('coachingDate', e.target.value)} />)}
            {row('Completed by', <input type="text" style={inp} value={f.coachingBy} onChange={e => set('coachingBy', e.target.value)} placeholder="Supervisor" />)}
          </>)}
          {row('Coaching notes', <textarea style={{ ...inp, minHeight: 56, resize: 'vertical' }} value={f.coachingNotes} onChange={e => set('coachingNotes', e.target.value)} placeholder="What was covered..." />)}
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0, background: 'var(--bg1)' }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13, fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={handleSave} style={{ background: 'var(--text-primary)', border: '1px solid var(--text-primary)', borderRadius: 6, padding: '6px 16px', cursor: 'pointer', color: 'var(--bg0)', fontSize: 13, fontFamily: 'inherit', fontWeight: 600 }}>Save incident</button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────
export default function DvrTracker() {
  const [cal, setCal] = useState(SEED_CAL)
  const [ken, setKen] = useState(SEED_KEN)
  const [facility, setFacility] = useState('all') // 'all' | 'cal' | 'ken'
  const [tab, setTab]           = useState('dash')  // 'dash' | 'tracker'
  const [search, setSearch]     = useState('')
  const [typeFilter, setTypeFilter]     = useState('all')
  const [reasonFilter, setReasonFilter] = useState('all')
  const [page, setPage]         = useState(1)
  const [detail, setDetail]     = useState(null) // { id, fac }
  const [showAdd, setShowAdd]   = useState(false)

  // Active dataset
  const activeData = useMemo(() => {
    if (facility === 'cal') return cal.map(i => ({ ...i, _fac: 'cal' }))
    if (facility === 'ken') return ken.map(i => ({ ...i, _fac: 'ken' }))
    return [...cal.map(i => ({ ...i, _fac: 'cal' })), ...ken.map(i => ({ ...i, _fac: 'ken' }))]
  }, [facility, cal, ken])

  // Derived stats
  const adjOpen   = useMemo(() => activeData.filter(i => i.adjOpen).length, [activeData])
  const coachOpen = useMemo(() => activeData.filter(i => i.coachingOpen).length, [activeData])
  const oldest    = useMemo(() => activeData.reduce((mx, i) => ageInDays(i.date) > ageInDays(mx?.date || '') ? i : mx, activeData[0]), [activeData])

  // Filtered tracker rows
  const filtered = useMemo(() => {
    let items = activeData.slice()
    if (search) {
      const s = search.toLowerCase()
      items = items.filter(i =>
        (i.customer || '').toLowerCase().includes(s) ||
        (i.id || '').toLowerCase().includes(s) ||
        (i.reason || '').toLowerCase().includes(s) ||
        (i.orderNum || '').toLowerCase().includes(s) ||
        (i.employeeResponsible || '').toLowerCase().includes(s) ||
        (i.incidentNotes || '').toLowerCase().includes(s)
      )
    }
    if (typeFilter !== 'all') items = items.filter(i => (i.incidentType || '').toLowerCase().includes(typeFilter.toLowerCase()))
    if (reasonFilter !== 'all') items = items.filter(i => (i.reason || '').toLowerCase() === reasonFilter.toLowerCase())
    return items.sort((a, b) => new Date(a.date) - new Date(b.date))
  }, [activeData, search, typeFilter, reasonFilter])

  const pages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePg = Math.min(page, pages)
  const paged  = filtered.slice((safePg - 1) * PAGE_SIZE, safePg * PAGE_SIZE)
  const reasons = useMemo(() => [...new Set(activeData.map(i => i.reason).filter(Boolean))].sort(), [activeData])

  // CRUD
  const handleUpdate = useCallback((id, fac, next, removeFromQueue = false) => {
    const setter = fac === 'cal' ? setCal : setKen
    setter(prev => removeFromQueue
      ? prev.filter(i => i.id !== id)
      : prev.map(i => i.id === id ? { ...i, ...next } : i)
    )
  }, [])

  const handleDelete = useCallback((id, fac) => {
    const setter = fac === 'cal' ? setCal : setKen
    setter(prev => prev.filter(i => i.id !== id))
  }, [])

  const handleAdd = useCallback((fac, fields) => {
    const setter = fac === 'cal' ? setCal : setKen
    const arr = fac === 'cal' ? cal : ken
    const prefix = fac === 'cal' ? 'DVR' : 'KEN'
    const base = fac === 'cal' ? 1321 : 2037
    const maxId = Math.max(base, ...arr.map(i => parseInt(i.id.replace(`${prefix}-`, '')) || 0))
    const newId = `${prefix}-${String(maxId + 1).padStart(4, '0')}`
    setter(prev => [{ ...fields, id: newId, _fac: fac }, ...prev])
  }, [cal, ken])

  // Chart data
  const typeEntries   = useMemo(() => { const e = topN(activeData, 'incidentType', 6); return [e, e[0]?.[1] || 1] }, [activeData])
  const reasonEntries = useMemo(() => { const e = topN(activeData, 'reason', 6); return [e, e[0]?.[1] || 1] }, [activeData])
  const custEntries   = useMemo(() => { const e = topN(activeData, 'customer', 5); return [e, e[0]?.[1] || 1] }, [activeData])

  // Styles
  const btn = (active, color = 'var(--text-primary)') => ({
    padding: '6px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: 'none', background: active ? color : 'transparent',
    color: active ? 'var(--bg0)' : 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)', transition: 'all .15s',
  })

  // Detail lookup
  const detailIncident = detail ? (detail.fac === 'cal' ? cal : ken).find(i => i.id === detail.id) : null

  return (
    <div className="page-content" style={{ padding: 0, minHeight: '100vh', background: 'var(--bg0)' }}>

      {/* Topbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg0)', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>DVR Tracker</span>
          {/* Facility toggle */}
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
            {[['all', 'All', '#374151'], ['cal', 'Caledonia', '#1d4ed8'], ['ken', 'Kenosha', '#15803d']].map(([id, label, color]) => (
              <button key={id} onClick={() => { setFacility(id); setPage(1) }}
                style={{ ...btn(facility === id, color), padding: '5px 14px', borderRight: id !== 'ken' ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
                {id !== 'all' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: facility === id ? 'var(--bg0)' : color, display: 'inline-block' }} />}
                {label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 600, background: 'rgba(220,38,38,0.12)', color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
            {activeData.length} open
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>last 30 days</span>
        </div>
        <button onClick={() => setShowAdd(true)}
          style={{ background: 'var(--text-primary)', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--bg0)', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
          + Add incident
        </button>
      </div>

      {/* Tab nav */}
      <div style={{ display: 'flex', gap: 2, padding: '0 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg0)' }}>
        {[['dash', 'Dashboard'], ['tracker', 'Open tracker']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '10px 14px', fontSize: 13, border: 'none', background: 'transparent',
            cursor: 'pointer', color: tab === id ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: tab === id ? 600 : 400, borderBottom: tab === id ? '2px solid var(--text-primary)' : '2px solid transparent',
            marginBottom: -1, fontFamily: 'inherit',
          }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: 20 }}>

        {/* ── Dashboard ── */}
        {tab === 'dash' && (
          <>
            {/* Banner */}
            <div style={{ background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 8, padding: '10px 16px', marginBottom: 18, fontSize: 13, color: '#d97706', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#d97706', display: 'inline-block', flexShrink: 0 }} />
              <strong>{activeData.length} open incidents</strong> across {facility === 'all' ? 'both facilities' : facility === 'cal' ? 'Caledonia' : 'Kenosha'} — last 30 days requiring action
            </div>

            {/* Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12, marginBottom: 20 }}>
              <StatCard label="Total open" value={activeData.length} color="var(--red)" />
              <StatCard label="Adj. needed" value={adjOpen} color="#d97706" />
              <StatCard label="Coaching pending" value={coachOpen} color="var(--red)" />
              <StatCard label="Oldest open" value={oldest ? `${ageInDays(oldest.date)}d` : '—'} color="var(--accent, #3b82f6)" />
            </div>

            {/* Facility compare (all view only) */}
            {facility === 'all' && <FacilityCompare cal={cal} ken={ken} />}

            {/* Charts */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, background: 'var(--bg0)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-mono)' }}>By incident type</div>
                <BarChart entries={typeEntries[0]} max={typeEntries[1]} color="#3b82f6" />
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, background: 'var(--bg0)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-mono)' }}>By reason</div>
                <BarChart entries={reasonEntries[0]} max={reasonEntries[1]} color="#8b5cf6" />
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, background: 'var(--bg0)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-mono)' }}>By customer (top 5)</div>
                <BarChart entries={custEntries[0]} max={custEntries[1]} color="#7c3aed" />
              </div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, background: 'var(--bg0)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-mono)' }}>Age breakdown</div>
                {[['0–7d', 0, 7, '#16a34a'], ['8–14d', 8, 14, '#3b82f6'], ['15–21d', 15, 21, '#d97706'], ['22–30d', 22, 30, '#dc2626']].map(([lbl, lo, hi, col]) => {
                  const n = activeData.filter(i => { const a = ageInDays(i.date); return a >= lo && a <= hi }).length
                  return <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', width: 60, flexShrink: 0 }}>{lbl}</div>
                    <div style={{ flex: 1, height: 7, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}><div style={{ height: '100%', borderRadius: 4, background: col, width: `${activeData.length ? Math.round(n / activeData.length * 100) : 0}%` }} /></div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 20, textAlign: 'right' }}>{n}</div>
                  </div>
                })}
              </div>
            </div>

            {/* Recent table */}
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10, fontFamily: 'var(--font-mono)' }}>Most recent open incidents</div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg1)' }}>
                    {facility === 'all' && <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Facility</th>}
                    {['Date', 'ID', 'Customer', 'Type', 'Reason', 'Age', 'Open action'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {activeData.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8).map((i, idx) => (
                    <tr key={i.id} onClick={() => setDetail({ id: i.id, fac: i._fac })} style={{ borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', background: idx % 2 === 0 ? 'var(--bg0)' : 'var(--bg1)' }}>
                      {facility === 'all' && <td style={{ padding: '8px 12px' }}><span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, fontWeight: 600, background: i._fac === 'cal' ? 'rgba(29,78,216,0.1)' : 'rgba(21,128,61,0.1)', color: i._fac === 'cal' ? '#1d4ed8' : '#15803d', fontFamily: 'var(--font-mono)' }}>{i._fac === 'cal' ? 'CAL' : 'KEN'}</span></td>}
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{fmtDate(i.date)}</td>
                      <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{i.id}</td>
                      <td style={{ padding: '8px 12px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.customer || '—'}</td>
                      <td style={{ padding: '8px 12px' }}><TypePill type={i.incidentType} /></td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{i.reason || '—'}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 600, color: ageColor(i.date), whiteSpace: 'nowrap' }}>{ageInDays(i.date)}d</td>
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {i.adjOpen && <StatusBadge label="Adj needed" variant="adj" />}
                          {i.coachingOpen && <StatusBadge label="Coaching" variant="coach" />}
                          {!i.adjOpen && !i.coachingOpen && <StatusBadge label="Clear" variant="done" />}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── Tracker ── */}
        {tab === 'tracker' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <input type="text" placeholder="Search customer, order #, employee, notes..." value={search}
                onChange={e => { setSearch(e.target.value); setPage(1) }}
                style={{ flex: 1, minWidth: 200, padding: '7px 11px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg1)', color: 'var(--text-primary)', fontFamily: 'inherit' }} />
              <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1) }}
                style={{ padding: '7px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg1)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
                <option value="all">All types</option>
                <option value="Outbound">Outbound</option>
                <option value="Warehouse">WH Ops Damage</option>
                <option value="Inbound">Inbound</option>
                <option value="Disposal">Disposal</option>
              </select>
              <select value={reasonFilter} onChange={e => { setReasonFilter(e.target.value); setPage(1) }}
                style={{ padding: '7px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg1)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
                <option value="all">All reasons</option>
                {reasons.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg1)' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Open incidents — last 30 days</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{filtered.length} of {activeData.length} records</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 900 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg1)' }}>
                      {facility === 'all' && <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Fac</th>}
                      {['Date', 'ID', 'Customer', 'Resp. party', 'Type', 'Reason', 'Emp. responsible', 'Age', 'Adj.', 'Coaching'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {paged.length ? paged.map((i, idx) => (
                      <tr key={i.id} onClick={() => setDetail({ id: i.id, fac: i._fac })} style={{ borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', background: idx % 2 === 0 ? 'var(--bg0)' : 'var(--bg1)' }}>
                        {facility === 'all' && <td style={{ padding: '8px 12px' }}><span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 10, fontWeight: 600, background: i._fac === 'cal' ? 'rgba(29,78,216,0.1)' : 'rgba(21,128,61,0.1)', color: i._fac === 'cal' ? '#1d4ed8' : '#15803d', fontFamily: 'var(--font-mono)' }}>{i._fac === 'cal' ? 'CAL' : 'KEN'}</span></td>}
                        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{fmtDate(i.date)}</td>
                        <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{i.id}</td>
                        <td style={{ padding: '8px 12px', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.customer || '—'}</td>
                        <td style={{ padding: '8px 12px', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{i.responsibleParty || '—'}</td>
                        <td style={{ padding: '8px 12px' }}><TypePill type={i.incidentType} /></td>
                        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{i.reason || '—'}</td>
                        <td style={{ padding: '8px 12px', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{i.employeeResponsible || '—'}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 600, color: ageColor(i.date), whiteSpace: 'nowrap' }}>{ageInDays(i.date)}d</td>
                        <td style={{ padding: '8px 12px' }}>{i.adjOpen ? <StatusBadge label="Needed" variant="adj" /> : <StatusBadge label="Done" variant="done" />}</td>
                        <td style={{ padding: '8px 12px' }}>{i.coachingRequired === 'Yes' ? (i.coachingOpen ? <StatusBadge label="Pending" variant="coach" /> : <StatusBadge label="Done" variant="done" />) : <StatusBadge label="N/A" variant="na" />}</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={facility === 'all' ? 11 : 10} style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>No records match filters</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {/* Pagination */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                <span>Showing {(safePg - 1) * PAGE_SIZE + 1}–{Math.min(safePg * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {Array.from({ length: Math.min(pages, 8) }, (_, i) => i + 1).map(p => (
                    <button key={p} onClick={() => setPage(p)} style={{ padding: '2px 9px', border: '1px solid var(--border)', borderRadius: 5, background: p === safePg ? 'var(--text-primary)' : 'var(--bg1)', color: p === safePg ? 'var(--bg0)' : 'var(--text-primary)', cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{p}</button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {detailIncident && (
        <DetailModal
          incident={detailIncident}
          fac={detail.fac}
          onClose={() => setDetail(null)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
        />
      )}
      {showAdd && (
        <AddModal
          defaultFac={facility}
          onClose={() => setShowAdd(false)}
          onAdd={handleAdd}
        />
      )}
    </div>
  )
}
