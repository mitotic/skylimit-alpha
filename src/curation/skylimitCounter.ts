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

import { getAllPostSummaries } from './skylimitCache'

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
    // Get all post summaries
    const allSummaries = await getAllPostSummaries()
    if (allSummaries.length === 0) {
      return
    }

    // Get the date range for the target date (local timezone)
    const dateStart = getLocalMidnight(date)
    const dateEnd = new Date(dateStart)
    dateEnd.setDate(dateEnd.getDate() + 1)

    // Filter summaries from the target date that are not dropped
    // Use postTimestamp for filtering (numeric timestamp)
    const summariesForDate = allSummaries.filter(summary => {
      const summaryDate = new Date(summary.postTimestamp)
      return summaryDate >= dateStart && summaryDate < dateEnd && !summary.curation_dropped
    })

    // Sort by postTimestamp ascending (chronological order)
    summariesForDate.sort((a, b) => a.postTimestamp - b.postTimestamp)

    // Assign numbers: first post after midnight = #1, second = #2, etc.
    // Use dateString:uniqueId as key to support multiple dates
    summariesForDate.forEach((summary, index) => {
      const key = `${dateString}:${summary.uniqueId}`
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _isRepost = false,
   
  _reposterDid?: string,
  isDropped = false
): Promise<number> {
  resetIfNewDay()

  // Dropped posts should not be counted - return 0
  if (isDropped) {
    return 0
  }

  // Determine which date this post is from (local timezone)
  const postDate = getDateString(postedAt)

  // First check if we already have a number for this post
  const key = `${postDate}:${postUri}`
  if (postCounter[key]) {
    return postCounter[key]
  }

  // Post not found in cache - force recomputation by clearing the update timestamp
  // This handles the case where new posts were added after the last computation
  delete lastCounterUpdate[postDate]

  // Compute post numbers from summaries cache for this specific date
  await computePostNumbersFromSummaries(postedAt)

  // Return the number for this post from its date, or 0 if not found
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _isRepost = false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

