/**
 * Settings store for Skylimit curation
 * Uses localStorage for persistence
 */

import { SkylimitSettings } from './types'
import { saveSettings, getSettings as getSettingsFromDB } from './skylimitCache'

// Exported defaults for use in UI components
export const FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT = 240 // minutes
export const REPOST_DISPLAY_INTERVAL_DEFAULT = 24 // hours

const DEFAULT_SETTINGS: SkylimitSettings = {
  viewsPerDay: 400,
  showTime: true, // Enable post numbering by default
  showAllPosts: false,
  curationSuspended: false,
  daysOfData: 30,
  secretKey: 'default',
  editionTimes: '',
  editionLayout: '',
  anonymizeUsernames: false,
  debugMode: false,
  feedRedisplayIdleInterval: FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT * 60 * 1000, // in milliseconds
  feedPageLength: 25, // number of posts per page, default 25
  infiniteScrollingOption: false, // default to "Load More" button
  curationIntervalHours: 2, // curation interval in hours, must be factor of 24 (1, 2, 3, 4, 6, 8, 12)
  minFolloweeDayCount: 1, // minimum followee day count (debug setting)
  hideUnfollowedReplies: false, // hide all replies to non-followees, default false
  repostDisplayIntervalHours: REPOST_DISPLAY_INTERVAL_DEFAULT, // hide reposts shown within this interval
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

