/**
 * Cleanup functions for Skylimit curation cache
 * Removes old post summaries and edition posts to prevent unbounded growth
 */

import { removePostSummariesBefore, removeOldEditionPosts } from './skylimitCache'
import { getSettings } from './skylimitStore'

// Cleanup constants (matching Mahoot's approach)
const CURATION_DELAY = 5 * 60 * 1000 // 5 minutes debounce delay
const EDITION_POSTS_AGO = 2 * 24 * 60 * 60 * 1000 // 2 days ago

let cleanupTimeoutId: number | null = null

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
    const cutoffTimestamp = Date.now() - retentionMs

    // Remove post summaries older than cutoff
    const deletedSummaries = await removePostSummariesBefore(cutoffTimestamp)

    // Remove edition posts older than 2 days
    const editionCutoffTime = Date.now() - EDITION_POSTS_AGO
    const deletedEditions = await removeOldEditionPosts(editionCutoffTime)

    console.log(`Cleanup complete: removed ${deletedSummaries} post summaries and ${deletedEditions} edition posts`)
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
    clearTimeout(cleanupTimeoutId)
  }
  
  // Schedule cleanup after delay
  cleanupTimeoutId = window.setTimeout(() => {
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
    clearTimeout(cleanupTimeoutId)
    cleanupTimeoutId = null
  }
}

