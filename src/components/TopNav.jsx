import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'

const links = [
  { to: '/',          label: 'Labor Planning' },
  { to: '/inventory', label: 'Inventory'      },
  { to: '/customers', label: 'Customers'      },
  { to: '/settings',  label: 'Settings'       },
]

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(id)
  }, [])
  return now
}

// Heron silhouette — matches CSW's bird logo concept
function HeronMark() {
  return (
    <svg viewBox="0 0 22 22" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M11 2C9.5 2 8.2 2.8 7.5 4L6 4.5C5.2 4.8 4.5 5.5 4.2 6.4L3 10l2 .5 1-3 1.5-.5C8 8.5 8.5 9.8 9 11l-3 6h2.5l2-4 .5 1v3h2v-3.5L14.5 11c.5-1.2 1-2.5 1.5-3.5l1.5.5 1 3 2-.5-1.2-3.6C19 6.5 18.3 5.8 17.5 5.5L16 5C15.3 3 13.3 2 11 2z"/>
    </svg>
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
            <HeronMark />
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
