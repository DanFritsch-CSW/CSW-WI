'use strict'

const TENANT_ID      = process.env.SHAREPOINT_TENANT_ID
const CLIENT_ID      = process.env.SHAREPOINT_CLIENT_ID
const CLIENT_SECRET  = process.env.SHAREPOINT_CLIENT_SECRET
const WEBHOOK_SECRET = process.env.SHAREPOINT_WEBHOOK_SECRET
const FRONT_API_KEY  = process.env.FRONT_API_KEY

const NOTIFY_CONVERSATION = 'cnv_1bwzzexg'

const FAC_LABEL = { mad: 'Madison', ken: 'Kenosha', cal: 'Caledonia' }
const TAB_LABEL = { dvrs: 'DVRS', inbound: 'Inbound', outbound: 'Outbound', hold: 'Inbound Hold' }

const FACILITY_CONFIG = {
  mad: {
    shareUrl: 'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQAPASRQFjePQrRLN4AwInUiAer-IKqYNs0K8QDh33CXJa0',
    tabs: { dvrs:'Mad CSW INV CTRL -DVRS-', inbound:'Mad Inbound', outbound:'Mad Outbound', hold:'Mad Inbound Hold' },
  },
  ken: {
    shareUrl: 'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBQP5TR7kMuQ5VxOHGS9_aqAbxgjdncbKna0Z_YxdLMHGI',
    tabs: { dvrs:'Ken CSW INV CTRL -DVRS', inbound:'Ken Inbound', outbound:'Ken Outbound', hold:'Ken Inbound Hold' },
  },
  cal: {
    shareUrl: 'https://centralstoragewarehouse.sharepoint.com/:x:/s/Employee/IQBZx7jyJ1QoTogdo9k0MVgNAY3X7ovQjmyMssbvwbOYnlE',
    tabs: { dvrs:'Cal CSW INV CTRL -DVRS-', inbound:'Cal Inbound', outbound:'Cal Outbound', hold:'Cal Inbound Hold' },
  },
}

let _token=null,_tokenExpiry=0
async function getToken(){
  if(_token&&Date.now()<_tokenExpiry)return _token
  const res=await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:CLIENT_ID,client_secret:CLIENT_SECRET,scope:'https://graph.microsoft.com/.default'}).toString()})
  const d=await res.json()
  if(!res.ok)throw new Error(`Auth failed: ${d.error_description||JSON.stringify(d)}`)
  _token=d.access_token;_tokenExpiry=Date.now()+(d.expires_in-120)*1000;return _token
}
async function graph(path,token,method='GET',body=null){
  const res=await fetch(`https://graph.microsoft.com/v1.0${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})}, ...(body?{body:JSON.stringify(body)}:{})})
  if(res.status===204)return null
  const text=await res.text()
  if(!res.ok)throw new Error(`Graph ${method} ${path} -> ${res.status}: ${text}`)
  return JSON.parse(text)
}
const _driveCache={}
async function getDriveRef(facility,token){
  if(_driveCache[facility])return _driveCache[facility]
  const{shareUrl}=FACILITY_CONFIG[facility]
  const encoded=Buffer.from(shareUrl).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
  const item=await graph(`/shares/u!${encoded}/driveItem`,token)
  _driveCache[facility]={driveId:item.parentReference.driveId,itemId:item.id}
  return _driveCache[facility]
}

// Read the entire column A in one call and scan forward for last non-empty row.
// One column is fast regardless of row count (no wide data, just date values).
// This correctly handles both large files (CAL 15k rows) and sheets with large
// phantom-formatted empty regions (KEN DVRS: usedRange=18k, real data ends at ~2.4k).
async function findLastDataRow(sheetBase, token) {
  let endRow = 1000
  try {
    const ur = await graph(`${sheetBase}/usedRange(valuesOnly=true)?$select=rowCount`, token)
    if (ur && ur.rowCount > 0) endRow = ur.rowCount
  } catch(e) {
    console.warn('[append] usedRange failed:', e.message)
  }

  // Single API call: read all of column A from row 1 to endRow
  const r = await graph(`${sheetBase}/range(address='A1:A${endRow}')`, token)
  const vals = r.values || []

  // Scan forward, tracking the last row that has actual data
  // Skip row 0 (header) — start from i=1
  let lastRow = 1
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i][0]
    if (v !== null && v !== '' && v !== 0 && v !== false) {
      lastRow = i + 1  // 1-indexed
    }
  }

  console.log(`[append] usedRange=${endRow} lastDataRow=${lastRow}`)
  return lastRow
}

function colLetter(idx){let r='',n=idx+1;while(n>0){n--;r=String.fromCharCode(65+(n%26))+r;n=Math.floor(n/26)}return r}
function buildColMap(headerRow){
  const col={}
  headerRow.forEach((h,i)=>{col[String(h).trim().toLowerCase()]=i})
  return{find(...terms){for(const t of terms){if(col[t.toLowerCase()]!==undefined)return col[t.toLowerCase()];const k=Object.keys(col).find(k=>k.includes(t.toLowerCase()));if(k!==undefined)return col[k]}return -1}}
}
function toExcelDate(raw){
  if(!raw)return new Date().toLocaleDateString('en-US')
  try{const d=new Date(raw);if(!isNaN(d.getTime()))return d.toLocaleDateString('en-US')}catch{}
  return raw
}
function str(v){return v!=null?String(v).trim():''}

function getCategoryTab(category){
  const cat=(category||'').toLowerCase()
  if(cat.includes('dvrs')||cat.includes('inv ctrl'))return'dvrs'
  if(cat.includes('outbound'))return'outbound'
  if(cat.includes('hold'))return'hold'
  return'inbound'
}

async function notifyFront(facility, tabKey, payload, rowNum){
  if(!FRONT_API_KEY) return
  try{
    const facLabel = FAC_LABEL[facility] || facility.toUpperCase()
    const tabLabel = TAB_LABEL[tabKey] || tabKey
    const lines = [
      `New LoadProof Entry - ${facLabel} / ${tabLabel} (row ${rowNum})`,
      `Customer: ${str(payload.customer)||'-'}`,
      `Employee: ${str(payload.employee)||'-'}`,
      `Type: ${str(payload.incidentType)||str(payload.category)||'-'} | Reason: ${str(payload.reason)||'-'}`,
    ]
    if(str(payload.loadproofUrl)) lines.push(`LP Link: ${str(payload.loadproofUrl)}`)
    if(str(payload.orderNum))     lines.push(`Order: ${str(payload.orderNum)}`)
    await fetch(`https://api2.frontapp.com/conversations/${NOTIFY_CONVERSATION}/comments`,{
      method:'POST',
      headers:{Authorization:`Bearer ${FRONT_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({author_id:'default',body:lines.join('\n')}),
    })
  }catch(e){
    console.warn(`[loadproof-notify] Front comment failed:`,e.message)
  }
}

exports.handler=async function(event){
  const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json'}
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:cors,body:''}
  if(event.httpMethod!=='POST')return{statusCode:405,headers:cors,body:JSON.stringify({error:'POST only'})}
  if(!TENANT_ID||!CLIENT_ID||!CLIENT_SECRET)return{statusCode:503,headers:cors,body:JSON.stringify({error:'SharePoint env vars not set'})}
  let payload
  try{payload=JSON.parse(event.body||'{}')}catch{return{statusCode:400,headers:cors,body:JSON.stringify({error:'Invalid JSON'})}}
  if(WEBHOOK_SECRET&&payload.secret!==WEBHOOK_SECRET)return{statusCode:401,headers:cors,body:JSON.stringify({error:'Invalid secret'})}
  const facility=((event.queryStringParameters||{}).facility||'mad').toLowerCase()
  const config=FACILITY_CONFIG[facility]
  if(!config)return{statusCode:400,headers:cors,body:JSON.stringify({error:`Unknown facility: ${facility}`})}
  const tabKey=getCategoryTab(payload.category||payload.incidentType||'')
  const sheetName=config.tabs[tabKey]
  try{
    const token=await getToken()
    const{driveId,itemId}=await getDriveRef(facility,token)
    const sheetBase=`/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(sheetName)}`
    const headerRange=await graph(`${sheetBase}/range(address='1:1')`,token)
    const headerRow=headerRange.values?.[0]||[]
    const c=buildColMap(headerRow)
    const totalCols=headerRow.length
    const row=new Array(totalCols).fill('')
    const set=(idx,val)=>{if(idx>=0&&idx<totalCols&&val!==''&&val!=null)row[idx]=val}
    const dateStr=toExcelDate(payload.date)
    if(tabKey==='dvrs'){
      set(c.find('filter by this date'),dateStr)
      set(c.find('loadproof date'),str(payload.date))
      set(c.find('csw inv ctrl - shipment type','shipment type'),str(payload.incidentType))
      set(c.find('csw inv ctrl - responsible party','responsible party'),str(payload.responsibleParty))
      set(c.find('csw inv ctrl - lot #','lot #'),str(payload.lotNum))
      set(c.find('csw inv ctrl - material #','material #'),str(payload.materialNum))
      set(c.find('csw inv ctrl - reason','reason'),str(payload.reason))
      set(c.find('csw inv ctrl - license plate','license plate'),str(payload.licensePlate))
      set(c.find('csw inv ctrl - # of cases','# of cases'),payload.cases!=null?Number(payload.cases)||'':'')
      set(c.find('csw inv ctrl - notes','notes'),str(payload.incidentNotes))
      set(c.find('csw inv ctrl - order #','csw inv ctrl - order','order'),str(payload.orderNum))
      set(c.find('csw inv ctrl - employee','employee'),str(payload.employee))
      set(c.find('customer madison','customer caledonia','customer kenosha','customer'),str(payload.customer))
      set(c.find('category'),str(payload.category))
      set(c.find('photos'),payload.photos!=null?Number(payload.photos)||'':'')
      set(c.find('videos'),payload.videos!=null?Number(payload.videos)||'':'')
      set(c.find('link to load proof','load proof url','loadproof'),str(payload.loadproofUrl))
      set(c.find('uploaded by'),str(payload.uploadedBy))
    } else {
      set(c.find('filter by this date'),dateStr)
      set(c.find('date'),str(payload.date))
      set(c.find('order number','order'),str(payload.orderNum))
      set(c.find('notes'),str(payload.incidentNotes||payload.notes))
      set(c.find('problem'),str(payload.reason||payload.problem))
      set(c.find('employee name submitting','employee'),str(payload.employee))
      set(c.find('customers madison','customers caledonia','customers kenosha','customer madison','customer caledonia','customer kenosha','customer'),str(payload.customer))
      set(c.find('license plate'),str(payload.licensePlate))
      set(c.find('category'),str(payload.category))
      set(c.find('photos','picture count'),payload.photos!=null?Number(payload.photos)||'':'')
      set(c.find('videos','video count'),payload.videos!=null?Number(payload.videos)||'':'')
      set(c.find('link to load proof','load proof url','loadproof'),str(payload.loadproofUrl))
      set(c.find('uploaded by'),str(payload.uploadedBy))
      if(tabKey==='inbound'){
        set(c.find('adjustment required','madison adjustment','caledonia adjustment','kenosha adjustment'),str(payload.adjRequired))
      }
    }
    const lastRow=await findLastDataRow(sheetBase,token)
    const nextRow=lastRow+1
    const endCol=colLetter(totalCols-1)
    await graph(`${sheetBase}/range(address='A${nextRow}:${endCol}${nextRow}')`,token,'PATCH',{values:[row]})
    console.log(`[sharepoint-dvr-append][${facility}][${tabKey}] Appended row ${nextRow}`)
    notifyFront(facility,tabKey,payload,nextRow)
    return{statusCode:200,headers:cors,body:JSON.stringify({success:true,facility,tab:tabKey,row:nextRow})}
  }catch(err){
    console.error(`[sharepoint-dvr-append][${facility}][${tabKey}]`,err.message)
    return{statusCode:500,headers:cors,body:JSON.stringify({error:err.message,facility,tab:tabKey})}
  }
}
