/**
 * Cleanup functions for Skylimit curation cache
 * Removes old post summaries to prevent unbounded growth
 */

import { removePostSummariesBefore } from './skylimitCache'
import { getSettings } from './skylimitStore'
import { clientNow, clientTimeout, clearClientTimeout } from '../utils/clientClock'
import { cullEditionRegistry } from './editionRegistry'

// Cleanup constants (matching Mahoot's approach)
const CURATION_DELAY = 5 * 60 * 1000 // 5 minutes debounce delay

let cleanupTimeoutId: ReturnType<typeof setTimeout> | null = null

/**
 * Cleanup old summaries and edition posts
 */
export async function performCleanup(): Promise<void> {
  try {
    console.log('Starting Skylimit cleanup...')

    const settings = await getSettings()
    const daysOfData = settings?.daysOfData || 30

    // Calculate cutoff timestamp based on daysOfData setting
    const retentionMs = daysOfData * 24 * 60 * 60 * 1000
    const cutoffTimestamp = clientNow() - retentionMs

    // Remove post summaries older than cutoff
    const deletedSummaries = await removePostSummariesBefore(cutoffTimestamp)

    // Cull edition registry entries whose original posts are past retention
    const culledEditions = cullEditionRegistry(cutoffTimestamp)

    console.log(`Cleanup complete: removed ${deletedSummaries} post summaries, ${culledEditions} edition registry entries`)
  } catch (error) {
    console.error('Error during cleanup:', error)
  }
}

/**
 * Schedule cleanup with debouncing (similar to Mahoot's approach)
 * Cleanup will run after CURATION_DELAY milliseconds of inactivity
 */
export function scheduleCleanup(): void {
  // Clear existing timeout
  if (cleanupTimeoutId !== null) {
    clearClientTimeout(cleanupTimeoutId)
  }

  // Schedule cleanup after delay (uses client clock for accelerated time)
  cleanupTimeoutId = clientTimeout(() => {
    performCleanup().catch(err => {
      console.error('Scheduled cleanup failed:', err)
    })
    cleanupTimeoutId = null
  }, CURATION_DELAY)
}

/**
 * Cancel scheduled cleanup
 */
export function cancelScheduledCleanup(): void {
  if (cleanupTimeoutId !== null) {
    clearClientTimeout(cleanupTimeoutId)
    cleanupTimeoutId = null
  }
}

