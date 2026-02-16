/**
 * Feed cache using IndexedDB
 * Stores full FeedViewPost objects for display, leveraging the existing Skylimit cache infrastructure
 */

import { AppBskyFeedDefs, BskyAgent } from '@atproto/api'
import {
  initDB,
  getPostSummary,
  clearPostSummaries,
  isInPrimaryCache,
  saveEditionPost,
  getFilter,
  getAllFollows,
  savePostsToPrimaryCache,
  savePostSummariesForce,
} from './skylimitCache'
import { getIntervalString, getFeedViewPostTimestamp, isRepost, getPostUniqueId, createPostSummary, getEditionTimeStrs } from './skylimitGeneral'
import { CurationFeedViewPost, FeedCacheEntry, FeedCacheEntryWithPost, PostSummary, isStatusShow, isStatusDrop, getIntervalHoursSync, FetchMode, FetchStopReason, SecondaryEntry, SecondaryFetchResult } from './types'
import { curatePosts } from './skylimitTimeline'
import { curateSinglePost } from './skylimitFilter'
import { getMaxNumbersForDay } from './skylimitNumbering'
import { getHomeFeed } from '../api/feed'
import { getSettings } from './skylimitStore'
import { clientNow, clientDate } from '../utils/clientClock'

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
      console.log('[Cache Integrity] Feed cache is empty, nothing to validate')
      return { valid: true, cleared: false, empty: true }
    }

    // Check if each sampled entry has a corresponding summary
    let missingCount = 0
    for (const entry of entries) {
      const uniqueId = getPostUniqueIdFromCache(entry)
      const summary = await getPostSummary(uniqueId)
      if (!summary) {
        missingCount++
        console.log(`[Cache Integrity] Missing summary for feed entry: ${uniqueId}`)
      }
    }

    if (missingCount > 0) {
      console.log(`[Cache Integrity] Found ${missingCount}/${entries.length} feed entries without summaries, clearing feed cache`)
      await clearFeedCache()
      // Also clear feed metadata to reset lookback status
      await clearFeedMetadata()
      return { valid: false, cleared: true, empty: false }
    }

    console.log(`[Cache Integrity] All ${entries.length} sampled feed entries have summaries`)
    return { valid: true, cleared: false, empty: false }
  } catch (error) {
    console.error('[Cache Integrity] Failed to validate feed cache:', error)
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
    console.log('[Feed Cache] Cleared feed metadata')
  } catch (error) {
    console.warn('Failed to clear feed metadata:', error)
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
  console.log('[Cache] Cleared all caches (feed, summaries, metadata)')
}

/**
 * Save posts to feed cache AND curate them (save summaries)
 * This ensures feed cache entries always have corresponding summary entries
 *
 * @param entries - Feed cache entries with calculated postTimestamps
 * @param cursor - Cursor for pagination
 * @param agent - BskyAgent instance
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @returns Object with curatedFeed and savedCount (number of new posts saved to cache)
 */
export async function savePostsWithCuration(
  entries: FeedCacheEntryWithPost[],
  cursor: string | undefined,
  agent: BskyAgent,
  myUsername: string,
  myDid: string
): Promise<{ curatedFeed: CurationFeedViewPost[], savedCount: number }> {
  // 1. Save to feed cache (returns count of newly saved posts)
  const savedCount = await savePostsToFeedCache(entries, cursor)

  // 2. Curate and save summaries (must succeed for cache integrity)
  const curatedFeed = await curatePosts(entries, agent, myUsername, myDid)

  return { curatedFeed, savedCount }
}

/**
 * Curate feed cache entries into in-memory SecondaryEntry[] format.
 * Does NOT write to primary cache or summaries — only creates in-memory entries.
 * Used by idle return mode to defer primary cache writes until lookback completes.
 *
 * Reuses the same inline curation logic as fetchToSecondaryFeedCache.
 */
export async function curateEntriesToSecondary(
  entries: FeedCacheEntryWithPost[],
  myUsername: string,
  myDid: string,
): Promise<SecondaryEntry[]> {
  // Setup curation context (same as fetchToSecondaryFeedCache)
  const settings = await getSettings()
  const [currentStats, currentProbs] = await getFilter() || [null, null]
  const currentFollows = await getAllFollows()
  const followMap: Record<string, any> = {}
  for (const follow of currentFollows) {
    followMap[follow.username] = follow
  }
  const editionTimeStrs = await getEditionTimeStrs()
  const editionCount = editionTimeStrs.length
  const secretKey = settings?.secretKey || 'default'

  const result: SecondaryEntry[] = []
  for (const entry of entries) {
    const existingSummary = await getPostSummary(entry.uniqueId)
    let summary: PostSummary
    if (existingSummary) {
      summary = existingSummary
    } else {
      const curationResult = await curateSinglePost(
        entry.originalPost, myUsername, myDid, followMap,
        currentStats, currentProbs, secretKey, editionCount
      )
      summary = createPostSummary(entry.originalPost, new Date(entry.postTimestamp))
      summary.curation_status = curationResult.curation_status
      summary.curation_msg = curationResult.curation_msg
      if (curationResult.curation_save) {
        summary.curation_save = curationResult.curation_save
      }
    }
    result.push({ entry, summary })
  }
  return result
}

/**
 * Convert SecondaryEntry[] to CurationFeedViewPost[] for display.
 * Uses in-memory summaries (no IndexedDB reads).
 */
export function secondaryEntriesToCuratedFeed(
  secondaryEntries: SecondaryEntry[]
): CurationFeedViewPost[] {
  return secondaryEntries.map(({ entry, summary }) => ({
    ...entry.originalPost,
    curation: {
      curation_status: summary.curation_status,
      curation_msg: summary.curation_msg,
    }
  }))
}

/**
 * Filter SecondaryEntry[] for display, applying the same curation logic
 * as lookupCurationAndFilter but using in-memory summaries.
 * Returns CurationFeedViewPost[] sorted newest-first by postTimestamp.
 */
export function filterSecondaryForDisplay(
  secondaryEntries: SecondaryEntry[],
  curationSuspended: boolean,
  showAllPosts: boolean,
): CurationFeedViewPost[] {
  const result: CurationFeedViewPost[] = []

  for (const { entry, summary } of secondaryEntries) {
    const curatedPost: CurationFeedViewPost = {
      ...entry.originalPost,
      curation: {
        curation_status: summary.curation_status,
        curation_msg: summary.curation_msg,
      }
    }

    // Apply same filtering logic as lookupCurationAndFilter
    if (curationSuspended) {
      // Show all except reply_drop (Bluesky default behavior)
      if (summary.curation_status !== 'reply_drop') {
        result.push(curatedPost)
      }
    } else if (showAllPosts) {
      result.push(curatedPost)
    } else if (isStatusShow(summary.curation_status)) {
      result.push(curatedPost)
    }
  }

  // Sort newest-first by postTimestamp using a lookup map
  const timestampMap = new Map<string, number>()
  for (const { entry } of secondaryEntries) {
    timestampMap.set(entry.uniqueId, entry.postTimestamp)
  }
  result.sort((a, b) => {
    const aTs = timestampMap.get(getPostUniqueId(a)) ?? 0
    const bTs = timestampMap.get(getPostUniqueId(b)) ?? 0
    return bTs - aTs
  })

  return result
}

// Get database instance (reuse from skylimitCache)
async function getDB(): Promise<IDBDatabase> {
  return await initDB()
}

const STORE_FEED_CACHE = 'feed_cache'

// Feed cache retention period - aligns with max lookback period (2 days)
export const FEED_CACHE_RETENTION_HOURS = 48
export const FEED_CACHE_RETENTION_MS = FEED_CACHE_RETENTION_HOURS * 60 * 60 * 1000

// Safety limits for fetch iterations and default page size
const MAX_FETCH_ITERATIONS = 80
const DEFAULT_PAGE_LENGTH = 25

// Cursor staleness threshold - cursors older than this are discarded
const CURSOR_STALENESS_MS = 5 * 60 * 1000  // 5 minutes

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

// FeedCacheEntry and FeedCacheEntryWithPost are imported from types.ts

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
      } else {
        // Use lastPostTime for reposts without reason.indexedAt
        postTimestamp = lastPostTime
      }
    } else {
      // Original post: use createdAt and update lastPostTime
      const record = post.post.record as any
      postTimestamp = new Date(record?.createdAt || post.post.indexedAt || now)
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
      console.log(`[Feed Cache] Skipping ${existingUniqueIds.size} already-cached posts, saving ${newEntries.length} new posts`)
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
        console.warn('Failed to clean up old feed cache:', err)
      }
    }, 0)

    return newEntries.length
  } catch (error) {
    console.warn('Failed to save posts to feed cache:', error)
    return 0
  }
}

/**
 * Metadata about the last feed fetch
 */
interface FeedCacheMetadata {
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
          console.warn('No metadata found to update oldestCachedPostTimestamp')
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
          console.log(`[Feed Cache] Updated oldestCachedPostTimestamp from ${new Date(currentMetadata.oldestCachedPostTimestamp).toISOString()} to ${new Date(newOldestCachedPostTimestamp).toISOString()}`)
          resolve()
        }
        putRequest.onerror = () => reject(putRequest.error)
      }
      getRequest.onerror = () => reject(getRequest.error)
    })
  } catch (error) {
    console.warn('Failed to update feed cache oldestCachedPostTimestamp:', error)
  }
}


/**
 * Get local midnight for a given date (00:00:00 in user's timezone)
 */
export function getLocalMidnight(date: Date = clientDate()): Date {
  const midnight = new Date(date)
  midnight.setHours(0, 0, 0, 0)
  return midnight
}

/**
 * Check if a timestamp is within the lookback period (calendar days, not hours)
 * Used to determine if feed cache is fresh enough to use
 *
 * @param timestamp - The timestamp to check (e.g., newest cached post timestamp)
 * @param lookbackDays - Number of days to look back (from settings)
 * @returns true if timestamp is within lookback period, false if stale or null
 */
export function isCacheWithinLookback(timestamp: number | null, lookbackDays: number): boolean {
  if (timestamp === null) return false

  const today = clientDate()

  // Get calendar day boundary: start of the lookback day
  const lookbackBoundary = new Date(today)
  lookbackBoundary.setDate(lookbackBoundary.getDate() - lookbackDays)
  lookbackBoundary.setHours(0, 0, 0, 0)  // Start of the lookback day

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
      console.log(`[Gap Detection] No summaries found in time window before ${new Date(beforeTimestamp).toLocaleTimeString()}`)
      return true
    }

    // Check if the oldest summary timestamp is close to our beforeTimestamp
    const summaryTimestamps = summaries.map(s => s.postTimestamp)
    const oldestSummaryTimestamp = Math.min(...summaryTimestamps)

    const hasGap = (beforeTimestamp - oldestSummaryTimestamp) > GAP_THRESHOLD
    if (hasGap) {
      console.log(`[Gap Detection] Gap detected: ${new Date(oldestSummaryTimestamp).toLocaleTimeString()} to ${new Date(beforeTimestamp).toLocaleTimeString()}`)
    }

    return hasGap
  } catch (error) {
    console.warn('[Gap Detection] Error checking for gap:', error)
    return false
  }
}

/**
 * Fill a gap in the cache back to local midnight
 * Used by Load More when a gap is detected
 * Stops when hitting cached posts OR reaching local midnight of the target date
 *
 * @param fromTimestamp - The timestamp where the gap starts (Load More's beforeTimestamp)
 * @param agent - BskyAgent for API calls
 * @param myUsername - User's username
 * @param myDid - User's DID
 * @param pageLength - Number of posts per page (default 25)
 * @returns Number of new posts cached during gap fill
 */
export async function fillGapToMidnight(
  fromTimestamp: number,
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  pageLength: number = DEFAULT_PAGE_LENGTH
): Promise<number> {
  // Use local midnight of the day containing fromTimestamp as the stop boundary
  const targetDate = new Date(fromTimestamp)
  const localMidnight = getLocalMidnight(targetDate).getTime()

  // If fromTimestamp is already at or before midnight, no gap fill needed
  if (fromTimestamp <= localMidnight) {
    console.log('[Gap Fill] Already at or past midnight boundary, skipping')
    return 0
  }

  // Get interval settings for cache entries
  const settings = await getSettings()
  const intervalHours = getIntervalHoursSync(settings)

  console.log(`[Gap Fill] Filling gap from ${new Date(fromTimestamp).toLocaleTimeString()} to midnight ${new Date(localMidnight).toLocaleTimeString()}`)

  let currentOldestTimestamp = fromTimestamp
  let cursor: string | undefined
  let totalNewPosts = 0
  let iterations = 0
  const maxIterations = MAX_FETCH_ITERATIONS

  // Keep fetching backward until we hit midnight OR cached posts
  while (currentOldestTimestamp > localMidnight && iterations < maxIterations) {
    iterations++

    try {
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor,
        limit: pageLength
      })

      if (feed.length === 0) {
        console.log('[Gap Fill] No more posts from server, stopping')
        break
      }

      const feedReceivedTime = clientDate()

      // Check each post - stop if we hit a cached post
      let hitCachedPost = false
      const newPosts: AppBskyFeedDefs.FeedViewPost[] = []

      for (const post of feed) {
        const uniqueId = getPostUniqueId(post)
        const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime).getTime()

        // Check if already cached - if so, stop gap fill
        const existsInCache = await checkFeedCacheExists(uniqueId)
        if (existsInCache) {
          console.log(`[Gap Fill] Hit cached post at ${new Date(postTimestamp).toLocaleTimeString()}, stopping`)
          hitCachedPost = true
          break
        }

        // Stop if post is before midnight
        if (postTimestamp < localMidnight) {
          console.log(`[Gap Fill] Reached midnight boundary at ${new Date(postTimestamp).toLocaleTimeString()}, stopping`)
          break
        }

        // Track oldest timestamp
        if (postTimestamp < currentOldestTimestamp) {
          currentOldestTimestamp = postTimestamp
        }

        newPosts.push(post)
      }

      // Save new posts if any (with no-overwrite protection)
      if (newPosts.length > 0) {
        const initialLastPostTime = clientDate()
        const { entries } = createFeedCacheEntries(newPosts, initialLastPostTime, intervalHours)

        await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)
        totalNewPosts += newPosts.length

        console.log(`[Gap Fill] Cached ${newPosts.length} new posts (total: ${totalNewPosts})`)
      }

      if (hitCachedPost) {
        break
      }

      cursor = newCursor
      if (!cursor) {
        console.log('[Gap Fill] No more cursor, stopping')
        break
      }
    } catch (error) {
      console.warn('[Gap Fill] Error during fetch:', error)
      break
    }
  }

  if (iterations >= maxIterations) {
    console.warn('[Gap Fill] Hit max iterations limit')
  }

  console.log(`[Gap Fill] Completed - cached ${totalNewPosts} new posts`)
  return totalNewPosts
}

/**
 * Fetch posts backwards from API until hitting a cached post or local midnight
 * Used by "Load More" and "New Posts" to ensure no gaps in display
 *
 * Algorithm:
 * 1. Fetch posts in batches starting from newest
 * 2. Skip posts newer than fromTimestamp
 * 3. For each post: check if it exists in feed cache (already displayable)
 * 4. Stop when hitting a cached post OR reaching local midnight of fromTimestamp's day
 * 5. Save new posts to cache with curation (existing summaries are preserved by curatePosts)
 * 6. Return curated posts for display
 *
 * Note: Uses feed cache (not summaries cache) as the stopping condition because
 * summaries cache has longer retention (30 days) than feed cache (48 hours),
 * so a post may have a summary but not be in feed cache.
 *
 * @param fromTimestamp - The oldest displayed post timestamp (pagination boundary)
 * @param agent - BskyAgent for API calls
 * @param myUsername - User's username
 * @param myDid - User's DID
 * @param pageLength - Number of posts per page (default 25)
 * @returns Curated posts ready for display
 */
export async function fetchUntilCached(
  fromTimestamp: number,
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  pageLength: number = DEFAULT_PAGE_LENGTH
): Promise<{ posts: CurationFeedViewPost[]; postTimestamps: Map<string, number>; reachedEnd: boolean }> {
  console.log(`[Fetch Until Cached] Starting from ${new Date(fromTimestamp).toLocaleTimeString()}, stopping at cached post`)

  // Get interval settings for cache entries
  const settings = await getSettings()
  const intervalHours = getIntervalHoursSync(settings)

  // Start from newest posts (no cursor) - we'll skip posts newer than fromTimestamp
  let cursor: string | undefined = undefined
  let totalNewPosts = 0
  let iterations = 0
  const maxIterations = MAX_FETCH_ITERATIONS
  const allPosts: CurationFeedViewPost[] = []
  const allPostTimestamps = new Map<string, number>()
  let hitCachedPost = false
  let startedCollecting = false  // Track when we've passed fromTimestamp

  // Get oldest cached timestamp for initialLastPostTime calculation
  const oldestTimestamp = await getOldestCachedPostTimestamp()
  let lastPostTime = oldestTimestamp ? new Date(oldestTimestamp) : clientDate()

  while (!hitCachedPost && iterations < maxIterations) {
    iterations++

    try {
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor,
        limit: pageLength
      })

      if (feed.length === 0) {
        console.log('[Fetch Until Cached] No more posts from server')
        break
      }

      const feedReceivedTime = clientDate()
      const newPosts: AppBskyFeedDefs.FeedViewPost[] = []

      for (const post of feed) {
        const uniqueId = getPostUniqueId(post)
        const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime)
        const postTimestampMs = postTimestamp.getTime()

        // Skip posts newer than or equal to fromTimestamp
        if (postTimestampMs >= fromTimestamp) {
          if (!startedCollecting) {
            console.log(`[Fetch Until Cached] Skipping post at ${postTimestamp.toLocaleTimeString()} (newer than fromTimestamp)`)
          }
          continue
        }

        // Now we're past fromTimestamp - start collecting
        if (!startedCollecting) {
          startedCollecting = true
          console.log(`[Fetch Until Cached] Started collecting at ${postTimestamp.toLocaleTimeString()}`)
        }

        // Check if post already exists in feed cache - stop
        // (curatePosts will preserve existing curation decisions from summaries cache)
        const inFeedCache = await checkFeedCacheExists(uniqueId)
        if (inFeedCache) {
          console.log(`[Fetch Until Cached] Hit cached post at ${postTimestamp.toLocaleTimeString()}`)
          hitCachedPost = true
          break
        }

        newPosts.push(post)
        allPostTimestamps.set(uniqueId, postTimestampMs)
      }

      // Save new posts if any
      if (newPosts.length > 0) {
        const { entries, finalLastPostTime } = createFeedCacheEntries(newPosts, lastPostTime, intervalHours)
        lastPostTime = finalLastPostTime

        // Save to cache with curation
        const { curatedFeed } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)
        allPosts.push(...curatedFeed)
        totalNewPosts += newPosts.length

        console.log(`[Fetch Until Cached] Cached ${newPosts.length} posts (total: ${totalNewPosts})`)
      }

      if (hitCachedPost) {
        break
      }

      cursor = newCursor
      if (!cursor) {
        console.log('[Fetch Until Cached] No more cursor')
        break
      }
    } catch (error) {
      console.warn('[Fetch Until Cached] Error during fetch:', error)
      break
    }
  }

  if (iterations >= maxIterations) {
    console.warn('[Fetch Until Cached] Hit max iterations limit')
  }

  const reachedEnd = !cursor || hitCachedPost
  console.log(`[Fetch Until Cached] Completed - returned ${allPosts.length} posts, reachedEnd: ${reachedEnd}`)
  return { posts: allPosts, postTimestamps: allPostTimestamps, reachedEnd }
}

/**
 * Fetch a page of posts from the server, starting from a given timestamp
 * Used as a fallback when gap-filling and cache are both exhausted
 *
 * @param fromTimestamp - Timestamp to start from (fetch posts older than this)
 * @param agent - BskyAgent instance
 * @param pageLength - Number of posts to fetch
 * @param existingCursor - If provided, use this cursor directly; otherwise skip from newest
 * @returns Posts, timestamps, cursor for next page, and hasMore flag
 */
export async function fetchPageFromTimestamp(
  fromTimestamp: number,
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  pageLength: number = DEFAULT_PAGE_LENGTH,
  existingCursor?: string
): Promise<{
  posts: CurationFeedViewPost[];
  postTimestamps: Map<string, number>;
  cursor: string | undefined;
  hasMore: boolean;
}> {
  console.log(`[Server Fallback] Fetching page from ${new Date(fromTimestamp).toLocaleTimeString()}, cursor: ${existingCursor ? 'provided' : 'none'}`)

  // Get interval settings for cache entries
  const settings = await getSettings()
  const intervalHours = getIntervalHoursSync(settings)

  const allPosts: CurationFeedViewPost[] = []
  const allPostTimestamps = new Map<string, number>()
  let currentCursor: string | undefined = existingCursor
  let iterations = 0
  const maxIterations = MAX_FETCH_ITERATIONS  // Safety limit for skipping phase

  // Get oldest cached timestamp for initialLastPostTime calculation
  const oldestTimestamp = await getOldestCachedPostTimestamp()
  let lastPostTime = oldestTimestamp ? new Date(oldestTimestamp) : clientDate()

  // If we have an existing cursor, use it directly
  if (existingCursor) {
    try {
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor: existingCursor,
        limit: pageLength
      })

      if (feed.length === 0) {
        console.log('[Server Fallback] No more posts from server')
        return { posts: [], postTimestamps: allPostTimestamps, cursor: undefined, hasMore: false }
      }

      const feedReceivedTime = clientDate()
      const { entries, finalLastPostTime } = createFeedCacheEntries(feed, lastPostTime, intervalHours)
      lastPostTime = finalLastPostTime

      // Save to cache with curation
      const { curatedFeed } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

      // Build timestamps map
      for (const post of curatedFeed) {
        const uniqueId = getPostUniqueId(post)
        const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime)
        allPostTimestamps.set(uniqueId, postTimestamp.getTime())
      }

      console.log(`[Server Fallback] Fetched ${curatedFeed.length} posts using cursor`)

      // Save cursor for future Prev Page use
      if (newCursor && curatedFeed.length > 0) {
        const oldestTimestamp = Math.min(...Array.from(allPostTimestamps.values()))
        await savePrevPageCursor(newCursor, oldestTimestamp)
      }

      return {
        posts: curatedFeed,
        postTimestamps: allPostTimestamps,
        cursor: newCursor,
        hasMore: !!newCursor && curatedFeed.length > 0
      }
    } catch (error) {
      console.warn('[Server Fallback] Error fetching with cursor:', error)
      return { posts: [], postTimestamps: allPostTimestamps, cursor: undefined, hasMore: false }
    }
  }

  // No cursor - need to skip from newest until reaching fromTimestamp
  let skippedCount = 0
  let foundStart = false

  while (!foundStart && iterations < maxIterations) {
    iterations++

    try {
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor: currentCursor,
        limit: pageLength
      })

      if (feed.length === 0) {
        console.log('[Server Fallback] No more posts while skipping')
        return { posts: [], postTimestamps: allPostTimestamps, cursor: undefined, hasMore: false }
      }

      const feedReceivedTime = clientDate()

      for (const post of feed) {
        const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime)
        const postTimestampMs = postTimestamp.getTime()

        // Skip posts newer than or equal to fromTimestamp
        if (postTimestampMs >= fromTimestamp) {
          skippedCount++
          continue
        }

        // Found the start - now collect a full page
        foundStart = true
        const uniqueId = getPostUniqueId(post)
        allPostTimestamps.set(uniqueId, postTimestampMs)

        // Create entry and save
        const { entries } = createFeedCacheEntries([post], lastPostTime, intervalHours)
        const { curatedFeed } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)
        allPosts.push(...curatedFeed)

        // Check if we have enough posts
        if (allPosts.length >= pageLength) {
          console.log(`[Server Fallback] Collected ${allPosts.length} posts after skipping ${skippedCount}`)
          return {
            posts: allPosts,
            postTimestamps: allPostTimestamps,
            cursor: newCursor,
            hasMore: !!newCursor
          }
        }
      }

      currentCursor = newCursor
      if (!currentCursor) {
        console.log('[Server Fallback] No more cursor while collecting')
        break
      }
    } catch (error) {
      console.warn('[Server Fallback] Error during fetch:', error)
      break
    }
  }

  if (iterations >= maxIterations) {
    console.warn('[Server Fallback] Hit max iterations while skipping')
  }

  console.log(`[Server Fallback] Completed - returned ${allPosts.length} posts after skipping ${skippedCount}`)

  // Save cursor for future Prev Page use (if we have posts and a cursor)
  if (currentCursor && allPosts.length > 0) {
    const oldestTimestamp = Math.min(...Array.from(allPostTimestamps.values()))
    await savePrevPageCursor(currentCursor, oldestTimestamp)
  }

  return {
    posts: allPosts,
    postTimestamps: allPostTimestamps,
    cursor: currentCursor,
    hasMore: !!currentCursor && allPosts.length > 0
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
    console.warn('Failed to get last fetch metadata:', error)
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

    console.log(`[Prev Page Cursor] Saved cursor, oldest timestamp: ${new Date(oldestPostTimestamp).toLocaleTimeString()}`)
  } catch (error) {
    console.warn('Failed to save Prev Page cursor:', error)
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
    console.warn('Failed to get fresh Prev Page cursor:', error)
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

      console.log('[Prev Page Cursor] Cleared')
    }
  } catch (error) {
    console.warn('Failed to clear Prev Page cursor:', error)
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
export function getLookbackBoundary(lookbackDays: number = 1): Date {
  const boundary = clientDate()
  boundary.setHours(0, 0, 0, 0)  // Set to midnight today
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

  const lookbackBoundary = getLookbackBoundary(lookbackDays)
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

      console.log('[Lookback] Marked lookback as complete')
    }
  } catch (error) {
    console.error('Failed to mark lookback complete:', error)
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

      console.log('[Lookback] Reset lookback status')
    }
  } catch (error) {
    console.error('Failed to reset lookback status:', error)
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
    console.warn('Failed to check initial lookback status:', error)
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

      console.log('[Lookback] Marked initial lookback as complete')
    }
  } catch (error) {
    console.error('Failed to mark initial lookback complete:', error)
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
    console.error('Failed to get cached post unique IDs:', error)
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
    console.warn('Failed to check feed cache existence:', error)
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
    console.warn('Failed to get cached feed before timestamp:', error)
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
    console.warn('Failed to get cached feed:', error)
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
            console.log(`[New Posts] getCachedFeedAfter found ${count} posts newer than ${new Date(afterTimestamp).toISOString()}`)
            console.log(`[New Posts] Found post timestamps:`, foundTimestamps.slice(0, 5).map(t => new Date(t).toISOString()))
          }
          resolve(count)
        }
      }
      
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.warn('Failed to get cached feed after timestamp:', error)
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
  limit: number = 50
): Promise<CurationFeedViewPost[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE)
    const index = store.index('postTimestamp')
    
    return new Promise((resolve, reject) => {
      // Query posts where postTimestamp > afterTimestamp (exclusive lower bound)
      const range = IDBKeyRange.lowerBound(afterTimestamp, true)
      const request = index.openCursor(range, 'prev') // 'prev' for descending order (newest first)
      
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
          // Already sorted by postTimestamp descending (newest first)
          resolve(results)
        }
      }
      
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.warn('Failed to get cached feed after timestamp:', error)
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
    console.warn('Failed to get newest cached post timestamp:', error)
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
    console.warn('Failed to get oldest cached post timestamp:', error)
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
    console.warn('Failed to clear feed cache:', error)
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
    console.warn('Failed to get cached post count:', error)
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
    console.warn('Failed to get last cached post timestamp:', error)
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
    console.warn('Failed to clear old feed cache:', error)
    return 0
  }
}

/**
 * Get statistics about feed cache
 */
export interface FeedCacheStats {
  totalCount: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
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
    console.error('Failed to get feed cache stats:', error)
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
    console.error('Failed to get feed cache timestamps:', error)
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
    const twoDaysAgo = new Date(now)
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)
    twoDaysAgo.setHours(0, 0, 0, 0)

    const isStale = newest < twoDaysAgo
    if (isStale) {
      console.log(`[Stale Check] Primary cache is stale. Newest post: ${newest.toISOString()}, threshold: ${twoDaysAgo.toISOString()}`)
    }
    return isStale
  } catch (error) {
    console.error('[Stale Check] Failed to check primary cache staleness:', error)
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

      console.log(`[Merge] Updated metadata newestCachedPostTimestamp: ${new Date(newestTimestamp).toISOString()}`)
    }
  } catch (error) {
    console.error('[Merge] Failed to update feed cache metadata:', error)
  }
}

// ============================================================================
// Unified Secondary Fetch
// ============================================================================

/**
 * Unified fetch to in-memory secondary cache.
 * Handles all 4 new-post-loading scenarios: initial, idle_return, all_new, next_page.
 *
 * Fetches posts from the server into an in-memory array, curating each post inline.
 * No IndexedDB writes during fetch — only reads for overlap detection.
 *
 * Stop conditions:
 * - 'initial': stop at midnight boundary (yesterday's midnight per clientDate())
 * - 'idle_return' / 'all_new': stop on overlap with primary cache OR midnight boundary
 * - 'next_page': stop on overlap with primary cache OR midnight boundary
 *
 * @param agent - BskyAgent instance
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @param mode - Fetch mode determining stop conditions and behavior
 * @param options - Configuration options
 * @returns SecondaryFetchResult with in-memory entries and metadata
 */
export async function fetchToSecondaryFeedCache(
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  mode: FetchMode,
  options: {
    pageLength?: number
    onProgress?: (percent: number) => void
    overlapTargetTimestamp?: number  // For idle_return: pre-idle cache's newest timestamp
  } = {}
): Promise<SecondaryFetchResult> {
  const pageLength = options.pageLength ?? DEFAULT_PAGE_LENGTH
  const label = `[Unified Fetch/${mode}]`

  console.log(`${label} Starting fetch`)

  // Get interval settings and curation context
  const settings = await getSettings()
  const intervalHours = getIntervalHoursSync(settings)

  // Setup curation context (mirrors fetchToSecondaryForNextPage pattern)
  const [currentStats, currentProbs] = await getFilter() || [null, null]
  const currentFollows = await getAllFollows()
  const followMap: Record<string, any> = {}
  for (const follow of currentFollows) {
    followMap[follow.username] = follow
  }
  const editionTimeStrs = await getEditionTimeStrs()
  const editionCount = editionTimeStrs.length
  const secretKey = settings?.secretKey || 'default'

  // Calculate midnight boundary: yesterday's midnight per clientDate()
  const today = clientDate()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(0, 0, 0, 0)
  const midnightBoundary = yesterday.getTime()
  console.log(`${label} Midnight boundary: ${yesterday.toLocaleString()}`)

  // For non-initial modes, get primary cache newest timestamp for overlap detection
  let primaryNewestTimestamp: number | null = null
  if (mode !== 'initial') {
    if (options.overlapTargetTimestamp !== undefined) {
      // Use explicit overlap target (e.g., pre-idle cache boundary before metadata was overwritten)
      primaryNewestTimestamp = options.overlapTargetTimestamp
      console.log(`${label} Using explicit overlap target: ${new Date(primaryNewestTimestamp).toLocaleString()}`)
    } else {
      const metadata = await getLastFetchMetadata()
      primaryNewestTimestamp = metadata?.newestCachedPostTimestamp ?? null
    }
    if (primaryNewestTimestamp) {
      console.log(`${label} Primary newest: ${new Date(primaryNewestTimestamp).toLocaleString()}`)
    } else {
      console.warn(`${label} No primary cache metadata, will stop on boundary only`)
    }
  }

  // In-memory secondary cache
  const secondaryEntries: SecondaryEntry[] = []
  let oldestTimestamp: number | null = null
  let newestTimestamp: number | null = null

  let cursor: string | undefined = undefined
  let lastPostTime = clientDate()
  let iterations = 0
  const maxIterations = MAX_FETCH_ITERATIONS
  let stopReason: FetchStopReason = 'exhausted'

  while (iterations < maxIterations) {
    iterations++

    // Fetch batch from server (undefined cursor = fetch from newest)
    const batchSize = 2 * pageLength
    const { feed, cursor: newCursor } = await getHomeFeed(agent, {
      cursor,
      limit: batchSize,
      onRateLimit: (info) => {
        console.warn(`${label} Rate limit encountered:`, info)
      }
    })

    if (feed.length === 0) {
      console.log(`${label} No more posts from server`)
      stopReason = 'exhausted'
      break
    }

    // Create feed cache entries with calculated postTimestamps
    const { entries, finalLastPostTime } = createFeedCacheEntries(feed, lastPostTime, intervalHours)
    lastPostTime = finalLastPostTime

    let batchStopped = false

    for (const entry of entries) {
      // Check midnight boundary — stop if post is at or before boundary
      if (entry.postTimestamp <= midnightBoundary) {
        console.log(`${label} Reached midnight boundary at ${new Date(entry.postTimestamp).toLocaleString()}`)
        stopReason = 'boundary'
        batchStopped = true
        break
      }

      // For non-initial modes, check overlap with primary cache
      if (mode !== 'initial' && primaryNewestTimestamp !== null) {
        // Timestamp-first approach: only check IndexedDB when timestamps overlap
        if (entry.postTimestamp <= primaryNewestTimestamp) {
          // Timestamps overlap — do IndexedDB check to confirm
          if (await isInPrimaryCache(entry.uniqueId)) {
            console.log(`${label} Found overlap with primary cache: ${entry.uniqueId}`)
            stopReason = 'overlap'
            batchStopped = true
            break
          }
        }
      }

      // Check for existing summary (respect prior curation decisions)
      const existingSummary = await getPostSummary(entry.uniqueId)

      let summary: PostSummary
      if (existingSummary) {
        summary = existingSummary
      } else {
        // Curate the post inline (no save)
        const curationResult = await curateSinglePost(
          entry.originalPost,
          myUsername,
          myDid,
          followMap,
          currentStats,
          currentProbs,
          secretKey,
          editionCount
        )

        summary = createPostSummary(entry.originalPost, new Date(entry.postTimestamp))
        summary.curation_status = curationResult.curation_status
        summary.curation_msg = curationResult.curation_msg
        if (curationResult.curation_save) {
          summary.curation_save = curationResult.curation_save
        }
      }

      // Append to in-memory array
      secondaryEntries.push({ entry, summary })

      // Track boundaries
      if (newestTimestamp === null || entry.postTimestamp > newestTimestamp) {
        newestTimestamp = entry.postTimestamp
      }
      if (oldestTimestamp === null || entry.postTimestamp < oldestTimestamp) {
        oldestTimestamp = entry.postTimestamp
      }
    }

    console.log(`${label} Batch ${iterations}: ${entries.length} entries, ${secondaryEntries.length} total in secondary`)

    if (batchStopped) break

    // Report progress based on time distance to boundary
    if (options.onProgress && newestTimestamp !== null && oldestTimestamp !== null) {
      const now = clientNow()
      const totalSpan = now - midnightBoundary
      const covered = now - oldestTimestamp
      const progress = totalSpan > 0 ? Math.min(99, Math.round((covered / totalSpan) * 100)) : 50
      options.onProgress(progress)
    }

    // Update cursor for next iteration
    cursor = newCursor
    if (!cursor) {
      console.log(`${label} Server cursor exhausted`)
      stopReason = 'exhausted'
      break
    }
  }

  if (iterations >= maxIterations) {
    console.warn(`${label} Reached max iterations limit (${maxIterations})`)
    stopReason = 'max_iterations'
  }

  console.log(`${label} Complete: ${secondaryEntries.length} posts, stopReason=${stopReason}, ` +
    `oldest=${oldestTimestamp ? new Date(oldestTimestamp).toLocaleString() : 'null'}, ` +
    `newest=${newestTimestamp ? new Date(newestTimestamp).toLocaleString() : 'null'}`)

  return {
    stopReason,
    entries: secondaryEntries,
    postsFetched: secondaryEntries.length,
    oldestTimestamp,
    newestTimestamp,
  }
}

/**
 * Result of transferring secondary entries to primary cache
 */
export interface TransferResult {
  postsTransferred: number
  displayableCount: number
  newestTransferredTimestamp: number | null
  oldestTransferredTimestamp: number | null
}

/**
 * Transfer in-memory secondary entries to primary cache with numbering.
 *
 * Processes entries oldest-first:
 * - 'page' mode: stops after pageLength displayable (shown) posts, discards remaining newer entries
 * - 'all' mode: processes all entries
 *
 * Numbers posts inline during processing. Starting numbers come from the overlap point
 * (maxPostNumber/maxCurationNumber for the day of the oldest entry).
 *
 * Batch-writes to primary cache and summaries for efficiency.
 *
 * @param secondaryEntries - In-memory entries from fetchToSecondaryFeedCache
 * @param transferMode - 'page' to transfer one page of displayable posts, 'all' to transfer everything
 * @param pageLength - Number of displayable posts per page (only used in 'page' mode)
 * @returns TransferResult with counts and timestamps
 */
export async function transferSecondaryToPrimary(
  secondaryEntries: SecondaryEntry[],
  transferMode: 'page' | 'all',
  pageLength: number = DEFAULT_PAGE_LENGTH,
  skipNumbering: boolean = false
): Promise<TransferResult> {
  const label = `[Transfer/${transferMode}]`

  if (secondaryEntries.length === 0) {
    console.log(`${label} No entries to transfer`)
    return { postsTransferred: 0, displayableCount: 0, newestTransferredTimestamp: null, oldestTransferredTimestamp: null }
  }

  // Sort oldest-first for correct numbering order
  const sorted = [...secondaryEntries].sort((a, b) => a.entry.postTimestamp - b.entry.postTimestamp)

  // Initialize numbering from the day of the oldest entry (unless skipping)
  const oldestTimestamp = sorted[0].entry.postTimestamp
  let currentDayStart = getLocalMidnight(new Date(oldestTimestamp)).getTime()
  let currentDayEnd = currentDayStart + 24 * 60 * 60 * 1000
  let postNumber = 0
  let curationNumber = 0
  if (!skipNumbering) {
    const dayNumbers = await getMaxNumbersForDay(currentDayStart, currentDayEnd)
    postNumber = dayNumbers.maxPostNumber
    curationNumber = dayNumbers.maxCurationNumber
  }

  // Collect entries to write
  const primaryEntries: Array<{
    uniqueId: string
    post: any
    timestamp: number
    postTimestamp: number
    interval: string
    cachedAt: number
    reposterDid?: string
  }> = []
  const summariesToSave: PostSummary[] = []
  let displayableCount = 0
  let newestTransferredTimestamp: number | null = null
  let oldestTransferredTimestamp: number | null = null

  for (const { entry, summary } of sorted) {
    // In 'page' mode, stop when we have enough displayable posts
    if (transferMode === 'page' && displayableCount >= pageLength) {
      break
    }

    if (skipNumbering) {
      // Leave numbers unassigned — they'll be assigned later by assignAllNumbers
      summary.postNumber = null
      summary.curationNumber = null
      if (isStatusShow(summary.curation_status)) {
        displayableCount++
      }
    } else {
      // Check if day boundary crossed — update numbering context
      if (entry.postTimestamp >= currentDayEnd) {
        currentDayStart = getLocalMidnight(new Date(entry.postTimestamp)).getTime()
        currentDayEnd = currentDayStart + 24 * 60 * 60 * 1000
        const dayNumbers = await getMaxNumbersForDay(currentDayStart, currentDayEnd)
        postNumber = dayNumbers.maxPostNumber
        curationNumber = dayNumbers.maxCurationNumber
      }

      // Assign numbers inline
      postNumber++
      summary.postNumber = postNumber
      if (isStatusDrop(summary.curation_status)) {
        summary.curationNumber = 0
      } else if (isStatusShow(summary.curation_status)) {
        curationNumber++
        summary.curationNumber = curationNumber
        displayableCount++
      } else {
        summary.curationNumber = null
      }
    }

    // Collect primary cache entry (strip originalPost)
    primaryEntries.push({
      uniqueId: entry.uniqueId,
      post: entry.post,
      timestamp: entry.timestamp,
      postTimestamp: entry.postTimestamp,
      interval: entry.interval,
      cachedAt: entry.cachedAt,
      reposterDid: entry.reposterDid,
    })

    summariesToSave.push(summary)

    // Track timestamps
    if (newestTransferredTimestamp === null || entry.postTimestamp > newestTransferredTimestamp) {
      newestTransferredTimestamp = entry.postTimestamp
    }
    if (oldestTransferredTimestamp === null || entry.postTimestamp < oldestTransferredTimestamp) {
      oldestTransferredTimestamp = entry.postTimestamp
    }

    // Save edition post if needed
    if (summary.curation_save) {
      await saveEditionPost(entry.post.post.uri, entry.post, summary.curation_save)
    }
  }

  // Batch write to primary cache
  const savedCount = await savePostsToPrimaryCache(primaryEntries)

  // Batch save summaries (numbers assigned inline unless skipNumbering)
  await savePostSummariesForce(summariesToSave)

  // Update primary cache metadata
  await updateFeedCacheNewestPostTimestamp()

  console.log(`${label} Complete: ${savedCount} saved to primary (${primaryEntries.length} processed), ${displayableCount} displayable${skipNumbering ? ', numbering deferred' : ''}`)

  return {
    postsTransferred: savedCount,
    displayableCount,
    newestTransferredTimestamp,
    oldestTransferredTimestamp,
  }
}

