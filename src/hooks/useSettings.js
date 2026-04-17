import { useState, useEffect, useCallback } from 'react'
import { fetchFacilitySettings, upsertFacilitySettings } from '../lib/supabase.js'

const DEFAULTS = { hours_per_appt: 1.5, break_pct: 10, shift1_hours: 8, shift2_hours: 8 }

export function useSettings(facilityId) {
  const [settings, setSettings] = useState(DEFAULTS)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (!facilityId) return
    setLoading(true)
    fetchFacilitySettings(facilityId).then(data => {
      setSettings(data)
      setLoading(false)
    })
  }, [facilityId])

  const saveSettings = useCallback(async (values) => {
    const next = { ...settings, ...values }
    setSettings(next)  // optimistic
    await upsertFacilitySettings(facilityId, values)
  }, [facilityId, settings])

  return { settings, saveSettings, loading }
}
