// Ported from front_netlify_datex/src/components/StatusBadge.jsx (2026-08-03).
// ADAPTED: original used Tailwind utility classes (bg-yellow-100, etc.) —
// CSW-WI has no Tailwind dependency, so this is rewritten as inline styles
// to match the rest of this app's design system instead of adding a second
// styling system alongside it.

const COLORS = {
  pending: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308' },
  processing: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308' },
  approved: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
  pushed: { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6' },
  failed: { bg: 'rgba(239, 68, 68, 0.15)', text: 'var(--red, #ef4444)' },
}

export default function StatusBadge({ status }) {
  const color = COLORS[status] || { bg: 'rgba(148, 163, 184, 0.15)', text: 'var(--text-secondary, #94a3b8)' }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'capitalize',
        whiteSpace: 'nowrap',
        background: color.bg,
        color: color.text,
      }}
    >
      {status || 'unknown'}
    </span>
  )
}
