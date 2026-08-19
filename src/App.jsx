import { Component, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import TopNav from './components/TopNav.jsx'
import PalermosPasswordGate from './components/PalermosPasswordGate.jsx'
import ManagerPasswordGate from './components/ManagerPasswordGate.jsx'
import HrPasswordGate from './components/HrPasswordGate.jsx'

// Build-time mode flag. Set via Netlify env var VITE_APP_MODE.
//   undefined / 'csw' → full CSW internal app (default)
//   'palermos'        → standalone Palermo's-only view (cswpvi.netlify.app)
const APP_MODE = import.meta.env.VITE_APP_MODE || 'csw'

// Routes that render inside Front's own sidebar iframe rather than as a
// normal page in this app — TopNav (util bar + main nav links) doesn't
// belong there: it wastes vertical space Front only gives us a few hundred
// pixels of, and none of its links are relevant inside Front anyway.
// Added 2026-08-18 per Dan's request after seeing the plugin embedded live.
const NO_TOPNAV_ROUTES = ['/scheduling/plugin']

const LaborPlanning      = lazy(() => import('./pages/LaborPlanning.jsx'))
const InventoryReport    = lazy(() => import('./pages/InventoryReport.jsx'))
const Customers          = lazy(() => import('./pages/Customers.jsx'))
const EmployeeOnboarding = lazy(() => import('./pages/EmployeeOnboarding.jsx'))
const OrderCreator       = lazy(() => import('./pages/OrderCreator.jsx'))
const Analytics          = lazy(() => import('./pages/Analytics.jsx'))
const Settings           = lazy(() => import('./pages/Settings.jsx'))
const PalermosStandalone = lazy(() => import('./pages/PalermosStandalone.jsx'))
const DvrTracker         = lazy(() => import('./pages/DvrTracker.jsx'))
const Takt               = lazy(() => import('./pages/Takt.jsx'))
const Manager            = lazy(() => import('./pages/Manager.jsx'))
const Hr                 = lazy(() => import('./pages/Hr.jsx'))
const SchedulingTab      = lazy(() => import('./pages/SchedulingTab.jsx'))
const SchedulingDashboard = lazy(() => import('./pages/scheduling/SchedulingDashboard.jsx'))
const PluginView         = lazy(() => import('./pages/scheduling/PluginView.jsx'))

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

// Rendered inside <BrowserRouter> so it can call useLocation() to decide
// whether TopNav belongs on the current route (see NO_TOPNAV_ROUTES above).
function AppShell() {
  const location = useLocation()
  const showTopNav = !NO_TOPNAV_ROUTES.includes(location.pathname)

  return (
    <div className="app-shell">
      {showTopNav && <TopNav />}
      <PageErrorBoundary>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/"                    element={<LaborPlanning />}      />
            <Route path="/inventory"            element={<InventoryReport />}    />
            <Route path="/customers"            element={<Customers />}         />
            <Route path="/employee-onboarding"  element={<EmployeeOnboarding />} />
            <Route path="/orders"               element={<OrderCreator />}      />
            <Route path="/analytics"            element={<Analytics />}         />
            <Route path="/settings"             element={<Settings />}          />
            <Route path="/dvr"                  element={<DvrTracker />}        />
            <Route path="/takt"                 element={<Takt />}              />
            <Route path="/manager"              element={<ManagerPasswordGate><Manager /></ManagerPasswordGate>} />
            <Route path="/hr"                   element={<HrPasswordGate><Hr /></HrPasswordGate>} />
            <Route path="/scheduling"            element={<SchedulingTab />}     />
            <Route path="/scheduling/dashboard"  element={<SchedulingDashboard />} />
            <Route path="/scheduling/plugin"     element={<PluginView />}        />
          </Routes>
        </Suspense>
      </PageErrorBoundary>
    </div>
  )
}

export default function App() {
  if (APP_MODE === 'palermos') {
    return (
      <PalermosPasswordGate>
        <BrowserRouter>
          <PageErrorBoundary>
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="*" element={<PalermosStandalone />} />
              </Routes>
            </Suspense>
          </PageErrorBoundary>
        </BrowserRouter>
      </PalermosPasswordGate>
    )
  }

  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}
