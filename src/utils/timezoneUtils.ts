/**
 * Timezone utilities for Websky curation
 *
 * Provides timezone-aware midnight computation that composes correctly
 * with the client clock system (clientDate()/clientNow()).
 */

/**
 * Get midnight (00:00:00) in a specific timezone for the calendar date
 * that `date` falls on in that timezone.
 *
 * Works correctly with accelerated/shifted client clock dates because
 * it operates on the Date's UTC timestamp, which Intl correctly interprets.
 */
export function getMidnightInTimezone(date: Date, timezone: string): Date {
  // Get calendar date components in target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  })
  const parts = formatter.formatToParts(date)
  const year = +parts.find(p => p.type === 'year')!.value
  const month = +parts.find(p => p.type === 'month')!.value - 1
  const day = +parts.find(p => p.type === 'day')!.value

  // Compute timezone offset at ~noon on that date (avoids DST edge at midnight)
  const noonUTC = new Date(Date.UTC(year, month, day, 12, 0, 0))
  const noonInTZ = new Date(noonUTC.toLocaleString('en-US', { timeZone: timezone }))
  const noonAsUTC = new Date(noonUTC.toLocaleString('en-US', { timeZone: 'UTC' }))
  const offsetMs = noonAsUTC.getTime() - noonInTZ.getTime()

  // Midnight in target timezone = UTC midnight for that date + offset
  return new Date(Date.UTC(year, month, day) + offsetMs)
}

/**
 * Get the browser's current timezone identifier (e.g., "America/New_York")
 */
export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Check if two timezone identifiers represent different current offsets.
 * Uses offset comparison to avoid false positives from timezone aliases.
 */
export function timezonesAreDifferent(tz1: string, tz2: string): boolean {
  const now = new Date()
  const fmt = (tz: string) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, timeZoneName: 'longOffset'
  }).format(now)
  return fmt(tz1) !== fmt(tz2)
}

/**
 * Get HH:MM time string in a specific timezone for a given date.
 * Used for edition time checks.
 */
export function getTimeInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  const parts = formatter.formatToParts(date)
  const hour = parts.find(p => p.type === 'hour')!.value
  const minute = parts.find(p => p.type === 'minute')!.value
  return `${hour}:${minute}`
}

/**
 * Get short timezone abbreviation (e.g., "GMT", "CST", "EST") for display.
 */
export function getTimezoneAbbreviation(timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'short'
  }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')!.value
}
