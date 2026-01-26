/**
 * Settings store for Skylimit curation
 * Uses localStorage for persistence
 */

import { SkylimitSettings } from './types'
import { saveSettings, getSettings as getSettingsFromDB } from './skylimitCache'

const DEFAULT_SETTINGS: SkylimitSettings = {
  viewsPerDay: 500,
  showTime: true, // Enable post numbering by default
  showAllStatus: false,
  disabled: false,
  daysOfData: 30,
  secretKey: 'default',
  editionTimes: '',
  editionLayout: '',
  anonymizeUsernames: false,
  debugMode: false,
  feedRedisplayIdleInterval: 5 * 60 * 1000, // 5 minutes in milliseconds
  feedPageLength: 25, // number of posts per page, default 25
  infiniteScrollingOption: false, // default to "Load More" button
  curationIntervalHours: 2, // curation interval in hours, must be factor of 24 (1, 2, 3, 4, 6, 8, 12)
  minFolloweeDayCount: 1, // minimum followee day count (debug setting)
}

/**
 * Get settings with defaults
 * If settings exist in DB, use them (even if they override defaults)
 * If no settings exist, use defaults
 */
export async function getSettings(): Promise<SkylimitSettings> {
  const settings = await getSettingsFromDB()
  // If settings exist, merge with defaults (saved settings take precedence)
  // If no settings exist, use defaults
  if (settings) {
    return { ...DEFAULT_SETTINGS, ...settings }
  }
  return DEFAULT_SETTINGS
}

/**
 * Update settings
 */
export async function updateSettings(updates: Partial<SkylimitSettings>): Promise<void> {
  const current = await getSettings()
  const updated = { ...current, ...updates }
  await saveSettings(updated)
}

/**
 * Get specific setting
 */
export async function getSetting<K extends keyof SkylimitSettings>(
  key: K
): Promise<SkylimitSettings[K]> {
  const settings = await getSettings()
  return settings[key]
}

