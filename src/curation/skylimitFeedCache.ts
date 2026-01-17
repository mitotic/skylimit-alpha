/**
 * Feed cache using IndexedDB
 * Stores full FeedViewPost objects for display, leveraging the existing Skylimit cache infrastructure
 */

import { AppBskyFeedDefs, BskyAgent } from '@atproto/api'
import {
  initDB,
  getSummaryByUri,
  clearSummaries,
  clearSecondaryFeedCache,
  getAllSecondaryPostsOldestFirst,
  getSecondaryCacheStats,
  checkSecondaryPrimaryOverlap,
  getPrimaryNewestTimestamp,
  isInPrimaryCache,
  copySecondaryEntryToPrimary,
  saveMultipleToSecondaryCache,
  SecondaryCacheEntry
} from './skylimitCache'
import { getIntervalString, getFeedViewPostTimestamp, isRepost, getPostUniqueId } from './skylimitGeneral'
import { CurationFeedViewPost, FeedCacheEntry, FeedCacheEntryWithPost } from './types'
import { curatePosts, insertEditionPosts } from './skylimitTimeline'
import { getHomeFeed } from '../api/feed'

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
      const summary = await getSummaryByUri(uniqueId)
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
    await store.clear()
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
  await clearSummaries()
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

// Get database instance (reuse from skylimitCache)
async function getDB(): Promise<IDBDatabase> {
  return await initDB()
}

const STORE_FEED_CACHE = 'feed_cache'

// Feed cache retention period - aligns with max lookback period (2 days)
export const FEED_CACHE_RETENTION_HOURS = 48
export const FEED_CACHE_RETENTION_MS = FEED_CACHE_RETENTION_HOURS * 60 * 60 * 1000

// Safety limits for fetch iterations and default page size
const MAX_FETCH_ITERATIONS = 50
const DEFAULT_PAGE_LENGTH = 25

// Cursor staleness threshold - cursors older than this are discarded
const CURSOR_STALENESS_MS = 15 * 60 * 1000  // 15 minutes

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
 * @returns entries and finalLastPostTime for chaining batches
 */
export function createFeedCacheEntries(
  posts: AppBskyFeedDefs.FeedViewPost[],
  initialLastPostTime: Date
): {
  entries: FeedCacheEntryWithPost[]
  finalLastPostTime: Date
} {
  let lastPostTime = initialLastPostTime
  const entries: FeedCacheEntryWithPost[] = []
  const now = Date.now()

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
      uri: getPostUniqueId(post),
      post: {
        post: post.post,
        reason: post.reason,
      } as AppBskyFeedDefs.FeedViewPost,
      originalPost: post,
      timestamp: now,
      postTimestamp: postTimestamp.getTime(),
      interval: getIntervalString(postTimestamp),
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
    const existingUris = new Set<string>()
    const readTransaction = database.transaction([STORE_FEED_CACHE], 'readonly')
    const readStore = readTransaction.objectStore(STORE_FEED_CACHE)

    // Check each entry's existence
    await Promise.all(entries.map(entry => {
      return new Promise<void>((resolve) => {
        const request = readStore.get(entry.uri)
        request.onsuccess = () => {
          if (request.result) {
            existingUris.add(entry.uri)
          }
          resolve()
        }
        request.onerror = () => resolve() // On error, assume not exists
      })
    }))

    // Filter to only new entries (not already cached)
    const newEntries = entries.filter(entry => !existingUris.has(entry.uri))

    if (existingUris.size > 0) {
      console.log(`[Feed Cache] Skipping ${existingUris.size} already-cached posts, saving ${newEntries.length} new posts`)
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
        uri: entry.uri,
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
        lastFetchTime: Date.now(),
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
  // Secondary cache tracking (for gap-filling lookback)
  secondaryCacheActive?: boolean       // true if secondary cache is being populated
  secondaryCacheNewestTimestamp?: number  // newest post in secondary cache
  secondaryCacheOldestTimestamp?: number  // oldest post in secondary cache
}

/**
 * Save curated feed posts to cache (legacy function - only used for metadata updates with empty posts)
 * Saves ALL posts (including dropped ones) - curation status is stored in summaries cache
 * NOTE: Does not overwrite existing cache entries to preserve first curation decision
 */
export async function saveFeedCache(
  posts: CurationFeedViewPost[],
  feedReceivedTime: Date,
  cursor?: string
): Promise<void> {
  try {
    const database = await getDB()

    const interval = getIntervalString(feedReceivedTime)
    const timestamp = feedReceivedTime.getTime()
    const cachedAt = Date.now()

    // Step 1: Build list of URIs and check which already exist (for non-empty posts)
    const existingUris = new Set<string>()
    if (posts.length > 0) {
      const readTransaction = database.transaction([STORE_FEED_CACHE], 'readonly')
      const readStore = readTransaction.objectStore(STORE_FEED_CACHE)

      await Promise.all(posts.map(async (post) => {
        // Get unique ID (includes reposter DID for reposts)
        const uniqueId = getPostUniqueId(post)
        return new Promise<void>((resolve) => {
          const request = readStore.get(uniqueId)
          request.onsuccess = () => {
            if (request.result) {
              existingUris.add(uniqueId)
            }
            resolve()
          }
          request.onerror = () => resolve()
        })
      }))

      if (existingUris.size > 0) {
        console.log(`[Feed Cache] Skipping ${existingUris.size} already-cached posts`)
      }
    }

    // Step 2: Write transaction for new posts and metadata
    const writeTransaction = database.transaction([STORE_FEED_CACHE, 'feed_metadata'], 'readwrite')
    const feedStore = writeTransaction.objectStore(STORE_FEED_CACHE)
    const metadataStore = writeTransaction.objectStore('feed_metadata')

    // Track newest and oldest postTimestamp from NEW posts only
    let newestCachedPostTimestamp = 0
    let oldestCachedPostTimestamp = Infinity
    let savedCount = 0

    // Save each post (ALL posts, including dropped ones) - but skip existing ones
    const savePromises = posts.map(async (post) => {
      // Get unique ID (includes reposter DID for reposts)
      const uniqueId = getPostUniqueId(post)

      // Skip if already cached
      if (existingUris.has(uniqueId)) {
        return
      }

      // Calculate postTimestamp (actual post creation/repost time)
      const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime).getTime()

      // Track oldest postTimestamp (fetches go backward in time)
      if (postTimestamp < oldestCachedPostTimestamp) {
        oldestCachedPostTimestamp = postTimestamp
      }

      // Track newest postTimestamp
      if (postTimestamp > newestCachedPostTimestamp) {
        newestCachedPostTimestamp = postTimestamp
      }

      // Get reposter DID for reposts (for unique ID construction)
      let reposterDid: string | undefined
      if (isRepost(post)) {
        const reposter = (post.reason as any)?.by
        if (reposter?.did) {
          reposterDid = reposter.did
        }
      }

      // Cache ALL posts (removed curation_dropped check)
      const entry: FeedCacheEntry = {
        uri: uniqueId,  // Use unique ID (includes reposter DID for reposts)
        post: {
          post: post.post,
          reason: post.reason,
        } as AppBskyFeedDefs.FeedViewPost,
        timestamp,              // feedReceivedTime
        postTimestamp,          // actual post creation/repost time
        interval,
        cachedAt,
        reposterDid,            // For reposts, store reposter DID
      }
      await feedStore.put(entry)
      savedCount++
    })

    await Promise.all(savePromises)

    // Always read existing metadata to preserve lookback status and timestamps
    let existingMetadata: FeedCacheMetadata | null = null
    try {
      const existingRequest = metadataStore.get('last_fetch')
      existingMetadata = await new Promise<FeedCacheMetadata | null>((resolve) => {
        existingRequest.onsuccess = () => resolve(existingRequest.result)
        existingRequest.onerror = () => resolve(null)
      })
    } catch (err) {
      // Ignore errors when reading existing metadata
      console.warn('Failed to read existing metadata:', err)
    }

    // Save metadata with oldestCachedPostTimestamp
    // If no NEW posts were saved, preserve existing timestamps to avoid overwriting with 0
    const metadata: FeedCacheMetadata = {
      id: 'last_fetch',
      lastCursor: cursor,
      lastFetchTime: cachedAt,
      newestCachedPostTimestamp: savedCount === 0 && existingMetadata?.newestCachedPostTimestamp
        ? existingMetadata.newestCachedPostTimestamp
        : newestCachedPostTimestamp,
      oldestCachedPostTimestamp: savedCount === 0 && existingMetadata?.oldestCachedPostTimestamp
        ? existingMetadata.oldestCachedPostTimestamp
        : (oldestCachedPostTimestamp === Infinity ? newestCachedPostTimestamp : oldestCachedPostTimestamp),
      // Preserve lookback status from existing metadata
      lookbackCompleted: existingMetadata?.lookbackCompleted,
      lookbackCompletedAt: existingMetadata?.lookbackCompletedAt,
    }
    await metadataStore.put(metadata)

    // Clean up old cache entries older than FEED_CACHE_RETENTION_HOURS - do this asynchronously
    setTimeout(async () => {
      try {
        await clearOldFeedCache(FEED_CACHE_RETENTION_HOURS)
      } catch (err) {
        console.warn('Failed to clean up old feed cache:', err)
      }
    }, 0)
  } catch (error) {
    console.warn('Failed to save feed cache:', error)
    // Don't throw - caching is optional
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
 * Extend feed cache by fetching more posts from server
 * Uses the cursor stored in feed cache metadata
 * 
 * @param agent - BskyAgent instance
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @returns Number of posts fetched, or 0 if no cursor available
 */
export async function extendFeedCache(
  agent: BskyAgent,
  myUsername: string,
  myDid: string
): Promise<number> {
  try {
    // 1. Get last fetch metadata
    const metadata = await getLastFetchMetadata()
    if (!metadata || !metadata.lastCursor) {
      // No cursor available - end of feed
      return 0
    }

    // 2. Fetch posts from server using cursor
    const { feed: newFeed, cursor: newCursor } = await getHomeFeed(agent, {
      cursor: metadata.lastCursor,
      limit: 25,
      onRateLimit: (info) => {
        console.warn('Rate limit in extendFeedCache:', info)
      }
    })

    if (newFeed.length === 0) {
      // No more posts available
      return 0
    }

    // 3. Get oldest cached timestamp for Load More initialLastPostTime
    const oldestTimestamp = await getOldestCachedPostTimestamp()
    const initialLastPostTime = oldestTimestamp ? new Date(oldestTimestamp) : new Date()

    // 4. Create feed cache entries with calculated postTimestamps
    const { entries } = createFeedCacheEntries(newFeed, initialLastPostTime)

    // 5. Save to feed cache and curate (ensures both happen together for cache integrity)
    const { curatedFeed } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

    // 6. Insert edition posts if needed (for display purposes)
    await insertEditionPosts(curatedFeed)

    // 7. Return number of posts fetched
    return newFeed.length
  } catch (error) {
    console.error('Failed to extend feed cache:', error)
    return 0
  }
}

/**
 * Perform background lookback fetch until reaching the lookback boundary
 * Fetches posts in batches, curates them, and caches them
 *
 * Uses lastPostTime tracking for accurate repost timestamps:
 * - Initial lastPostTime comes from oldest timestamp in feed cache (or provided externally)
 * - Each batch chains finalLastPostTime to the next
 *
 * @param agent - BskyAgent instance
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @param lookbackBoundary - Date representing the lookback boundary
 * @param pageLength - Number of posts per batch
 * @param onProgress - Callback for progress updates (0-100)
 * @param initialLastPostTimeParam - Optional initial lastPostTime (e.g., from initial fetch)
 * @returns true if lookback completed successfully, false if interrupted
 */
export async function performLookbackFetch(
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  lookbackBoundary: Date,
  pageLength: number = DEFAULT_PAGE_LENGTH,
  onProgress?: (percent: number) => void,
  initialLastPostTimeParam?: Date
): Promise<boolean> {
  try {
    console.log(`[Lookback] Starting background fetch until ${lookbackBoundary.toISOString()}`)

    const metadata = await getLastFetchMetadata()
    let iterations = 0
    const maxIterations = 100 // Safety limit

    // Initialize cursor state with staleness checking
    // Cursor state tracks: cursor value, when received, oldest post timestamp from that response
    let cursorState: { cursor: string | undefined; receivedAt: number; oldestPostTimestamp: number } | null = null
    if (metadata?.lastCursor && metadata.lastFetchTime) {
      const cursorAge = Date.now() - metadata.lastFetchTime
      if (cursorAge < CURSOR_STALENESS_MS) {
        cursorState = {
          cursor: metadata.lastCursor,
          receivedAt: metadata.lastFetchTime,
          oldestPostTimestamp: metadata.oldestCachedPostTimestamp || Date.now()
        }
        console.log(`[Lookback] Using existing cursor (age: ${Math.round(cursorAge / 1000)}s)`)
      } else {
        console.log(`[Lookback] Cursor is stale (age: ${Math.round(cursorAge / 1000)}s), starting fresh`)
      }
    } else {
      console.log('[Lookback] No cursor available, starting fresh')
    }

    // Initialize lastPostTime from parameter, oldest cached timestamp, or current time
    let lastPostTime: Date
    if (initialLastPostTimeParam) {
      lastPostTime = initialLastPostTimeParam
    } else {
      const oldestTimestamp = await getOldestCachedPostTimestamp()
      lastPostTime = oldestTimestamp ? new Date(oldestTimestamp) : new Date()
    }
    console.log(`[Lookback] Initial lastPostTime: ${lastPostTime.toISOString()}`)

    // Loop continues until we hit a stopping condition (not dependent on having a cursor)
    while (iterations < maxIterations) {
      iterations++

      // Fetch batch using cursor (undefined cursor = fetch from newest)
      const batchSize = 2 * pageLength
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor: cursorState?.cursor,  // undefined = fetch from newest
        limit: batchSize,
        onRateLimit: (info) => {
          console.warn('[Lookback] Rate limit encountered:', info)
        }
      })

      if (feed.length === 0) {
        console.log('[Lookback] No more posts from server')
        break
      }

      // Create feed cache entries with calculated postTimestamps
      // Chain lastPostTime from previous batch
      const { entries, finalLastPostTime } = createFeedCacheEntries(feed, lastPostTime)
      lastPostTime = finalLastPostTime  // Chain for next batch

      // Save to feed cache and curate (ensures both happen together for cache integrity)
      const { curatedFeed, savedCount } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

      // Insert edition posts if needed (for display purposes)
      await insertEditionPosts(curatedFeed)

      console.log(`[Lookback] Fetched ${feed.length} posts, saved ${savedCount} new (iteration ${iterations})`)

      // Update cursor state for next iteration
      if (newCursor && entries.length > 0) {
        cursorState = {
          cursor: newCursor,
          receivedAt: Date.now(),
          oldestPostTimestamp: entries[entries.length - 1].postTimestamp
        }
      } else {
        cursorState = null  // No more pages
      }

      // Stop if we've reached already-cached posts (no new posts saved)
      if (savedCount === 0) {
        console.log('[Lookback] Reached already-cached posts, stopping')
        break
      }

      // Check if oldest postTimestamp in batch is beyond lookback boundary
      // Use the last entry's postTimestamp (oldest in batch)
      const oldestEntry = entries[entries.length - 1]
      const oldestTimestamp = new Date(oldestEntry.postTimestamp)

      if (oldestTimestamp < lookbackBoundary) {
        console.log(`[Lookback] Reached lookback boundary (oldest post: ${oldestTimestamp.toISOString()})`)
        break
      }

      // Calculate and report progress
      if (onProgress) {
        const progress = calculateLookbackProgress(oldestTimestamp, lookbackBoundary)
        onProgress(progress)
      }

      // If cursor became undefined, server has no more posts
      if (!cursorState?.cursor) {
        console.log('[Lookback] Server cursor exhausted')
        break
      }
    }

    if (iterations >= maxIterations) {
      console.warn('[Lookback] Reached max iterations limit')
    }

    // Mark lookback as complete
    await markLookbackComplete()
    console.log('[Lookback] Background fetch completed')

    return true
  } catch (error) {
    console.error('[Lookback] Failed during background fetch:', error)
    return false
  }
}

/**
 * Perform a lookback fetch to SECONDARY cache for gap-filling
 * Used when returning from idle with a fresh primary cache
 * Writes to secondary cache until overlap with primary is found, then merges
 *
 * @param agent - BskyAgent instance
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @param pageLength - Number of posts per batch
 * @param onProgress - Callback for progress updates (0-100)
 * @param onMergeProgress - Callback for merge progress updates (0-100)
 * @returns Object with completion status and whether merge happened
 */
export async function performLookbackFetchToSecondary(
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  pageLength: number = DEFAULT_PAGE_LENGTH,
  onProgress?: (percent: number) => void,
  onMergeProgress?: (percent: number) => void
): Promise<{ completed: boolean; merged: boolean; postsMerged: number }> {
  try {
    console.log('[Secondary Lookback] Starting gap-filling lookback to secondary cache')

    // Clear any existing secondary cache from interrupted lookback
    await clearSecondaryFeedCache()

    // Get primary cache newest timestamp (our target to reach)
    const primaryNewest = await getPrimaryNewestTimestamp()
    if (!primaryNewest) {
      console.warn('[Secondary Lookback] No primary cache found, should use regular lookback instead')
      return { completed: false, merged: false, postsMerged: 0 }
    }
    console.log(`[Secondary Lookback] Primary newest: ${new Date(primaryNewest).toISOString()}`)

    // Update metadata to mark secondary cache as active
    await updateSecondaryCacheMetadata(true, null, null)

    let iterations = 0
    const maxIterations = 100
    let cursor: string | undefined = undefined
    let lastPostTime = new Date()
    let secondaryNewest: number | null = null
    let secondaryOldest: number | null = null

    while (iterations < maxIterations) {
      iterations++

      // Fetch batch (undefined cursor = fetch from newest)
      const batchSize = 2 * pageLength
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor,
        limit: batchSize,
        onRateLimit: (info) => {
          console.warn('[Secondary Lookback] Rate limit encountered:', info)
        }
      })

      if (feed.length === 0) {
        console.log('[Secondary Lookback] No more posts from server')
        break
      }

      // Create feed cache entries
      const { entries, finalLastPostTime } = createFeedCacheEntries(feed, lastPostTime)
      lastPostTime = finalLastPostTime

      // Curate posts (respects existing summaries)
      // curatePosts takes FeedCacheEntryWithPost[] and saves summaries
      await curatePosts(entries, agent, myUsername, myDid)

      // Save to secondary cache
      const secondaryEntries: SecondaryCacheEntry[] = entries.map(entry => ({
        uri: entry.uri,
        post: entry.post,
        timestamp: entry.timestamp,
        postTimestamp: entry.postTimestamp,
        interval: entry.interval,
        cachedAt: entry.cachedAt,
        reposterDid: entry.reposterDid,
      }))

      await saveMultipleToSecondaryCache(secondaryEntries)

      // Track secondary cache boundaries
      const batchNewest = entries[0].postTimestamp
      const batchOldest = entries[entries.length - 1].postTimestamp
      if (secondaryNewest === null || batchNewest > secondaryNewest) {
        secondaryNewest = batchNewest
      }
      if (secondaryOldest === null || batchOldest < secondaryOldest) {
        secondaryOldest = batchOldest
      }

      // Update metadata
      await updateSecondaryCacheMetadata(true, secondaryNewest, secondaryOldest)

      console.log(`[Secondary Lookback] Saved ${entries.length} posts to secondary (iteration ${iterations})`)

      // Check for overlap with primary cache
      const { hasOverlap, overlapUri } = await checkSecondaryPrimaryOverlap()
      if (hasOverlap) {
        console.log(`[Secondary Lookback] Found overlap with primary at: ${overlapUri}`)
        break
      }

      // Failsafe: stop if we've gone past primary's newest
      if (secondaryOldest && secondaryOldest < primaryNewest) {
        console.log('[Secondary Lookback] Failsafe: reached beyond primary newest timestamp')
        break
      }

      // Report progress
      if (onProgress && secondaryOldest && secondaryNewest) {
        // Progress based on how close oldest is to primary newest
        const totalGap = secondaryNewest - primaryNewest
        const coveredGap = secondaryNewest - secondaryOldest
        const percent = totalGap > 0 ? Math.min(99, Math.round((coveredGap / totalGap) * 100)) : 50
        onProgress(percent)
      }

      cursor = newCursor
      if (!cursor) {
        console.log('[Secondary Lookback] Server cursor exhausted')
        break
      }
    }

    if (iterations >= maxIterations) {
      console.warn('[Secondary Lookback] Reached max iterations limit')
    }

    // Merge secondary to primary
    console.log('[Secondary Lookback] Starting merge to primary cache')
    const mergeResult = await mergeSecondaryToPrimary(onMergeProgress)

    // Clear secondary cache metadata
    await updateSecondaryCacheMetadata(false, null, null)

    console.log(`[Secondary Lookback] Completed. Merged ${mergeResult.postsMerged} posts`)
    return {
      completed: true,
      merged: mergeResult.success,
      postsMerged: mergeResult.postsMerged
    }
  } catch (error) {
    console.error('[Secondary Lookback] Failed:', error)
    // Clear secondary metadata on error
    await updateSecondaryCacheMetadata(false, null, null)
    return { completed: false, merged: false, postsMerged: 0 }
  }
}

/**
 * Update secondary cache metadata
 */
async function updateSecondaryCacheMetadata(
  active: boolean,
  newestTimestamp: number | null,
  oldestTimestamp: number | null
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_metadata'], 'readwrite')
    const store = transaction.objectStore('feed_metadata')

    const existingMetadata = await new Promise<FeedCacheMetadata | null>((resolve, reject) => {
      const request = store.get('last_fetch')
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })

    const updatedMetadata: FeedCacheMetadata = {
      id: 'last_fetch',
      lastFetchTime: existingMetadata?.lastFetchTime || Date.now(),
      newestCachedPostTimestamp: existingMetadata?.newestCachedPostTimestamp || 0,
      oldestCachedPostTimestamp: existingMetadata?.oldestCachedPostTimestamp || 0,
      lastCursor: existingMetadata?.lastCursor,
      lookbackCompleted: existingMetadata?.lookbackCompleted,
      lookbackCompletedAt: existingMetadata?.lookbackCompletedAt,
      secondaryCacheActive: active,
      secondaryCacheNewestTimestamp: newestTimestamp || undefined,
      secondaryCacheOldestTimestamp: oldestTimestamp || undefined,
    }

    await new Promise<void>((resolve, reject) => {
      const request = store.put(updatedMetadata)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Metadata] Failed to update:', error)
  }
}

/**
 * Check if secondary cache is active (lookback in progress)
 */
export async function isSecondaryCacheActive(): Promise<boolean> {
  try {
    const metadata = await getLastFetchMetadata()
    return metadata?.secondaryCacheActive === true
  } catch (error) {
    console.error('[Secondary Cache] Failed to check active status:', error)
    return false
  }
}

/**
 * Get local midnight for a given date (00:00:00 in user's timezone)
 */
export function getLocalMidnight(date: Date = new Date()): Date {
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

  const today = new Date()

  // Get calendar day boundary: start of the lookback day
  const lookbackBoundary = new Date(today)
  lookbackBoundary.setDate(lookbackBoundary.getDate() - lookbackDays)
  lookbackBoundary.setHours(0, 0, 0, 0)  // Start of the lookback day

  return timestamp >= lookbackBoundary.getTime()
}

/**
 * Perform a limited lookback to fill gaps back to local midnight
 * Used when loading new posts to ensure consistent counter numbering
 * Stops when hitting cached posts OR reaching local midnight
 *
 * @param oldestFetchedTimestamp - Timestamp of the oldest post from the initial fetch
 * @param initialCursor - Cursor from the initial fetch for pagination
 * @param agent - BskyAgent for API calls
 * @param myUsername - User's username
 * @param myDid - User's DID
 * @param pageLength - Number of posts per page (default 25)
 * @returns Number of new posts cached during lookback
 */
export async function limitedLookbackToMidnight(
  oldestFetchedTimestamp: number,
  initialCursor: string | undefined,
  agent: BskyAgent,
  myUsername: string,
  myDid: string,
  pageLength: number = DEFAULT_PAGE_LENGTH
): Promise<number> {
  const localMidnight = getLocalMidnight().getTime()

  // If oldest fetched is already at or before midnight, no lookback needed
  if (oldestFetchedTimestamp <= localMidnight) {
    console.log('[Limited Lookback] Already at or past midnight boundary, skipping')
    return 0
  }

  console.log(`[Limited Lookback] Starting from ${new Date(oldestFetchedTimestamp).toLocaleTimeString()} to midnight ${new Date(localMidnight).toLocaleTimeString()}`)

  let currentOldestTimestamp = oldestFetchedTimestamp
  let cursor = initialCursor
  let totalNewPosts = 0
  let iterations = 0
  const maxIterations = MAX_FETCH_ITERATIONS

  // Keep fetching backward until we hit midnight OR cached posts
  while (currentOldestTimestamp > localMidnight && iterations < maxIterations) {
    iterations++

    if (!cursor) {
      console.log('[Limited Lookback] No cursor available, stopping')
      break
    }

    try {
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor,
        limit: pageLength
      })

      if (feed.length === 0) {
        console.log('[Limited Lookback] No more posts from server, stopping')
        break
      }

      const feedReceivedTime = new Date()

      // Check each post - stop if we hit a cached post
      let hitCachedPost = false
      const newPosts: AppBskyFeedDefs.FeedViewPost[] = []

      for (const post of feed) {
        const uniqueId = getPostUniqueId(post)
        const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime).getTime()

        // Check if already cached - if so, stop lookback
        const existsInCache = await checkFeedCacheExists(uniqueId)
        if (existsInCache) {
          console.log(`[Limited Lookback] Hit cached post at ${new Date(postTimestamp).toLocaleTimeString()}, stopping`)
          hitCachedPost = true
          break
        }

        // Stop if post is before midnight
        if (postTimestamp < localMidnight) {
          console.log(`[Limited Lookback] Reached midnight boundary at ${new Date(postTimestamp).toLocaleTimeString()}, stopping`)
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
        // Use current time as initialLastPostTime for entries
        const initialLastPostTime = new Date()
        const { entries } = createFeedCacheEntries(newPosts, initialLastPostTime)

        // Save to feed cache and curate
        await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)
        totalNewPosts += newPosts.length

        console.log(`[Limited Lookback] Cached ${newPosts.length} new posts (total: ${totalNewPosts})`)
      }

      if (hitCachedPost) {
        break
      }

      cursor = newCursor
      if (!cursor) {
        console.log('[Limited Lookback] No more cursor, stopping')
        break
      }
    } catch (error) {
      console.warn('[Limited Lookback] Error during fetch:', error)
      break
    }
  }

  if (iterations >= maxIterations) {
    console.warn('[Limited Lookback] Hit max iterations limit')
  }

  console.log(`[Limited Lookback] Completed - cached ${totalNewPosts} new posts`)
  return totalNewPosts
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
    const { getSummaries } = await import('./skylimitCache')

    // Get the interval for the timestamp (getIntervalString is already imported from skylimitGeneral)
    const targetDate = new Date(beforeTimestamp)
    const interval = getIntervalString(targetDate)

    // Check if there are summaries for this interval
    const summaries = await getSummaries(interval)

    if (!summaries || summaries.length === 0) {
      // No summaries for this interval - potential gap
      console.log(`[Gap Detection] No summaries found for interval ${interval}`)
      return true
    }

    // Check if the oldest summary timestamp is close to our beforeTimestamp
    // If there's a large gap (more than 2 hours = one interval), return true
    const summaryTimestamps = summaries.map(s =>
      s.timestamp instanceof Date ? s.timestamp.getTime() : new Date(s.timestamp).getTime()
    )
    const oldestSummaryTimestamp = Math.min(...summaryTimestamps)
    const GAP_THRESHOLD = 2 * 60 * 60 * 1000  // 2 hours (one interval)

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

      const feedReceivedTime = new Date()

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
        const initialLastPostTime = new Date()
        const { entries } = createFeedCacheEntries(newPosts, initialLastPostTime)

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
  let lastPostTime = oldestTimestamp ? new Date(oldestTimestamp) : new Date()

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

      const feedReceivedTime = new Date()
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
        const { entries, finalLastPostTime } = createFeedCacheEntries(newPosts, lastPostTime)
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

  const allPosts: CurationFeedViewPost[] = []
  const allPostTimestamps = new Map<string, number>()
  let currentCursor: string | undefined = existingCursor
  let iterations = 0
  const maxIterations = MAX_FETCH_ITERATIONS  // Safety limit for skipping phase

  // Get oldest cached timestamp for initialLastPostTime calculation
  const oldestTimestamp = await getOldestCachedPostTimestamp()
  let lastPostTime = oldestTimestamp ? new Date(oldestTimestamp) : new Date()

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

      const feedReceivedTime = new Date()
      const { entries, finalLastPostTime } = createFeedCacheEntries(feed, lastPostTime)
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

      const feedReceivedTime = new Date()

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
        const { entries } = createFeedCacheEntries([post], lastPostTime)
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
 * Calculate the lookback boundary timestamp
 * The boundary is midnight of (today - lookbackDays)
 *
 * @param lookbackDays - Number of days to look back (default 1)
 * @returns Date representing the lookback boundary
 */
export function getLookbackBoundary(lookbackDays: number = 1): Date {
  const boundary = new Date()
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
  const now = new Date()
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
        lookbackCompletedAt: Date.now()
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
 * Get unique ID from a feed cache entry
 * The entry.uri is already set to getPostUniqueId(post) when created,
 * which includes the reposter DID prefix for reposts.
 */
export function getPostUniqueIdFromCache(entry: FeedCacheEntry): string {
  // entry.uri is already the full unique ID (set by getPostUniqueId when entry was created)
  return entry.uri
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
      
      const results: Array<{ post: CurationFeedViewPost; postTimestamp: number; uri: string; reposterDid?: string }> = []
      
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
            uri: entry.uri,
            reposterDid: entry.reposterDid
          })
          cursor.continue()
        } else {
          // Sort by postTimestamp descending (newest first)
          results.sort((a, b) => b.postTimestamp - a.postTimestamp)
          
          // Create map of post URIs to postTimestamps
          const postTimestamps = new Map<string, number>()
          results.forEach(r => {
            // For reposts, use unique ID format: ${reposterDid}:${post.post.uri}
            // For original posts, use post.post.uri
            const uniqueId = r.reposterDid 
              ? `${r.reposterDid}:${r.post.post.uri}`
              : r.post.post.uri
            postTimestamps.set(uniqueId, r.postTimestamp)
            // Also store by original URI for lookup
            postTimestamps.set(r.uri, r.postTimestamp)
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
        const now = Date.now()
        
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
                await store.put({ ...entry, postTimestamp: postTime })
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
    await store.clear()
    // Clear sessionStorage feed state to maintain consistency
    sessionStorage.removeItem('websky9_home_feed_state')
    sessionStorage.removeItem('websky9_home_scroll_state')
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
    
    const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000
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
    const now = new Date()

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
 * Merge secondary cache into primary cache
 * Copies posts oldest-first to preserve contiguity
 *
 * @param onProgress - Callback for progress updates (0-100)
 * @returns Result with success status and count of posts merged
 */
export async function mergeSecondaryToPrimary(
  onProgress?: (percent: number) => void
): Promise<{ success: boolean; postsMerged: number }> {
  try {
    console.log('[Merge] Starting secondary to primary cache merge')

    // Get all secondary posts sorted oldest first
    const secondaryPosts = await getAllSecondaryPostsOldestFirst()
    if (secondaryPosts.length === 0) {
      console.log('[Merge] No posts in secondary cache to merge')
      await clearSecondaryFeedCache()
      return { success: true, postsMerged: 0 }
    }

    console.log(`[Merge] Found ${secondaryPosts.length} posts to merge`)

    let mergedCount = 0
    let skippedCount = 0

    // Copy posts oldest first (preserves contiguity after each copy)
    for (let i = 0; i < secondaryPosts.length; i++) {
      const entry = secondaryPosts[i]

      // Skip if already in primary (by URI)
      const alreadyExists = await isInPrimaryCache(entry.uri)
      if (alreadyExists) {
        skippedCount++
        continue
      }

      // Copy to primary
      const success = await copySecondaryEntryToPrimary(entry)
      if (success) {
        mergedCount++
      }

      // Report progress
      if (onProgress) {
        const percent = Math.round(((i + 1) / secondaryPosts.length) * 100)
        onProgress(percent)
      }
    }

    // Clear secondary cache after successful merge
    await clearSecondaryFeedCache()

    // Update primary cache metadata with new boundaries
    await updateFeedCacheNewestPostTimestamp()

    console.log(`[Merge] Complete. Merged: ${mergedCount}, Skipped: ${skippedCount}`)
    return { success: true, postsMerged: mergedCount }
  } catch (error) {
    console.error('[Merge] Failed to merge secondary to primary:', error)
    return { success: false, postsMerged: 0 }
  }
}

/**
 * Update the feed cache metadata with the newest post timestamp
 * Called after merge to ensure metadata reflects new cache state
 */
async function updateFeedCacheNewestPostTimestamp(): Promise<void> {
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
        lastFetchTime: Date.now(),
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

/**
 * Get sync progress for secondary cache merge
 * Returns percentage based on secondary cache oldest vs primary cache newest
 */
export async function getSecondaryMergeProgress(): Promise<number> {
  try {
    const secondaryStats = await getSecondaryCacheStats()
    if (secondaryStats.count === 0 || !secondaryStats.oldestTimestamp || !secondaryStats.newestTimestamp) {
      return 100 // No secondary cache = complete
    }

    const primaryNewest = await getPrimaryNewestTimestamp()
    if (!primaryNewest) {
      return 0 // No primary cache = starting fresh
    }

    // Calculate progress: how close is secondary's oldest to primary's newest?
    // When they meet (overlap), progress is 100%
    const secondaryRange = secondaryStats.newestTimestamp - secondaryStats.oldestTimestamp
    if (secondaryRange <= 0) {
      return 50 // Single post, unknown progress
    }

    const distanceToTarget = secondaryStats.oldestTimestamp - primaryNewest
    if (distanceToTarget <= 0) {
      return 100 // Overlap achieved
    }

    // Estimate based on how far we still need to go
    // This is a rough estimate since we don't know the exact gap
    const estimatedProgress = Math.max(0, Math.min(99, 100 - (distanceToTarget / (60 * 60 * 1000)) * 10))
    return Math.round(estimatedProgress)
  } catch (error) {
    console.error('[Merge Progress] Failed to calculate:', error)
    return 0
  }
}

