import { BrowserRouter, Routes, Route } from 'react-router-dom'
import TopNav from './components/TopNav.jsx'
import LaborPlanning from './pages/LaborPlanning.jsx'
import OrderCreator from './pages/OrderCreator.jsx'
import Analytics from './pages/Analytics.jsx'
import Settings from './pages/Settings.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <TopNav />
        <Routes>
          <Route path="/"          element={<LaborPlanning />} />
          <Route path="/orders"    element={<OrderCreator />}  />
          <Route path="/analytics" element={<Analytics />}     />
          <Route path="/settings"  element={<Settings />}      />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
