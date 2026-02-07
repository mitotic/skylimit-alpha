/**
 * Client Clock - Provides time functions that support accelerated time for testing
 *
 * When connected to a Skyspeed test server, time can run at an accelerated rate
 * (e.g., 60x normal speed). This module provides drop-in replacements for
 * Date.now(), new Date(), setTimeout, and setInterval that account for the
 * acceleration factor.
 *
 * When clockFactor === 1 (default), all functions pass through directly to
 * native APIs with no overhead.
 *
 * Usage:
 *   import { clientNow, clientDate, clientTimeout, clientInterval } from '../utils/clientClock'
 *   // Use clientNow() instead of Date.now() for logical timestamps
 *   // Use clientDate() instead of new Date() for logical dates
 *   // Use clientTimeout/clientInterval instead of setTimeout/setInterval for logical timers
 *   // Keep native setTimeout/setInterval for UI timers (toast, scroll debounce, etc.)
 */

// --- Skyspeed config types ---

export interface SkyspeedConfig {
  skyspeedRandomSeed: number
  skyspeedClockFactor: number
  skyspeedServerStartTime: string   // ISO 8601 - when server started (server time = actual time at this point)
  skyspeedServerCurrentTime: string // ISO 8601 - current simulated time on server
  skyspeedActualCurrentTime: string // ISO 8601 - current wall clock time on server
}

// --- Clock state ---

let clockFactor = 1
let realEpoch = 0       // Real Date.now() when acceleration was configured
let clientEpoch = 0     // What the client clock reads at realEpoch

const SKYSPEED_CONFIG_KEY = 'skylimit_skyspeed_config'

/**
 * Notify listeners (e.g., AcceleratedClock component) that the clock config changed.
 */
function notifyClockChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('clientClockChange'))
  }
}

// --- Core clock functions ---

/**
 * Returns current client time in milliseconds.
 * Replaces Date.now() for logical timestamps (cache metadata, idle detection, etc.)
 */
export function clientNow(): number {
  if (clockFactor === 1) return Date.now()
  return clientEpoch + (Date.now() - realEpoch) * clockFactor
}

/**
 * Returns a Date object in client time.
 * Replaces new Date() for logical dates (midnight calculations, lookback boundaries, etc.)
 * When called with a timestamp argument, wraps it as-is (same as new Date(timestamp)).
 */
export function clientDate(): Date
export function clientDate(timestamp: number | string): Date
export function clientDate(timestamp?: number | string): Date {
  if (timestamp !== undefined) return new Date(timestamp)
  if (clockFactor === 1) return new Date()
  return new Date(clientNow())
}

/**
 * Schedules a callback with delay adjusted for clock acceleration.
 * Replaces setTimeout for logical timers (feed polling, idle checks, cache cleanup, etc.)
 * Keep native setTimeout for UI timers (toast dismiss, scroll debounce, etc.)
 */
export function clientTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  if (clockFactor === 1) return setTimeout(fn, ms)
  return setTimeout(fn, ms / clockFactor)
}

/**
 * Schedules a repeating callback with interval adjusted for clock acceleration.
 * Replaces setInterval for logical timers (periodic polling, stats computation, etc.)
 * Keep native setInterval for UI timers (countdown display, scroll checks, etc.)
 */
export function clientInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  if (clockFactor === 1) return setInterval(fn, ms)
  return setInterval(fn, ms / clockFactor)
}

/**
 * Clears a timeout created by clientTimeout.
 */
export function clearClientTimeout(id: ReturnType<typeof setTimeout>): void {
  clearTimeout(id)
}

/**
 * Clears an interval created by clientInterval.
 */
export function clearClientInterval(id: ReturnType<typeof setInterval>): void {
  clearInterval(id)
}

// --- Configuration ---

/**
 * Returns the current clock acceleration factor (1 = normal, >1 = accelerated).
 */
export function getClockFactor(): number {
  return clockFactor
}

/**
 * Returns true if the clock is running faster than normal.
 */
export function isClockAccelerated(): boolean {
  return clockFactor > 1
}

/**
 * Configure the client clock from a Skyspeed server config.
 * Computes sync parameters accounting for client-server clock skew.
 */
export function configureClientClock(config: SkyspeedConfig): void {
  const serverStartTime = Date.parse(config.skyspeedServerStartTime)
  const serverCurrentTime = Date.parse(config.skyspeedServerCurrentTime)
  const serverActualTime = Date.parse(config.skyspeedActualCurrentTime)
  const factor = config.skyspeedClockFactor

  if (factor <= 0) {
    console.warn('[ClientClock] Invalid clock factor:', factor)
    return
  }

  // Compute offset between client's actual time and server's actual time
  const clientActualTime = Date.now()
  const actualTimeOffset = clientActualTime - serverActualTime

  // The effective start real time from the client's perspective
  // (when did the server start, in client's wall clock?)
  const clientStartRealTime = clientActualTime - (serverCurrentTime - serverStartTime) / factor + actualTimeOffset

  clockFactor = factor
  realEpoch = clientStartRealTime
  clientEpoch = serverStartTime

  console.log('[ClientClock] Configured:')
  console.log(`  Clock factor: ${factor}x`)
  console.log(`  Server start: ${config.skyspeedServerStartTime}`)
  console.log(`  Server current: ${config.skyspeedServerCurrentTime}`)
  console.log(`  Client-server offset: ${actualTimeOffset}ms`)
  console.log(`  Client time now: ${new Date(clientNow()).toISOString()}`)
  notifyClockChange()
}

/**
 * Configure the client clock manually (for console-based testing).
 * @param factor - Acceleration factor (e.g., 60 for 60x speed)
 * @param startTimeISO - Optional ISO 8601 start time for the accelerated clock.
 *                       If omitted, acceleration starts from the current real time.
 */
export function setClientClockManual(factor: number, startTimeISO?: string): void {
  if (factor <= 0) {
    console.warn('[ClientClock] Invalid clock factor:', factor)
    return
  }

  clockFactor = factor
  realEpoch = Date.now()
  clientEpoch = startTimeISO ? Date.parse(startTimeISO) : realEpoch

  console.log(`[ClientClock] Manual config: ${factor}x from ${new Date(clientEpoch).toISOString()}`)
  console.log(`  Client time now: ${new Date(clientNow()).toISOString()}`)
  notifyClockChange()
}

/**
 * Reset the client clock to normal (factor=1).
 */
export function resetClientClock(): void {
  clockFactor = 1
  realEpoch = 0
  clientEpoch = 0
  console.log('[ClientClock] Reset to normal time')
  notifyClockChange()
}

// --- Skyspeed detection ---

/**
 * After a successful login, check if the server is a Skyspeed test server.
 * Fetches the dev.skyspeed.getConfig XRPC endpoint and checks for the X-Skyspeed header.
 *
 * @param serviceUrl - The base URL of the AT Protocol service
 * @param accessJwt - The access JWT from login
 * @returns SkyspeedConfig if connected to Skyspeed, null otherwise
 */
export async function detectSkyspeed(
  serviceUrl: string,
  accessJwt: string,
): Promise<SkyspeedConfig | null> {
  try {
    const response = await fetch(`${serviceUrl}/xrpc/dev.skyspeed.getConfig`, {
      headers: {
        'Authorization': `Bearer ${accessJwt}`,
      },
    })

    // Check for X-Skyspeed header
    const skyspeedHeader = response.headers.get('X-Skyspeed')
    if (!skyspeedHeader) return null

    if (!response.ok) return null

    const config: SkyspeedConfig = await response.json()

    // Acknowledge the clock factor so the server knows we're clock-aware
    if (config.skyspeedClockFactor > 1) {
      try {
        const ackResponse = await fetch(`${serviceUrl}/xrpc/dev.skyspeed.ackConfig`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ clockFactor: config.skyspeedClockFactor }),
        })
        if (ackResponse.ok) {
          console.log(`[Skyspeed] Clock factor ${config.skyspeedClockFactor}x acknowledged by server`)
        } else {
          console.warn('[Skyspeed] Failed to acknowledge clock factor:', await ackResponse.text())
        }
      } catch (ackError) {
        console.warn('[Skyspeed] Failed to send clock ack:', ackError)
      }
    }

    return config
  } catch {
    // Not a Skyspeed server, or network error
    return null
  }
}

// --- Skyspeed config persistence ---

/**
 * Save Skyspeed config to localStorage for comparison on subsequent logins.
 */
export function saveSkyspeedConfig(config: SkyspeedConfig): void {
  localStorage.setItem(SKYSPEED_CONFIG_KEY, JSON.stringify(config))
}

/**
 * Load previously saved Skyspeed config from localStorage.
 */
export function loadSkyspeedConfig(): SkyspeedConfig | null {
  const stored = localStorage.getItem(SKYSPEED_CONFIG_KEY)
  if (!stored) return null
  try {
    return JSON.parse(stored)
  } catch {
    return null
  }
}

/**
 * Clear saved Skyspeed config from localStorage.
 */
export function clearSkyspeedConfig(): void {
  localStorage.removeItem(SKYSPEED_CONFIG_KEY)
}

/**
 * Check if a new Skyspeed config represents a server restart or reconfiguration
 * compared to the previously stored config.
 * Returns true if a reset is needed (config changed materially).
 */
export function hasSkyspeedConfigChanged(newConfig: SkyspeedConfig): boolean {
  const stored = loadSkyspeedConfig()
  if (!stored) return false  // No previous config, no change to detect

  return (
    stored.skyspeedClockFactor !== newConfig.skyspeedClockFactor ||
    stored.skyspeedServerStartTime !== newConfig.skyspeedServerStartTime
  )
}

// --- Console API for manual testing ---

// Expose manual configuration on window for console-based testing
if (typeof window !== 'undefined') {
  (window as any).setClientClock = setClientClockManual;
  (window as any).resetClientClock = resetClientClock;
  (window as any).getClientTime = () => new Date(clientNow()).toISOString();
  (window as any).getClockFactor = getClockFactor
}
