import DvrTracker from '../../pages/DvrTracker.jsx'

// Thin wrapper — breaks out of the Customers tab 24px padding
// so DvrTracker renders full-width with its own topbar and layout.
export default function DvrTab() {
  return (
    <div style={{ margin: '-24px' }}>
      <DvrTracker />
    </div>
  )
}
