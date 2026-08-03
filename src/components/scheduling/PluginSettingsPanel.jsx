import { useState, useEffect } from 'react'
import { getLookupOptionsWithIds, getLookupOptions, saveSettings } from '../../lib/schedulingApi.js'
import { DEFAULT_DRAFT_TEMPLATE, DEFAULT_MULTI_DRAFT_TEMPLATE } from '../../lib/pluginUtils.js'

// PluginSettingsPanel — extracted from the 'settings' branch of
// front_netlify_datex/src/views/PluginView.jsx (2026-08-03) as part of
// splitting that 125KB file into companion files.
//
// This tab's UI-open/close toggles (showTemplateEditor etc.) and the
// per-warehouse dock-door cache used only by the dock-door-rules editor are
// kept as LOCAL state here — they're not referenced anywhere else in
// PluginView, so this component is fully self-contained aside from the
// settings values themselves (which the parent owns, since Single APPT/Load
// Container/Multi APPT tabs all read draftTemplate, abbreviations, etc.).
//
// Props: abbreviations, setAbbreviations, draftTemplate, setDraftTemplate,
//        multiDraftTemplate, setMultiDraftTemplate, dockDoorRules,
//        setDockDoorRules, lookups (warehouses/projects/types for the
//        dock-door-rule dropdowns)

export default function PluginSettingsPanel({
  abbreviations,
  setAbbreviations,
  draftTemplate,
  setDraftTemplate,
  multiDraftTemplate,
  setMultiDraftTemplate,
  dockDoorRules,
  setDockDoorRules,
  lookups,
}) {
  const [showAbbrevEditor, setShowAbbrevEditor] = useState(false)
  const [showTemplateEditor, setShowTemplateEditor] = useState(false)
  const [showMultiTemplateEditor, setShowMultiTemplateEditor] = useState(false)
  const [showDockDoorRules, setShowDockDoorRules] = useState(false)
  const [settingsDockDoors, setSettingsDockDoors] = useState({})

  useEffect(() => {
    if (!showDockDoorRules) return
    for (const wh of lookups.warehouses) {
      if (settingsDockDoors[wh]) continue
      getLookupOptionsWithIds('dock_doors', wh)
        .then(async (pairs) => {
          if (!pairs.length) {
            const names = await getLookupOptions('dock_doors').catch(() => [])
            return names.map((n) => ({ name: n, id: null }))
          }
          if (typeof pairs[0] !== 'object') return pairs.map((n) => ({ name: n, id: null }))
          return pairs
        })
        .then((normalized) => {
          setSettingsDockDoors((prev) => ({ ...prev, [wh]: normalized.map((p) => p.name) }))
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDockDoorRules])

  return (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Settings</h2>

      {/* Single APPT Draft Template */}
      <div className="border-t border-gray-100 pt-3">
        <button
          onClick={() => setShowTemplateEditor((v) => !v)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors font-medium w-full text-left"
        >
          <span className="text-[10px]">{showTemplateEditor ? '▾' : '▸'}</span>
          Confirmation Draft Template (Single APPT)
        </button>
        {showTemplateEditor && (
          <div className="mt-2">
            <p className="text-[11px] text-gray-400 mb-2">
              Placeholders: <code className="bg-gray-100 px-0.5 rounded">{'{{lookup_code}}'}</code>{' '}
              <code className="bg-gray-100 px-0.5 rounded">{'{{arrival}}'}</code>{' '}
              <code className="bg-gray-100 px-0.5 rounded">{'{{appointment_id}}'}</code>{' '}
              <code className="bg-gray-100 px-0.5 rounded">{'{{address}}'}</code>
            </p>
            <textarea
              value={draftTemplate}
              onChange={(e) => {
                setDraftTemplate(e.target.value)
                saveSettings('draft_template', e.target.value).catch(() => {})
              }}
              rows={12}
              className="w-full text-xs font-mono border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:border-indigo-400 resize-y"
            />
            <button
              onClick={() => {
                setDraftTemplate(DEFAULT_DRAFT_TEMPLATE)
                saveSettings('draft_template', DEFAULT_DRAFT_TEMPLATE).catch(() => {})
              }}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors mt-1"
            >
              Reset to default
            </button>
          </div>
        )}
      </div>

      {/* Multi APPT Draft Template */}
      <div className="border-t border-gray-100 pt-3">
        <button
          onClick={() => setShowMultiTemplateEditor((v) => !v)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors font-medium w-full text-left"
        >
          <span className="text-[10px]">{showMultiTemplateEditor ? '▾' : '▸'}</span>
          Confirmation Draft Template (Multi APPT)
        </button>
        {showMultiTemplateEditor && (
          <div className="mt-2">
            <p className="text-[11px] text-gray-400 mb-2">
              Placeholders: <code className="bg-gray-100 px-0.5 rounded">{'{{appointments}}'}</code> (numbered list){' '}
              <code className="bg-gray-100 px-0.5 rounded">{'{{address}}'}</code>
            </p>
            <textarea
              value={multiDraftTemplate}
              onChange={(e) => {
                setMultiDraftTemplate(e.target.value)
                saveSettings('multi_draft_template', e.target.value).catch(() => {})
              }}
              rows={12}
              className="w-full text-xs font-mono border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:border-indigo-400 resize-y"
            />
            <button
              onClick={() => {
                setMultiDraftTemplate(DEFAULT_MULTI_DRAFT_TEMPLATE)
                saveSettings('multi_draft_template', DEFAULT_MULTI_DRAFT_TEMPLATE).catch(() => {})
              }}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors mt-1"
            >
              Reset to default
            </button>
          </div>
        )}
      </div>

      {/* Appointment Code Abbreviations */}
      <div className="border-t border-gray-100 pt-3">
        <button
          onClick={() => setShowAbbrevEditor((v) => !v)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors font-medium w-full text-left"
        >
          <span className="text-[10px]">{showAbbrevEditor ? '▾' : '▸'}</span>
          Appointment Code Abbreviations
        </button>
        {showAbbrevEditor && (
          <div className="mt-2 space-y-1">
            <p className="text-[11px] text-gray-400 mb-2">Keyword matches by substring (case-insensitive). First match wins.</p>
            {abbreviations.map((entry, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  type="text"
                  value={entry.keyword}
                  onChange={(e) => {
                    const next = abbreviations.map((x, j) => (j === i ? { ...x, keyword: e.target.value } : x))
                    setAbbreviations(next)
                    saveSettings('abbreviations', next).catch(() => {})
                  }}
                  placeholder="Customer keyword"
                  className="flex-1 text-xs border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-400"
                />
                <span className="text-gray-300 text-xs">=</span>
                <input
                  type="text"
                  value={entry.abbr}
                  onChange={(e) => {
                    const next = abbreviations.map((x, j) => (j === i ? { ...x, abbr: e.target.value } : x))
                    setAbbreviations(next)
                    saveSettings('abbreviations', next).catch(() => {})
                  }}
                  placeholder="Abbr"
                  className="w-16 text-xs border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-400"
                />
                <button
                  onClick={() => {
                    const next = abbreviations.filter((_, j) => j !== i)
                    setAbbreviations(next)
                    saveSettings('abbreviations', next).catch(() => {})
                  }}
                  className="text-gray-300 hover:text-red-400 text-sm leading-none transition-colors"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => {
                  const next = [...abbreviations, { keyword: '', abbr: '' }]
                  setAbbreviations(next)
                  saveSettings('abbreviations', next).catch(() => {})
                }}
                className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                + Add row
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Dock Door Auto-Select Rules */}
      <div className="border-t border-gray-100 pt-3">
        <button
          onClick={() => setShowDockDoorRules((v) => !v)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors font-medium w-full text-left"
        >
          <span className="text-[10px]">{showDockDoorRules ? '▾' : '▸'}</span>
          Dock Door Auto-Select Rules
        </button>
        {showDockDoorRules && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] text-gray-400 mb-2">
              Auto-fills Dock Door when Warehouse, Project, and Type all match. Type matched by substring — "Inbound" matches "Inbound/Drop", "Inbound/Lump", etc.
            </p>
            {dockDoorRules.map((rule, i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Rule {i + 1}</span>
                  <button
                    onClick={() => {
                      const next = dockDoorRules.filter((_, j) => j !== i)
                      setDockDoorRules(next)
                      saveSettings('dock_door_rules', next).catch(() => {})
                    }}
                    className="text-gray-300 hover:text-red-400 text-base leading-none transition-colors"
                    title="Remove rule"
                  >
                    ×
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-0.5">Warehouse</label>
                    <select
                      value={rule.warehouse ?? ''}
                      onChange={(e) => {
                        const newWh = e.target.value
                        const next = dockDoorRules.map((r, j) => (j === i ? { ...r, warehouse: newWh, dock_door: '' } : r))
                        setDockDoorRules(next)
                        saveSettings('dock_door_rules', next).catch(() => {})
                        if (newWh && !settingsDockDoors[newWh]) {
                          getLookupOptionsWithIds('dock_doors', newWh)
                            .then(async (pairs) => {
                              if (!pairs.length) {
                                const names = await getLookupOptions('dock_doors').catch(() => [])
                                return names.map((n) => ({ name: n, id: null }))
                              }
                              if (typeof pairs[0] !== 'object') return pairs.map((n) => ({ name: n, id: null }))
                              return pairs
                            })
                            .then((normalized) => {
                              setSettingsDockDoors((prev) => ({ ...prev, [newWh]: normalized.map((p) => p.name) }))
                            })
                            .catch(() => {})
                        }
                      }}
                      className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-400 bg-white"
                    >
                      <option value="">— Any —</option>
                      {lookups.warehouses.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                      {rule.warehouse && !lookups.warehouses.includes(rule.warehouse) && <option value={rule.warehouse}>{rule.warehouse}</option>}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-0.5">Project</label>
                    <select
                      value={rule.project}
                      onChange={(e) => {
                        const next = dockDoorRules.map((r, j) => (j === i ? { ...r, project: e.target.value } : r))
                        setDockDoorRules(next)
                        saveSettings('dock_door_rules', next).catch(() => {})
                      }}
                      className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-400 bg-white"
                    >
                      <option value="">— Project —</option>
                      {[...lookups.projects].sort((a, b) => a.localeCompare(b)).map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                      {rule.project && !lookups.projects.includes(rule.project) && <option value={rule.project}>{rule.project}</option>}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-0.5">Type (contains)</label>
                    <select
                      value={rule.type_contains}
                      onChange={(e) => {
                        const next = dockDoorRules.map((r, j) => (j === i ? { ...r, type_contains: e.target.value } : r))
                        setDockDoorRules(next)
                        saveSettings('dock_door_rules', next).catch(() => {})
                      }}
                      className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-400 bg-white"
                    >
                      <option value="">— Type —</option>
                      {lookups.types.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      {rule.type_contains && !lookups.types.includes(rule.type_contains) && <option value={rule.type_contains}>{rule.type_contains}</option>}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-0.5">Dock Door</label>
                    {rule.warehouse ? (
                      <select
                        value={rule.dock_door}
                        onChange={(e) => {
                          const next = dockDoorRules.map((r, j) => (j === i ? { ...r, dock_door: e.target.value } : r))
                          setDockDoorRules(next)
                          saveSettings('dock_door_rules', next).catch(() => {})
                        }}
                        className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-400 bg-white"
                      >
                        <option value="">{settingsDockDoors[rule.warehouse] ? '— Dock Door —' : 'Loading…'}</option>
                        {(settingsDockDoors[rule.warehouse] ?? []).map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                        {rule.dock_door && !(settingsDockDoors[rule.warehouse] ?? []).includes(rule.dock_door) && <option value={rule.dock_door}>{rule.dock_door}</option>}
                      </select>
                    ) : (
                      <select disabled className="w-full text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50 text-gray-400 cursor-not-allowed">
                        <option>Select warehouse first</option>
                      </select>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={() => {
                const next = [...dockDoorRules, { warehouse: '', project: '', type_contains: '', dock_door: '' }]
                setDockDoorRules(next)
                saveSettings('dock_door_rules', next).catch(() => {})
              }}
              className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors mt-1"
            >
              + Add rule
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
