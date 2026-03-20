/**
 * Background worker for computing statistics
 */

import { BskyAgent } from '@atproto/api'
import { computePostStats } from './skylimitStats'
import { getSettings } from './skylimitStore'
import { refreshFollows, sweepFollowCache } from './skylimitFollows'
import { scheduleCleanup } from './skylimitCleanup'
import { getIntervalHoursSync } from './types'
import { clientInterval, clearClientInterval, clientTimeout, clearClientTimeout, clientNow } from '../utils/clientClock'
import { isTabDormant } from '../utils/tabGuard'
import log from '../utils/logger'

/**
 * Compute statistics in the background
 */
export async function computeStatsInBackground(
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  forceRefreshFollows: boolean = false,
  onFollowsProgress?: (percent: number) => void
): Promise<void> {
  try {
    const settings = await getSettings()

    // Refresh follows first (only if forced or it's been more than an hour)
    // Wait for completion so cached follows are available for stats computation
    try {
      await refreshFollows(agent, myDid, forceRefreshFollows, onFollowsProgress)
    } catch (err) {
      log.warn('Stats Worker', 'refreshFollows failed (non-critical):', err)
    }

    // Compute statistics (follows are now cached)
    await computePostStats(
      settings.viewsPerDay,
      settings.daysOfData,
      myUsername,
      myDid,
      settings.secretKey
    )

    // Check if daily follow cache sweep is due (targets noon local time)
    const now = new Date(clientNow())
    if (now.getHours() >= 12) {
      try {
        await sweepFollowCache(agent, myDid)
      } catch (err) {
        log.warn('Stats Worker', 'sweepFollowCache failed (non-critical):', err)
      }
    }

    // Schedule cleanup after stats computation
    scheduleCleanup()
  } catch (error) {
    log.error('Stats Worker', 'Failed to compute statistics:', error)
  }
}

/**
 * Schedule periodic statistics computation
 * Uses curation interval from settings to determine scheduling frequency
 */
export function scheduleStatsComputation(
  agent: BskyAgent,
  myUsername: string,
  myDid: string
): () => void {
  // Track cleanup state
  let intervalId: ReturnType<typeof setInterval> | null = null
  let initialTimeout: ReturnType<typeof setTimeout> | null = null
  let isCleanedUp = false

  // Initialize scheduling asynchronously
  getSettings().then(settings => {
    if (isCleanedUp) return // Don't schedule if already cleaned up

    const intervalHours = getIntervalHoursSync(settings)
    const intervalMs = intervalHours * 60 * 60 * 1000

    // Don't run immediately on page load - wait for the interval
    // This prevents excessive API calls when navigating back to home page

    // Schedule periodic runs
    intervalId = clientInterval(() => {
      if (isTabDormant()) return
      computeStatsInBackground(agent, myUsername, myDid, false)
    }, intervalMs)

    // Run once after a short delay to initialize (but don't force follow refresh)
    // This allows initial stats computation without hitting rate limits
    initialTimeout = clientTimeout(() => {
      if (isTabDormant()) return
      computeStatsInBackground(agent, myUsername, myDid, false)
    }, 5000) // Wait 5 seconds after page load
  }).catch(err => {
    log.warn('Stats Worker', 'Failed to get settings for stats scheduling:', err)
  })

  // Return cleanup function
  return () => {
    isCleanedUp = true
    if (intervalId !== null) clearClientInterval(intervalId)
    if (initialTimeout !== null) clearClientTimeout(initialTimeout)
  }
}

