/**
 * Numbering system for curation counters
 * Assigns invariant postNumber and curationNumber to posts
 *
 * - postNumber: Sequential count of ALL posts in follow feed for the day (1, 2, 3, ...)
 * - curationNumber: 0 for dropped posts, sequential count of shown posts (1, 2, 3, ...)
 * - Both reset to 1 at the start of each local day
 */

import { getAllPostSummaries, getPostSummariesInRange, initDB } from './skylimitCache'
import { getLocalMidnight, getNextLocalMidnight } from './skylimitFeedCache'
import { PostSummary, isStatusDrop, isStatusShow } from './types'
import { getSettings } from './skylimitStore'
import log from '../utils/logger'

/**
 * Get date string in local timezone (YYYY-MM-DD) for a given timestamp.
 * When timezone is provided, formats the date in that timezone.
 */
function getDateString(timestamp: number, timezone?: string): string {
  const date = new Date(timestamp)
  if (timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    })
    const parts = formatter.formatToParts(date)
    const year = parts.find(p => p.type === 'year')!.value
    const month = parts.find(p => p.type === 'month')!.value
    const day = parts.find(p => p.type === 'day')!.value
    return `${year}-${month}-${day}`
  }
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Save summaries with updated numbers to IndexedDB
 */
async function saveNumberedSummaries(summaries: PostSummary[]): Promise<void> {
  if (summaries.length === 0) return

  const database = await initDB()
  const transaction = database.transaction(['post_summaries'], 'readwrite')
  const store = transaction.objectStore('post_summaries')

  for (const summary of summaries) {
    // Re-read from store to preserve fields (e.g., viewedAt) that may have been
    // written concurrently since the summary was originally read
    const fresh = await new Promise<PostSummary | null>((resolve) => {
      const request = store.get(summary.uniqueId)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => resolve(null)
    })
    if (fresh) {
      // Apply only the numbering fields to the fresh copy
      fresh.postNumber = summary.postNumber
      fresh.curationNumber = summary.curationNumber
      store.put(fresh)
    } else {
      store.put(summary)
    }
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

/**
 * Assign numbers to all posts within a date range
 * Called after lookback completes and stats are computed
 *
 * @param startOfDay - Start of the local day (midnight) in milliseconds
 * @param endOfDay - End of the day (next midnight) in milliseconds
 * @returns Count of posts numbered
 */
export async function assignNumbersForDay(
  startOfDay: number,
  endOfDay: number
): Promise<{ postCount: number; shownCount: number }> {
  // Get all summaries for this day
  const summaries = await getPostSummariesInRange(startOfDay, endOfDay)

  if (summaries.length === 0) {
    return { postCount: 0, shownCount: 0 }
  }

  // Sort chronologically (oldest first = #1)
  summaries.sort((a, b) => a.postTimestamp - b.postTimestamp)

  let postNumber = 0
  let curationNumber = 0
  const updatedSummaries: PostSummary[] = []

  for (const summary of summaries) {
    postNumber++
    summary.postNumber = postNumber

    if (isStatusDrop(summary.curation_status)) {
      summary.curationNumber = 0
    } else if (isStatusShow(summary.curation_status)) {
      curationNumber++
      summary.curationNumber = curationNumber
    } else {
      // Unknown status - leave as null
      summary.curationNumber = null
    }

    updatedSummaries.push(summary)
  }

  // Batch save updates
  await saveNumberedSummaries(updatedSummaries)

  log.debug('Numbering', `Assigned numbers for day ${getDateString(startOfDay)}: ${postNumber} posts, ${curationNumber} shown`)

  return { postCount: postNumber, shownCount: curationNumber }
}

/**
 * Assign numbers for all complete days in cache
 * Called after lookback completes
 */
export async function assignAllNumbers(): Promise<void> {
  const summaries = await getAllPostSummaries()
  if (summaries.length === 0) {
    log.debug('Numbering', 'No summaries to number')
    return
  }

  // Get stored timezone for consistent day boundaries
  const settings = await getSettings()
  const timezone = settings.timezone

  // Find the date range
  let oldestTimestamp = Infinity
  let newestTimestamp = 0
  for (const s of summaries) {
    if (s.postTimestamp < oldestTimestamp) oldestTimestamp = s.postTimestamp
    if (s.postTimestamp > newestTimestamp) newestTimestamp = s.postTimestamp
  }

  if (!isFinite(oldestTimestamp) || !isFinite(newestTimestamp) || newestTimestamp === 0) {
    log.warn('Numbering', `Invalid timestamp range (oldest=${oldestTimestamp}, newest=${newestTimestamp}), skipping`)
    return
  }

  // Process each day
  const startDate = new Date(oldestTimestamp)
  const endDate = new Date(newestTimestamp)

  let currentDay = getLocalMidnight(startDate, timezone)
  const finalDay = getLocalMidnight(endDate, timezone)

  log.debug('Numbering', `Assigning numbers from ${getDateString(currentDay.getTime(), timezone)} to ${getDateString(finalDay.getTime(), timezone)}`)

  let totalPosts = 0
  let totalShown = 0

  while (currentDay <= finalDay) {
    const nextDay = getNextLocalMidnight(currentDay, timezone)

    const { postCount, shownCount } = await assignNumbersForDay(currentDay.getTime(), nextDay.getTime())
    totalPosts += postCount
    totalShown += shownCount

    currentDay = nextDay
  }

  log.info('Numbering', `Complete: ${totalPosts} total posts, ${totalShown} shown across all days`)
}

/**
 * Get the highest postNumber and curationNumber for a specific day
 */
export async function getMaxNumbersForDay(
  startOfDay: number,
  endOfDay: number
): Promise<{ maxPostNumber: number; maxCurationNumber: number }> {
  const summaries = await getPostSummariesInRange(startOfDay, endOfDay)

  let maxPostNumber = 0
  let maxCurationNumber = 0

  for (const s of summaries) {
    if (s.postNumber && s.postNumber > maxPostNumber) {
      maxPostNumber = s.postNumber
    }
    if (s.curationNumber && s.curationNumber > maxCurationNumber) {
      maxCurationNumber = s.curationNumber
    }
  }

  return { maxPostNumber, maxCurationNumber }
}

/**
 * Incrementally assign numbers for new posts (forward direction)
 * Called during paged updates when posts are added to cache
 *
 * Always overwrites numbers for consistency. Warns once per batch if overwriting
 * existing numbers (which may indicate a bug in the numbering flow).
 *
 * @param newSummaries - Newly cached summaries to number (will be mutated)
 * @param existingMaxPostNumber - Current max postNumber for the day
 * @param existingMaxCurationNumber - Current max curationNumber for the day
 */
export async function assignIncrementalNumbers(
  newSummaries: PostSummary[],
  existingMaxPostNumber: number,
  existingMaxCurationNumber: number
): Promise<void> {
  if (newSummaries.length === 0) return

  // Sort new summaries chronologically (oldest first for forward numbering)
  newSummaries.sort((a, b) => a.postTimestamp - b.postTimestamp)

  let postNumber = existingMaxPostNumber
  let curationNumber = existingMaxCurationNumber
  let warnedAboutOverwrite = false

  for (const summary of newSummaries) {
    // Check if we're overwriting existing numbers (warn once per batch)
    if (!warnedAboutOverwrite &&
        summary.postNumber !== null && summary.postNumber !== undefined) {
      const postDate = new Date(summary.postTimestamp)
      const newCurationNum = isStatusShow(summary.curation_status) ? curationNumber + 1 :
                             isStatusDrop(summary.curation_status) ? 0 : null
      log.warn('Numbering', `WARNING: Overwriting existing numbers. ` +
        `First occurrence at ${postDate.toLocaleString()}: ` +
        `postNumber ${summary.postNumber} → ${postNumber + 1}, ` +
        `curationNumber ${summary.curationNumber} → ${newCurationNum}`)
      warnedAboutOverwrite = true
    }

    // Always assign numbers (overwrite for consistency)
    postNumber++
    summary.postNumber = postNumber

    if (isStatusDrop(summary.curation_status)) {
      summary.curationNumber = 0
    } else if (isStatusShow(summary.curation_status)) {
      curationNumber++
      summary.curationNumber = curationNumber
    } else {
      // Unknown status - leave as null
      summary.curationNumber = null
    }
  }

  await saveNumberedSummaries(newSummaries)

  log.debug('Numbering', `Incremental: assigned numbers to ${newSummaries.length} posts (postNumber ${existingMaxPostNumber + 1}-${postNumber}, curationNumber up to ${curationNumber})`)
}

/**
 * Number all unnumbered post summaries within a day range.
 * Consolidates the repeated pattern of finding unnumbered posts and assigning numbers.
 *
 * @param dayStart - Start of day (midnight timestamp in ms)
 * @param dayEnd - End of day (next midnight timestamp in ms)
 * @param topic - Log topic for debugging (e.g., "Prefetch")
 * @returns Number of posts that were assigned numbers
 */
export async function numberUnnumberedPostsForDay(
  dayStart: number,
  dayEnd: number,
  topic: string
): Promise<number> {
  const { maxPostNumber, maxCurationNumber } = await getMaxNumbersForDay(dayStart, dayEnd)
  const allSummaries = await getPostSummariesInRange(dayStart, dayEnd)
  const unnumbered = allSummaries.filter(
    s => s.postNumber === null || s.postNumber === undefined
  )
  if (unnumbered.length > 0) {
    await assignIncrementalNumbers(unnumbered, maxPostNumber, maxCurationNumber)
    log.debug(topic, `Assigned numbers to ${unnumbered.length} posts`)
  }
  return unnumbered.length
}

