/**
 * Feed cache using IndexedDB
 * Stores full FeedViewPost objects for display, leveraging the existing Skylimit cache infrastructure
 */

import { AppBskyFeedDefs, BskyAgent } from '@atproto/api'
import { initDB, getSummaryByUri, clearSummaries } from './skylimitCache'
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
 * @returns Curated posts
 */
export async function savePostsWithCuration(
  entries: FeedCacheEntryWithPost[],
  cursor: string | undefined,
  agent: BskyAgent,
  myUsername: string,
  myDid: string
): Promise<CurationFeedViewPost[]> {
  // 1. Save to feed cache
  await savePostsToFeedCache(entries, cursor)

  // 2. Curate and save summaries (must succeed for cache integrity)
  const curatedPosts = await curatePosts(entries, agent, myUsername, myDid)

  return curatedPosts
}

// Get database instance (reuse from skylimitCache)
async function getDB(): Promise<IDBDatabase> {
  return await initDB()
}

const STORE_FEED_CACHE = 'feed_cache'

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
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE, 'feed_metadata'], 'readwrite')
    const feedStore = transaction.objectStore(STORE_FEED_CACHE)
    const metadataStore = transaction.objectStore('feed_metadata')

    // Track newest and oldest postTimestamp from entries
    let newestCachedPostTimestamp = 0
    let oldestCachedPostTimestamp = Infinity

    // Queue all put operations synchronously (IndexedDB transactions auto-commit between async ops)
    for (const entry of entries) {
      // Track oldest/newest postTimestamp
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

    // Save metadata (must be queued synchronously in the same transaction)
    const metadata: FeedCacheMetadata = {
      id: 'last_fetch',
      lastCursor: cursor,
      lastFetchTime: Date.now(),
      newestCachedPostTimestamp: newestCachedPostTimestamp,
      oldestCachedPostTimestamp: oldestCachedPostTimestamp === Infinity ? newestCachedPostTimestamp : oldestCachedPostTimestamp,
    }
    metadataStore.put(metadata)  // Queue synchronously

    // Wait for transaction to complete
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(new Error('Transaction aborted'))
    })

    // Clean up old cache entries asynchronously (after transaction completes)
    setTimeout(async () => {
      try {
        await clearOldFeedCache(24)
      } catch (err) {
        console.warn('Failed to clean up old feed cache:', err)
      }
    }, 0)
  } catch (error) {
    console.warn('Failed to save posts to feed cache:', error)
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
}

/**
 * Save curated feed posts to cache
 * Saves ALL posts (including dropped ones) - curation status is stored in summaries cache
 */
export async function saveFeedCache(
  posts: CurationFeedViewPost[],
  feedReceivedTime: Date,
  cursor?: string
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE, 'feed_metadata'], 'readwrite')
    const feedStore = transaction.objectStore(STORE_FEED_CACHE)
    const metadataStore = transaction.objectStore('feed_metadata')
    
    const interval = getIntervalString(feedReceivedTime)
    const timestamp = feedReceivedTime.getTime()
    const cachedAt = Date.now()
    
    // Track newest and oldest postTimestamp
    // newestCachedPostTimestamp: newest postTimestamp from batch
    // oldestCachedPostTimestamp: oldest postTimestamp (because fetches go backward in time)
    let newestCachedPostTimestamp = 0
    let oldestCachedPostTimestamp = Infinity  // Start with Infinity to find minimum
    
    // Save each post (ALL posts, including dropped ones)
    const savePromises = posts.map(async (post) => {
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
        uri: post.post.uri,  // Original post URI (for reposts, this is the original post URI)
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
    // oldestCachedPostTimestamp is the oldest postTimestamp (fetches go backward in time)
    // If no posts were saved, preserve existing timestamps to avoid overwriting with 0
    const metadata: FeedCacheMetadata = {
      id: 'last_fetch',
      lastCursor: cursor,
      lastFetchTime: cachedAt,
      newestCachedPostTimestamp: posts.length === 0 && existingMetadata?.newestCachedPostTimestamp
        ? existingMetadata.newestCachedPostTimestamp
        : newestCachedPostTimestamp,
      oldestCachedPostTimestamp: posts.length === 0 && existingMetadata?.oldestCachedPostTimestamp
        ? existingMetadata.oldestCachedPostTimestamp
        : (oldestCachedPostTimestamp === Infinity ? newestCachedPostTimestamp : oldestCachedPostTimestamp),
      // Preserve lookback status from existing metadata
      lookbackCompleted: existingMetadata?.lookbackCompleted,
      lookbackCompletedAt: existingMetadata?.lookbackCompletedAt,
    }
    await metadataStore.put(metadata)
    
    // Clean up old cache entries (older than 24 hours) - do this asynchronously
    setTimeout(async () => {
      try {
        await clearOldFeedCache(24)
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
    const curatedFeed = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

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
  pageLength: number = 25,
  onProgress?: (percent: number) => void,
  initialLastPostTimeParam?: Date
): Promise<boolean> {
  try {
    console.log(`[Lookback] Starting background fetch until ${lookbackBoundary.toISOString()}`)

    let metadata = await getLastFetchMetadata()
    let iterations = 0
    const maxIterations = 100 // Safety limit

    // Initialize lastPostTime from parameter, oldest cached timestamp, or current time
    let lastPostTime: Date
    if (initialLastPostTimeParam) {
      lastPostTime = initialLastPostTimeParam
    } else {
      const oldestTimestamp = await getOldestCachedPostTimestamp()
      lastPostTime = oldestTimestamp ? new Date(oldestTimestamp) : new Date()
    }
    console.log(`[Lookback] Initial lastPostTime: ${lastPostTime.toISOString()}`)

    while (metadata?.lastCursor && iterations < maxIterations) {
      iterations++

      // Fetch batch using cursor
      const batchSize = 2 * pageLength
      const { feed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor: metadata.lastCursor,
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
      const curatedFeed = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

      // Insert edition posts if needed (for display purposes)
      await insertEditionPosts(curatedFeed)

      console.log(`[Lookback] Fetched and cached ${feed.length} posts (iteration ${iterations})`)

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

      // Update metadata for next iteration
      metadata = await getLastFetchMetadata()

      // If cursor became undefined, server has no more posts
      if (!metadata?.lastCursor) {
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

  // Check if lookback was completed recently
  if (metadata.lookbackCompleted && metadata.lookbackCompletedAt) {
    // Lookback completion is valid if it happened after the current lookback boundary
    // (i.e., within the lookback period from now)
    if (metadata.lookbackCompletedAt > lookbackBoundaryMs) {
      return true  // Cache is fresh, use it
    }
  }

  return false  // Cache is stale or lookback never completed, start fresh
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
 * Get cached feed posts older than a given timestamp
 * Used for pagination - gets posts before oldestCachedPostTimestamp
 * 
 * @param beforeTimestamp - Get posts with postTimestamp < beforeTimestamp
 * @param limit - Maximum number of posts to return
 * @returns Array of posts sorted by postTimestamp (newest first)
 */
export async function getCachedFeedBefore(
  beforeTimestamp: number,
  limit: number = 25
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
          
          // Only include posts from last 24 hours
          if (postTime >= now - 24 * 60 * 60 * 1000) {
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
export async function clearOldFeedCache(olderThanHours: number = 24): Promise<number> {
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

