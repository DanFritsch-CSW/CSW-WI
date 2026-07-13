import { useState, useMemo, useCallback, useEffect } from 'react'

// ─── Seed data (fallback if SharePoint is unavailable) ────────────────────────────
const SEED_CAL = [{"id":"DVR-1107","date":"2026-03-08","orderNum":"202340","customer":"PALERMOS FINISHED","employee":"usman","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":60,"lotNum":"wc104255","materialNum":"30358","licensePlate":"mfg0438410","incidentNotes":"extra pallet","investigationNotes":"","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false,"loadproofUrl":""},{"id":"DVR-1165","date":"2026-03-12","orderNum":"","customer":"PALERMOS FINISHED","employee":"Collin p","responsibleParty":"Customer / Carrier","incidentType":"Warehouse Ops Damage","reason":"Receiving Error","damageType":"No Damage","cases":84,"lotNum":"WC103297","materialNum":"30898","licensePlate":"MFG0406086","incidentNotes":"no scan. located middle x-over BE.","investigationNotes":"INVESTIGATE","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false,"loadproofUrl":""},{"id":"DVR-1219","date":"2026-03-20","orderNum":"511058","customer":"PALERMOS FINISHED","employee":"jorge","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":0,"lotNum":"wc103999","materialNum":"38815","licensePlate":"multi","incidentNotes":"missing","investigationNotes":"Not sure what load this came in on since it was not scanned in upon receiving.","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"No","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false,"loadproofUrl":""},{"id":"DVR-1246","date":"2026-03-25","orderNum":"0","customer":"PALERMOS FINISHED","employee":"juan","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":48,"lotNum":"wj100571","materialNum":"15101","licensePlate":"mfg0410307","incidentNotes":"missing","investigationNotes":"Received by csw-rguzman","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"No","employeeResponsible":"No Longer Employed","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false,"loadproofUrl":""},{"id":"DVR-1314","date":"2026-04-02","orderNum":"na","customer":"PALERMOS FINISHED","employee":"collin p","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Shipping Error","damageType":"No Damage","cases":2,"lotNum":"WC103811","materialNum":"30901","licensePlate":"mfg0445303","incidentNotes":"no scan. placed in BH001A","investigationNotes":"","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"VIDEO REQ","coachingOpen":false,"loadproofUrl":""},{"id":"DVR-1320","date":"2026-04-03","orderNum":"na","customer":"PALERMOS RAW","employee":"Collin p","responsibleParty":"CSW","incidentType":"Warehouse Ops Damage","reason":"Receiving Error","damageType":"No Damage","cases":0,"lotNum":"34025","materialNum":"1003096","licensePlate":"multi","incidentNotes":"no scan. kept in location AM042A","investigationNotes":"","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false,"loadproofUrl":""}]

const SEED_KEN = [{"id":"KEN-1975","date":"2026-03-09","orderNum":"sh 03092026","customer":"Shanty","employee":"JG","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":2,"lotNum":"082725","materialNum":"5512","licensePlate":"na","incidentNotes":"missing","investigationNotes":"Pallet still needs to be located.","adjDate":"","adjBy":"","adjNotes":"Investigating","adjOpen":true,"coachingRequired":"","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":false,"loadproofUrl":""},{"id":"KEN-1988","date":"2026-03-12","orderNum":"4500409921","customer":"Crown - CSW Kenosha","employee":"joshg","responsibleParty":"CSW","incidentType":"Outbound","reason":"Missing","damageType":"No Damage","cases":1,"lotNum":"PPW02222026","materialNum":"4210314","licensePlate":"9000585385","incidentNotes":"pallet in system as 27 cases but only 26","investigationNotes":"G Franco crushed the box.","adjDate":"","adjBy":"","adjNotes":"No inventory to adjust","adjOpen":true,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true,"loadproofUrl":""},{"id":"KEN-2020","date":"2026-03-27","orderNum":"791561","customer":"Birchwood Finished Goods","employee":"GF","responsibleParty":"CSW","incidentType":"Outbound","reason":"Receiving Error","damageType":"No Damage","cases":0,"lotNum":"0128097919","materialNum":"015639","licensePlate":"0100044375156399","incidentNotes":"short a layer","investigationNotes":"jjohnson received as 208 but pallet is missing a layer","adjDate":"","adjBy":"","adjNotes":"","adjOpen":true,"coachingRequired":"Yes","employeeResponsible":"","coachingDate":"","coachingBy":"","coachingNotes":"","coachingOpen":true,"loadproofUrl":""}]

// ─── Helpers ──────────────────────────────────────────────────────────────
const PAGE_SIZE = 25
function fmtDate(d) { if(!d)return'—'; try{return new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'})}catch{return d} }
function ageInDays(d) { return !d?0:Math.floor((Date.now()-new Date(d+'T12:00:00'))/86400000) }
function ageColor(d) { const a=ageInDays(d); return a>21?'var(--red)':a>14?'#e09a2a':'var(--text-primary)' }
function preview(s,n=55) { return !s?'':s.length>n?s.slice(0,n)+'…':s }
function topN(arr,key,n=6) { const c={}; arr.forEach(i=>{const v=(i[key]||'Unknown').trim()||'Unknown';c[v]=(c[v]||0)+1}); return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,n) }
function sortItems(items,field,dir) {
  if(!field)return items
  return [...items].sort((a,b)=>{
    let va=a[field]??'',vb=b[field]??''
    if(field==='date'){va=new Date(va+'T12:00:00');vb=new Date(vb+'T12:00:00')}
    else if(field==='cases'){va=Number(va);vb=Number(vb)}
    else if(field==='age'){va=ageInDays(a.date);vb=ageInDays(b.date)}
    else{va=String(va).toLowerCase();vb=String(vb).toLowerCase()}
    if(va<vb)return dir==='asc'?-1:1; if(va>vb)return dir==='asc'?1:-1; return 0
  })
}

function TypePill({type}) {
  const t=(type||'').toLowerCase().trim()
  let bg='var(--bg3)',color='var(--text-secondary)'
  if(t==='inbound'){bg='rgba(37,99,235,0.12)';color='#3b82f6'}
  if(t==='outbound'){bg='rgba(22,163,74,0.12)';color='#16a34a'}
  if(t.includes('warehouse')){bg='rgba(217,119,6,0.12)';color='#d97706'}
  return <span style={{display:'inline-block',fontSize:10,padding:'2px 8px',borderRadius:20,fontWeight:600,background:bg,color,fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>{type||'—'}</span>
}
function Badge({label,variant}) {
  const s={adj:{bg:'rgba(217,119,6,0.12)',color:'#d97706'},coach:{bg:'rgba(220,38,38,0.12)',color:'var(--red)'},done:{bg:'rgba(22,163,74,0.12)',color:'#16a34a'},na:{bg:'var(--bg3)',color:'var(--text-secondary)'}}[variant]||{bg:'var(--bg3)',color:'var(--text-secondary)'}
  return <span style={{display:'inline-block',fontSize:10,padding:'2px 8px',borderRadius:20,fontWeight:600,background:s.bg,color:s.color,fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>{label}</span>
}
function FacBadge({fac}) {
  const map={cal:['rgba(29,78,216,0.1)','#1d4ed8','CAL'],ken:['rgba(21,128,61,0.1)','#15803d','KEN'],mad:['rgba(124,58,237,0.1)','#7c3aed','MAD']}
  const [bg,color,label]=map[fac]||map.cal
  return <span style={{fontSize:10,padding:'2px 7px',borderRadius:10,fontWeight:600,background:bg,color,fontFamily:'var(--font-mono)'}}>{label}</span>
}
function SortTh({label,field,sortField,sortDir,onSort,style={}}) {
  const active=sortField===field; const arrow=active?(sortDir==='asc'?' ↑':' ↓'):''
  return <th onClick={()=>onSort(field)} style={{padding:'9px 12px',textAlign:'left',fontSize:10,fontWeight:600,color:active?'var(--text-primary)':'var(--text-secondary)',borderBottom:'1px solid var(--border)',background:'var(--bg1)',textTransform:'uppercase',letterSpacing:'.3px',whiteSpace:'nowrap',cursor:'pointer',userSelect:'none',...style}}>{label}{arrow}</th>
}
function BarChart({entries,color='#3b82f6'}) {
  const max=entries[0]?.[1]||1
  return <div>{entries.map(([l,n])=>(<div key={l} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}><div style={{fontSize:12,color:'var(--text-secondary)',width:130,flexShrink:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l}>{l}</div><div style={{flex:1,height:7,background:'var(--bg3)',borderRadius:4,overflow:'hidden'}}><div style={{height:'100%',borderRadius:4,background:color,width:`${Math.round(n/max*100)}%`,transition:'width 0.3s'}}/></div><div style={{fontSize:12,color:'var(--text-secondary)',minWidth:28,textAlign:'right'}}>{n}</div></div>))}</div>
}

function DetailModal({incident,fac,onClose,onUpdate,onDelete}) {
  const [fields,setFields]=useState({...incident})
  const set=(k,v)=>{const next={...fields,[k]:v};next.adjOpen=!(next.adjDate||next.adjBy);next.coachingOpen=next.coachingRequired==='Yes'&&!next.coachingDate;setFields(next)}
  const inp=(ov={})=>({width:'100%',padding:'7px 10px',fontSize:13,border:'1px solid var(--border)',borderRadius:6,background:'var(--bg1)',color:'var(--text-primary)',fontFamily:'inherit',boxSizing:'border-box',...ov})
  const lbl={display:'block',fontSize:11,fontWeight:600,color:'var(--text-secondary)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.4px',fontFamily:'var(--font-mono)'}
  const row=(label,el)=><div style={{marginBottom:12}}><label style={lbl}>{label}</label>{el}</div>
  const two=ch=><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>{ch}</div>
  const sdiv=t=><div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:'var(--text-secondary)',borderTop:'1px solid var(--border)',paddingTop:14,margin:'14px 0 10px',fontFamily:'var(--font-mono)'}}>{t}</div>
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--bg0)',border:'1px solid var(--border)',borderRadius:12,width:660,maxWidth:'95vw',maxHeight:'90vh',overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 20px 60px rgba(0,0,0,.3)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'16px 20px',borderBottom:'1px solid var(--border)',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}><span style={{fontSize:15,fontWeight:700}}>{incident.id}</span><FacBadge fac={fac}/><span style={{fontSize:13,color:'var(--text-secondary)'}}>{incident.customer}</span></div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            {incident.loadproofUrl&&<a href={incident.loadproofUrl} target="_blank" rel="noreferrer" style={{fontSize:12,color:'var(--accent,#3b82f6)',textDecoration:'none',fontFamily:'var(--font-mono)'}}>View in LoadProof ↗</a>}
            <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-secondary)',fontSize:22,lineHeight:1}}>×</button>
          </div>
        </div>
        <div style={{padding:20,overflowY:'auto',flex:1}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:14}}>
            {[['Date',fmtDate(incident.date)],['Age',`${ageInDays(incident.date)} days`],['Order #',incident.orderNum||'—'],['Type',incident.incidentType],['Reason',incident.reason],['Cases',incident.cases||'—'],['License plate',incident.licensePlate||'—'],['Material # / Lot',`${incident.materialNum||'—'} / ${incident.lotNum||'—'}`],['Responsible party',incident.responsibleParty||'—']].map(([l,v])=>(
              <div key={l} style={{background:'var(--bg1)',borderRadius:7,padding:'8px 12px',border:'1px solid var(--border-subtle)'}}><div style={{fontSize:10,color:'var(--text-secondary)',marginBottom:2}}>{l}</div><div style={{fontSize:13,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={String(v)}>{v}</div></div>
            ))}
          </div>
          {incident.incidentNotes&&<div style={{background:'var(--bg1)',borderRadius:7,padding:12,marginBottom:12,fontSize:13,color:'var(--text-secondary)',lineHeight:1.5,whiteSpace:'pre-wrap',wordBreak:'break-word',border:'1px solid var(--border-subtle)'}}>{incident.incidentNotes}</div>}
          {incident.investigationNotes&&<><div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',color:'var(--text-secondary)',marginBottom:4,fontFamily:'var(--font-mono)'}}>Investigation notes</div><div style={{background:'var(--bg1)',borderRadius:7,padding:12,marginBottom:12,fontSize:13,color:'var(--text-secondary)',lineHeight:1.5,whiteSpace:'pre-wrap',wordBreak:'break-word',border:'1px solid var(--border-subtle)'}}>{incident.investigationNotes}</div></>
          }
          {sdiv('LoadProof link')}
          {row('Record URL',<input type="url" style={inp()} value={fields.loadproofUrl||''} onChange={e=>set('loadproofUrl',e.target.value)} placeholder="Paste LoadProof record URL here"/>)}
          <div style={{border:'1px solid var(--border)',borderRadius:8,padding:14,marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:600,color:'var(--text-secondary)',marginBottom:10,display:'flex',alignItems:'center',gap:5}}><span style={{width:7,height:7,borderRadius:'50%',background:fields.adjOpen?'#d97706':'#16a34a',display:'inline-block'}}/>Adjustment — {fields.adjOpen?<span style={{color:'#d97706'}}>Needed</span>:<span style={{color:'#16a34a'}}>Complete</span>}</div>
            {two(<>{row('Completed date',<input type="date" style={inp()} value={fields.adjDate||''} onChange={e=>set('adjDate',e.target.value)}/>)}{row('Completed by',<input type="text" style={inp()} value={fields.adjBy||''} onChange={e=>set('adjBy',e.target.value)} placeholder="Name"/>)}</>)}
            {row('Adjustment notes',<input type="text" style={inp()} value={fields.adjNotes||''} onChange={e=>set('adjNotes',e.target.value)} placeholder="LP, Datex ref..."/>)}
          </div>
          <div style={{border:'1px solid var(--border)',borderRadius:8,padding:14,marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:600,color:'var(--text-secondary)',marginBottom:10,display:'flex',alignItems:'center',gap:5}}><span style={{width:7,height:7,borderRadius:'50%',background:fields.coachingOpen?'var(--red)':'#16a34a',display:'inline-block'}}/>Coaching — {fields.coachingRequired==='Yes'?(fields.coachingOpen?<span style={{color:'var(--red)'}}>Pending</span>:<span style={{color:'#16a34a'}}>Complete</span>):<span style={{color:'var(--text-secondary)'}}>N/A</span>}</div>
            {two(<>{row('Required?',<select style={inp()} value={fields.coachingRequired||'No'} onChange={e=>set('coachingRequired',e.target.value)}><option value="No">No</option><option value="Yes">Yes</option></select>)}{row('Employee responsible',<input type="text" style={inp()} value={fields.employeeResponsible||''} onChange={e=>set('employeeResponsible',e.target.value)} placeholder="Name"/>)}</>)}
            {two(<>{row('Coaching completed date',<input type="date" style={inp()} value={fields.coachingDate||''} onChange={e=>set('coachingDate',e.target.value)}/>)}{row('Completed by',<input type="text" style={inp()} value={fields.coachingBy||''} onChange={e=>set('coachingBy',e.target.value)} placeholder="Supervisor"/>)}</>)}
            {row('Coaching notes',<textarea style={{...inp(),minHeight:56,resize:'vertical'}} value={fields.coachingNotes||''} onChange={e=>set('coachingNotes',e.target.value)} placeholder="What was covered, follow-up actions..."/>)}
          </div>
        </div>
        <div style={{padding:'12px 20px',borderTop:'1px solid var(--border)',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0,background:'var(--bg1)'}}>
          <button onClick={()=>{if(window.confirm('Delete this incident?')){onDelete(incident.id,fac);onClose()}}} style={{background:'none',border:'1px solid var(--border)',borderRadius:6,padding:'6px 14px',cursor:'pointer',color:'var(--red)',fontSize:13,fontFamily:'inherit'}}>Delete</button>
          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>{const today=new Date().toISOString().split('T')[0];const n={...fields};if(!n.adjDate)n.adjDate=today;n.adjOpen=false;if(n.coachingRequired==='Yes'&&!n.coachingDate)n.coachingDate=today;n.coachingOpen=false;onUpdate(incident.id,fac,n,true);onClose()}} style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:6,padding:'6px 14px',cursor:'pointer',color:'var(--text-primary)',fontSize:13,fontFamily:'inherit',fontWeight:600}}>Mark resolved</button>
            <button onClick={()=>{onUpdate(incident.id,fac,fields);onClose()}} style={{background:'var(--text-primary)',border:'1px solid var(--text-primary)',borderRadius:6,padding:'6px 16px',cursor:'pointer',color:'var(--bg0)',fontSize:13,fontFamily:'inherit',fontWeight:600}}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AddModal({defaultFac,onClose,onAdd}) {
  const today=new Date().toISOString().split('T')[0]
  const [f,setF]=useState({fac:defaultFac==='ken'?'ken':defaultFac==='mad'?'mad':'cal',date:today,orderNum:'',customer:'',employee:'',responsibleParty:'',incidentType:'Outbound',reason:'Damaged',damageType:'No Damage',cases:'',lotNum:'',materialNum:'',licensePlate:'',incidentNotes:'',investigationNotes:'',loadproofUrl:'',adjDate:'',adjBy:'',adjNotes:'',coachingRequired:'No',employeeResponsible:'',coachingDate:'',coachingBy:'',coachingNotes:''})
  const set=(k,v)=>setF(p=>({...p,[k]:v}))
  const inp={width:'100%',padding:'7px 10px',fontSize:13,border:'1px solid var(--border)',borderRadius:6,background:'var(--bg1)',color:'var(--text-primary)',fontFamily:'inherit',boxSizing:'border-box'}
  const lbl={display:'block',fontSize:11,fontWeight:600,color:'var(--text-secondary)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.4px',fontFamily:'var(--font-mono)'}
  const row=(label,el)=><div style={{marginBottom:12}}><label style={lbl}>{label}</label>{el}</div>
  const two=ch=><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>{ch}</div>
  const sdiv=t=><div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:'var(--text-secondary)',borderTop:'1px solid var(--border)',paddingTop:14,margin:'14px 0 10px',fontFamily:'var(--font-mono)'}}>{t}</div>
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--bg0)',border:'1px solid var(--border)',borderRadius:12,width:660,maxWidth:'95vw',maxHeight:'90vh',overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 20px 60px rgba(0,0,0,.3)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'16px 20px',borderBottom:'1px solid var(--border)',flexShrink:0}}><span style={{fontSize:15,fontWeight:700}}>Add new incident</span><button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-secondary)',fontSize:22,lineHeight:1}}>×</button></div>
        <div style={{padding:20,overflowY:'auto',flex:1}}>
          {sdiv('Incident details')}
          {two(<>{row('Facility',<select style={inp} value={f.fac} onChange={e=>set('fac',e.target.value)}><option value="cal">Caledonia</option><option value="ken">Kenosha</option><option value="mad">Madison</option></select>)}{row('Date',<input type="date" style={inp} value={f.date} onChange={e=>set('date',e.target.value)}/>)}</>)}
          {two(<>{row('Order #',<input type="text" style={inp} value={f.orderNum} onChange={e=>set('orderNum',e.target.value)}/>)}{row('Customer',<input type="text" style={inp} value={f.customer} onChange={e=>set('customer',e.target.value)}/>)}</>)}
          {two(<>{row('Responsible party',<input type="text" style={inp} value={f.responsibleParty} onChange={e=>set('responsibleParty',e.target.value)}/>)}{row('Incident type',<select style={inp} value={f.incidentType} onChange={e=>set('incidentType',e.target.value)}><option>Inbound</option><option>Outbound</option><option>Warehouse Ops Damage</option><option>Disposal</option><option>Transfer</option></select>)}</>)}
          {two(<>{row('Reason',<select style={inp} value={f.reason} onChange={e=>set('reason',e.target.value)}><option>Damaged</option><option>Missing</option><option>Receiving Error</option><option>Shipping Error</option><option>Mislabeled Pallet</option><option>Cycle Count</option><option>Hold</option></select>)}{row('# Cases',<input type="number" style={inp} value={f.cases} onChange={e=>set('cases',e.target.value)} min="0"/>)}</>)}
          {two(<>{row('Lot #',<input type="text" style={inp} value={f.lotNum} onChange={e=>set('lotNum',e.target.value)}/>)}{row('Material #',<input type="text" style={inp} value={f.materialNum} onChange={e=>set('materialNum',e.target.value)}/>)}</>)}
          {two(<>{row('License plate',<input type="text" style={inp} value={f.licensePlate} onChange={e=>set('licensePlate',e.target.value)}/>)}{row('Employee submitting',<input type="text" style={inp} value={f.employee} onChange={e=>set('employee',e.target.value)}/>)}</>)}
          {row('LoadProof URL',<input type="url" style={inp} value={f.loadproofUrl} onChange={e=>set('loadproofUrl',e.target.value)} placeholder="Paste LoadProof record link"/>)}
          {row('Incident notes',<textarea style={{...inp,minHeight:60,resize:'vertical'}} value={f.incidentNotes} onChange={e=>set('incidentNotes',e.target.value)} placeholder="Describe what happened..."/>)}
          {row('Investigation notes',<textarea style={{...inp,minHeight:50,resize:'vertical'}} value={f.investigationNotes} onChange={e=>set('investigationNotes',e.target.value)} placeholder="Findings, root cause..."/>)}
          {sdiv('Adjustment')}
          {two(<>{row('Completed date',<input type="date" style={inp} value={f.adjDate} onChange={e=>set('adjDate',e.target.value)}/>)}{row('Completed by',<input type="text" style={inp} value={f.adjBy} onChange={e=>set('adjBy',e.target.value)} placeholder="Name"/>)}</>)}
          {row('Adjustment notes',<input type="text" style={inp} value={f.adjNotes} onChange={e=>set('adjNotes',e.target.value)} placeholder="LP, Datex ref..."/>)}
          {sdiv('Coaching')}
          {two(<>{row('Required?',<select style={inp} value={f.coachingRequired} onChange={e=>set('coachingRequired',e.target.value)}><option value="No">No</option><option value="Yes">Yes</option></select>)}{row('Employee responsible',<input type="text" style={inp} value={f.employeeResponsible} onChange={e=>set('employeeResponsible',e.target.value)} placeholder="Name"/>)}</>)}
          {two(<>{row('Coaching completed date',<input type="date" style={inp} value={f.coachingDate} onChange={e=>set('coachingDate',e.target.value)}/>)}{row('Completed by',<input type="text" style={inp} value={f.coachingBy} onChange={e=>set('coachingBy',e.target.value)} placeholder="Supervisor"/>)}</>)}
          {row('Coaching notes',<textarea style={{...inp,minHeight:50,resize:'vertical'}} value={f.coachingNotes} onChange={e=>set('coachingNotes',e.target.value)} placeholder="What was covered..."/>)}
        </div>
        <div style={{padding:'12px 20px',borderTop:'1px solid var(--border)',display:'flex',justifyContent:'flex-end',gap:8,flexShrink:0,background:'var(--bg1)'}}>
          <button onClick={onClose} style={{background:'none',border:'1px solid var(--border)',borderRadius:6,padding:'6px 14px',cursor:'pointer',color:'var(--text-secondary)',fontSize:13,fontFamily:'inherit'}}>Cancel</button>
          <button onClick={()=>{const adjOpen=!(f.adjDate||f.adjBy);const coachingOpen=f.coachingRequired==='Yes'&&!f.coachingDate;onAdd(f.fac,{...f,adjOpen,coachingOpen});onClose()}} style={{background:'var(--text-primary)',border:'1px solid var(--text-primary)',borderRadius:6,padding:'6px 16px',cursor:'pointer',color:'var(--bg0)',fontSize:13,fontFamily:'inherit',fontWeight:600}}>Save incident</button>
        </div>
      </div>
    </div>
  )
}

export default function DvrTracker() {
  // Seed data used as fallback if SharePoint fetch fails
  const [cal,setCal]=useState(SEED_CAL)
  const [ken,setKen]=useState(SEED_KEN)
  const [mad,setMad]=useState([])
  const [loading,setLoading]=useState(true)
  const [loadErrors,setLoadErrors]=useState({})

  const [facility,setFacility]=useState('all')
  const [tab,setTab]=useState('tracker')
  const [search,setSearch]=useState('')
  const [typeFilter,setTypeFilter]=useState('all')
  const [reasonFilter,setReasonFilter]=useState('all')
  const [statusFilter,setStatusFilter]=useState('all')
  const [sortField,setSortField]=useState('date')
  const [sortDir,setSortDir]=useState('desc')
  const [page,setPage]=useState(1)
  const [detail,setDetail]=useState(null)
  const [showAdd,setShowAdd]=useState(false)

  // Fetch all facilities from SharePoint on mount
  // Falls back to seed data for CAL/KEN if fetch fails
  useEffect(()=>{
    setLoading(true)
    const load = async (fac) => {
      try {
        const r = await fetch(`/.netlify/functions/sharepoint-dvr?facility=${fac}`)
        const d = await r.json()
        if (d.error) throw new Error(d.error)
        return d.incidents?.map(i=>({...i,_fac:fac})) ?? []
      } catch(e) {
        console.warn(`[DVR] ${fac} fetch failed:`, e.message)
        setLoadErrors(prev=>({...prev,[fac]:e.message}))
        return null // null = keep fallback seed data
      }
    }
    Promise.all([load('cal'),load('ken'),load('mad')]).then(([calData,kenData,madData])=>{
      if(calData!==null)setCal(calData)
      if(kenData!==null)setKen(kenData)
      if(madData!==null)setMad(madData)
    }).finally(()=>setLoading(false))
  },[])

  const handleSort=(field)=>{
    if(sortField===field){setSortDir(d=>d==='asc'?'desc':'asc')}
    else{setSortField(field);setSortDir('asc')}
    setPage(1)
  }

  const activeData=useMemo(()=>{
    if(facility==='cal')return cal.map(i=>({...i,_fac:'cal'}))
    if(facility==='ken')return ken.map(i=>({...i,_fac:'ken'}))
    if(facility==='mad')return mad
    return[...cal.map(i=>({...i,_fac:'cal'})),...ken.map(i=>({...i,_fac:'ken'})),...mad]
  },[facility,cal,ken,mad])

  const adjOpen=useMemo(()=>activeData.filter(i=>i.adjOpen).length,[activeData])
  const coachOpen=useMemo(()=>activeData.filter(i=>i.coachingOpen).length,[activeData])
  const oldest=useMemo(()=>activeData.reduce((mx,i)=>ageInDays(i.date)>ageInDays(mx?.date||'')?i:mx,activeData[0]),[activeData])

  const filtered=useMemo(()=>{
    let items=activeData.slice()
    if(search){const s=search.toLowerCase();items=items.filter(i=>(i.customer||'').toLowerCase().includes(s)||(i.id||'').toLowerCase().includes(s)||(i.orderNum||'').toLowerCase().includes(s)||(i.reason||'').toLowerCase().includes(s)||(i.licensePlate||'').toLowerCase().includes(s)||(i.lotNum||'').toLowerCase().includes(s)||(i.materialNum||'').toLowerCase().includes(s)||(i.employeeResponsible||'').toLowerCase().includes(s)||(i.employee||'').toLowerCase().includes(s)||(i.incidentNotes||'').toLowerCase().includes(s)||(i.investigationNotes||'').toLowerCase().includes(s))}
    if(typeFilter!=='all')items=items.filter(i=>(i.incidentType||'').toLowerCase().includes(typeFilter.toLowerCase()))
    if(reasonFilter!=='all')items=items.filter(i=>(i.reason||'').toLowerCase()===reasonFilter.toLowerCase())
    if(statusFilter==='adj')items=items.filter(i=>i.adjOpen)
    if(statusFilter==='coaching')items=items.filter(i=>i.coachingOpen)
    if(statusFilter==='both')items=items.filter(i=>i.adjOpen&&i.coachingOpen)
    return sortItems(items,sortField,sortDir)
  },[activeData,search,typeFilter,reasonFilter,statusFilter,sortField,sortDir])

  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE))
  const safePg=Math.min(page,pages)
  const paged=filtered.slice((safePg-1)*PAGE_SIZE,safePg*PAGE_SIZE)
  const reasons=useMemo(()=>[...new Set(activeData.map(i=>i.reason).filter(Boolean))].sort(),[activeData])

  const writeBack = useCallback((id,fac,next)=>{
    const arr=fac==='cal'?cal:fac==='ken'?ken:mad
    const incident=arr.find(i=>i.id===id)
    if(!incident?.rowIndex||!incident?._colMap)return
    const updates={}
    const fields=['adjDate','adjBy','adjNotes','coachingRequired','employeeResponsible','coachingDate','coachingBy','coachingNotes']
    fields.forEach(f=>{if(next[f]!==undefined&&next[f]!==incident[f])updates[f]=next[f]})
    if(Object.keys(updates).length===0)return
    fetch(`/.netlify/functions/sharepoint-dvr?facility=${fac}`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rowIndex:incident.rowIndex,updates,colMap:incident._colMap}),
    }).catch(e=>console.error(`[DVR] ${fac} write-back failed:`,e))
  },[cal,ken,mad])

  const handleUpdate=useCallback((id,fac,next,remove=false)=>{
    writeBack(id,fac,next)
    const setter=fac==='cal'?setCal:fac==='ken'?setKen:setMad
    setter(prev=>remove?prev.filter(i=>i.id!==id):prev.map(i=>i.id===id?{...i,...next}:i))
  },[writeBack])

  const handleDelete=useCallback((id,fac)=>{
    const setter=fac==='cal'?setCal:fac==='ken'?setKen:setMad
    setter(prev=>prev.filter(i=>i.id!==id))
  },[])

  const handleAdd=useCallback((fac,fields)=>{
    const setter=fac==='cal'?setCal:fac==='ken'?setKen:setMad
    const arr=fac==='cal'?cal:fac==='ken'?ken:mad
    const prefixes={cal:'DVR',ken:'KEN',mad:'MAD'}
    const bases={cal:1321,ken:2037,mad:1000}
    const prefix=prefixes[fac]||'DVR'
    const base=bases[fac]||1000
    const maxId=Math.max(base,...arr.map(i=>parseInt(i.id.replace(`${prefix}-`,''))||0))
    setter(prev=>[{...fields,id:`${prefix}-${String(maxId+1).padStart(4,'0')}`,_fac:fac},...prev])
  },[cal,ken,mad])

  const detailIncident=detail?(detail.fac==='cal'?cal:detail.fac==='ken'?ken:mad).find(i=>i.id===detail.id):null
  const hasFilters=search||typeFilter!=='all'||reasonFilter!=='all'||statusFilter!=='all'
  const thBase={padding:'9px 12px',textAlign:'left',fontSize:10,fontWeight:600,color:'var(--text-secondary)',borderBottom:'1px solid var(--border)',background:'var(--bg1)',textTransform:'uppercase',letterSpacing:'.3px',whiteSpace:'nowrap'}
  const tdBase={padding:'10px 12px',verticalAlign:'top',borderBottom:'1px solid var(--border-subtle)',fontSize:13}

  return(
    <div style={{padding:0,background:'var(--bg0)'}}>
      {/* Topbar */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 20px',borderBottom:'1px solid var(--border)',flexWrap:'wrap',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:14,fontWeight:700,fontFamily:'var(--font-mono)'}}>DVR Tracker</span>
          <div style={{display:'flex',border:'1px solid var(--border)',borderRadius:7,overflow:'hidden'}}>
            {[['all','All','#374151'],['cal','Caledonia','#1d4ed8'],['ken','Kenosha','#15803d'],['mad','Madison','#7c3aed']].map(([id,label,color])=>(
              <button key={id} onClick={()=>{setFacility(id);setPage(1)}} style={{padding:'5px 14px',fontSize:12,fontWeight:600,cursor:'pointer',border:'none',background:facility===id?color:'transparent',color:facility===id?'var(--bg0)':'var(--text-secondary)',fontFamily:'var(--font-mono)',transition:'all .15s',borderRight:id!=='mad'?'1px solid var(--border)':'none',display:'flex',alignItems:'center',gap:5}}>
                {id!=='all'&&<span style={{width:6,height:6,borderRadius:'50%',background:facility===id?'var(--bg0)':color,display:'inline-block'}}/>}
                {label}
              </button>
            ))}
          </div>
          {loading
            ?<span style={{fontSize:11,padding:'2px 9px',borderRadius:20,fontWeight:600,background:'var(--bg3)',color:'var(--text-secondary)',fontFamily:'var(--font-mono)'}}>Loading…</span>
            :<span style={{fontSize:11,padding:'2px 9px',borderRadius:20,fontWeight:600,background:'rgba(220,38,38,0.12)',color:'var(--red)',fontFamily:'var(--font-mono)'}}>{activeData.length} open</span>
          }
          <span style={{fontSize:10,color:'var(--text-secondary)'}}>live from SharePoint</span>
        </div>
        <button onClick={()=>setShowAdd(true)} style={{background:'var(--text-primary)',border:'none',borderRadius:6,padding:'6px 14px',cursor:'pointer',color:'var(--bg0)',fontSize:12,fontWeight:600,fontFamily:'var(--font-mono)'}}>+ Add incident</button>
      </div>

      {/* Tab nav */}
      <div style={{display:'flex',gap:2,padding:'0 20px',borderBottom:'1px solid var(--border)'}}>
        {[['tracker','Open tracker'],['dash','Dashboard']].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:'10px 14px',fontSize:13,border:'none',background:'transparent',cursor:'pointer',color:tab===id?'var(--text-primary)':'var(--text-secondary)',fontWeight:tab===id?600:400,borderBottom:tab===id?'2px solid var(--text-primary)':'2px solid transparent',marginBottom:-1,fontFamily:'inherit'}}>{label}</button>
        ))}
      </div>

      <div style={{padding:20}}>

        {/* Error banners */}
        {Object.entries(loadErrors).map(([fac,err])=>(
          <div key={fac} style={{background:'rgba(220,38,38,0.08)',border:'1px solid rgba(220,38,38,0.2)',borderRadius:8,padding:'10px 14px',marginBottom:10,fontSize:12,color:'var(--red)',fontFamily:'var(--font-mono)'}}>
            {fac.toUpperCase()} SharePoint: {err} — showing cached data
          </div>
        ))}

        {/* ══ TRACKER ══ */}
        {tab==='tracker'&&(
          <>
            <div style={{background:'var(--bg1)',border:'1px solid var(--border)',borderRadius:10,padding:'14px 16px',marginBottom:16}}>
              <div style={{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap'}}>
                <input type="text" placeholder="🔍  Search by customer, order #, LP, lot, material #, employee, notes..." value={search} onChange={e=>{setSearch(e.target.value);setPage(1)}} style={{flex:1,minWidth:240,padding:'8px 12px',fontSize:13,border:'1px solid var(--border)',borderRadius:8,background:'var(--bg0)',color:'var(--text-primary)',fontFamily:'inherit',boxSizing:'border-box'}}/>
                {hasFilters&&<button onClick={()=>{setSearch('');setTypeFilter('all');setReasonFilter('all');setStatusFilter('all');setPage(1)}} style={{padding:'8px 12px',fontSize:12,border:'1px solid var(--border)',borderRadius:8,background:'var(--bg0)',color:'var(--text-secondary)',cursor:'pointer',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>Clear filters ×</button>}
              </div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
                <span style={{fontSize:11,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',marginRight:4}}>FILTER:</span>
                <select value={typeFilter} onChange={e=>{setTypeFilter(e.target.value);setPage(1)}} style={{padding:'5px 10px',fontSize:12,border:'1px solid var(--border)',borderRadius:6,background:'var(--bg0)',color:'var(--text-primary)',fontFamily:'inherit'}}><option value="all">All types</option><option value="Outbound">Outbound</option><option value="Warehouse">WH Ops Damage</option><option value="Inbound">Inbound</option><option value="Disposal">Disposal</option></select>
                <select value={reasonFilter} onChange={e=>{setReasonFilter(e.target.value);setPage(1)}} style={{padding:'5px 10px',fontSize:12,border:'1px solid var(--border)',borderRadius:6,background:'var(--bg0)',color:'var(--text-primary)',fontFamily:'inherit'}}><option value="all">All reasons</option>{reasons.map(r=><option key={r} value={r}>{r}</option>)}</select>
                <select value={statusFilter} onChange={e=>{setStatusFilter(e.target.value);setPage(1)}} style={{padding:'5px 10px',fontSize:12,border:'1px solid var(--border)',borderRadius:6,background:'var(--bg0)',color:'var(--text-primary)',fontFamily:'inherit'}}><option value="all">All statuses</option><option value="adj">Adj. needed</option><option value="coaching">Coaching pending</option><option value="both">Both open</option></select>
                <span style={{fontSize:11,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',marginLeft:'auto'}}>{filtered.length} of {activeData.length} records{hasFilters?' (filtered)':''}</span>
              </div>
            </div>
            <div style={{border:'1px solid var(--border)',borderRadius:10,overflow:'hidden'}}>
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:13,minWidth:1100}}>
                  <thead><tr>
                    {facility==='all'&&<th style={thBase}>Fac</th>}
                    <SortTh label="Date" field="date" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                    <SortTh label="ID" field="id" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                    <SortTh label="Customer" field="customer" sortField={sortField} sortDir={sortDir} onSort={handleSort} style={{minWidth:130}}/>
                    <SortTh label="Order #" field="orderNum" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                    <SortTh label="Type" field="incidentType" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                    <SortTh label="Reason" field="reason" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                    <th style={thBase}>LP / Lot / Mat#</th>
                    <SortTh label="Cases" field="cases" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                    <th style={{...thBase,minWidth:180}}>Notes</th>
                    <th style={thBase}>Emp. responsible</th>
                    <SortTh label="Age" field="age" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                    <th style={thBase}>Adj.</th>
                    <th style={thBase}>Coaching</th>
                    <th style={thBase}>LP Link</th>
                  </tr></thead>
                  <tbody>
                    {loading&&!paged.length?(
                      <tr><td colSpan={facility==='all'?15:14} style={{padding:40,textAlign:'center',color:'var(--text-secondary)',fontSize:13,fontFamily:'var(--font-mono)'}}>Loading from SharePoint…</td></tr>
                    ):paged.length?paged.map((i,idx)=>(
                      <tr key={i.id} onClick={()=>setDetail({id:i.id,fac:i._fac})} style={{background:idx%2===0?'var(--bg0)':'var(--bg1)',cursor:'pointer'}}
                        onMouseEnter={e=>e.currentTarget.style.background='var(--bg2)'}
                        onMouseLeave={e=>e.currentTarget.style.background=idx%2===0?'var(--bg0)':'var(--bg1)'}>
                        {facility==='all'&&<td style={tdBase}><FacBadge fac={i._fac}/></td>}
                        <td style={{...tdBase,whiteSpace:'nowrap'}}>{fmtDate(i.date)}</td>
                        <td style={{...tdBase,fontSize:11,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>{i.id}</td>
                        <td style={{...tdBase,maxWidth:150}}><div style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={i.customer}>{i.customer||'—'}</div></td>
                        <td style={{...tdBase,fontFamily:'var(--font-mono)',fontSize:11,whiteSpace:'nowrap'}}>{i.orderNum||'—'}</td>
                        <td style={tdBase}><TypePill type={i.incidentType}/></td>
                        <td style={{...tdBase,whiteSpace:'nowrap'}}>{i.reason||'—'}</td>
                        <td style={{...tdBase,fontSize:11,fontFamily:'var(--font-mono)'}}>
                          <div style={{color:'var(--text-secondary)'}}>{i.licensePlate||'—'}</div>
                          <div style={{color:'var(--text-dim,#888)',marginTop:2}}>{[i.lotNum,i.materialNum].filter(Boolean).join(' / ')||''}</div>
                        </td>
                        <td style={{...tdBase,textAlign:'center',fontFamily:'var(--font-mono)'}}>{i.cases!=null&&i.cases!==''&&i.cases!==0?i.cases:'—'}</td>
                        <td style={{...tdBase,maxWidth:200}}>
                          {i.incidentNotes&&<div style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.4}}>{preview(i.incidentNotes)}</div>}
                          {i.investigationNotes&&<div style={{fontSize:11,color:'var(--text-dim,#888)',marginTop:3,lineHeight:1.4}}>🔍 {preview(i.investigationNotes,45)}</div>}
                        </td>
                        <td style={{...tdBase,fontSize:12,whiteSpace:'nowrap'}}>{i.employeeResponsible||i.employee||'—'}</td>
                        <td style={{...tdBase,fontWeight:600,color:ageColor(i.date),whiteSpace:'nowrap',fontFamily:'var(--font-mono)'}}>{ageInDays(i.date)}d</td>
                        <td style={tdBase}>{i.adjOpen?<Badge label="Needed" variant="adj"/>:<Badge label="Done" variant="done"/>}</td>
                        <td style={tdBase}>{i.coachingRequired==='Yes'?(i.coachingOpen?<Badge label="Pending" variant="coach"/>:<Badge label="Done" variant="done"/>):<Badge label="N/A" variant="na"/>}</td>
                        <td style={tdBase} onClick={e=>e.stopPropagation()}>
                          {i.loadproofUrl?<a href={i.loadproofUrl} target="_blank" rel="noreferrer" style={{fontSize:11,color:'var(--accent,#3b82f6)',textDecoration:'none',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>View ↗</a>:<span style={{fontSize:11,color:'var(--text-dim,#aaa)',fontFamily:'var(--font-mono)'}}>—</span>}
                        </td>
                      </tr>
                    )):(
                      <tr><td colSpan={facility==='all'?15:14} style={{padding:40,textAlign:'center',color:'var(--text-secondary)',fontSize:13}}>No records match — <button onClick={()=>{setSearch('');setTypeFilter('all');setReasonFilter('all');setStatusFilter('all')}} style={{background:'none',border:'none',color:'var(--accent,#3b82f6)',cursor:'pointer',fontSize:13,fontFamily:'inherit'}}>clear filters</button></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px',borderTop:'1px solid var(--border)',fontSize:12,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',background:'var(--bg1)'}}>
                <span>Showing {(safePg-1)*PAGE_SIZE+1}–{Math.min(safePg*PAGE_SIZE,filtered.length)} of {filtered.length}</span>
                <div style={{display:'flex',gap:4}}>
                  <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={safePg===1} style={{padding:'3px 9px',border:'1px solid var(--border)',borderRadius:5,background:'var(--bg0)',color:'var(--text-primary)',cursor:'pointer',fontSize:12,fontFamily:'var(--font-mono)',opacity:safePg===1?0.4:1}}>‹</button>
                  {Array.from({length:Math.min(pages,8)},(_,i)=>i+1).map(p=>(<button key={p} onClick={()=>setPage(p)} style={{padding:'3px 9px',border:'1px solid var(--border)',borderRadius:5,background:p===safePg?'var(--text-primary)':'var(--bg0)',color:p===safePg?'var(--bg0)':'var(--text-primary)',cursor:'pointer',fontSize:12,fontFamily:'var(--font-mono)'}}>{p}</button>))}
                  <button onClick={()=>setPage(p=>Math.min(pages,p+1))} disabled={safePg===pages} style={{padding:'3px 9px',border:'1px solid var(--border)',borderRadius:5,background:'var(--bg0)',color:'var(--text-primary)',cursor:'pointer',fontSize:12,fontFamily:'var(--font-mono)',opacity:safePg===pages?0.4:1}}>›</button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ══ DASHBOARD ══ */}
        {tab==='dash'&&(
          <>
            <div style={{background:'rgba(217,119,6,0.1)',border:'1px solid rgba(217,119,6,0.3)',borderRadius:8,padding:'10px 16px',marginBottom:18,fontSize:13,color:'#d97706',display:'flex',alignItems:'center',gap:8}}>
              <span style={{width:7,height:7,borderRadius:'50%',background:'#d97706',display:'inline-block',flexShrink:0}}/>
              <strong>{loading?'Loading…':activeData.length+' open incidents'}</strong> — {facility==='all'?'Caledonia + Kenosha + Madison • all live from SharePoint':facility==='cal'?'Caledonia':facility==='ken'?'Kenosha':'Madison'}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,minmax(0,1fr))',gap:12,marginBottom:20}}>
              {[['Total open',activeData.length,'var(--red)'],['Adj. needed',adjOpen,'#d97706'],['Coaching pending',coachOpen,'var(--red)'],['Oldest open',oldest?`${ageInDays(oldest.date)}d`:'—','#3b82f6']].map(([l,v,c])=>(
                <div key={l} style={{background:'var(--bg1)',border:'1px solid var(--border)',borderRadius:8,padding:'12px 16px'}}>
                  <div style={{fontSize:10,color:'var(--text-secondary)',textTransform:'uppercase',letterSpacing:'.5px',marginBottom:6,fontFamily:'var(--font-mono)'}}>{l}</div>
                  <div style={{fontSize:28,fontWeight:700,color:c}}>{v}</div>
                </div>
              ))}
            </div>
            {facility==='all'&&(
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:16,marginBottom:20}}>
                {[['cal','Caledonia','#1d4ed8',cal],['ken','Kenosha','#15803d',ken],['mad','Madison','#7c3aed',mad]].map(([id,name,color,data])=>(
                  <div key={id} style={{border:`1px solid var(--border)`,borderTop:`3px solid ${color}`,borderRadius:8,padding:16,background:'var(--bg0)'}}>
                    <div style={{fontSize:13,fontWeight:700,color,marginBottom:12}}>{name}</div>
                    {[['Total open',data.length,'var(--red)'],['Adj. needed',data.filter(i=>i.adjOpen).length,'#d97706'],['Coaching pending',data.filter(i=>i.coachingOpen).length,'var(--red)'],['Top reason',topN(data,'reason',1)[0]?.[0]||'—','var(--text-primary)']].map(([lbl,val,c])=>(
                      <div key={lbl} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',borderBottom:'1px solid var(--border-subtle)',fontSize:13}}>
                        <span style={{color:'var(--text-secondary)',fontSize:12}}>{lbl}</span>
                        <span style={{fontWeight:600,color:c,fontSize:typeof val==='number'?15:12}}>{val}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
              {[['By incident type','incidentType','#3b82f6'],['By reason','reason','#8b5cf6'],['By customer','customer','#7c3aed'],['By responsible party','responsibleParty','#0891b2']].map(([title,key,color])=>(
                <div key={key} style={{border:'1px solid var(--border)',borderRadius:8,padding:16,background:'var(--bg0)'}}>
                  <div style={{fontSize:12,fontWeight:600,color:'var(--text-secondary)',marginBottom:12,fontFamily:'var(--font-mono)'}}>{title}</div>
                  <BarChart entries={topN(activeData,key)} color={color}/>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {detailIncident&&<DetailModal incident={detailIncident} fac={detail.fac} onClose={()=>setDetail(null)} onUpdate={handleUpdate} onDelete={handleDelete}/>}
      {showAdd&&<AddModal defaultFac={facility} onClose={()=>setShowAdd(false)} onAdd={handleAdd}/>}
    </div>
  )
}
