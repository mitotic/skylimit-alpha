/**
 * Cleanup functions for Skylimit curation cache
 * Removes old post summaries to prevent unbounded growth
 */

import { removePostSummariesBefore } from './skylimitCache'
import { getSettings } from './skylimitStore'
import { DAYS_OF_DATA_DEFAULT } from './types'
import { FEED_CACHE_RETENTION_DAYS } from './feedCacheCore'
import { clientNow, clientTimeout, clearClientTimeout } from '../utils/clientClock'
import { isTabDormant } from '../utils/tabGuard'
import { cullEditionRegistry } from './editionRegistry'
import log from '../utils/logger'

// Cleanup constants (matching Mahoot's approach)
const CURATION_DELAY = 5 * 60 * 1000 // 5 minutes debounce delay

let cleanupTimeoutId: ReturnType<typeof setTimeout> | null = null

/**
 * Cleanup old summaries and edition posts
 */
export async function performCleanup(): Promise<void> {
  try {
    log.info('Cleanup', 'Starting Skylimit cleanup...')

    const settings = await getSettings()
    const daysOfData = settings?.daysOfData || DAYS_OF_DATA_DEFAULT

    // Calculate cutoff timestamp: daysOfData + feed cache retention buffer
    // The buffer ensures summaries remain available for reproducible re-curation
    // when statistics are computed looking back daysOfData
    const retentionDays = daysOfData + FEED_CACHE_RETENTION_DAYS
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000
    const cutoffTimestamp = clientNow() - retentionMs

    // Remove post summaries older than cutoff
    const deletedSummaries = await removePostSummariesBefore(cutoffTimestamp)

    // Cull edition registry entries whose original posts are past retention
    const culledEditions = cullEditionRegistry(cutoffTimestamp)

    log.info('Cleanup', `Cleanup complete: removed ${deletedSummaries} post summaries, ${culledEditions} edition registry entries`)
  } catch (error) {
    log.error('Cleanup', 'Error during cleanup:', error)
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
    if (isTabDormant()) { cleanupTimeoutId = null; return }
    performCleanup().catch(err => {
      log.error('Cleanup', 'Scheduled cleanup failed:', err)
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

