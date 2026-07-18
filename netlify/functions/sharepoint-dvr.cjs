'use strict'

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET

const FACILITY_CONFIG = {
  mad: {
    shareUrl: 'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQAPASRQFjePQrRLN4AwInUiAer-IKqYNs0K8QDh33CXJa0',
    tabs: { dvrs:'Mad CSW INV CTRL -DVRS-', inbound:'Mad Inbound', outbound:'Mad Outbound', hold:'Mad Inbound Hold' },
    prefix: { dvrs:'MAD', inbound:'MAD-IN', outbound:'MAD-OUT', hold:'MAD-HLD' },
  },
  ken: {
    shareUrl: 'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBQP5TR7kMuQ5VxOHGS9_aqAbxgjdncbKna0Z_YxdLMHGI',
    tabs: { dvrs:'Ken CSW INV CTRL -DVRS', inbound:'Ken Inbound', outbound:'Ken Outbound', hold:'Ken Inbound Hold' },
    prefix: { dvrs:'KEN', inbound:'KEN-IN', outbound:'KEN-OUT', hold:'KEN-HLD' },
  },
  cal: {
    shareUrl: 'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBZx7jyJ1QoTogdo9k0MVgNAY3X7ovQjmyMssbvwbOYnlE',
    tabs: { dvrs:'Cal CSW INV CTRL -DVRS-', inbound:'Cal Inbound', outbound:'Cal Outbound', hold:'Cal Inbound Hold' },
    prefix: { dvrs:'DVR', inbound:'CAL-IN', outbound:'CAL-OUT', hold:'CAL-HLD' },
  },
}
// Bounded fallback — avoids usedRange timeouts from phantom formatting
const FALLBACK_RANGE = 'A1:CB500'

let _token=null, _tokenExpiry=0
async function getToken() {
  if(_token && Date.now()<_tokenExpiry) return _token
  const res=await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:CLIENT_ID,client_secret:CLIENT_SECRET,scope:'https://graph.microsoft.com/.default'}).toString()})
  const d=await res.json()
  if(!res.ok) throw new Error(`Auth failed: ${d.error_description||JSON.stringify(d)}`)
  _token=d.access_token; _tokenExpiry=Date.now()+(d.expires_in-120)*1000; return _token
}
async function graph(path,token,method='GET',body=null) {
  const res=await fetch(`https://graph.microsoft.com/v1.0${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})}, ...(body?{body:JSON.stringify(body)}:{})})
  if(res.status===204) return null
  const text=await res.text()
  if(!res.ok) throw new Error(`Graph ${method} ${path} -> ${res.status}: ${text}`)
  return JSON.parse(text)
}
const _driveCache={}
async function getDriveRef(facility,token) {
  if(_driveCache[facility]) return _driveCache[facility]
  const {shareUrl}=FACILITY_CONFIG[facility]
  const encoded=Buffer.from(shareUrl).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
  const item=await graph(`/shares/u!${encoded}/driveItem`,token)
  _driveCache[facility]={driveId:item.parentReference.driveId,itemId:item.id}
  return _driveCache[facility]
}
async function fetchSheetValues(sheetBase,token) {
  // Try usedRange first; fall back to bounded range on ANY error
  // (catches RangeExceedsLimit, 504 MaxRequestDurationExceeded, phantom-format timeouts)
  try {
    const r=await graph(`${sheetBase}/usedRange`,token)
    if(r.values&&r.values.length>0) return r.values
  } catch(err) {
    // Fall through on ANY error - usedRange is an optimisation only
    console.warn(`[fetchSheetValues] usedRange failed, using bounded fallback: ${err.message.slice(0,80)}`)
  }
  const r=await graph(`${sheetBase}/range(address='${FALLBACK_RANGE}')`,token)
  const vals=r.values||[]; let last=vals.length-1
  while(last>0&&vals[last].every(v=>v===null||v===''||v===0)) last--
  return vals.slice(0,last+1)
}
function parseDate(v) {
  if(v==null||v==='') return ''
  if(typeof v==='number') return new Date((v-25569)*86400*1000).toISOString().slice(0,10)
  const s=String(v).trim(); if(!s) return ''
  try{const d=new Date(s);return isNaN(d.getTime())?'':d.toISOString().slice(0,10)}catch{return ''}
}
function str(v){if(v==null)return '';const s=String(v).trim();return['null','nan','none','n/a'].includes(s.toLowerCase())?'':s}
function colLetter(idx){let r='',n=idx+1;while(n>0){n--;r=String.fromCharCode(65+(n%26))+r;n=Math.floor(n/26)}return r}
function buildColMap(headerRow) {
  const col={}
  headerRow.forEach((h,i)=>{col[String(h).trim().toLowerCase()]=i})
  return {find(...terms){for(const t of terms){if(col[t.toLowerCase()]!==undefined)return col[t.toLowerCase()];const k=Object.keys(col).find(k=>k.includes(t.toLowerCase()));if(k!==undefined)return col[k]}return -1}}
}
function linkVal(raw) {
  const s=str(raw)
  return (s&&s.toLowerCase()!=='load link'&&s.toLowerCase()!=='load url') ? s : ''
}

// DVRS parser
function parseDvrs(headerRow,dataRows,prefix) {
  const c=buildColMap(headerRow)
  const i_date=c.find('filter by this date'),i_order=c.find('csw inv ctrl - order #','csw inv ctrl - order','order')
  const i_customer=c.find('customer caledonia','customer kenosha','customer madison','customer','csw inv ctrl - customer')
  const i_type=c.find('csw inv ctrl - shipment type','shipment type'),i_reason=c.find('csw inv ctrl - reason','reason')
  const i_emp=c.find('csw inv ctrl - employee','employee'),i_respParty=c.find('csw inv ctrl - responsible party','responsible party')
  const i_cases=c.find('csw inv ctrl - # of cases','# of cases'),i_lot=c.find('csw inv ctrl - lot #','lot #')
  const i_mat=c.find('csw inv ctrl - material #','material #'),i_lp=c.find('csw inv ctrl - license plate','license plate')
  const i_notes=c.find('csw inv ctrl - notes','notes'),i_invNotes=c.find('investigation notes')
  const i_adjDate=c.find('date adjustment completed'),i_adjBy=c.find('adjustment completed by')
  const i_adjNotes=c.find('adjustment/resolved notes','adjustment notes')
  const i_coachReq=c.find('coaching required?','coaching required'),i_coachDate=c.find('date coaching completed')
  const i_coachBy=c.find('coaching completed by'),i_coachNotes=c.find('coaching notes')
  const i_empResp=c.find('employee who caused','employee responsible'),i_link=c.find('link to load proof','load proof url')
  const i_category=c.find('category'),i_photos=c.find('photos'),i_videos=c.find('videos'),i_uploadBy=c.find('uploaded by')
  const TYPE_NORM={'inbound':'Inbound','outbound':'Outbound','warehouse ops damage':'Warehouse Ops Damage','warehouse ops damage ':'Warehouse Ops Damage','disposal':'Disposal','transfer':'Transfer','dsd':'DSD','cycle count':'Cycle Count'}
  const incidents=[];let counter=1
  for(let i=0;i<dataRows.length;i++){
    const row=dataRows[i],rowIndex=i+2
    const incDate=parseDate(i_date>=0?row[i_date]:null);if(!incDate){counter++;continue}
    const adjBy=str(i_adjBy>=0?row[i_adjBy]:''),adjDate=parseDate(i_adjDate>=0?row[i_adjDate]:null),adjOpen=!adjBy
    const coachRaw=str(i_coachReq>=0?row[i_coachReq]:'').toLowerCase()
    const coaching=coachRaw==='yes'?'Yes':coachRaw==='no'?'No':''
    const coachDate=parseDate(i_coachDate>=0?row[i_coachDate]:null),coachingOpen=coaching==='Yes'&&!coachDate
    const invNotes=str(i_invNotes>=0?row[i_invNotes]:''),invOpen=!invNotes
    if(!adjOpen&&!coachingOpen&&!invOpen){counter++;continue}
    const typeRaw=str(i_type>=0?row[i_type]:'').trim(),reasonRaw=str(i_reason>=0?row[i_reason]:'')
    incidents.push({
      id:`${prefix}-${String(counter).padStart(4,'0')}`,rowIndex,date:incDate,
      orderNum:str(i_order>=0?row[i_order]:''),customer:str(i_customer>=0?row[i_customer]:''),
      employee:str(i_emp>=0?row[i_emp]:''),responsibleParty:str(i_respParty>=0?row[i_respParty]:''),
      incidentType:TYPE_NORM[typeRaw.toLowerCase()]||typeRaw,
      reason:reasonRaw.charAt(0).toUpperCase()+reasonRaw.slice(1),damageType:'',
      cases:Number(i_cases>=0?row[i_cases]:0)||0,lotNum:str(i_lot>=0?row[i_lot]:''),
      materialNum:str(i_mat>=0?row[i_mat]:''),licensePlate:str(i_lp>=0?row[i_lp]:''),
      incidentNotes:str(i_notes>=0?row[i_notes]:''),investigationNotes:invNotes,
      adjDate:adjDate||'',adjBy,adjNotes:str(i_adjNotes>=0?row[i_adjNotes]:''),adjOpen,
      coachingRequired:coaching,employeeResponsible:str(i_empResp>=0?row[i_empResp]:''),
      coachingDate:coachDate||'',coachingBy:str(i_coachBy>=0?row[i_coachBy]:''),
      coachingNotes:str(i_coachNotes>=0?row[i_coachNotes]:''),coachingOpen,invOpen,
      loadproofUrl:linkVal(i_link>=0?row[i_link]:''),
      category:str(i_category>=0?row[i_category]:''),
      photos:Number(i_photos>=0?row[i_photos]:0)||0,videos:Number(i_videos>=0?row[i_videos]:0)||0,
      uploadedBy:str(i_uploadBy>=0?row[i_uploadBy]:''),
      _colMap:{
        adjDate:i_adjDate>=0?colLetter(i_adjDate):null,adjBy:i_adjBy>=0?colLetter(i_adjBy):null,
        adjNotes:i_adjNotes>=0?colLetter(i_adjNotes):null,coachingRequired:i_coachReq>=0?colLetter(i_coachReq):null,
        employeeResponsible:i_empResp>=0?colLetter(i_empResp):null,coachingDate:i_coachDate>=0?colLetter(i_coachDate):null,
        coachingBy:i_coachBy>=0?colLetter(i_coachBy):null,coachingNotes:i_coachNotes>=0?colLetter(i_coachNotes):null,
        investigationNotes:i_invNotes>=0?colLetter(i_invNotes):null,
        loadproofUrl:i_link>=0?colLetter(i_link):null,
      },
    });counter++
  }
  return incidents
}

// Inbound parser
function parseInbound(headerRow,dataRows,prefix) {
  const c=buildColMap(headerRow)
  const i_date=c.find('filter by this date'),i_lpDate=c.find('date')
  const i_order=c.find('order number','order'),i_notes=c.find('notes'),i_problem=c.find('problem')
  const i_custNotified=c.find('customer notified')
  const i_employee=c.find('employee name submitting','employee')
  const i_customer=c.find('customers madison','customers caledonia','customers kenosha','customer madison','customer caledonia','customer kenosha','customer')
  const i_adjReq=c.find('adjustment required','madison adjustment','caledonia adjustment','kenosha adjustment')
  const i_lp=c.find('license plate'),i_category=c.find('category')
  const i_photos=c.find('photos','picture count'),i_link=c.find('link to load proof')
  const i_uploadedBy=c.find('uploaded by'),i_whoResolved=c.find('who resolved')
  const records=[]
  for(let i=0;i<dataRows.length;i++){
    const row=dataRows[i],rowIndex=i+2
    const incDate=parseDate(i_date>=0?row[i_date]:null);if(!incDate) continue
    const problem=str(i_problem>=0?row[i_problem]:''),custNotified=str(i_custNotified>=0?row[i_custNotified]:'')
    const whoResolved=str(i_whoResolved>=0?row[i_whoResolved]:'')
    const hasProblem=problem.toLowerCase().startsWith('yes')
    let status='clean'
    if(hasProblem){if(!custNotified)status='notify';else if(!whoResolved)status='pending';else status='resolved'}
    records.push({
      id:`${prefix}-${String(i+1).padStart(4,'0')}`,rowIndex,date:incDate,
      loadproofDate:str(i_lpDate>=0?row[i_lpDate]:''),orderNum:str(i_order>=0?row[i_order]:''),
      notes:str(i_notes>=0?row[i_notes]:''),problem,hasProblem,customerNotified:custNotified,
      employee:str(i_employee>=0?row[i_employee]:''),customer:str(i_customer>=0?row[i_customer]:''),
      adjRequired:str(i_adjReq>=0?row[i_adjReq]:''),licensePlate:str(i_lp>=0?row[i_lp]:''),
      category:str(i_category>=0?row[i_category]:''),photos:Number(i_photos>=0?row[i_photos]:0)||0,
      loadproofUrl:linkVal(i_link>=0?row[i_link]:''),uploadedBy:str(i_uploadedBy>=0?row[i_uploadedBy]:''),
      whoResolved,status,
      _colMap:{customerNotified:i_custNotified>=0?colLetter(i_custNotified):null,whoResolved:i_whoResolved>=0?colLetter(i_whoResolved):null,loadproofUrl:i_link>=0?colLetter(i_link):null}
    })
  }
  return records
}

// Outbound parser
function parseOutbound(headerRow,dataRows,prefix) {
  const c=buildColMap(headerRow)
  const i_date=c.find('filter by this date'),i_lpDate=c.find('date')
  const i_order=c.find('order number','order')
  const i_customer=c.find('customer madison','customer caledonia','customer kenosha','customer')
  const i_notes=c.find('notes'),i_problem=c.find('problem')
  const i_employee=c.find('employee name submitting','employee'),i_category=c.find('category')
  const i_photos=c.find('photos','picture count'),i_videos=c.find('videos','video count')
  const i_link=c.find('link to load proof'),i_uploadedBy=c.find('uploaded by'),i_remarks=c.find('load remarks')
  const records=[]
  for(let i=0;i<dataRows.length;i++){
    const row=dataRows[i],rowIndex=i+2
    const incDate=parseDate(i_date>=0?row[i_date]:null);if(!incDate) continue
    const problem=str(i_problem>=0?row[i_problem]:''),hasProblem=problem.toLowerCase().startsWith('yes')
    records.push({
      id:`${prefix}-${String(i+1).padStart(4,'0')}`,rowIndex,date:incDate,
      loadproofDate:str(i_lpDate>=0?row[i_lpDate]:''),orderNum:str(i_order>=0?row[i_order]:''),
      customer:str(i_customer>=0?row[i_customer]:''),notes:str(i_notes>=0?row[i_notes]:''),
      problem,hasProblem,employee:str(i_employee>=0?row[i_employee]:''),
      category:str(i_category>=0?row[i_category]:''),
      photos:Number(i_photos>=0?row[i_photos]:0)||0,videos:Number(i_videos>=0?row[i_videos]:0)||0,
      loadproofUrl:linkVal(i_link>=0?row[i_link]:''),uploadedBy:str(i_uploadedBy>=0?row[i_uploadedBy]:''),
      remarks:str(i_remarks>=0?row[i_remarks]:''),status:hasProblem?'flagged':'clean',
      _colMap:{loadproofUrl:i_link>=0?colLetter(i_link):null}
    })
  }
  return records
}

// Hold parser
function parseHold(headerRow,dataRows,prefix) {
  const c=buildColMap(headerRow)
  const i_date=c.find('filter by this date'),i_lpDate=c.find('date')
  const i_order=c.find('order number','order'),i_notes=c.find('notes'),i_problem=c.find('problem')
  const i_csrNotified=c.find('csr > customer notified','csr','customer notified')
  const i_employee=c.find('employee name submitting','employee')
  const i_customer=c.find('customers madison','customers caledonia','customers kenosha','customer')
  const i_category=c.find('category')
  const i_photos=c.find('photos','picture count'),i_videos=c.find('videos','video count')
  const i_link=c.find('link to load proof'),i_uploadedBy=c.find('uploaded by'),i_remarks=c.find('load remarks')
  const records=[]
  for(let i=0;i<dataRows.length;i++){
    const row=dataRows[i],rowIndex=i+2
    const incDate=parseDate(i_date>=0?row[i_date]:null);if(!incDate) continue
    const problem=str(i_problem>=0?row[i_problem]:''),hasProblem=problem.toLowerCase().startsWith('yes')
    const csrNotified=str(i_csrNotified>=0?row[i_csrNotified]:'')
    let status='clean'
    if(hasProblem) status=csrNotified?'notified':'notify'
    records.push({
      id:`${prefix}-${String(i+1).padStart(4,'0')}`,rowIndex,date:incDate,
      loadproofDate:str(i_lpDate>=0?row[i_lpDate]:''),orderNum:str(i_order>=0?row[i_order]:''),
      notes:str(i_notes>=0?row[i_notes]:''),problem,hasProblem,csrNotified,
      employee:str(i_employee>=0?row[i_employee]:''),customer:str(i_customer>=0?row[i_customer]:''),
      category:str(i_category>=0?row[i_category]:''),
      photos:Number(i_photos>=0?row[i_photos]:0)||0,videos:Number(i_videos>=0?row[i_videos]:0)||0,
      loadproofUrl:linkVal(i_link>=0?row[i_link]:''),uploadedBy:str(i_uploadedBy>=0?row[i_uploadedBy]:''),
      remarks:str(i_remarks>=0?row[i_remarks]:''),status,
      _colMap:{csrNotified:i_csrNotified>=0?colLetter(i_csrNotified):null,loadproofUrl:i_link>=0?colLetter(i_link):null}
    })
  }
  return records
}

exports.handler=async function(event){
  const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Content-Type':'application/json'}
  if(event.httpMethod==='OPTIONS') return{statusCode:200,headers:cors,body:''}
  if(!TENANT_ID||!CLIENT_ID||!CLIENT_SECRET) return{statusCode:503,headers:cors,body:JSON.stringify({error:'SharePoint env vars not set'})}
  const params=event.queryStringParameters||{}
  const facility=(params.facility||'mad').toLowerCase()
  const tab=(params.tab||'dvrs').toLowerCase()
  const config=FACILITY_CONFIG[facility]
  if(!config) return{statusCode:400,headers:cors,body:JSON.stringify({error:`Unknown facility: ${facility}`})}
  const sheetName=config.tabs[tab]
  if(!sheetName) return{statusCode:400,headers:cors,body:JSON.stringify({error:`Unknown tab: ${tab}. Use dvrs, inbound, outbound, or hold`})}
  const prefix=config.prefix[tab]||'REC'
  try{
    const token=await getToken()
    const{driveId,itemId}=await getDriveRef(facility,token)
    const sheetBase=`/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(sheetName)}`
    if(event.httpMethod==='POST'){
      const{rowIndex,updates,colMap}=JSON.parse(event.body||'{}')
      if(!rowIndex||!updates||!colMap) return{statusCode:400,headers:cors,body:JSON.stringify({error:'rowIndex, updates, colMap required'})}
      await Promise.all(Object.entries(updates).filter(([f])=>colMap[f]).map(([f,v])=>graph(`${sheetBase}/range(address='${colMap[f]}${rowIndex}')`,token,'PATCH',{values:[[v||'']]})))
      return{statusCode:200,headers:cors,body:JSON.stringify({success:true,updated:Object.keys(updates),rowIndex})}
    }
    const values=await fetchSheetValues(sheetBase,token)
    if(!values||values.length<2) return{statusCode:200,headers:cors,body:JSON.stringify({records:[],incidents:[],count:0,facility,tab})}
    const[headerRow,...dataRows]=values
    let records
    if(tab==='dvrs') records=parseDvrs(headerRow,dataRows,prefix)
    else if(tab==='inbound') records=parseInbound(headerRow,dataRows,prefix)
    else if(tab==='outbound') records=parseOutbound(headerRow,dataRows,prefix)
    else records=parseHold(headerRow,dataRows,prefix)
    return{statusCode:200,headers:cors,body:JSON.stringify({records,incidents:records,count:records.length,facility,tab})}
  }catch(err){
    console.error(`[sharepoint-dvr][${facility}][${tab}]`,err.message)
    return{statusCode:500,headers:cors,body:JSON.stringify({error:err.message,facility,tab})}
  }
}
