import { useState, useMemo, useCallback, useEffect } from 'react'

const PAGE_SIZE = 30
function fmtDate(d){if(!d)return'—';try{return new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'})}catch{return d}}
function ageInDays(d){return !d?0:Math.floor((Date.now()-new Date(d+'T12:00:00'))/86400000)}
function ageColor(d){const a=ageInDays(d);return a>21?'var(--red)':a>14?'#e09a2a':'var(--text-primary)'}
function preview(s,n=60){return !s?'':s.length>n?s.slice(0,n)+'…':s}
function sortItems(items,field,dir){
  if(!field)return items
  return [...items].sort((a,b)=>{
    let va=a[field]??'',vb=b[field]??''
    if(field==='date'){va=new Date(va+'T12:00:00');vb=new Date(vb+'T12:00:00')}
    else if(field==='age'){va=ageInDays(a.date);vb=ageInDays(b.date)}
    else{va=String(va).toLowerCase();vb=String(vb).toLowerCase()}
    if(va<vb)return dir==='asc'?-1:1;if(va>vb)return dir==='asc'?1:-1;return 0
  })
}

function StatusBadge({status}){
  const map={
    clean:{bg:'rgba(22,163,74,0.12)',color:'#16a34a',label:'Clean'},
    notify:{bg:'rgba(220,38,38,0.12)',color:'var(--red)',label:'Notify Customer'},
    pending:{bg:'rgba(217,119,6,0.12)',color:'#d97706',label:'Pending Resolution'},
    resolved:{bg:'rgba(22,163,74,0.12)',color:'#16a34a',label:'Resolved'},
    flagged:{bg:'rgba(217,119,6,0.12)',color:'#d97706',label:'Issue Found'},
    notified:{bg:'rgba(37,99,235,0.12)',color:'#3b82f6',label:'CSR Notified'},
  }
  const s=map[status]||{bg:'var(--bg3)',color:'var(--text-secondary)',label:status}
  return <span style={{display:'inline-block',fontSize:10,padding:'2px 8px',borderRadius:20,fontWeight:600,background:s.bg,color:s.color,fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>{s.label}</span>
}
function ProblemBadge({problem}){
  const isYes=(problem||'').toLowerCase().startsWith('yes')
  return <span style={{display:'inline-block',fontSize:10,padding:'2px 8px',borderRadius:20,fontWeight:600,background:isYes?'rgba(220,38,38,0.12)':'rgba(22,163,74,0.12)',color:isYes?'var(--red)':'#16a34a',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>{isYes?'Issue':'Clean'}</span>
}
function FacBadge({fac}){
  const map={cal:['rgba(29,78,216,0.1)','#1d4ed8','CAL'],ken:['rgba(21,128,61,0.1)','#15803d','KEN'],mad:['rgba(124,58,237,0.1)','#7c3aed','MAD']}
  const[bg,color,label]=map[fac]||map.cal
  return <span style={{fontSize:10,padding:'2px 7px',borderRadius:10,fontWeight:600,background:bg,color,fontFamily:'var(--font-mono)'}}>{label}</span>
}
function SortTh({label,field,sortField,sortDir,onSort,style{}}){
  const active=sortField===field,arrow=active?(sortDir==='asc'?' ↑':' ↓'):''
  return <th onClick={()=>onSort(field)} style={{padding:'9px 12px',textAlign:'left',fontSize:10,fontWeight:600,color:active?'var(--text-primary)':'var(--text-secondary)',borderBottom:'1px solid var(--border)',background:'var(--bg1)',textTransform:'uppercase',letterSpacing:'.3px',whiteSpace:'nowrap',cursor:'pointer',userSelect:'none',...style}}>{label}{arrow}</th>
}

function InboundDetailModal({record,fac,tab,onClose,onSave}){
  const[fields,setFields]=useState({...record})
  const set=(k,v)=>setFields(p=>({...p,[k]:v}))
  const inp=(ov={})=>({width:'100%',padding:'7px 10px',fontSize:13,border:'1px solid var(--border)',borderRadius:6,background:'var(--bg1)',color:'var(--text-primary)',fontFamily:'inherit',boxSizing:'border-box',...ov})
  const lbl={display:'block',fontSize:11,fontWeight:600,color:'var(--text-secondary)',marginBottom:4,textTransform:'uppercase',letterSpacing:'.4px',fontFamily:'var(--font-mono)'}
  const row=(label,el)=><div style={{marginBottom:12}}><label style={lbl}>{label}</label>{el}</div>
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--bg0)',border:'1px solid var(--border)',borderRadius:12,width:580,maxWidth:'95vw',maxHeight:'90vh',overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 20px 60px rgba(0,0,0,.3)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'16px 20px',borderBottom:'1px solid var(--border)',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <span style={{fontSize:15,fontWeight:700}}>{record.id}</span>
            <FacBadge fac={fac}/><StatusBadge status={record.status}/>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-secondary)',fontSize:22,lineHeight:1}}>×</button>
        </div>
        <div style={{padding:20,overflowY:'auto',flex:1}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:14}}>
            {[['Date',fmtDate(record.date)],['Age',`${ageInDays(record.date)}d`],['Order #',record.orderNum||'—'],['Customer',record.customer||'—'],['Employee',record.employee||'—'],['Photos',record.photos||0]].map(([l,v])=>(
              <div key={l} style={{background:'var(--bg1)',borderRadius:7,padding:'8px 12px',border:'1px solid var(--border-subtle)'}}><div style={{fontSize:10,color:'var(--text-secondary)',marginBottom:2}}>{l}</div><div style={{fontSize:13,fontWeight:500}}>{v}</div></div>
            ))}
          </div>
          <div style={{background:'var(--bg1)',borderRadius:7,padding:12,marginBottom:12,border:'1px solid var(--border-subtle)'}}>
            <div style={{fontSize:10,color:'var(--text-secondary)',marginBottom:4}}>Problem / Notes</div>
            <div style={{fontSize:13,fontWeight:500}}>{record.problem||'—'}</div>
            {record.notes&&<div style={{fontSize:12,color:'var(--text-secondary)',marginTop:6}}>{record.notes}</div>}
          </div>
          <div style={{marginBottom:12}}>
            <label style={lbl}>LoadProof URL</label>
            {fields.loadproofUrl
              ?<div><a href={fields.loadproofUrl} target="_blank" rel="noreferrer" style={{fontSize:13,color:'var(--accent,#3b82f6)',textDecoration:'none',fontFamily:'var(--font-mono)',wordBreak:'break-all'}}>{fields.loadproofUrl} ↗</a></div>
              :<input type="url" style={inp()} value={fields.loadproofUrl||''} onChange={e=>set('loadproofUrl',e.target.value)} placeholder="Paste LoadProof record URL here"/>
            }
          </div>
          {tab==='inbound'&&<>
            {row('Customer Notified (MMDDYY)',<input type="text" style={inp()} value={fields.customerNotified||''} onChange={e=>set('customerNotified',e.target.value)} placeholder="e.g. 071326"/>)}
            {row('Who Resolved?',<input type="text" style={inp()} value={fields.whoResolved||''} onChange={e=>set('whoResolved',e.target.value)} placeholder="Name of person who resolved"/>)}
          </>}
          {tab==='hold'&&row('CSR > Customer Notified?',<input type="text" style={inp()} value={fields.csrNotified||''} onChange={e=>set('csrNotified',e.target.value)} placeholder="Date or name when customer notified"/>)}
          {record.adjRequired&&<div style={{background:'var(--bg1)',borderRadius:7,padding:12,border:'1px solid var(--border-subtle)'}}><div style={{fontSize:10,color:'var(--text-secondary)',marginBottom:4}}>Adjustment Required?</div><div style={{fontSize:13,fontWeight:500}}>{record.adjRequired}</div></div>}
        </div>
        <div style={{padding:'12px 20px',borderTop:'1px solid var(--border)',display:'flex',justifyContent:'flex-end',gap:8,flexShrink:0,background:'var(--bg1)'}}>
          <button onClick={onClose} style={{background:'none',border:'1px solid var(--border)',borderRadius:6,padding:'6px 14px',cursor:'pointer',color:'var(--text-secondary)',fontSize:13,fontFamily:'inherit'}}>Cancel</button>
          <button onClick={()=>{onSave(record.id,fac,fields);onClose()}} style={{background:'var(--text-primary)',border:'1px solid var(--text-primary)',borderRadius:6,padding:'6px 16px',cursor:'pointer',color:'var(--bg0)',fontSize:13,fontFamily:'inherit',fontWeight:600}}>Save</button>
        </div>
      </div>
    </div>
  )
}

export default function LoadProofInboundTracker({type}){
  const[cal,setCal]=useState([])
  const[ken,setKen]=useState([])
  const[mad,setMad]=useState([])
  const[loading,setLoading]=useState(true)
  const[loadErrors,setLoadErrors]=useState({})
  const[facility,setFacility]=useState('all')
  const[search,setSearch]=useState('')
  const[statusFilter,setStatusFilter]=useState('all')
  const[sortField,setSortField]=useState('date')
  const[sortDir,setSortDir]=useState('desc')
  const[page,setPage]=useState(1)
  const[detail,setDetail]=useState(null)

  useEffect(()=>{
    setLoading(true);setLoadErrors({})
    const load=async(fac)=>{
      try{
        const r=await fetch(`/.netlify/functions/sharepoint-dvr?facility=${fac}&tab=${type}`)
        const d=await r.json()
        if(d.error)throw new Error(d.error)
        return(d.records||[]).map(i=>({...i,_fac:fac}))
      }catch(e){
        console.warn(`[LP] ${fac}/${type} failed:`,e.message)
        setLoadErrors(prev=>({...prev,[fac]:e.message}))
        return null
      }
    }
    Promise.all([load('cal'),load('ken'),load('mad')]).then(([c,k,m])=>{
      if(c!==null)setCal(c);if(k!==null)setKen(k);if(m!==null)setMad(m)
    }).finally(()=>setLoading(false))
  },[type])

  const handleSort=(field)=>{
    if(sortField===field)setSortDir(d=>d==='asc'?'desc':'asc')
    else{setSortField(field);setSortDir('asc')}
    setPage(1)
  }

  const activeData=useMemo(()=>{
    if(facility==='cal')return cal.map(i=>({...i,_fac:'cal'}))
    if(facility==='ken')return ken.map(i=>({...i,_fac:'ken'}))
    if(facility==='mad')return mad
    return[...cal.map(i=>({...i,_fac:'cal'})),...ken.map(i=>({...i,_fac:'ken'})),...mad]
  },[facility,cal,ken,mad])

  const filtered=useMemo(()=>{
    let items=activeData.slice()
    if(search){const s=search.toLowerCase();items=items.filter(i=>(i.customer||'').toLowerCase().includes(s)||(i.orderNum||'').toLowerCase().includes(s)||(i.notes||'').toLowerCase().includes(s)||(i.employee||'').toLowerCase().includes(s)||(i.problem||'').toLowerCase().includes(s))}
    if(statusFilter!=='all')items=items.filter(i=>i.status===statusFilter)
    return sortItems(items,sortField,sortDir)
  },[activeData,search,statusFilter,sortField,sortDir])

  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE))
  const safePg=Math.min(page,pages)
  const paged=filtered.slice((safePg-1)*PAGE_SIZE,safePg*PAGE_SIZE)
  const hasFilters=search||statusFilter!=='all'
  const showFac=facility==='all'

  const handleSave=useCallback((id,fac,fields)=>{
    const setter=fac==='cal'?setCal:fac==='ken'?setKen:setMad
    setter(prev=>prev.map(i=>{
      if(i.id!==id)return i
      const next={...i,...fields}
      if(type==='inbound'){const hp=next.problem?.toLowerCase().startsWith('yes');if(!hp)next.status='clean';else if(!next.customerNotified)next.status='notify';else if(!next.whoResolved)next.status='pending';else next.status='resolved'}
      else if(type==='hold'){const hp=next.problem?.toLowerCase().startsWith('yes');next.status=!hp?'clean':next.csrNotified?'notified':'notify'}
      return next
    }))
    const arr=(fac==='cal'?cal:fac==='ken'?ken:mad)
    const record=arr.find(i=>i.id===id)
    if(!record?.rowIndex||!record?._colMap)return
    const updates={}
    ;['customerNotified','whoResolved','csrNotified','loadproofUrl'].forEach(f=>{if(fields[f]!==undefined&&fields[f]!==record[f])updates[f]=fields[f]})
    if(Object.keys(updates).length===0)return
    fetch(`/.netlify/functions/sharepoint-dvr?facility=${fac}&tab=${type}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rowIndex:record.rowIndex,updates,colMap:record._colMap})}).catch(e=>console.error('[LP] write-back failed:',e))
  },[cal,ken,mad,type])

  const detailRecord=detail?(detail.fac==='cal'?cal:detail.fac==='ken'?ken:mad).find(i=>i.id===detail.id):null
  const thBase={padding:'9px 12px',textAlign:'left',fontSize:10,fontWeight:600,color:'var(--text-secondary)',borderBottom:'1px solid var(--border)',background:'var(--bg1)',textTransform:'uppercase',letterSpacing:'.3px',whiteSpace:'nowrap'}
  const tdBase={padding:'10px 12px',verticalAlign:'top',borderBottom:'1px solid var(--border-subtle)',fontSize:13}
  const statusOptions={inbound:[['all','All'],['clean','Clean'],['notify','Notify Customer'],['pending','Pending'],['resolved','Resolved']],outbound:[['all','All'],['clean','Clean'],['flagged','Issue Found']],hold:[['all','All'],['clean','Clean'],['notify','Notify'],['notified','Notified']]}[type]||[['all','All']]
  const typeLabel={inbound:'Inbound',outbound:'Outbound',hold:'Inbound Hold'}[type]||type
  const colCount=(showFac?1:0)+(type==='inbound'?2:type==='hold'?1:0)+8

  return(
    <div style={{padding:0}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 20px',borderBottom:'1px solid var(--border)',flexWrap:'wrap',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:14,fontWeight:700,fontFamily:'var(--font-mono)'}}>{typeLabel} Records</span>
          <div style={{display:'flex',border:'1px solid var(--border)',borderRadius:7,overflow:'hidden'}}>
            {[['all','All','#374151'],['cal','Caledonia','#1d4ed8'],['ken','Kenosha','#15803d'],['mad','Madison','#7c3aed']].map(([id,label,color])=>(
              <button key={id} onClick={()=>{setFacility(id);setPage(1)}} style={{padding:'5px 14px',fontSize:12,fontWeight:600,cursor:'pointer',border:'none',background:facility===id?color:'transparent',color:facility===id?'var(--bg0)':'var(--text-secondary)',fontFamily:'var(--font-mono)',transition:'all .15s',borderRight:id!=='mad'?'1px solid var(--border)':'none'}}>
                {id!=='all'&&<span style={{width:6,height:6,borderRadius:'50%',background:facility===id?'var(--bg0)':color,display:'inline-block',marginRight:5}}/>}{label}
              </button>
            ))}
          </div>
          {loading
            ?<span style={{fontSize:11,padding:'2px 9px',borderRadius:20,fontWeight:600,background:'var(--bg3)',color:'var(--text-secondary)',fontFamily:'var(--font-mono)'}}>Loading…</span>
            :<span style={{fontSize:11,padding:'2px 9px',borderRadius:20,fontWeight:600,background:'var(--bg2)',color:'var(--text-secondary)',fontFamily:'var(--font-mono)'}}>{activeData.length} records</span>
          }
          <span style={{fontSize:10,color:'var(--text-secondary)'}}>live from SharePoint</span>
        </div>
      </div>
      <div style={{padding:20}}>
        {Object.entries(loadErrors).map(([fac,err])=>(<div key={fac} style={{background:'rgba(220,38,38,0.08)',border:'1px solid rgba(220,38,38,0.2)',borderRadius:8,padding:'10px 14px',marginBottom:10,fontSize:12,color:'var(--red)',fontFamily:'var(--font-mono)'}}>{fac.toUpperCase()}: {err}</div>))}
        <div style={{background:'var(--bg1)',border:'1px solid var(--border)',borderRadius:10,padding:'14px 16px',marginBottom:16}}>
          <div style={{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap'}}>
            <input type="text" placeholder="🔍  Search by customer, order #, employee, notes..." value={search} onChange={e=>{setSearch(e.target.value);setPage(1)}} style={{flex:1,minWidth:240,padding:'8px 12px',fontSize:13,border:'1px solid var(--border)',borderRadius:8,background:'var(--bg0)',color:'var(--text-primary)',fontFamily:'inherit',boxSizing:'border-box'}}/>
            {hasFilters&&<button onClick={()=>{setSearch('');setStatusFilter('all');setPage(1)}} style={{padding:'8px 12px',fontSize:12,border:'1px solid var(--border)',borderRadius:8,background:'var(--bg0)',color:'var(--text-secondary)',cursor:'pointer',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>Clear ×</button>}
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            <span style={{fontSize:11,color:'var(--text-secondary)',fontFamily:'var(--font-mono)'}}>STATUS:</span>
            {statusOptions.map(([val,label])=>(<button key={val} onClick={()=>{setStatusFilter(val);setPage(1)}} style={{padding:'4px 12px',fontSize:12,borderRadius:6,border:'1px solid var(--border)',background:statusFilter===val?'var(--text-primary)':'var(--bg0)',color:statusFilter===val?'var(--bg0)':'var(--text-secondary)',cursor:'pointer',fontFamily:'var(--font-mono)'}}>{label}</button>))}
            <span style={{fontSize:11,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',marginLeft:'auto'}}>{filtered.length} of {activeData.length}{hasFilters?' (filtered)':''}</span>
          </div>
        </div>
        <div style={{border:'1px solid var(--border)',borderRadius:10,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13,minWidth:900}}>
              <thead><tr>
                {showFac&&<th style={thBase}>Fac</th>}
                <SortTh label="Date" field="date" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                <th style={thBase}>Order #</th>
                <th style={thBase}>Customer</th>
                <th style={{...thBase,minWidth:160}}>Notes</th>
                <th style={thBase}>Problem</th>
                {type==='inbound'&&<th style={thBase}>Cust. Notified</th>}
                {type==='inbound'&&<th style={thBase}>Who Resolved?</th>}
                {type==='hold'&&<th style={thBase}>CSR Notified?</th>}
                <th style={thBase}>Photos</th>
                <SortTh label="Age" field="age" sortField={sortField} sortDir={sortDir} onSort={handleSort}/>
                <th style={thBase}>Status</th>
                <th style={thBase}>LP Link</th>
              </tr></thead>
              <tbody>
                {loading&&!paged.length?(<tr><td colSpan={colCount} style={{padding:40,textAlign:'center',color:'var(--text-secondary)',fontSize:13,fontFamily:'var(--font-mono)'}}>Loading from SharePoint…</td></tr>)
                :paged.length?paged.map((i,idx)=>(
                  <tr key={i.id} onClick={()=>setDetail({id:i.id,fac:i._fac})} style={{background:idx%2===0?'var(--bg0)':'var(--bg1)',cursor:'pointer'}}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--bg2)'}
                    onMouseLeave={e=>e.currentTarget.style.background=idx%2===0?'var(--bg0)':'var(--bg1)'}>
                    {showFac&&<td style={tdBase}><FacBadge fac={i._fac}/></td>}
                    <td style={{...tdBase,whiteSpace:'nowrap'}}>{fmtDate(i.date)}</td>
                    <td style={{...tdBase,fontFamily:'var(--font-mono)',fontSize:11}}>{i.orderNum||'—'}</td>
                    <td style={{...tdBase,maxWidth:140}}><div style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={i.customer}>{i.customer||'—'}</div></td>
                    <td style={{...tdBase,maxWidth:200,fontSize:12,color:'var(--text-secondary)'}}>{preview(i.notes||i.problem||'')}</td>
                    <td style={tdBase}><ProblemBadge problem={i.problem}/></td>
                    {type==='inbound'&&<td style={{...tdBase,fontSize:12,color:i.customerNotified?'var(--text-primary)':'var(--text-secondary)'}}>{i.customerNotified||<span style={{color:'rgba(220,38,38,0.8)',fontSize:11}}>Not sent</span>}</td>}
                    {type==='inbound'&&<td style={{...tdBase,fontSize:12}}>{i.whoResolved||'—'}</td>}
                    {type==='hold'&&<td style={{...tdBase,fontSize:12,color:i.csrNotified?'var(--text-primary)':'var(--text-secondary)'}}>{i.csrNotified||<span style={{color:'rgba(220,38,38,0.8)',fontSize:11}}>Not sent</span>}</td>}
                    <td style={{...tdBase,textAlign:'center',fontFamily:'var(--font-mono)'}}>{i.photos||'—'}</td>
                    <td style={{...tdBase,fontWeight:600,color:ageColor(i.date),fontFamily:'var(--font-mono)'}}>{ageInDays(i.date)}d</td>
                    <td style={tdBase}><StatusBadge status={i.status}/></td>
                    <td style={tdBase} onClick={e=>e.stopPropagation()}>
                      {i.loadproofUrl?<a href={i.loadproofUrl} target="_blank" rel="noreferrer" style={{fontSize:11,color:'var(--accent,#3b82f6)',textDecoration:'none',fontFamily:'var(--font-mono)'}}>View ↗</a>:<span style={{fontSize:11,color:'var(--text-dim,#aaa)',fontFamily:'var(--font-mono)'}}>—</span>}
                    </td>
                  </tr>
                )):(<tr><td colSpan={colCount} style={{padding:40,textAlign:'center',color:'var(--text-secondary)',fontSize:13}}>No records{hasFilters?' match':''} — <button onClick={()=>{setSearch('');setStatusFilter('all')}} style={{background:'none',border:'none',color:'var(--accent,#3b82f6)',cursor:'pointer',fontSize:13,fontFamily:'inherit'}}>clear filters</button></td></tr>)}
              </tbody>
            </table>
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px',borderTop:'1px solid var(--border)',fontSize:12,color:'var(--text-secondary)',fontFamily:'var(--font-mono)',background:'var(--bg1)'}}>
            <span>Showing {Math.min((safePg-1)*PAGE_SIZE+1,filtered.length)}–{Math.min(safePg*PAGE_SIZE,filtered.length)} of {filtered.length}</span>
            <div style={{display:'flex',gap:4}}>
              <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={safePg===1} style={{padding:'3px 9px',border:'1px solid var(--border)',borderRadius:5,background:'var(--bg0)',color:'var(--text-primary)',cursor:'pointer',fontSize:12,opacity:safePg===1?0.4:1}}>‹</button>
              {Array.from({length:Math.min(pages,8)},(_,i)=>i+1).map(p=>(<button key={p} onClick={()=>setPage(p)} style={{padding:'3px 9px',border:'1px solid var(--border)',borderRadius:5,background:p===safePg?'var(--text-primary)':'var(--bg0)',color:p===safePg?'var(--bg0)':'var(--text-primary)',cursor:'pointer',fontSize:12}}>{p}</button>))}
              <button onClick={()=>setPage(p=>Math.min(pages,p+1))} disabled={safePg===pages} style={{padding:'3px 9px',border:'1px solid var(--border)',borderRadius:5,background:'var(--bg0)',color:'var(--text-primary)',cursor:'pointer',fontSize:12,opacity:safePg===pages?0.4:1}}>›</button>
            </div>
          </div>
        </div>
      </div>
      {detailRecord&&<InboundDetailModal record={detailRecord} fac={detail.fac} tab={type} onClose={()=>setDetail(null)} onSave={handleSave}/>}
    </div>
  )
}
