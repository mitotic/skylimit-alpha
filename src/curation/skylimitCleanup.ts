/**
 * Cleanup functions for Skylimit curation cache
 * Removes old post summaries and edition posts to prevent unbounded growth
 */

import { removeSummariesBefore, removeOldEditionPosts, getAllIntervalsSorted } from './skylimitCache'
import { getSettings } from './skylimitStore'
import { oldestInterval, nextInterval } from './skylimitGeneral'

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
    
    // Get all intervals to find the most recent one
    const intervals = await getAllIntervalsSorted()
    
    if (intervals.length === 0) {
      console.log('No intervals to clean up')
      return
    }
    
    // Find the most recent interval
    const lastInterval = intervals[intervals.length - 1]
    const nextIntervalStr = nextInterval(lastInterval)
    
    // Calculate oldest interval to keep (based on daysOfData setting)
    const oldestIntervalStr = oldestInterval(nextIntervalStr, daysOfData)
    
    // Remove summaries older than oldestIntervalStr
    const deletedSummaries = await removeSummariesBefore(oldestIntervalStr)
    
    // Remove edition posts older than 2 days
    const cutoffTime = Date.now() - EDITION_POSTS_AGO
    const deletedEditions = await removeOldEditionPosts(cutoffTime)
    
    console.log(`Cleanup complete: removed ${deletedSummaries} summary intervals and ${deletedEditions} edition posts`)
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

