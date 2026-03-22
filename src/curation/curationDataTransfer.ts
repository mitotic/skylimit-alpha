/**
 * Export/import curation data for syncing across devices.
 * Exports curation-behavior settings, edition layout, and followee amp factors/priority patterns.
 */

import { SkylimitSettings } from './types'
import { getSettings } from './skylimitStore'
import { updateSettings } from './skylimitStore'
import { getAllFollows, getFollow, saveFollow } from './skylimitCache'

const WEBSKY_CURATION_VERSION = 1

// Settings keys that affect curation behavior (excludes display-only settings)
const CURATION_SETTINGS_KEYS: (keyof SkylimitSettings)[] = [
  'viewsPerDay',
  'daysOfData',
  'curationSuspended',
  'secretKey',
  'curationIntervalHours',
  'minFolloweeDayCount',
  'hideUnfollowedReplies',
  'repostDisplayIntervalHours',
  'initialLookbackDays',
  'refillLookbackDays',
  'feedPageLength',
  'infiniteScrollingOption',
  'maxDisplayedFeedSize',
  'newPostBatchFetches',
  'pagedUpdatesFullPageWaitMinutes',
  'feedRedisplayIdleInterval',
  'showEditionsInFeed',
  'editionLayout',
  'timezone',
]

export interface ExportHeader {
  websky_curation_version: number
  username: string
  exported_at: string
  settings: Partial<SkylimitSettings>
  follows_count: number
}

export interface ExportFollowEntry {
  username: string
  amp_factor: number
  priorityPatterns?: string
}

export type CurationExportData = [ExportHeader, ExportFollowEntry[]]

export interface ImportValidation {
  success: true
  data: CurationExportData
  matchedFollows: number
  skippedFollows: number
  totalSettingsKeys: number
}

export interface ImportError {
  success: false
  error: string
}

export interface ImportResult {
  settingsUpdated: number
  followsUpdated: number
  followsSkipped: number
}

/**
 * Export curation data as JSON string
 */
export async function exportCurationData(username: string): Promise<string> {
  const settings = await getSettings()

  // Extract only curation-behavior settings
  const curationSettings: Partial<SkylimitSettings> = {}
  for (const key of CURATION_SETTINGS_KEYS) {
    if (key in settings) {
      ;(curationSettings as Record<string, unknown>)[key] = settings[key]
    }
  }

  // Get followee amp factors and priority patterns
  const allFollows = await getAllFollows()
  const followEntries: ExportFollowEntry[] = allFollows
    .map((f) => {
      const entry: ExportFollowEntry = {
        username: f.username,
        amp_factor: f.amp_factor,
      }
      if (f.priorityPatterns) {
        entry.priorityPatterns = f.priorityPatterns
      }
      return entry
    })
    .sort((a, b) => a.username.localeCompare(b.username))

  const header: ExportHeader = {
    websky_curation_version: WEBSKY_CURATION_VERSION,
    username,
    exported_at: new Date().toISOString(),
    settings: curationSettings,
    follows_count: followEntries.length,
  }

  const exportData: CurationExportData = [header, followEntries]
  return JSON.stringify(exportData, null, 2)
}

/**
 * Validate an import file before applying it
 */
export async function validateCurationImport(
  jsonString: string,
  currentUsername: string
): Promise<ImportValidation | ImportError> {
  let data: CurationExportData
  try {
    data = JSON.parse(jsonString)
  } catch {
    return { success: false, error: 'Invalid JSON file' }
  }

  if (!Array.isArray(data) || data.length !== 2) {
    return { success: false, error: 'Invalid file format: expected [header, follows] array' }
  }

  const header = data[0]
  if (!header || typeof header !== 'object') {
    return { success: false, error: 'Invalid file format: missing header' }
  }

  if (header.websky_curation_version !== WEBSKY_CURATION_VERSION) {
    return {
      success: false,
      error: `Version mismatch: file version ${header.websky_curation_version}, expected ${WEBSKY_CURATION_VERSION}`,
    }
  }

  if (
    !header.username ||
    header.username.toLowerCase() !== currentUsername.toLowerCase()
  ) {
    return {
      success: false,
      error: `Username mismatch: file is for "${header.username}", current user is "${currentUsername}"`,
    }
  }

  // Count matched vs skipped followees
  const followEntries = data[1]
  if (!Array.isArray(followEntries)) {
    return { success: false, error: 'Invalid file format: follows must be an array' }
  }

  let matchedFollows = 0
  let skippedFollows = 0
  for (const entry of followEntries) {
    const existing = await getFollow(entry.username)
    if (existing) {
      matchedFollows++
    } else {
      skippedFollows++
    }
  }

  const totalSettingsKeys = header.settings
    ? Object.keys(header.settings).length
    : 0

  return {
    success: true,
    data,
    matchedFollows,
    skippedFollows,
    totalSettingsKeys,
  }
}

/**
 * Apply validated import data
 */
export async function applyCurationImport(
  data: CurationExportData
): Promise<ImportResult> {
  const header = data[0]
  const followEntries = data[1]

  // Apply curation settings (only curation keys, preserve display settings)
  let settingsUpdated = 0
  if (header.settings) {
    const updates: Partial<SkylimitSettings> = {}
    for (const key of CURATION_SETTINGS_KEYS) {
      if (key in header.settings) {
        ;(updates as Record<string, unknown>)[key] =
          (header.settings as Record<string, unknown>)[key]
        settingsUpdated++
      }
    }
    await updateSettings(updates)
  }

  // Apply followee amp factors and priority patterns
  let followsUpdated = 0
  let followsSkipped = 0
  for (const entry of followEntries) {
    const existing = await getFollow(entry.username)
    if (existing) {
      existing.amp_factor = entry.amp_factor
      existing.priorityPatterns = entry.priorityPatterns
      await saveFollow(existing)
      followsUpdated++
    } else {
      followsSkipped++
    }
  }

  return { settingsUpdated, followsUpdated, followsSkipped }
}

/**
 * Trigger browser download of a JSON string
 */
export function downloadJson(jsonString: string, filename: string): void {
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
