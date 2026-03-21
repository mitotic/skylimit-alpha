/**
 * Settings store for Skylimit curation
 * Uses localStorage for persistence
 */

import { SkylimitSettings, DAYS_OF_DATA_DEFAULT } from './types'
import { saveSettings, getSettings as getSettingsFromDB } from './skylimitCache'

// Exported defaults for use in UI components
export const FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT = 240 // minutes
export const REPOST_DISPLAY_INTERVAL_DEFAULT = 24 // hours
export const VIEWS_PER_DAY_DEFAULT = 600

const DEFAULT_SETTINGS: SkylimitSettings = {
  viewsPerDay: VIEWS_PER_DAY_DEFAULT,
  showTime: true, // Enable post numbering by default
  showAllPosts: false,
  curationSuspended: false,
  daysOfData: DAYS_OF_DATA_DEFAULT,
  secretKey: 'default',
  editionLayout: '',
  anonymizeUsernames: false,
  debugMode: true,
  feedRedisplayIdleInterval: FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT * 60 * 1000, // in milliseconds
  feedPageLength: 25, // number of posts per page, default 25
  infiniteScrollingOption: false, // default to "Load More" button
  curationIntervalHours: 2, // curation interval in hours, must be factor of 24 (1, 2, 3, 4, 6, 8, 12)
  minFolloweeDayCount: 1, // minimum followee day count (debug setting)
  hideUnfollowedReplies: false, // hide all replies to non-followees, default false
  showViewedStatus: true, // show viewed-post visual indicators, default true
  consoleLogLevel: 2, // console log verbosity: 0=errors, 1=warnings, 2=milestones, 3=debug, 4=verbose
  traceUsers: '', // comma-separated list of handles to trace
  repostDisplayIntervalHours: REPOST_DISPLAY_INTERVAL_DEFAULT, // hide reposts shown within this interval
  initialLookbackDays: 1, // days to look back on initial load
  refillLookbackDays: 1, // days to look back for refill fetches
  popAmp: 1, // popularity amplifier: 1-5, default 1 (disabled)
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

