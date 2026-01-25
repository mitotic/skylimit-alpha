/**
 * Background worker for computing statistics
 */

import { BskyAgent } from '@atproto/api'
import { computePostStats } from './skylimitStats'
import { getSettings } from './skylimitStore'
import { refreshFollows } from './skylimitFollows'
import { scheduleCleanup } from './skylimitCleanup'
import { getIntervalHoursSync } from './types'

/**
 * Compute statistics in the background
 */
export async function computeStatsInBackground(
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  forceRefreshFollows: boolean = false
): Promise<void> {
  try {
    const settings = await getSettings()
    if (settings.disabled) {
      return
    }
    
    // Refresh follows first (only if forced or it's been more than an hour)
    // But don't block stats computation - do it in background
    refreshFollows(agent, myDid, forceRefreshFollows).catch((err) => {
      console.warn('Follow refresh failed (non-critical):', err)
    })
    
    // Compute statistics (don't wait for follow refresh to complete)
    await computePostStats(
      settings.viewsPerDay,
      settings.daysOfData,
      myUsername,
      myDid,
      settings.secretKey
    )
    
    // Schedule cleanup after stats computation
    scheduleCleanup()
  } catch (error) {
    console.error('Failed to compute statistics:', error)
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
    intervalId = setInterval(() => {
      computeStatsInBackground(agent, myUsername, myDid, false)
    }, intervalMs)

    // Run once after a short delay to initialize (but don't force follow refresh)
    // This allows initial stats computation without hitting rate limits
    initialTimeout = setTimeout(() => {
      computeStatsInBackground(agent, myUsername, myDid, false)
    }, 5000) // Wait 5 seconds after page load
  }).catch(err => {
    console.warn('Failed to get settings for stats scheduling:', err)
  })

  // Return cleanup function
  return () => {
    isCleanedUp = true
    if (intervalId !== null) clearInterval(intervalId)
    if (initialTimeout !== null) clearTimeout(initialTimeout)
  }
}

