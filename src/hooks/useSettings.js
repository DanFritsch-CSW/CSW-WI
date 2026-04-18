import { useState, useEffect, useCallback } from 'react'
import { fetchFacilitySettings, upsertFacilitySettings } from '../lib/supabase.js'

const DEFAULTS = {
  hours_per_appt: 1.5,
  shift1_start: 5,  shift1_hours: 8,
  mid_start:    9,  mid_hours:    8,
  shift2_start: 13, shift2_hours: 8,
  shift3_start: 22, shift3_hours: 8,
  break_hour_1: 83, break_hour_2: 100, break_hour_3: 75, break_hour_4: 100,
  break_hour_5: 50, break_hour_6: 100, break_hour_7: 75, break_hour_8: 100,
}

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
