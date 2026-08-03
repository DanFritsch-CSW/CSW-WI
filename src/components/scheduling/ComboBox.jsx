import { useState, useRef, useEffect } from 'react'

/**
 * ComboBox — searchable dropdown constrained to a list of valid options.
 * Ported from front_netlify_datex/src/components/ComboBox.jsx (2026-08-03),
 * verbatim — Tailwind classes now work since Tailwind was added to CSW-WI
 * scoped to the scheduling components (see tailwind.config.js).
 *
 * Props:
 *   label       string   — field label (uppercase small caps)
 *   fieldKey    string   — key passed back to onChange
 *   value       string   — current committed value
 *   options     string[] — valid options to filter against
 *   loading     bool     — show loading state while options are fetching
 *   small       bool     — use text-xs instead of text-sm (for compact views)
 *   onChange    fn(key, value) — called when user selects a valid option
 */

// Maximum number of options rendered in the dropdown at once. Prevents the
// Front sidebar iframe from freezing when a large unfiltered list (e.g. 250
// carriers) is rendered as DOM nodes in one React pass.
const MAX_VISIBLE = 50

export default function ComboBox({ label, fieldKey, value, options = [], loading = false, onChange, small = false }) {
  const [inputText, setInputText] = useState(value ?? '')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef(null)
  const activeItemRef = useRef(null)
  const textCls = small ? 'text-xs' : 'text-sm'

  useEffect(() => {
    setInputText(value ?? '')
  }, [value])

  useEffect(() => {
    function handleMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        closeAndRevert()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const filtered = options.filter((opt) => opt.toLowerCase().includes(inputText.toLowerCase()))

  const visibleOptions = filtered.slice(0, MAX_VISIBLE)
  const hasMore = filtered.length > MAX_VISIBLE

  useEffect(() => {
    setActiveIndex(-1)
  }, [visibleOptions.length, inputText])

  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex])

  function select(opt) {
    setInputText(opt)
    setOpen(false)
    setActiveIndex(-1)
    onChange(fieldKey, opt)
  }

  function closeAndRevert() {
    const exact = options.find((o) => o.toLowerCase() === inputText.toLowerCase())
    if (exact) {
      onChange(fieldKey, exact)
      setInputText(exact)
    } else {
      setInputText(value ?? '')
    }
    setOpen(false)
    setActiveIndex(-1)
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      closeAndRevert()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setActiveIndex((i) => (i + 1) % visibleOptions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
      setActiveIndex((i) => (i <= 0 ? visibleOptions.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0 && visibleOptions[activeIndex]) {
        select(visibleOptions[activeIndex])
      } else if (filtered.length === 1) {
        select(filtered[0])
      } else {
        const exact = options.find((o) => o.toLowerCase() === inputText.toLowerCase())
        if (exact) select(exact)
      }
    } else if (e.key === 'Tab') {
      if (activeIndex >= 0 && visibleOptions[activeIndex]) {
        select(visibleOptions[activeIndex])
      } else {
        closeAndRevert()
      }
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wide mb-0.5">{label}</label>
      <input
        type="text"
        value={inputText}
        disabled={loading}
        placeholder={loading ? 'Loading…' : ''}
        onChange={(e) => {
          setInputText(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className={`w-full ${textCls} text-gray-900 border border-transparent rounded px-1.5 py-1 -mx-1.5
          hover:border-gray-300 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400
          bg-transparent focus:bg-white transition-colors disabled:text-gray-400`}
      />

      {open && !loading && visibleOptions.length > 0 && (
        <ul
          className={`absolute z-50 left-0 right-0 mt-0.5 bg-white border border-gray-200 rounded-lg shadow-lg
          max-h-48 overflow-y-auto ${textCls}`}
        >
          {visibleOptions.map((opt, i) => (
            <li
              key={opt}
              ref={i === activeIndex ? activeItemRef : null}
              onMouseDown={(e) => {
                e.preventDefault()
                select(opt)
              }}
              className={`px-3 py-1.5 cursor-pointer hover:bg-indigo-50 hover:text-indigo-700
                ${i === activeIndex ? 'bg-indigo-50 text-indigo-700' : ''}
                ${opt === value && i !== activeIndex ? 'font-medium text-indigo-600' : 'text-gray-800'}`}
            >
              {opt}
            </li>
          ))}
          {hasMore && (
            <li className={`px-3 py-1.5 text-gray-400 italic select-none border-t border-gray-100 ${textCls}`}>
              Type to narrow results ({filtered.length - MAX_VISIBLE} more…)
            </li>
          )}
        </ul>
      )}

      {open && !loading && inputText.length > 0 && filtered.length === 0 && (
        <div className={`absolute z-50 left-0 right-0 mt-0.5 bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 ${textCls} text-gray-400`}>
          No matches
        </div>
      )}
    </div>
  )
}
