/**
 * Daily post counter for Skylimit curation
 * Tracks the number of posts per day based on summaries cache, resetting at local midnight
 * Posts are numbered chronologically by posting/reposting time within each day
 * The first non-dropped post after local midnight gets #1, next gets #2, etc.
 * 
 * IMPORTANT: Counter is based on summaries cache, not displayed posts
 * Only non-dropped posts are counted (posts without curation_dropped)
 * 
 * For reposts, uses the time when they were reposted (not when original was created)
 */

import { getAllIntervals, getSummaries } from './skylimitCache'
import { PostSummary } from './types'

// Map of post URI to its assigned number (cached)
// Key format: "dateString:uri" to support multiple dates
let postCounter: Record<string, number> = {}
let lastResetDate: string = ''
let lastCounterUpdate: Record<string, number> = {} // Timestamp of last counter update per date

/**
 * Get date string in local timezone (YYYY-MM-DD) for a given date
 */
function getDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Get today's date string in local timezone
 */
function getTodayDateString(): string {
  return getDateString(new Date())
}

/**
 * Get local midnight time for a given date
 */
function getLocalMidnight(date: Date): Date {
  const localDate = new Date(date)
  localDate.setHours(0, 0, 0, 0)
  return localDate
}

/**
 * Reset counters if it's a new day
 * Note: We keep counters for previous days, so we don't clear postCounter
 * We only track the last reset date to know when to update today's counters
 */
function resetIfNewDay(): void {
  const today = getTodayDateString()
  if (today !== lastResetDate) {
    // Don't clear postCounter - we want to keep numbers for previous days
    // Just update the last reset date
    lastResetDate = today
    // Clear today's update timestamp to force recalculation
    if (lastCounterUpdate[today]) {
      delete lastCounterUpdate[today]
    }
  }
}

/**
 * Load and compute post numbers from summaries cache for a specific date
 * Only counts non-dropped posts, sorted chronologically
 * 
 * @param targetDate - The date to compute numbers for (defaults to today)
 */
async function computePostNumbersFromSummaries(targetDate?: Date): Promise<void> {
  resetIfNewDay()
  
  // Use target date or default to today
  const date = targetDate || new Date()
  const dateString = getDateString(date)
  
  // Only recompute if cache is stale (older than 30 seconds) or empty for this date
  const now = Date.now()
  if (lastCounterUpdate[dateString] && (now - lastCounterUpdate[dateString]) < 30000) {
    // Check if we already have numbers for this date
    const hasNumbersForDate = Object.keys(postCounter).some(key => key.startsWith(`${dateString}:`))
    if (hasNumbersForDate) {
      return // Use cached numbers
    }
  }
  
  try {
    // Get all intervals
    const intervals = await getAllIntervals()
    if (intervals.length === 0) {
      return
    }
    
    // Get the date range for the target date (local timezone)
    const dateStart = getLocalMidnight(date)
    const dateEnd = new Date(dateStart)
    dateEnd.setDate(dateEnd.getDate() + 1)
    
    // Collect all summaries from the target date
    const allSummaries: PostSummary[] = []
    
    for (const interval of intervals) {
      // Parse interval string (format: "YYYY-MM-DD-HH" in UTC)
      const [year, month, day, hour] = interval.split('-').map(Number)
      const intervalStartUTC = new Date(Date.UTC(year, month - 1, day, hour))
      const intervalEndUTC = new Date(intervalStartUTC)
      intervalEndUTC.setUTCHours(intervalEndUTC.getUTCHours() + 2) // 2-hour intervals
      
      // Convert to local time for comparison
      const intervalStart = new Date(intervalStartUTC.getTime())
      const intervalEnd = new Date(intervalEndUTC.getTime())
      
      // Check if interval overlaps with the target date (in local timezone)
      if (intervalEnd >= dateStart && intervalStart < dateEnd) {
        const summaries = await getSummaries(interval)
        if (summaries) {
          // Filter to only summaries from the target date and not dropped
          for (const summary of summaries) {
            // Handle timestamp - might be Date object or string from IndexedDB
            const summaryTimestamp = summary.timestamp instanceof Date 
              ? summary.timestamp 
              : new Date(summary.timestamp)
            const summaryDate = new Date(summaryTimestamp)
            
            // Check if summary is from the target date (local timezone)
            if (summaryDate >= dateStart && summaryDate < dateEnd) {
              // Only include non-dropped posts
              if (!summary.curation_dropped) {
                allSummaries.push(summary)
              }
            }
          }
        }
      }
    }
    
    // Sort by timestamp ascending (chronological order)
    // Handle timestamps that might be Date objects or strings
    allSummaries.sort((a, b) => {
      const aTime = a.timestamp instanceof Date 
        ? a.timestamp.getTime() 
        : new Date(a.timestamp).getTime()
      const bTime = b.timestamp instanceof Date 
        ? b.timestamp.getTime() 
        : new Date(b.timestamp).getTime()
      return aTime - bTime
    })
    
    // Assign numbers: first post after midnight = #1, second = #2, etc.
    // Use dateString:uri as key to support multiple dates
    allSummaries.forEach((summary, index) => {
      const key = `${dateString}:${summary.uri}`
      postCounter[key] = index + 1
    })
    
    lastCounterUpdate[dateString] = now
  } catch (error) {
    console.error('Error computing post numbers from summaries:', error)
  }
}

/**
 * Get post number for a post based on summaries cache
 * Posts are numbered chronologically within each day (first non-dropped post after midnight = #1)
 * 
 * IMPORTANT: Counter is based on summaries cache, not displayed posts
 * Dropped posts (with curation_dropped) are not counted and return 0
 * Posts from previous days show their counter number from that day
 * 
 * @param postUri - The URI of the post (original post URI)
 * @param postedAt - The timestamp when the post was posted or reposted (used to determine which day)
 * @param isRepost - Whether this is a repost (not used, kept for compatibility)
 * @param reposterDid - The DID of the user who reposted (not used, kept for compatibility)
 * @param isDropped - Whether this post was dropped by curation (if true, returns 0)
 */
export async function getPostNumber(
  postUri: string,
  postedAt: Date,
  _isRepost: boolean = false,
  _reposterDid?: string,
  isDropped: boolean = false
): Promise<number> {
  resetIfNewDay()
  
  // Dropped posts should not be counted - return 0
  if (isDropped) {
    return 0
  }
  
  // Determine which date this post is from (local timezone)
  const postDate = getDateString(postedAt)
  
  // Compute post numbers from summaries cache for this specific date
  await computePostNumbersFromSummaries(postedAt)
  
  // Return the number for this post from its date, or 0 if not found
  const key = `${postDate}:${postUri}`
  return postCounter[key] || 0
}

/**
 * Get post number without assigning (if post already counted)
 * 
 * @param postUri - The URI of the post (original post URI)
 * @param postedAt - The timestamp when the post was posted or reposted (used to determine which day)
 * @param isRepost - Whether this is a repost (not used, kept for compatibility)
 * @param reposterDid - The DID of the user who reposted (not used, kept for compatibility)
 */
export async function getPostNumberIfExists(
  postUri: string,
  postedAt: Date,
  _isRepost: boolean = false,
  _reposterDid?: string
): Promise<number | null> {
  resetIfNewDay()
  const postDate = getDateString(postedAt)
  await computePostNumbersFromSummaries(postedAt)
  const key = `${postDate}:${postUri}`
  return postCounter[key] || null
}

/**
 * Check if counter should be displayed
 */
export function shouldShowCounter(): boolean {
  // This will be controlled by settings
  // For now, always return true
  return true
}

/**
 * Get all counters (for debugging)
 * Returns counters for today by default, or for a specific date if provided
 */
export async function getAllCounters(targetDate?: Date): Promise<Record<string, number>> {
  resetIfNewDay()
  await computePostNumbersFromSummaries(targetDate)
  return { ...postCounter }
}

/**
 * Clear all counters (for testing)
 */
export function clearCounters(): void {
  postCounter = {}
  lastResetDate = ''
  lastCounterUpdate = {}
}

