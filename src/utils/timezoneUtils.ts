/**
 * Timezone utilities for Websky curation
 *
 * Provides timezone-aware midnight computation that composes correctly
 * with the client clock system (clientDate()/clientNow()).
 */

import { clientDate } from './clientClock'
import log from './logger'

/**
 * Get midnight (00:00:00) in a specific timezone for the calendar date
 * that `date` falls on in that timezone.
 *
 * Works correctly with accelerated/shifted client clock dates because
 * it operates on the Date's UTC timestamp, which Intl correctly interprets.
 */
export function getMidnightInTimezone(date: Date, timezone: string): Date {
  if (isNaN(date.getTime())) {
    log.warn('Timezone', `getMidnightInTimezone called with invalid date, substituting current time`)
    date = new Date()
  }
  // Get calendar date components in target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  })
  const parts = formatter.formatToParts(date)
  const year = +parts.find(p => p.type === 'year')!.value
  const month = +parts.find(p => p.type === 'month')!.value - 1
  const day = +parts.find(p => p.type === 'day')!.value

  // Two-pass offset calculation to handle DST transitions correctly.
  // On DST spring-forward/fall-back days, the offset at midnight differs from
  // the offset at other times of day. A single-pass approach using noon offset
  // produces the wrong midnight (e.g., 11 PM previous day on spring-forward).
  //
  // Pass 1: Get offset at midnight UTC → approximate local midnight
  // Pass 2: Get offset at the approximate midnight → correct local midnight
  //
  // This converges because midnight is always before any 2 AM DST transition,
  // so the second pass always lands on the correct side of the boundary.
  const midnightUTC = Date.UTC(year, month, day)
  const offset1 = tzOffsetMs(midnightUTC, timezone)
  const approxMidnight = midnightUTC + offset1
  const offset2 = tzOffsetMs(approxMidnight, timezone)

  return new Date(midnightUTC + offset2)
}

/**
 * Compute UTC-to-timezone offset in milliseconds at a given UTC instant.
 *
 * Uses Intl.DateTimeFormat.formatToParts + Date.UTC to avoid DST bugs
 * from new Date(string) parsing, which applies the browser's current
 * DST offset rather than the offset at the original UTC instant.
 */
function tzOffsetMs(utcMs: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  })
  const parts = fmt.formatToParts(new Date(utcMs))
  const y = +parts.find(p => p.type === 'year')!.value
  const m = +parts.find(p => p.type === 'month')!.value - 1
  const d = +parts.find(p => p.type === 'day')!.value
  const h = +parts.find(p => p.type === 'hour')!.value % 24
  const min = +parts.find(p => p.type === 'minute')!.value
  const sec = +parts.find(p => p.type === 'second')!.value
  const localAsUTC = Date.UTC(y, m, d, h, min, sec)
  return utcMs - localAsUTC
}

/**
 * Get midnight for the next calendar day in a specific timezone.
 * DST-safe: computes actual midnight rather than adding 24 hours,
 * which would be wrong on spring-forward (23h) or fall-back (25h) days.
 */
export function getNextMidnight(midnight: Date, timezone: string): Date {
  // Add 25 hours to guarantee we land in the next calendar day,
  // even on fall-back days where the day is 25 hours long
  const nextDayApprox = new Date(midnight.getTime() + 25 * 60 * 60 * 1000)
  return getMidnightInTimezone(nextDayApprox, timezone)
}

/**
 * Get midnight for the previous calendar day in a specific timezone.
 * DST-safe: computes actual midnight rather than subtracting 24 hours.
 */
export function getPrevMidnight(midnight: Date, timezone: string): Date {
  // Subtract 1 hour to land in the previous calendar day
  const prevDayApprox = new Date(midnight.getTime() - 1 * 60 * 60 * 1000)
  return getMidnightInTimezone(prevDayApprox, timezone)
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
  if (isNaN(date.getTime())) {
    log.warn('Timezone', `getTimeInTimezone called with invalid date, substituting current time`)
    date = new Date()
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  const parts = formatter.formatToParts(date)
  const hour = parts.find(p => p.type === 'hour')!.value
  const minute = parts.find(p => p.type === 'minute')!.value
  const timeStr = `${hour}:${minute}`

  // Add day-of-week prefix for posts not from today
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  })
  const postDate = dateFmt.format(date)
  const nowDate = dateFmt.format(clientDate())

  if (postDate !== nowDate) {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short'
    }).format(date)
    return `${weekday} ${timeStr}`
  }

  return timeStr
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
