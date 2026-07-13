import { useState } from 'react'
import DvrTracker from '../../pages/DvrTracker.jsx'
import LoadProofInboundTracker from './LoadProofInboundTracker.jsx'

const TABS = [
  { id: 'dvrs',     label: 'DVRS',         color: '#dc2626' },
  { id: 'inbound',  label: 'Inbound',      color: '#1d4ed8' },
  { id: 'outbound', label: 'Outbound',     color: '#15803d' },
  { id: 'hold',     label: 'Inbound Hold', color: '#d97706' },
]

export default function DvrTab() {
  const [type, setType] = useState('dvrs')
  return (
    <div style={{ margin: '-24px' }}>
      <div style={{ display:'flex', gap:4, padding:'10px 20px 10px', borderBottom:'1px solid var(--border)', background:'var(--bg1)', alignItems:'center' }}>
        <span style={{ fontSize:11, fontWeight:600, color:'var(--text-secondary)', fontFamily:'var(--font-mono)', marginRight:8 }}>TAB:</span>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setType(tab.id)} style={{ padding:'5px 16px', fontSize:12, fontWeight:600, cursor:'pointer', border:'1px solid var(--border)', borderRadius:6, background: type===tab.id ? tab.color : 'var(--bg0)', color: type===tab.id ? '#fff' : 'var(--text-secondary)', fontFamily:'var(--font-mono)', transition:'all .15s' }}>
            {tab.label}
          </button>
        ))}
      </div>
      {type === 'dvrs' ? <DvrTracker /> : <LoadProofInboundTracker key={type} type={type} />}
    </div>
  )
}
