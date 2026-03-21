/**
 * Feed cache core — IndexedDB CRUD, metadata, lookback, pagination, stats, and helpers
 */

import { AppBskyFeedDefs } from '@atproto/api'
import {
  initDB,
  getPostSummary,
  clearPostSummaries,
} from './skylimitCache'
import { getIntervalString, getFeedViewPostTimestamp, isRepost, getPostUniqueId } from './skylimitGeneral'
import { FeedCacheEntry, FeedCacheEntryWithPost, CurationFeedViewPost, getIntervalHoursSync } from './types'
import { getSettings } from './skylimitStore'
import { clientNow, clientDate } from '../utils/clientClock'
import { getMidnightInTimezone, getNextMidnight, getPrevMidnight } from '../utils/timezoneUtils'
import log from '../utils/logger'

// Get database instance (reuse from skylimitCache)
async function getDB(): Promise<IDBDatabase> {
  return await initDB()
}

const STORE_FEED_CACHE = 'feed_cache'

// Feed cache retention period - aligns with max lookback period
export const FEED_CACHE_RETENTION_DAYS = 2
export const FEED_CACHE_RETENTION_HOURS = FEED_CACHE_RETENTION_DAYS * 24
export const FEED_CACHE_RETENTION_MS = FEED_CACHE_RETENTION_HOURS * 60 * 60 * 1000

// Safety limits for fetch iterations and default page size
export const MAX_FETCH_ITERATIONS = 128
export const DEFAULT_PAGE_LENGTH = 25

// Cursor staleness threshold - cursors older than this are discarded
const CURSOR_STALENESS_MS = 5 * 60 * 1000  // 5 minutes

/**
 * Metadata about the last feed fetch
 */
export interface FeedCacheMetadata {
  id: 'last_fetch'
  lastCursor?: string
  lastFetchTime: number
  newestCachedPostTimestamp: number    // newest postTimestamp from last batch
  oldestCachedPostTimestamp: number   // oldest postTimestamp from last batch
  // Lookback caching tracking
  lookbackCompleted?: boolean          // true if lookback fetch completed
  lookbackCompletedAt?: number         // timestamp when lookback finished
  // Initial lookback/curation completion flag
  initialLookbackCompleted?: boolean   // true after first curation round completes
  // Secondary cache tracking (for gap-filling lookback)
  secondaryCacheActive?: boolean       // true if secondary cache is being populated
  secondaryCacheNewestTimestamp?: number  // newest post in secondary cache
  secondaryCacheOldestTimestamp?: number  // oldest post in secondary cache
  // Prev Page cursor tracking (for crossing midnight boundary)
  prevPageCursor?: string              // Cursor for continuing Prev Page pagination
  prevPageCursorReceivedAt?: number    // When the cursor was received
  prevPageCursorOldestTimestamp?: number // Oldest post timestamp from batch
}

/**
 * Get statistics about feed cache
 */
export interface FeedCacheStats {
  totalCount: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
}

/**
 * Validate feed cache integrity - ensure all feed entries have corresponding summaries
 * If any feed entry lacks a summary, clear the entire feed cache
 *
 * @returns Object indicating if cache is valid, if it was cleared, and if it was empty
 */
export async function validateFeedCacheIntegrity(): Promise<{ valid: boolean; cleared: boolean; empty: boolean }> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)

    // Get a sample of feed cache entries (first 20)
    const entries = await new Promise<FeedCacheEntry[]>((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => {
        const results = request.result as FeedCacheEntry[]
        resolve(results.slice(0, 20))
      }
      request.onerror = () => reject(request.error)
    })

    if (entries.length === 0) {
      log.debug('Cache/Integrity', 'Feed cache is empty, nothing to validate')
      return { valid: true, cleared: false, empty: true }
    }

    // Check if each sampled entry has a corresponding summary
    let missingCount = 0
    for (const entry of entries) {
      const uniqueId = getPostUniqueIdFromCache(entry)
      const summary = await getPostSummary(uniqueId)
      if (!summary) {
        missingCount++
        log.debug('Cache/Integrity', `Missing summary for feed entry: ${uniqueId}`)
      }
    }

    if (missingCount > 0) {
      log.debug('Cache/Integrity', `Found ${missingCount}/${entries.length} feed entries without summaries, clearing feed cache`)
      await clearFeedCache()
      // Also clear feed metadata to reset lookback status
      await clearFeedMetadata()
      return { valid: false, cleared: true, empty: false }
    }

    log.debug('Cache/Integrity', `All ${entries.length} sampled feed entries have summaries`)
    return { valid: true, cleared: false, empty: false }
  } catch (error) {
    log.error('Cache/Integrity', 'Failed to validate feed cache:', error)
    // On error, assume cache is valid to avoid clearing good data
    return { valid: true, cleared: false, empty: false }
  }
}

/**
 * Clear feed metadata (cursor and lookback status)
 */
export async function clearFeedMetadata(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')
    await new Promise<void>((resolve, reject) => {
      const request = store.clear()
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    log.debug('Feed Cache', 'Cleared feed metadata')
  } catch (error) {
    log.warn('Feed Cache', 'Failed to clear feed metadata:', error)
  }
}

/**
 * Clear all caches (feed cache, summaries, and metadata)
 * Use for full reset when caches are out of sync
 */
export async function clearAllCaches(): Promise<void> {
  await clearFeedCache()
  await clearPostSummaries()
  await clearFeedMetadata()
  log.info('Cache', 'Cleared all caches (feed, summaries, metadata)')
}

/**
 * Initialize feed cache store (called during DB initialization)
 */
export async function initFeedCacheStore(database: IDBDatabase): Promise<void> {
  if (!database.objectStoreNames.contains(STORE_FEED_CACHE)) {
    const store = database.createObjectStore(STORE_FEED_CACHE, { keyPath: 'uri' })
    store.createIndex('timestamp', 'timestamp', { unique: false })
    store.createIndex('interval', 'interval', { unique: false })
  }
}

/**
 * Create feed cache entries with calculated postTimestamps
 * Does NOT save to database - use savePostsToFeedCache for that
 *
 * Uses lastPostTime tracking algorithm:
 * - For original posts: use createdAt and update lastPostTime
 * - For reposts with reason.indexedAt: use that timestamp
 * - For reposts without reason.indexedAt: use current lastPostTime
 *
 * @param posts - Posts to create entries for
 * @param initialLastPostTime - Starting lastPostTime for timestamp calculation
 * @param intervalHours - The curation interval in hours
 * @returns entries and finalLastPostTime for chaining batches
 */
export function createFeedCacheEntries(
  posts: AppBskyFeedDefs.FeedViewPost[],
  initialLastPostTime: Date,
  intervalHours: number
): {
  entries: FeedCacheEntryWithPost[]
  finalLastPostTime: Date
} {
  let lastPostTime = initialLastPostTime
  const entries: FeedCacheEntryWithPost[] = []
  const now = clientNow()

  for (const post of posts) {
    let postTimestamp: Date

    if (isRepost(post)) {
      const reason = post.reason as any
      if (reason?.indexedAt) {
        // Use reason.indexedAt when available (this is the repost timestamp)
        postTimestamp = new Date(reason.indexedAt)
        if (isNaN(postTimestamp.getTime())) {
          log.warn('FeedCache', `Invalid repost indexedAt for ${post.post.uri}: ${reason.indexedAt}`)
          postTimestamp = lastPostTime
        }
      } else {
        // Use lastPostTime for reposts without reason.indexedAt
        postTimestamp = lastPostTime
      }
    } else {
      // Original post: use createdAt and update lastPostTime
      const record = post.post.record as any
      postTimestamp = new Date(record?.createdAt || post.post.indexedAt || now)
      if (isNaN(postTimestamp.getTime())) {
        log.warn('FeedCache', `Invalid post timestamp for ${post.post.uri}, using current time`)
        postTimestamp = new Date(now)
      }
      lastPostTime = postTimestamp
    }

    // Get reposter DID for reposts (for unique ID construction)
    let reposterDid: string | undefined
    if (isRepost(post)) {
      const reposter = (post.reason as any)?.by
      if (reposter?.did) {
        reposterDid = reposter.did
      }
    }

    const entry: FeedCacheEntryWithPost = {
      uniqueId: getPostUniqueId(post),
      post: {
        post: post.post,
        reason: post.reason,
      } as AppBskyFeedDefs.FeedViewPost,
      originalPost: post,
      timestamp: now,
      postTimestamp: postTimestamp.getTime(),
      interval: getIntervalString(postTimestamp, intervalHours),
      cachedAt: now,
      reposterDid,
    }
    entries.push(entry)
  }

  return { entries, finalLastPostTime: lastPostTime }
}

/**
 * Save feed cache entries to IndexedDB
 * Uses pre-calculated postTimestamps from entries (created by createFeedCacheEntries)
 *
 * @param entries - Feed cache entries with calculated postTimestamps
 * @param cursor - Cursor for pagination
 */
export async function savePostsToFeedCache(
  entries: FeedCacheEntryWithPost[],
  cursor?: string
): Promise<number> {
  try {
    if (entries.length === 0) {
      return 0
    }

    const database = await getDB()

    // Step 1: Check which entries already exist in cache (read transaction)
    const existingUniqueIds = new Set<string>()
    const readTransaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const readStore = readTransaction.objectStore(STORE_FEED_CACHE)

    // Check each entry's existence
    await Promise.all(entries.map(entry => {
      return new Promise<void>((resolve) => {
        const request = readStore.get(entry.uniqueId)
        request.onsuccess = () => {
          if (request.result) {
            existingUniqueIds.add(entry.uniqueId)
          }
          resolve()
        }
        request.onerror = () => resolve() // On error, assume not exists
      })
    }))

    // Filter to only new entries (not already cached)
    const newEntries = entries.filter(entry => !existingUniqueIds.has(entry.uniqueId))

    if (existingUniqueIds.size > 0) {
      log.debug('Feed Cache', `Skipping ${existingUniqueIds.size} already-cached posts, saving ${newEntries.length} new posts`)
    }

    // Step 2: Write only new entries (write transaction)
    const writeTransaction = database.transaction([STORE_FEED_CACHE, 'feed_metadata'], 'readwrite')
    const feedStore = writeTransaction.objectStore(STORE_FEED_CACHE)
    const metadataStore = writeTransaction.objectStore('feed_metadata')

    // Track newest and oldest postTimestamp from NEW entries only
    let newestCachedPostTimestamp = 0
    let oldestCachedPostTimestamp = Infinity

    // Queue all put operations synchronously (IndexedDB transactions auto-commit between async ops)
    for (const entry of newEntries) {
      // Track oldest/newest postTimestamp from new entries
      if (entry.postTimestamp < oldestCachedPostTimestamp) {
        oldestCachedPostTimestamp = entry.postTimestamp
      }
      if (entry.postTimestamp > newestCachedPostTimestamp) {
        newestCachedPostTimestamp = entry.postTimestamp
      }

      // Create the cache entry (without originalPost for storage)
      const cacheEntry: FeedCacheEntry = {
        uniqueId: entry.uniqueId,
        post: entry.post,
        timestamp: entry.timestamp,
        postTimestamp: entry.postTimestamp,
        interval: entry.interval,
        cachedAt: entry.cachedAt,
        reposterDid: entry.reposterDid,
      }
      feedStore.put(cacheEntry)  // Queue synchronously, don't await
      const postRecord = entry.originalPost?.post?.record as any
      log.trace('post-cached', entry.originalPost?.post?.author?.handle || '', entry.postTimestamp, postRecord?.text || '')
    }

    // Save metadata only if we have new entries (must be queued synchronously in the same transaction)
    if (newEntries.length > 0) {
      const metadata: FeedCacheMetadata = {
        id: 'last_fetch',
        lastCursor: cursor,
        lastFetchTime: clientNow(),
        newestCachedPostTimestamp: newestCachedPostTimestamp,
        oldestCachedPostTimestamp: oldestCachedPostTimestamp === Infinity ? newestCachedPostTimestamp : oldestCachedPostTimestamp,
      }
      metadataStore.put(metadata)  // Queue synchronously
    }

    // Wait for transaction to complete
    await new Promise<void>((resolve, reject) => {
      writeTransaction.oncomplete = () => resolve()
      writeTransaction.onerror = () => reject(writeTransaction.error)
      writeTransaction.onabort = () => reject(new Error('Transaction aborted'))
    })

    // Clean up old cache entries asynchronously (after transaction completes)
    setTimeout(async () => {
      try {
        await clearOldFeedCache(FEED_CACHE_RETENTION_HOURS)
      } catch (err) {
        log.warn('Feed Cache', 'Failed to clean up old feed cache:', err)
      }
    }, 0)

    return newEntries.length
  } catch (error) {
    log.warn('Feed Cache', 'Failed to save posts to feed cache:', error)
    return 0
  }
}

/**
 * Update oldestCachedPostTimestamp in feed cache metadata
 * Called after displaying a batch of posts to set new pagination boundary
 *
 * @param newOldestCachedPostTimestamp - New oldestCachedPostTimestamp (oldest postTimestamp from displayed batch)
 */
export async function updateFeedCacheOldestPostTimestamp(
  newOldestCachedPostTimestamp: number
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')

    // Get current metadata within the same transaction to avoid race conditions
    return new Promise((resolve, reject) => {
      const getRequest = store.get('last_fetch')
      getRequest.onsuccess = () => {
        const currentMetadata = getRequest.result as FeedCacheMetadata | undefined
        if (!currentMetadata) {
          log.warn('Feed Cache', 'No metadata found to update oldestCachedPostTimestamp')
          resolve()
          return
        }

        // Update oldestCachedPostTimestamp
        const updatedMetadata: FeedCacheMetadata = {
          ...currentMetadata,
          oldestCachedPostTimestamp: newOldestCachedPostTimestamp,
        }

        const putRequest = store.put(updatedMetadata)
        putRequest.onsuccess = () => {
          log.debug('Feed Cache', `Updated oldestCachedPostTimestamp from ${new Date(currentMetadata.oldestCachedPostTimestamp).toISOString()} to ${new Date(newOldestCachedPostTimestamp).toISOString()}`)
          resolve()
        }
        putRequest.onerror = () => reject(putRequest.error)
      }
      getRequest.onerror = () => reject(getRequest.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to update feed cache oldestCachedPostTimestamp:', error)
  }
}

/**
 * Get local midnight for a given date (00:00:00 in user's timezone)
 * When timezone is provided, uses Intl-based computation for consistent day boundaries.
 * Falls back to browser locale when timezone is not provided.
 */
export function getLocalMidnight(date: Date = clientDate(), timezone?: string): Date {
  if (timezone) {
    return getMidnightInTimezone(date, timezone)
  }
  // Fallback: browser locale (backward compatible)
  const midnight = new Date(date)
  midnight.setHours(0, 0, 0, 0)
  return midnight
}

/**
 * Get the next day's local midnight, DST-safe.
 * When timezone is provided, uses proper calendar day advancement.
 * Falls back to +24h when timezone is not provided.
 */
export function getNextLocalMidnight(midnight: Date, timezone?: string): Date {
  if (timezone) {
    return getNextMidnight(midnight, timezone)
  }
  return new Date(midnight.getTime() + 24 * 60 * 60 * 1000)
}

/**
 * Get the previous day's local midnight, DST-safe.
 * When timezone is provided, uses proper calendar day retreat.
 * Falls back to -24h when timezone is not provided.
 */
export function getPrevLocalMidnight(midnight: Date, timezone?: string): Date {
  if (timezone) {
    return getPrevMidnight(midnight, timezone)
  }
  return new Date(midnight.getTime() - 24 * 60 * 60 * 1000)
}

/**
 * Check if a timestamp is within the lookback period (calendar days, not hours)
 * Used to determine if feed cache is fresh enough to use
 *
 * @param timestamp - The timestamp to check (e.g., newest cached post timestamp)
 * @param lookbackDays - Number of days to look back (from settings)
 * @returns true if timestamp is within lookback period, false if stale or null
 */
export function isCacheWithinLookback(timestamp: number | null, lookbackDays: number, timezone?: string): boolean {
  if (timestamp === null) return false

  const today = clientDate()

  // Get calendar day boundary: start of the lookback day
  const todayMidnight = getLocalMidnight(today, timezone)
  const lookbackBoundary = new Date(todayMidnight)
  lookbackBoundary.setDate(lookbackBoundary.getDate() - lookbackDays)
  // When using timezone-aware midnight, the boundary is already at 00:00 in the target timezone
  // When not using timezone, getLocalMidnight already set hours to 0,0,0,0
  // Either way, subtracting days gives us the correct lookback boundary

  return timestamp >= lookbackBoundary.getTime()
}


/**
 * Detect if there's a gap in the summary cache at a given timestamp
 * Used by Load More to determine if gap filling is needed
 *
 * @param beforeTimestamp - The timestamp we're trying to load posts before
 * @returns true if a gap is detected, false otherwise
 */
export async function detectSummaryCacheGap(beforeTimestamp: number): Promise<boolean> {
  try {
    const { getPostSummariesInRange } = await import('./skylimitCache')

    // Check for summaries in a window around the target timestamp
    // Window: one interval before to the target timestamp
    const settings = await getSettings()
    const intervalHours = getIntervalHoursSync(settings)
    const GAP_THRESHOLD = intervalHours * 60 * 60 * 1000  // one interval in milliseconds
    const windowStart = beforeTimestamp - GAP_THRESHOLD
    const windowEnd = beforeTimestamp

    // Check if there are summaries in this time window
    const summaries = await getPostSummariesInRange(windowStart, windowEnd)

    if (!summaries || summaries.length === 0) {
      // No summaries in this window - potential gap
      log.debug('Gap Detection', `No summaries found in time window before ${new Date(beforeTimestamp).toLocaleTimeString()}`)
      return true
    }

    // Check if the oldest summary timestamp is close to our beforeTimestamp
    const summaryTimestamps = summaries.map(s => s.postTimestamp)
    const oldestSummaryTimestamp = Math.min(...summaryTimestamps)

    const hasGap = (beforeTimestamp - oldestSummaryTimestamp) > GAP_THRESHOLD
    if (hasGap) {
      log.debug('Gap Detection', `Gap detected: ${new Date(oldestSummaryTimestamp).toLocaleTimeString()} to ${new Date(beforeTimestamp).toLocaleTimeString()}`)
    }

    return hasGap
  } catch (error) {
    log.warn('Gap Detection', 'Error checking for gap:', error)
    return false
  }
}

/**
 * Get last fetch metadata (cursor and timestamp)
 */
export async function getLastFetchMetadata(): Promise<FeedCacheMetadata | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readonly')
    const store = transaction.objectStore('feed_metadata')

    return new Promise((resolve, reject) => {
      const request = store.get('last_fetch')
      request.onsuccess = () => {
        const result = request.result
        resolve(result || null)
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get last fetch metadata:', error)
    return null
  }
}

/**
 * Save Prev Page cursor metadata after successful server fetch
 * Used to continue pagination across midnight boundary
 */
export async function savePrevPageCursor(
  cursor: string,
  oldestPostTimestamp: number
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')

    const existingMetadata = await new Promise<FeedCacheMetadata | undefined>((resolve, reject) => {
      const request = store.get('last_fetch')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    const updatedMetadata: FeedCacheMetadata = {
      ...existingMetadata,
      id: 'last_fetch',
      lastFetchTime: existingMetadata?.lastFetchTime || clientNow(),
      newestCachedPostTimestamp: existingMetadata?.newestCachedPostTimestamp || clientNow(),
      oldestCachedPostTimestamp: existingMetadata?.oldestCachedPostTimestamp || clientNow(),
      prevPageCursor: cursor,
      prevPageCursorReceivedAt: clientNow(),
      prevPageCursorOldestTimestamp: oldestPostTimestamp
    }

    await new Promise<void>((resolve, reject) => {
      const putRequest = store.put(updatedMetadata)
      putRequest.onsuccess = () => resolve()
      putRequest.onerror = () => reject(putRequest.error)
    })

    log.verbose('Prev Page Cursor', `Saved cursor, oldest timestamp: ${new Date(oldestPostTimestamp).toLocaleTimeString()}`)
  } catch (error) {
    log.warn('Feed Cache', 'Failed to save Prev Page cursor:', error)
  }
}

/**
 * Get fresh Prev Page cursor if available and not stale (< 5 min)
 * Returns null if cursor is stale or doesn't exist
 */
export async function getFreshPrevPageCursor(): Promise<{
  cursor: string;
  oldestPostTimestamp: number;
} | null> {
  try {
    const metadata = await getLastFetchMetadata()
    if (!metadata?.prevPageCursor || !metadata.prevPageCursorReceivedAt) {
      return null
    }

    const cursorAge = clientNow() - metadata.prevPageCursorReceivedAt
    if (cursorAge >= CURSOR_STALENESS_MS) {
      return null
    }

    return {
      cursor: metadata.prevPageCursor,
      oldestPostTimestamp: metadata.prevPageCursorOldestTimestamp || clientNow()
    }
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get fresh Prev Page cursor:', error)
    return null
  }
}

/**
 * Clear Prev Page cursor (called when starting fresh pagination)
 */
export async function clearPrevPageCursor(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')

    const existingMetadata = await new Promise<FeedCacheMetadata | undefined>((resolve, reject) => {
      const request = store.get('last_fetch')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    if (existingMetadata) {
      const updatedMetadata: FeedCacheMetadata = {
        ...existingMetadata,
        prevPageCursor: undefined,
        prevPageCursorReceivedAt: undefined,
        prevPageCursorOldestTimestamp: undefined
      }

      await new Promise<void>((resolve, reject) => {
        const putRequest = store.put(updatedMetadata)
        putRequest.onsuccess = () => resolve()
        putRequest.onerror = () => reject(putRequest.error)
      })

      log.debug('Prev Page Cursor', 'Cleared')
    }
  } catch (error) {
    log.warn('Feed Cache', 'Failed to clear Prev Page cursor:', error)
  }
}

/**
 * Get diagnostic info about Prev Page cursor status
 */
export async function getPrevPageCursorStatus(): Promise<{
  available: boolean;
  message: string;
  ageSeconds?: number;
}> {
  try {
    const metadata = await getLastFetchMetadata()
    if (!metadata?.prevPageCursor || !metadata.prevPageCursorReceivedAt) {
      return {
        available: false,
        message: 'No Prev Page cursor available'
      }
    }

    const cursorAge = clientNow() - metadata.prevPageCursorReceivedAt
    const ageSeconds = Math.round(cursorAge / 1000)

    if (cursorAge >= CURSOR_STALENESS_MS) {
      return {
        available: false,
        message: `Cursor expired (${Math.round(ageSeconds / 60)} min old)`,
        ageSeconds
      }
    }

    return {
      available: true,
      message: `Cursor fresh (${ageSeconds}s old)`,
      ageSeconds
    }
  } catch (error) {
    return {
      available: false,
      message: 'Error checking cursor status'
    }
  }
}

/**
 * Calculate the lookback boundary timestamp
 * The boundary is midnight of (today - lookbackDays)
 *
 * @param lookbackDays - Number of days to look back (default 1)
 * @returns Date representing the lookback boundary
 */
export function getLookbackBoundary(lookbackDays: number = 1, timezone?: string): Date {
  const todayMidnight = getLocalMidnight(clientDate(), timezone)
  const boundary = new Date(todayMidnight)
  boundary.setDate(boundary.getDate() - lookbackDays)
  return boundary
}

/**
 * Calculate lookback progress as a percentage
 *
 * @param currentTimestamp - Timestamp of the oldest post fetched so far
 * @param lookbackBoundary - The target lookback boundary
 * @returns Progress percentage (0-100)
 */
export function calculateLookbackProgress(
  currentTimestamp: Date,
  lookbackBoundary: Date
): number {
  const now = clientDate()
  const totalSpan = now.getTime() - lookbackBoundary.getTime()
  const covered = now.getTime() - currentTimestamp.getTime()
  return Math.min(100, Math.round((covered / totalSpan) * 100))
}

/**
 * Check if cache is fresh enough to use on page load
 * Cache is considered fresh if lookback was completed within the current lookback period
 *
 * @param lookbackDays - Number of days for lookback period
 * @returns true if cache should be used, false if fresh fetch needed
 */
export async function shouldUseCacheOnLoad(lookbackDays: number = 1): Promise<boolean> {
  const metadata = await getLastFetchMetadata()
  if (!metadata) return false  // No cache, start fresh

  const settings = await getSettings()
  const lookbackBoundary = getLookbackBoundary(lookbackDays, settings.timezone)
  const lookbackBoundaryMs = lookbackBoundary.getTime()

  // Check if newest cached post is within the lookback window
  // (i.e., from yesterday or today, not day-before-yesterday or older)
  if (metadata.newestCachedPostTimestamp) {
    if (metadata.newestCachedPostTimestamp >= lookbackBoundaryMs) {
      return true  // Cache has recent posts, use it
    }
  }

  return false  // Cache is stale (posts too old) or empty
}

/**
 * Update feed cache metadata with lookback completion status
 */
export async function markLookbackComplete(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')

    // Get existing metadata
    const existingMetadata = await new Promise<FeedCacheMetadata | null>((resolve, reject) => {
      const request = store.get('last_fetch')
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })

    if (existingMetadata) {
      // Update with lookback completion
      const updatedMetadata: FeedCacheMetadata = {
        ...existingMetadata,
        lookbackCompleted: true,
        lookbackCompletedAt: clientNow()
      }

      await new Promise<void>((resolve, reject) => {
        const request = store.put(updatedMetadata)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })

      log.debug('Lookback', 'Marked lookback as complete')
    }
  } catch (error) {
    log.error('Feed Cache', 'Failed to mark lookback complete:', error)
  }
}

/**
 * Reset lookback completion status (for when starting fresh)
 */
export async function resetLookbackStatus(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')

    // Get existing metadata
    const existingMetadata = await new Promise<FeedCacheMetadata | null>((resolve, reject) => {
      const request = store.get('last_fetch')
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })

    if (existingMetadata) {
      // Reset lookback status
      const updatedMetadata: FeedCacheMetadata = {
        ...existingMetadata,
        lookbackCompleted: false,
        lookbackCompletedAt: undefined
      }

      await new Promise<void>((resolve, reject) => {
        const request = store.put(updatedMetadata)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })

      log.debug('Lookback', 'Reset lookback status')
    }
  } catch (error) {
    log.error('Feed Cache', 'Failed to reset lookback status:', error)
  }
}

/**
 * Check if initial lookback (first curation round) has completed.
 * Returns false by default (initial lookback is still active).
 */
export async function isInitialLookbackCompleted(): Promise<boolean> {
  try {
    const metadata = await getLastFetchMetadata()
    return metadata?.initialLookbackCompleted ?? false
  } catch (error) {
    log.warn('Feed Cache', 'Failed to check initial lookback status:', error)
    return false
  }
}

/**
 * Mark initial lookback as completed (first curation round done).
 * Called after recomputeCurationDecisions() completes.
 */
export async function markInitialLookbackCompleted(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')

    // Get existing metadata
    const existingMetadata = await new Promise<FeedCacheMetadata | null>((resolve, reject) => {
      const request = store.get('last_fetch')
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })

    if (existingMetadata) {
      // Update with initial lookback completion
      const updatedMetadata: FeedCacheMetadata = {
        ...existingMetadata,
        initialLookbackCompleted: true
      }

      await new Promise<void>((resolve, reject) => {
        const request = store.put(updatedMetadata)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })

      log.debug('Lookback', 'Marked initial lookback as complete')
    }
  } catch (error) {
    log.error('Feed Cache', 'Failed to mark initial lookback complete:', error)
  }
}

/**
 * Get unique ID from a feed cache entry
 * The entry.uniqueId is already set to getPostUniqueId(post) when created,
 * which includes the reposter DID prefix for reposts.
 */
export function getPostUniqueIdFromCache(entry: FeedCacheEntry): string {
  // entry.uniqueId is already the full unique ID (set by getPostUniqueId when entry was created)
  return entry.uniqueId
}

/**
 * Get all unique IDs of posts in the feed cache
 * Used by probe to skip posts already displayed
 */
export async function getCachedPostUniqueIds(): Promise<Set<string>> {
  try {
    const database = await getDB()
    const transaction = database.transaction(STORE_FEED_CACHE, 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)

    return new Promise((resolve, reject) => {
      const uniqueIds = new Set<string>()
      const request = store.openCursor()

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result
        if (cursor) {
          const entry = cursor.value as FeedCacheEntry
          uniqueIds.add(getPostUniqueIdFromCache(entry))
          cursor.continue()
        } else {
          resolve(uniqueIds)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.error('Feed Cache', 'Failed to get cached post unique IDs:', error)
    return new Set()
  }
}

/**
 * Check if a post with the given unique ID exists in the feed cache
 * Used by limited lookback to stop when hitting cached posts
 *
 * @param uniqueId - The unique ID of the post (from getPostUniqueId)
 * @returns true if the post exists in cache, false otherwise
 */
export async function checkFeedCacheExists(uniqueId: string): Promise<boolean> {
  try {
    const database = await getDB()
    const transaction = database.transaction(STORE_FEED_CACHE, 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)

    return new Promise((resolve) => {
      const request = store.get(uniqueId)
      request.onsuccess = () => resolve(!!request.result)
      request.onerror = () => resolve(false)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to check feed cache existence:', error)
    return false
  }
}

/**
 * Get cached feed posts older than a given timestamp
 * Used for pagination - gets posts before oldestCachedPostTimestamp
 *
 * @param beforeTimestamp - Get posts with postTimestamp < beforeTimestamp
 * @param limit - Maximum number of posts to return
 * @returns Array of posts sorted by postTimestamp (newest first)
 */
export async function getCachedFeedBefore(
  beforeTimestamp: number,
  limit: number = DEFAULT_PAGE_LENGTH
): Promise<{ posts: CurationFeedViewPost[]; postTimestamps: Map<string, number> }> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Query posts where postTimestamp < beforeTimestamp (exclusive upper bound)
      const range = IDBKeyRange.upperBound(beforeTimestamp, true)
      const request = index.openCursor(range, 'prev') // 'prev' for descending order (newest first)

      const results: Array<{ post: CurationFeedViewPost; postTimestamp: number; uniqueId: string; reposterDid?: string }> = []

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor && results.length < limit) {
          const entry = cursor.value as FeedCacheEntry
          const cachedPost: CurationFeedViewPost = {
            ...entry.post,
            // curation status will be looked up separately from summaries cache
          }
          results.push({
            post: cachedPost,
            postTimestamp: entry.postTimestamp,
            uniqueId: entry.uniqueId,
            reposterDid: entry.reposterDid
          })
          cursor.continue()
        } else {
          // Sort by postTimestamp descending (newest first)
          results.sort((a, b) => b.postTimestamp - a.postTimestamp)

          // Create map of post uniqueIds to postTimestamps
          const postTimestamps = new Map<string, number>()
          results.forEach(r => {
            // entry.uniqueId is already in the correct format
            postTimestamps.set(r.uniqueId, r.postTimestamp)
          })

          resolve({
            posts: results.map(r => r.post),
            postTimestamps
          })
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get cached feed before timestamp:', error)
    return { posts: [], postTimestamps: new Map() }
  }
}


/**
 * Get cached feed posts
 * Returns posts sorted by their actual creation time (not cache timestamp)
 * Filters by postTimestamp, not when they were cached
 * Note: curation status is NOT included - must be looked up from summaries cache
 */
export async function getCachedFeed(limit: number = 50): Promise<CurationFeedViewPost[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)

    return new Promise((resolve, reject) => {
      // Get all cached posts (we'll filter by postTimestamp)
      const request = store.getAll()
      const results: Array<{ post: CurationFeedViewPost; postTimestamp: number }> = []

      request.onsuccess = () => {
        const entries = request.result as FeedCacheEntry[]
        const now = clientNow()

        // Filter to only recent posts (based on postTimestamp, not cache time)
        for (const entry of entries) {
          // Use postTimestamp (actual post creation/repost time)
          // If missing (from old cache entries), compute it from post data
          let postTime = entry.postTimestamp
          if (!postTime) {
            // Migrate old entries: compute postTimestamp from post data
            postTime = getFeedViewPostTimestamp(entry.post, new Date(entry.timestamp)).getTime()
            // Optionally update the entry (but don't block on it)
            setTimeout(async () => {
              try {
                const db = await getDB()
                const tx = db.transaction([STORE_FEED_CACHE], 'readwrite')
                const store = tx.objectStore(STORE_FEED_CACHE)
                store.put({ ...entry, postTimestamp: postTime })  // Queue synchronously
                // Wait for transaction to complete
                await new Promise<void>((resolve, reject) => {
                  tx.oncomplete = () => resolve()
                  tx.onerror = () => reject(tx.error)
                })
              } catch (err) {
                // Ignore migration errors
              }
            }, 0)
          }

          // Only include posts within FEED_CACHE_RETENTION_MS
          if (postTime >= now - FEED_CACHE_RETENTION_MS) {
            const cachedPost: CurationFeedViewPost = {
              ...entry.post,
              // curation status will be looked up separately from summaries cache
            }
            results.push({ post: cachedPost, postTimestamp: postTime })
          }
        }

        // Sort by postTimestamp (descending - newest first)
        results.sort((a, b) => b.postTimestamp - a.postTimestamp)

        // Return just the posts
        resolve(results.slice(0, limit).map(r => r.post))
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get cached feed:', error)
    return []
  }
}

/**
 * Get all raw feed cache entries, optionally filtered by minimum postTimestamp.
 * Returns FeedCacheEntry[] (not converted to CurationFeedViewPost).
 * Used by recurateFromCache to read entries before clearing.
 */
export async function getAllFeedCacheEntries(
  minPostTimestamp?: number
): Promise<FeedCacheEntry[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)

    return new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => {
        let entries = request.result as FeedCacheEntry[]
        if (minPostTimestamp !== undefined) {
          entries = entries.filter(e => e.postTimestamp >= minPostTimestamp)
        }
        resolve(entries)
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get all feed cache entries:', error)
    return []
  }
}

/**
 * Get cached feed posts newer than a given timestamp
 * Used for detecting new posts - gets posts with postTimestamp > afterTimestamp
 *
 * @param afterTimestamp - Get posts with postTimestamp > afterTimestamp
 * @param limit - Maximum number of posts to return
 * @returns Count of posts newer than the timestamp
 */
export async function getCachedFeedAfter(
  afterTimestamp: number,
  limit: number = 100
): Promise<number> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Query posts where postTimestamp > afterTimestamp (exclusive lower bound)
      const range = IDBKeyRange.lowerBound(afterTimestamp, true)
      const request = index.openCursor(range, 'next') // 'next' for ascending order

      let count = 0
      const foundTimestamps: number[] = []

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor && count < limit) {
          const entry = cursor.value as FeedCacheEntry
          foundTimestamps.push(entry.postTimestamp)
          count++
          cursor.continue()
        } else {
          if (count > 0) {
            log.verbose('New Posts', `getCachedFeedAfter found ${count} posts newer than ${new Date(afterTimestamp).toISOString()}`)
            log.verbose('New Posts', `Found post timestamps:`, foundTimestamps.slice(0, 5).map(t => new Date(t).toISOString()))
          }
          resolve(count)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get cached feed after timestamp:', error)
    return 0
  }
}

/**
 * Get cached feed posts newer than a given timestamp
 * Returns the actual posts for displaying new posts
 *
 * @param afterTimestamp - Get posts with postTimestamp > afterTimestamp
 * @param limit - Maximum number of posts to return
 * @returns Array of posts sorted by postTimestamp (newest first)
 */
export async function getCachedFeedAfterPosts(
  afterTimestamp: number,
  limit: number = 50,
  adjacent: boolean = false
): Promise<CurationFeedViewPost[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Query posts where postTimestamp > afterTimestamp (exclusive lower bound)
      const range = IDBKeyRange.lowerBound(afterTimestamp, true)
      // 'prev' = newest first (default: get the N newest posts above timestamp)
      // 'next' = oldest first (adjacent: get the N posts just above timestamp, then reverse to newest-first)
      const request = index.openCursor(range, adjacent ? 'next' : 'prev')

      const results: CurationFeedViewPost[] = []

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor && results.length < limit) {
          const entry = cursor.value as FeedCacheEntry
          const cachedPost: CurationFeedViewPost = {
            ...entry.post,
            // curation status will be looked up separately from summaries cache
          }
          results.push(cachedPost)
          cursor.continue()
        } else {
          // Return newest-first in both modes
          if (adjacent) results.reverse()
          resolve(results)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get cached feed after timestamp:', error)
    return []
  }
}

/**
 * Get the newest postTimestamp from feed cache
 * Returns the highest postTimestamp value in the cache
 */
export async function getNewestCachedPostTimestamp(): Promise<number | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Get the entry with the highest postTimestamp value
      const request = index.openCursor(null, 'prev') // 'prev' for descending order

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          const entry = cursor.value as FeedCacheEntry
          resolve(entry.postTimestamp)
        } else {
          resolve(null)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get newest cached post timestamp:', error)
    return null
  }
}

/**
 * Get the oldest postTimestamp from feed cache
 * Returns the lowest postTimestamp value in the cache
 * Used for Load More to determine initialLastPostTime
 */
export async function getOldestCachedPostTimestamp(): Promise<number | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Get the entry with the lowest postTimestamp value
      const request = index.openCursor(null, 'next') // 'next' for ascending order

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          const entry = cursor.value as FeedCacheEntry
          resolve(entry.postTimestamp)
        } else {
          resolve(null)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get oldest cached post timestamp:', error)
    return null
  }
}

/**
 * Clear feed cache (useful when user actions require fresh data)
 */
export async function clearFeedCache(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readwrite')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    await new Promise<void>((resolve, reject) => {
      const request = store.clear()
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    // Clear sessionStorage feed state to maintain consistency
    sessionStorage.removeItem('websky_home_feed_state')
    sessionStorage.removeItem('websky_home_scroll_state')
  } catch (error) {
    log.warn('Feed Cache', 'Failed to clear feed cache:', error)
  }
}

/**
 * Get count of cached posts
 */
export async function getCachedPostCount(): Promise<number> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)

    return new Promise((resolve, reject) => {
      const request = store.count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get cached post count:', error)
    return 0
  }
}

/**
 * Get timestamp of the last cached post
 */
export async function getLastCachedPostTimestamp(): Promise<number | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('cachedAt')

    return new Promise((resolve, reject) => {
      // Get the entry with the highest cachedAt value (most recent)
      const request = index.openCursor(null, 'prev')

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          const entry = cursor.value as FeedCacheEntry
          resolve(entry.cachedAt)
        } else {
          resolve(null)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to get last cached post timestamp:', error)
    return null
  }
}

/**
 * Clear old feed cache entries (older than specified hours based on postTimestamp)
 * Uses postTimestamp (when post was created/reposted) rather than cachedAt
 * This ensures we keep posts that are recent, regardless of when they were cached
 */
export async function clearOldFeedCache(olderThanHours: number = FEED_CACHE_RETENTION_HOURS): Promise<number> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readwrite')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    const cutoff = clientNow() - olderThanHours * 60 * 60 * 1000
    const range = IDBKeyRange.upperBound(cutoff)

    return new Promise((resolve, reject) => {
      let deletedCount = 0
      const request = index.openCursor(range)

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          cursor.delete()
          deletedCount++
          cursor.continue()
        } else {
          resolve(deletedCount)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.warn('Feed Cache', 'Failed to clear old feed cache:', error)
    return 0
  }
}

export async function getFeedCacheStats(): Promise<FeedCacheStats> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Get count
      const countRequest = store.count()

      countRequest.onsuccess = () => {
        const totalCount = countRequest.result

        if (totalCount === 0) {
          resolve({
            totalCount: 0,
            oldestTimestamp: null,
            newestTimestamp: null,
          })
          return
        }

        // Get oldest postTimestamp (first entry in ascending order)
        const oldestRequest = index.openCursor(null, 'next')
        let oldestTimestamp: number | null = null

        oldestRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
          if (cursor) {
            const entry = cursor.value as FeedCacheEntry
            oldestTimestamp = entry.postTimestamp
            // Get newest postTimestamp (last entry in descending order)
            const newestRequest = index.openCursor(null, 'prev')

            newestRequest.onsuccess = (newestEvent) => {
              const newestCursor = (newestEvent.target as IDBRequest<IDBCursorWithValue>).result
              if (newestCursor) {
                const newestEntry = newestCursor.value as FeedCacheEntry
                resolve({
                  totalCount,
                  oldestTimestamp,
                  newestTimestamp: newestEntry.postTimestamp,
                })
              } else {
                resolve({
                  totalCount,
                  oldestTimestamp,
                  newestTimestamp: null,
                })
              }
            }

            newestRequest.onerror = () => reject(newestRequest.error)
          } else {
            resolve({
              totalCount,
              oldestTimestamp: null,
              newestTimestamp: null,
            })
          }
        }

        oldestRequest.onerror = () => reject(oldestRequest.error)
      }

      countRequest.onerror = () => reject(countRequest.error)
    })
  } catch (error) {
    log.error('Feed Cache', 'Failed to get feed cache stats:', error)
    return {
      totalCount: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
    }
  }
}

/**
 * Get all postTimestamp values from feed cache, sorted ascending.
 * Uses the postTimestamp index key cursor to avoid loading full post objects.
 */
export async function getFeedCacheTimestamps(): Promise<number[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      const timestamps: number[] = []
      const request = index.openKeyCursor(null, 'next')

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursor>).result
        if (cursor) {
          timestamps.push(cursor.key as number)
          cursor.continue()
        } else {
          resolve(timestamps)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.error('Feed Cache', 'Failed to get feed cache timestamps:', error)
    return []
  }
}

// ============================================================================
// Secondary Cache Merge and Stale Detection
// ============================================================================

/**
 * Check if the primary cache is stale (newest post > 2 calendar days old)
 * If stale, lookback should discard primary and do fresh lookback
 */
export async function isPrimaryCacheStale(): Promise<boolean> {
  try {
    const metadata = await getLastFetchMetadata()
    if (!metadata?.newestCachedPostTimestamp) {
      // No metadata means cache is empty/uninitialized - not stale, just empty
      return false
    }

    const newest = new Date(metadata.newestCachedPostTimestamp)
    const now = clientDate()

    // Calculate start of day-before-yesterday (2 calendar days ago at midnight)
    // Use settings timezone if available for consistent day boundaries
    const settings = await getSettings()
    const todayMidnight = getLocalMidnight(now, settings.timezone)
    const twoDaysAgo = new Date(todayMidnight.getTime() - 2 * 24 * 60 * 60 * 1000)

    const isStale = newest < twoDaysAgo
    if (isStale) {
      log.debug('Stale Check', `Primary cache is stale. Newest post: ${newest.toISOString()}, threshold: ${twoDaysAgo.toISOString()}`)
    }
    return isStale
  } catch (error) {
    log.error('Stale Check', 'Failed to check primary cache staleness:', error)
    return false
  }
}

/**
 * Update the feed cache metadata with the newest post timestamp
 * Called after merge to ensure metadata reflects new cache state
 */
export async function updateFeedCacheNewestPostTimestamp(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE, 'feed_metadata'], 'readwrite')
    const feedStore = transaction.objectStore(STORE_FEED_CACHE)
    const metadataStore = transaction.objectStore('feed_metadata')
    const index = feedStore.index('postTimestamp')

    // Get newest post timestamp
    const newestTimestamp = await new Promise<number | null>((resolve, reject) => {
      const request = index.openCursor(null, 'prev')
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          resolve((cursor.value as FeedCacheEntry).postTimestamp)
        } else {
          resolve(null)
        }
      }
      request.onerror = () => reject(request.error)
    })

    if (newestTimestamp) {
      // Get existing metadata
      const existingMetadata = await new Promise<FeedCacheMetadata | null>((resolve, reject) => {
        const request = metadataStore.get('last_fetch')
        request.onsuccess = () => resolve(request.result || null)
        request.onerror = () => reject(request.error)
      })

      // Update metadata with new newest timestamp
      const updatedMetadata: FeedCacheMetadata = {
        id: 'last_fetch',
        lastFetchTime: clientNow(),
        newestCachedPostTimestamp: newestTimestamp,
        oldestCachedPostTimestamp: existingMetadata?.oldestCachedPostTimestamp || newestTimestamp,
        lastCursor: existingMetadata?.lastCursor,
        lookbackCompleted: existingMetadata?.lookbackCompleted,
        lookbackCompletedAt: existingMetadata?.lookbackCompletedAt,
      }

      await new Promise<void>((resolve, reject) => {
        const request = metadataStore.put(updatedMetadata)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })

      log.debug('Merge', `Updated metadata newestCachedPostTimestamp: ${new Date(newestTimestamp).toISOString()}`)
    }
  } catch (error) {
    log.error('Merge', 'Failed to update feed cache metadata:', error)
  }
}
