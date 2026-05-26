import { Component } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import TopNav from './components/TopNav.jsx'
import LaborPlanning from './pages/LaborPlanning.jsx'
import InventoryReport from './pages/InventoryReport.jsx'
import OrderCreator from './pages/OrderCreator.jsx'
import Analytics from './pages/Analytics.jsx'
import Settings from './pages/Settings.jsx'

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
      return (
        <div className="page-content">
          <div className="stub-page">
            <h2>Something went wrong</h2>
            <p style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {this.state.error.message}
            </p>
            <button
              style={{ marginTop: 12, padding: '6px 16px', borderRadius: 'var(--r-md)',
                background: 'var(--bg3)', border: '1px solid var(--border)',
                color: 'var(--text-secondary)', cursor: 'pointer' }}
              onClick={() => this.setState({ error: null })}
            >
              Retry
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <TopNav />
        <PageErrorBoundary>
          <Routes>
            <Route path="/"          element={<LaborPlanning />}    />
            <Route path="/inventory" element={<InventoryReport />}  />
            <Route path="/orders"    element={<OrderCreator />}     />
            <Route path="/analytics" element={<Analytics />}        />
            <Route path="/settings"  element={<Settings />}         />
          </Routes>
        </PageErrorBoundary>
      </div>
    </BrowserRouter>
  )
}
