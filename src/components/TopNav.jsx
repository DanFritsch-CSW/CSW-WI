import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { CSW_BEAR_LOGO } from '../lib/csw-logo.js'

const links = [
  { to: '/',                    label: 'Labor Planning'     },
  { to: '/inventory',           label: 'Inventory'          },
  { to: '/customers',           label: 'Customers'          },
  { to: '/employee-onboarding', label: 'Employee Onboarding'},
  { to: '/recruiting',          label: 'Recruiting'         },
  { to: '/manager',             label: 'Manager'            },
  { to: '/hr',                  label: 'HR'                 },
  // DVR Tracker suppressed — pending LoadProof Zapier API activation
  // Re-enable by adding: { to: '/dvr', label: 'DVR Tracker' }
  { to: '/settings',            label: 'Settings'           },
]

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(id)
  }, [])
  return now
}

function CswBearMark() {
  return (
    <img
      src={CSW_BEAR_LOGO}
      alt="Central Storage & Warehouse"
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
    />
  )
}

export default function TopNav() {
  const now = useClock()
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <>
      {/* Utility bar */}
      <div className="util-bar">
        <div className="util-bar-left">
          <span className="util-bar-item">
            <span className="icon">◆</span>
            CENTRAL STORAGE &amp; WAREHOUSE
          </span>
          <span className="util-bar-item">
            <span className="icon">▸</span>
            INTERNAL OPERATIONS PLATFORM
          </span>
        </div>
        <div className="util-bar-right">
          <span className="util-bar-item">5 WI FACILITIES</span>
          <span className="util-live">
            <span className="status-dot" />
            LIVE
          </span>
        </div>
      </div>

      {/* Main nav */}
      <nav className="top-nav">
        <div className="nav-brand">
          <div className="nav-logo-mark">
            <CswBearMark />
          </div>
          <div className="nav-brand-text">
            <span className="nav-brand-csw">CSW</span>
            <span className="nav-brand-sub">Ops Hub</span>
          </div>
        </div>

        <div className="nav-divider" />

        <div className="nav-links">
          {links.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {label}
            </NavLink>
          ))}
        </div>

        <div className="nav-meta">
          <div className="nav-date-time">
            <span className="nav-date">{dateStr}</span>
            <span className="nav-time">{timeStr}</span>
          </div>
        </div>
      </nav>
    </>
  )
}
