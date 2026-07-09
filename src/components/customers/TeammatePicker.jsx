import { useEffect, useRef, useState } from 'react'

// TeammatePicker — shared searchable @username picker. Added 2026-07-09
// after Dan noted the plain <select> (87 options) was unwieldy to scroll —
// this lets you type to filter (matches username, first name, or last name)
// and click to select, closer to how @ mentions feel in Front itself.
//
// Used in TemplateEditor.jsx and OnboardingTab.jsx (AddTaskInline). Kept as
// one shared component so filtering/keyboard/click-outside behavior only
// needs to be right in one place.
export default function TeammatePicker({ teammates, value, onChange, placeholder = '— unassigned —' }) {
  const selected = teammates.find(t => t.teammate_id === value) || null
  const label = (tm) => `@${tm.username}${tm.first_name ? ` — ${tm.first_name} ${tm.last_name || ''}`.trimEnd() : ''}`

  const [query, setQuery] = useState(selected ? label(selected) : '')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Keep displayed text in sync if the selected value changes from
    // outside (e.g. parent resets the row) while the picker isn't open.
    if (!open) setQuery(selected ? label(selected) : '')
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  const isShowingSelectedLabel = selected && query === label(selected)
  const filtered = (query.trim() === '' || isShowingSelectedLabel)
    ? teammates
    : teammates.filter(tm => {
        const q = query.toLowerCase()
        return tm.username?.toLowerCase().includes(q)
          || tm.first_name?.toLowerCase().includes(q)
          || tm.last_name?.toLowerCase().includes(q)
      })

  const handleSelect = (tm) => {
    onChange(tm ? tm.teammate_id : '')
    setQuery(tm ? label(tm) : '')
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative', width: 190 }}>
      <input
        value={query}
        onFocus={() => { setOpen(true); setQuery('') }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onBlur={() => {
          // Delay so a click on a dropdown item registers before we close
          // and reset the text back to the current selection.
          setTimeout(() => {
            setOpen(false)
            setQuery(selected ? label(selected) : '')
          }, 120)
        }}
        placeholder={placeholder}
        style={{
          width: '100%', fontSize: 12, padding: '4px 6px', borderRadius: 4, boxSizing: 'border-box',
          border: `1px solid ${value ? 'var(--border)' : '#fde68a'}`,
          background: value ? 'transparent' : '#fffbeb',
        }}
        title={value ? undefined : 'No teammate selected — handoff notification/assignment won\'t fire for this task'}
      />
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          background: 'var(--surface, #fff)', border: '1px solid var(--border)', borderRadius: 4,
          maxHeight: 220, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.12)', marginTop: 2,
        }}>
          <div
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleSelect(null)}
            style={{ padding: '6px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            — unassigned —
          </div>
          {filtered.map(tm => (
            <div
              key={tm.teammate_id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(tm)}
              style={{ padding: '6px 8px', fontSize: 12, cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2, #f8f8f8)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              {label(tm)}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-dim)' }}>No match</div>
          )}
        </div>
      )}
    </div>
  )
}
