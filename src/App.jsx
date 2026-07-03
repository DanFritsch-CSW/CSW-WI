import { Component, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import TopNav from './components/TopNav.jsx'

// Build-time mode flag. Set via Netlify env var VITE_APP_MODE.
//   undefined / 'csw' → full CSW internal app (default)
//   'palermos'        → standalone Palermo's-only view (cswpvi.netlify.app)
// Read once at module load — Vite inlines this at build so switching modes
// requires a rebuild (which is exactly what Netlify triggers on push).
const APP_MODE = import.meta.env.VITE_APP_MODE || 'csw'

// Route-level code splitting — each page ships as its own chunk so the
// initial JS payload only contains the active route. Subsequent route
// visits fetch their chunk once and cache it for the session.
const LaborPlanning      = lazy(() => import('./pages/LaborPlanning.jsx'))
const InventoryReport    = lazy(() => import('./pages/InventoryReport.jsx'))
const Customers          = lazy(() => import('./pages/Customers.jsx'))
const OrderCreator       = lazy(() => import('./pages/OrderCreator.jsx'))
const Analytics          = lazy(() => import('./pages/Analytics.jsx'))
const Settings           = lazy(() => import('./pages/Settings.jsx'))
const PalermosStandalone = lazy(() => import('./pages/PalermosStandalone.jsx'))

function PageLoading() {
  return (
    <div className="page-content">
      <div className="stub-page" style={{ opacity: 0.6 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>Loading…</p>
      </div>
    </div>
  )
}

class PageErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      // Detect stale-chunk error — happens when Netlify deploys a new
      // build while a user has an old tab open and they click a route
      // they haven't visited yet (the old chunk URL no longer exists).
      const msg = this.state.error.message || ''
      const isChunkError = /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)
      return (
        <div className="page-content">
          <div className="stub-page">
            <h2>{isChunkError ? 'App was updated' : 'Something went wrong'}</h2>
            <p style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {isChunkError ? 'A new version was deployed. Reload to continue.' : msg}
            </p>
            <button
              style={{ marginTop: 12, padding: '6px 16px', borderRadius: 'var(--r-md)',
                background: 'var(--bg3)', border: '1px solid var(--border)',
                color: 'var(--text-secondary)', cursor: 'pointer' }}
              onClick={() => {
                if (isChunkError) {
                  window.location.reload()
                } else {
                  this.setState({ error: null })
                }
              }}
            >
              {isChunkError ? 'Reload' : 'Retry'}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  // Palermo's build: one route, catches everything (so any URL, including
  // random guesses like /labor-planning, lands on the standalone view — the
  // other page components aren't even imported in this build, so no code
  // leaks and there's nowhere for Palermo's users to escape to). No TopNav,
  // no app-shell wrapper — PalermosStandalone renders its own header.
  if (APP_MODE === 'palermos') {
    return (
      <BrowserRouter>
        <PageErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route path="*" element={<PalermosStandalone />} />
            </Routes>
          </Suspense>
        </PageErrorBoundary>
      </BrowserRouter>
    )
  }

  // Default CSW build: full app with all routes. Unchanged from before the
  // palermos-mode flag was introduced. PVI Shelf Life still lives inside
  // Customers > ?tab=pvi as it did — same component the palermos build
  // renders standalone.
  return (
    <BrowserRouter>
      <div className="app-shell">
        <TopNav />
        <PageErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route path="/"          element={<LaborPlanning />}    />
              <Route path="/inventory" element={<InventoryReport />}  />
              <Route path="/customers" element={<Customers />}        />
              <Route path="/orders"    element={<OrderCreator />}     />
              <Route path="/analytics" element={<Analytics />}        />
              <Route path="/settings"  element={<Settings />}         />
            </Routes>
          </Suspense>
        </PageErrorBoundary>
      </div>
    </BrowserRouter>
  )
}
