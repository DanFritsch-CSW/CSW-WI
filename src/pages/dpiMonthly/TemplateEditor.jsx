import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { colors, cardStyle } from './dpiMonthlyStyles.js'
import { WEEKDAY_LABELS, formatTimeDisplay } from './dpiCalendarUtils.js'

// Route Template editor (A2) — added 2026-09-25, directly prompted by the
// Oshkosh/Madison A3 investigation: Dan described agency #709270 as
// living on both the OSHKO and MADISON route templates, but the live data
// showed it only on OSHKO — nobody had an easy way to just LOOK at which
// agencies sit on which route template, let alone fix a mismatch. This
// screen is that visibility, plus the ability to edit it directly, rather
// than needing a Supabase query every time a question like that comes up.
//
// Deliberately edits dpi_route_templates/dpi_route_template_stops directly
// — the master, annual pattern every monthly cycle is seeded from
// (Phase2BuildFlag's seedFromTemplate) — NOT a specific cycle's dpi_routes/
// dpi_route_stops. A change here affects every future month; it never
// touches an already-seeded cycle already in progress. This is a
// standing configuration screen, not a phase of the monthly pipeline, so
// it lives behind its own top-level toggle in DpiMonthlyProcess.jsx
// (Monthly Cycle | Route Templates) rather than as a 5th phase pill.
//
// Deliberately NO drag-and-drop anywhere on this screen. Given today's
// extended native-HTML5-DnD saga in Phase2BuildFlag.jsx (three patches
// that didn't fully fix it, ultimately requiring a switch to @dnd-kit),
// and that this is described as an occasional-use admin screen rather
// than a high-frequency daily interaction, plain buttons (reorder,
// move-to-route dropdown, remove) are the safer choice here — there is
// no interaction class to get wrong.
export default function TemplateEditor({ facility }) {
  const [templates, setTemplates] = useState([]) // [{ id, route_code, load_day, deliver_day, load_time, depart_day, depart_time, notes, template_week, stops: [...] }]
  const [loading, setLoading] = useState(true)
  const [newRouteCode, setNewRouteCode] = useState('')
  const [addingStopForTemplateId, setAddingStopForTemplateId] = useState(null)
  const [newStop, setNewStop] = useState({ agency_number: '', agency_name: '', city: '' })
  const [editingTemplateId, setEditingTemplateId] = useState(null)
  const [editFields, setEditFields] = useState({})

  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    setLoading(true)
    const { data: templateRows, error: tErr } = await supabase
      .from('dpi_route_templates')
      .select('*')
      .eq('facility', facility)
      .order('route_code')
    if (tErr) console.error('load templates:', tErr)

    const templateIds = (templateRows || []).map((t) => t.id)
    let stopRows = []
    if (templateIds.length > 0) {
      const { data, error } = await supabase
        .from('dpi_route_template_stops')
        .select('*')
        .in('template_id', templateIds)
        .order('sequence')
      if (error) console.error('load template stops:', error)
      stopRows = data || []
    }

    setTemplates((templateRows || []).map((t) => ({
      ...t,
      stops: stopRows.filter((s) => s.template_id === t.id),
    })))
    setLoading(false)
  }, [facility])

  useEffect(() => { load() }, [load])

  const addRouteTemplate = async () => {
    const code = newRouteCode.trim()
    if (!code || !supabase) return
    const { error } = await supabase.from('dpi_route_templates').insert({ facility, route_code: code })
    if (error) { console.error('add route template:', error); return }
    setNewRouteCode('')
    load()
  }

  const deleteRouteTemplate = async (template) => {
    if (!supabase) return
    const stopCount = template.stops.length
    const msg = stopCount > 0
      ? `Delete route template ${template.route_code}? It has ${stopCount} agenc${stopCount === 1 ? 'y' : 'ies'} on it — they'll be removed from the template too (this does not touch any month already in progress). This cannot be undone.`
      : `Delete route template ${template.route_code}? This cannot be undone.`
    if (!window.confirm(msg)) return
    // dpi_route_template_stops has no FK cascade from dpi_route_templates
    // (confirmed live) — delete stops first, same order as every other
    // cascade-less delete in this app (e.g. DPI Monthly cycle reset).
    const { error: stopsErr } = await supabase.from('dpi_route_template_stops').delete().eq('template_id', template.id)
    if (stopsErr) { console.error('delete template stops:', stopsErr); return }
    const { error: tErr } = await supabase.from('dpi_route_templates').delete().eq('id', template.id)
    if (tErr) { console.error('delete template:', tErr); return }
    load()
  }

  const startEditTemplate = (template) => {
    setEditingTemplateId(template.id)
    setEditFields({
      load_day: template.load_day || '',
      load_time: template.load_time ? template.load_time.slice(0, 5) : '',
      deliver_day: template.deliver_day || '',
      depart_day: template.depart_day || '',
      depart_time: template.depart_time ? template.depart_time.slice(0, 5) : '',
      template_week: template.template_week ?? '',
      notes: template.notes || '',
    })
  }

  const saveEditTemplate = async (templateId) => {
    if (!supabase) return
    const payload = {
      load_day: editFields.load_day || null,
      load_time: editFields.load_time || null,
      deliver_day: editFields.deliver_day || null,
      depart_day: editFields.depart_day || null,
      depart_time: editFields.depart_time || null,
      template_week: editFields.template_week === '' ? null : Number(editFields.template_week),
      notes: editFields.notes || null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('dpi_route_templates').update(payload).eq('id', templateId)
    if (error) { console.error('save template:', error); return }
    setEditingTemplateId(null)
    load()
  }

  // Reorder within the same template — mirrors Phase2BuildFlag's
  // reorderStopWithinRoute exactly (plain up/down buttons, adjacent-
  // sibling-as-target), just without any ETA-chain recalculation, since
  // templates have no cycle-specific travel-time data to recompute.
  const reorderStop = async (template, fromAgencyNumber, toAgencyNumber) => {
    if (!supabase || fromAgencyNumber === toAgencyNumber) return
    const stops = [...template.stops]
    const fromIdx = stops.findIndex((s) => s.agency_number === fromAgencyNumber)
    const toIdx = stops.findIndex((s) => s.agency_number === toAgencyNumber)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = stops.splice(fromIdx, 1)
    stops.splice(toIdx, 0, moved)

    setTemplates((prev) => prev.map((t) => (t.id === template.id ? { ...t, stops } : t)))
    for (let i = 0; i < stops.length; i++) {
      const { error } = await supabase.from('dpi_route_template_stops').update({ sequence: i + 1 }).eq('id', stops[i].id)
      if (error) console.error('reorder template stop:', error)
    }
  }

  // Moves a stop from its current template to a different one, appending
  // to the end. No drag surface at all — a plain <select> per stop row.
  const moveStopToTemplate = async (stop, sourceTemplate, destTemplateId) => {
    if (!supabase || destTemplateId === sourceTemplate.id) return
    const destTemplate = templates.find((t) => t.id === Number(destTemplateId))
    if (!destTemplate) return
    const nextSequence = destTemplate.stops.length > 0 ? Math.max(...destTemplate.stops.map((s) => s.sequence)) + 1 : 1
    const { error } = await supabase
      .from('dpi_route_template_stops')
      .update({ template_id: destTemplate.id, sequence: nextSequence })
      .eq('id', stop.id)
    if (error) { console.error('move stop to template:', error); return }
    load()
  }

  const removeStop = async (stop, template) => {
    if (!supabase) return
    if (!window.confirm(`Remove ${stop.agency_name || stop.agency_number} from Route ${template.route_code}'s template? This does not affect any month already in progress.`)) return
    const { error } = await supabase.from('dpi_route_template_stops').delete().eq('id', stop.id)
    if (error) { console.error('remove template stop:', error); return }
    load()
  }

  const startAddStop = (templateId) => {
    setAddingStopForTemplateId(templateId)
    setNewStop({ agency_number: '', agency_name: '', city: '' })
  }

  const saveAddStop = async (template) => {
    if (!supabase || !newStop.agency_number.trim()) return
    const nextSequence = template.stops.length > 0 ? Math.max(...template.stops.map((s) => s.sequence)) + 1 : 1
    const { error } = await supabase.from('dpi_route_template_stops').insert({
      template_id: template.id,
      sequence: nextSequence,
      agency_number: newStop.agency_number.trim(),
      agency_name: newStop.agency_name.trim() || null,
      city: newStop.city.trim() || null,
    })
    if (error) { console.error('add template stop:', error); return }
    setAddingStopForTemplateId(null)
    load()
  }

  if (loading) return <div style={{ fontSize: 13, color: colors.textFaint }}>Loading route templates…</div>

  const fieldStyle = { fontSize: 12, padding: '3px 6px', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.bg, color: colors.text }

  return (
    <div>
      <div style={{ fontSize: 12, color: colors.textFaint, marginBottom: 16, maxWidth: 720 }}>
        These are the master route templates — the annual pattern each new monthly cycle is seeded from (Phase2BuildFlag's "Route Build" pulls from here every time a facility's routes are first built for a month). Editing here changes the pattern going forward; it never touches a month that's already in progress.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {templates.map((template) => (
          <div key={template.id} style={{ ...cardStyle, minWidth: 260, maxWidth: 320, flex: '0 0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>Route {template.route_code}</div>
              <button
                onClick={() => deleteRouteTemplate(template)}
                title="Delete this route template"
                style={{ fontSize: 11, color: colors.danger, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Delete
              </button>
            </div>

            {editingTemplateId === template.id ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10, padding: 8, borderRadius: 6, border: `1px solid ${colors.accent}`, background: colors.panelAlt }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: colors.textFaint, width: 56 }}>Load</span>
                  <select value={editFields.load_day} onChange={(e) => setEditFields((f) => ({ ...f, load_day: e.target.value }))} style={fieldStyle}>
                    <option value="">—</option>
                    {WEEKDAY_LABELS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <input type="time" value={editFields.load_time} onChange={(e) => setEditFields((f) => ({ ...f, load_time: e.target.value }))} style={{ ...fieldStyle, width: 90 }} />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: colors.textFaint, width: 56 }}>Leave</span>
                  <select value={editFields.depart_day} onChange={(e) => setEditFields((f) => ({ ...f, depart_day: e.target.value }))} style={fieldStyle}>
                    <option value="">—</option>
                    {WEEKDAY_LABELS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <input type="time" value={editFields.depart_time} onChange={(e) => setEditFields((f) => ({ ...f, depart_time: e.target.value }))} style={{ ...fieldStyle, width: 90 }} />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: colors.textFaint, width: 56 }}>Deliver</span>
                  <select value={editFields.deliver_day} onChange={(e) => setEditFields((f) => ({ ...f, deliver_day: e.target.value }))} style={fieldStyle}>
                    <option value="">—</option>
                    {WEEKDAY_LABELS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: colors.textFaint, width: 56 }}>Week</span>
                  <select value={editFields.template_week} onChange={(e) => setEditFields((f) => ({ ...f, template_week: e.target.value }))} style={fieldStyle}>
                    <option value="">—</option>
                    <option value="1">1st</option>
                    <option value="2">2nd</option>
                    <option value="3">3rd</option>
                    <option value="4">4th</option>
                  </select>
                </div>
                <textarea
                  value={editFields.notes}
                  onChange={(e) => setEditFields((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Notes (pipe-separated, e.g. Load 1st Mon PM | reload ok)"
                  rows={2}
                  style={{ ...fieldStyle, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => saveEditTemplate(template.id)} style={{ fontSize: 11, color: colors.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Save</button>
                  <button onClick={() => setEditingTemplateId(null)} style={{ fontSize: 11, color: colors.textFaint, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div
                onClick={() => startEditTemplate(template)}
                title="Click to edit load/leave/deliver day & time, week, notes"
                style={{ fontSize: 11, color: colors.textFaint, marginBottom: 10, cursor: 'pointer' }}
              >
                Load {template.load_day || '—'}{template.load_time ? ` ${formatTimeDisplay(template.load_time)}` : ''}
                {' · '}Leave {template.depart_day || '—'}{template.depart_time ? ` ${formatTimeDisplay(template.depart_time)}` : ''}
                {' · '}Deliver {template.deliver_day || '—'}
                {template.template_week ? ` · Week ${template.template_week}` : ''}
                {template.notes ? <div style={{ marginTop: 2, fontStyle: 'italic' }}>{template.notes}</div> : null}
                <span style={{ color: colors.accent }}> ✎</span>
              </div>
            )}

            {template.stops.length === 0 && (
              <div style={{ fontSize: 12, color: colors.textFaint, fontStyle: 'italic', marginBottom: 8 }}>No agencies on this route template</div>
            )}
            {template.stops.map((stop, idx) => (
              <div key={stop.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, padding: '6px 8px', borderRadius: 6, background: colors.panelAlt, border: `1px solid ${colors.border}` }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                  <button
                    disabled={idx === 0}
                    onClick={() => reorderStop(template, stop.agency_number, template.stops[idx - 1].agency_number)}
                    style={{ fontSize: 8, lineHeight: 1, padding: '1px 3px', border: 'none', background: 'none', color: idx === 0 ? colors.border : colors.accent, cursor: idx === 0 ? 'default' : 'pointer' }}
                  >▲</button>
                  <button
                    disabled={idx === template.stops.length - 1}
                    onClick={() => reorderStop(template, stop.agency_number, template.stops[idx + 1].agency_number)}
                    style={{ fontSize: 8, lineHeight: 1, padding: '1px 3px', border: 'none', background: 'none', color: idx === template.stops.length - 1 ? colors.border : colors.accent, cursor: idx === template.stops.length - 1 ? 'default' : 'pointer' }}
                  >▼</button>
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                  <div style={{ color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stop.agency_name || '(unnamed)'}</div>
                  <div style={{ fontSize: 10, color: colors.textFaint }}>#{stop.agency_number}{stop.city ? ` · ${stop.city}` : ''}</div>
                </div>
                <select
                  value={template.id}
                  onChange={(e) => moveStopToTemplate(stop, template, e.target.value)}
                  title="Move to a different route template"
                  style={{ ...fieldStyle, fontSize: 10, padding: '2px 3px', maxWidth: 70 }}
                >
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.route_code}</option>)}
                </select>
                <button
                  onClick={() => removeStop(stop, template)}
                  title="Remove from this route template"
                  style={{ fontSize: 13, color: colors.danger, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                >×</button>
              </div>
            ))}

            {addingStopForTemplateId === template.id ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                <input
                  placeholder="Agency #"
                  value={newStop.agency_number}
                  onChange={(e) => setNewStop((s) => ({ ...s, agency_number: e.target.value }))}
                  style={fieldStyle}
                />
                <input
                  placeholder="Agency name"
                  value={newStop.agency_name}
                  onChange={(e) => setNewStop((s) => ({ ...s, agency_name: e.target.value }))}
                  style={fieldStyle}
                />
                <input
                  placeholder="City"
                  value={newStop.city}
                  onChange={(e) => setNewStop((s) => ({ ...s, city: e.target.value }))}
                  style={fieldStyle}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => saveAddStop(template)} disabled={!newStop.agency_number.trim()} style={{ fontSize: 11, color: colors.accent, background: 'none', border: 'none', cursor: newStop.agency_number.trim() ? 'pointer' : 'default', padding: 0, opacity: newStop.agency_number.trim() ? 1 : 0.5 }}>Add</button>
                  <button onClick={() => setAddingStopForTemplateId(null)} style={{ fontSize: 11, color: colors.textFaint, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => startAddStop(template.id)}
                style={{ fontSize: 11, color: colors.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 4 }}
              >
                + Add agency
              </button>
            )}
          </div>
        ))}

        <div style={{ ...cardStyle, minWidth: 220, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
          <div style={{ fontSize: 12, color: colors.textFaint }}>New route template</div>
          <input
            value={newRouteCode}
            onChange={(e) => setNewRouteCode(e.target.value)}
            placeholder="Route code (e.g. 121 or GREEN)"
            style={fieldStyle}
          />
          <button
            onClick={addRouteTemplate}
            disabled={!newRouteCode.trim()}
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.textMuted, cursor: newRouteCode.trim() ? 'pointer' : 'default', opacity: newRouteCode.trim() ? 1 : 0.5 }}
          >
            + Add route
          </button>
        </div>
      </div>
    </div>
  )
}
