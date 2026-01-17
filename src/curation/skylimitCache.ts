/**
 * IndexedDB storage for Skylimit curation data
 */

import { PostSummary, UserFilter, GlobalStats, FollowInfo, UserEntry, UserAccumulator } from './types'
import { getIntervalString } from './skylimitGeneral'
import { FEED_CACHE_RETENTION_MS } from './skylimitFeedCache'

const DB_NAME = 'skylimit_db'
const DB_VERSION = 7 // Increment version to add secondary feed cache store

// Store names
const STORE_SUMMARIES = 'summaries'
const STORE_FOLLOWS = 'follows'
const STORE_FILTER = 'filter'
const STORE_EDITIONS = 'editions'
const STORE_SETTINGS = 'settings'
export const STORE_PARENT_POSTS = 'parent_posts'
export const STORE_FEED_CACHE_SECONDARY = 'feed_cache_secondary'

let db: IDBDatabase | null = null

/**
 * Initialize IndexedDB
 */
export async function initDB(): Promise<IDBDatabase> {
  if (db) return db

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    // IMPORTANT: onupgradeneeded must be assigned first, before onerror/onsuccess
    // IndexedDB fires onupgradeneeded synchronously during version upgrades,
    // so the handler must be registered immediately after opening the request
    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result
      const transaction = (event.target as IDBOpenDBRequest).transaction!

      // Summaries store: indexed by interval string
      if (!database.objectStoreNames.contains(STORE_SUMMARIES)) {
        const summariesStore = database.createObjectStore(STORE_SUMMARIES, { keyPath: 'interval' })
        summariesStore.createIndex('interval', 'interval', { unique: true })
      }

      // Follows store: indexed by username
      if (!database.objectStoreNames.contains(STORE_FOLLOWS)) {
        const followsStore = database.createObjectStore(STORE_FOLLOWS, { keyPath: 'username' })
        followsStore.createIndex('username', 'username', { unique: true })
      }

      // Filter store: single entry
      if (!database.objectStoreNames.contains(STORE_FILTER)) {
        database.createObjectStore(STORE_FILTER, { keyPath: 'id' })
      }

      // Editions store: indexed by section
      if (!database.objectStoreNames.contains(STORE_EDITIONS)) {
        const editionsStore = database.createObjectStore(STORE_EDITIONS, { keyPath: 'uri' })
        editionsStore.createIndex('section', 'section', { unique: false })
      }

      // Settings store: single entry
      if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
        database.createObjectStore(STORE_SETTINGS, { keyPath: 'id' })
      }

      // Feed cache store: for caching full FeedViewPost objects
      let feedCacheStore: IDBObjectStore
      if (!database.objectStoreNames.contains('feed_cache')) {
        feedCacheStore = database.createObjectStore('feed_cache', { keyPath: 'uri' })
        feedCacheStore.createIndex('timestamp', 'timestamp', { unique: false })
        feedCacheStore.createIndex('interval', 'interval', { unique: false })
        feedCacheStore.createIndex('cachedAt', 'cachedAt', { unique: false })
        feedCacheStore.createIndex('postTimestamp', 'postTimestamp', { unique: false })
      } else {
        // Add postTimestamp index if it doesn't exist (for existing stores)
        feedCacheStore = transaction.objectStore('feed_cache')
        if (!feedCacheStore.indexNames.contains('postTimestamp')) {
          feedCacheStore.createIndex('postTimestamp', 'postTimestamp', { unique: false })
        }
      }

      // Feed metadata store: for storing last fetch cursor and timestamp
      if (!database.objectStoreNames.contains('feed_metadata')) {
        database.createObjectStore('feed_metadata', { keyPath: 'id' })
      }

      // Root posts cache store: indexed by rootUri
      // Delete old store if it exists (migration from childPostId to rootUri)
      if (database.objectStoreNames.contains(STORE_PARENT_POSTS)) {
        database.deleteObjectStore(STORE_PARENT_POSTS)
      }
      const rootPostsStore = database.createObjectStore(STORE_PARENT_POSTS, { keyPath: 'rootUri' })
      rootPostsStore.createIndex('cachedAt', 'cachedAt', { unique: false })
      rootPostsStore.createIndex('lastAccessed', 'lastAccessed', { unique: false })

      // Secondary feed cache store: for temporary lookback posts before merge
      // Same structure as primary feed_cache but used for gap-filling during lookback
      if (!database.objectStoreNames.contains(STORE_FEED_CACHE_SECONDARY)) {
        const secondaryFeedCacheStore = database.createObjectStore(STORE_FEED_CACHE_SECONDARY, { keyPath: 'uri' })
        secondaryFeedCacheStore.createIndex('timestamp', 'timestamp', { unique: false })
        secondaryFeedCacheStore.createIndex('postTimestamp', 'postTimestamp', { unique: false })
      }
    }

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      db = request.result
      resolve(db)
    }
  })
}

/**
 * Get database instance
 */
export async function getDB(): Promise<IDBDatabase> {
  if (!db) {
    db = await initDB()
  }
  return db
}

/**
 * Save post summaries for an interval
 * Merges with existing summaries - existing entries take precedence to preserve first curation decision
 */
export async function saveSummaries(interval: string, summaries: PostSummary[]): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_SUMMARIES)

  // Get existing summaries for this interval to merge
  const existing = await new Promise<PostSummary[] | null>((resolve, reject) => {
    const request = store.get(interval)
    request.onsuccess = () => {
      const result = request.result
      resolve(result ? result.summaries : null)
    }
    request.onerror = () => reject(request.error)
  })

  // Merge summaries: existing entries take precedence.
  // This preserves original curation decisions when posts are re-fetched (e.g., during Load More).
  // Rationale: When scrolling backwards through the feed, users should see the same posts they
  // saw before. Preserving original curation ensures feed consistency and prevents posts from
  // suddenly appearing/disappearing based on changed stats. Curation is only recomputed globally
  // during initial curation via recomputeCurationStatus().
  const summaryMap = new Map<string, PostSummary>()

  // Add existing summaries first (they take precedence)
  if (existing) {
    for (const summary of existing) {
      summaryMap.set(summary.uri, summary)
    }
  }

  // Add new summaries ONLY if not already present (preserve existing curation decisions)
  let skippedCount = 0
  for (const summary of summaries) {
    if (!summaryMap.has(summary.uri)) {
      summaryMap.set(summary.uri, summary)
    } else {
      skippedCount++
    }
  }

  if (skippedCount > 0) {
    console.log(`[Summary Cache] Skipping ${skippedCount} already-cached summaries for interval ${interval}`)
  }

  // Convert back to array
  const mergedSummaries = Array.from(summaryMap.values())

  await store.put({ interval, summaries: mergedSummaries, timestamp: Date.now() })
}

/**
 * Get post summaries for an interval
 */
export async function getSummaries(interval: string): Promise<PostSummary[] | null> {
  const database = await getDB()
  const transaction = database.transaction([STORE_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_SUMMARIES)
  
  return new Promise((resolve, reject) => {
    const request = store.get(interval)
    request.onsuccess = () => {
      const result = request.result
      resolve(result ? result.summaries : null)
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get all interval keys
 */
export async function getAllIntervals(): Promise<string[]> {
  const database = await getDB()
  const transaction = database.transaction([STORE_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_SUMMARIES)
  
  return new Promise((resolve, reject) => {
    const request = store.getAllKeys()
    request.onsuccess = () => resolve(request.result as string[])
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get all intervals sorted
 */
export async function getAllIntervalsSorted(): Promise<string[]> {
  const intervals = await getAllIntervals()
  return intervals.sort()
}

/**
 * Check if summaries cache is empty (no intervals stored)
 */
export async function isSummariesCacheEmpty(): Promise<boolean> {
  const intervals = await getAllIntervals()
  return intervals.length === 0
}

/**
 * Statistics for curation initialization modal
 */
export interface CurationInitStats {
  totalCount: number
  droppedCount: number  // Posts with curation_dropped set (truthy)
  oldestTimestamp: number | null
  newestTimestamp: number | null
}

/**
 * Get curation statistics from summaries cache
 * Counts total posts and posts that were dropped by curation
 */
export async function getCurationInitStats(): Promise<CurationInitStats> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_SUMMARIES], 'readonly')
    const store = transaction.objectStore(STORE_SUMMARIES)

    return new Promise((resolve, reject) => {
      const request = store.getAll()

      request.onsuccess = () => {
        const results = request.result || []
        let totalCount = 0
        let droppedCount = 0
        let oldestTimestamp: number | null = null
        let newestTimestamp: number | null = null

        // Process all intervals
        for (const intervalData of results) {
          const summaries = intervalData.summaries || []

          for (const summary of summaries) {
            totalCount++

            // Count dropped posts (curation_dropped is truthy)
            if (summary.curation_dropped) {
              droppedCount++
            }

            // Track timestamps
            const timestamp = summary.timestamp instanceof Date
              ? summary.timestamp.getTime()
              : new Date(summary.timestamp).getTime()

            if (oldestTimestamp === null || timestamp < oldestTimestamp) {
              oldestTimestamp = timestamp
            }
            if (newestTimestamp === null || timestamp > newestTimestamp) {
              newestTimestamp = timestamp
            }
          }
        }

        resolve({
          totalCount,
          droppedCount,
          oldestTimestamp,
          newestTimestamp,
        })
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('Failed to get curation init stats:', error)
    return {
      totalCount: 0,
      droppedCount: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
    }
  }
}

/**
 * Get post summary by unique ID (uri for originals, `${did}:${uri}` for reposts)
 */
export async function getSummaryByUri(uniqueId: string): Promise<PostSummary | null> {
  await getDB() // Ensure DB is initialized
  const intervals = await getAllIntervals()
  
  // Search through all intervals to find the summary
  for (const interval of intervals) {
    const summaries = await getSummaries(interval)
    if (summaries) {
      const summary = summaries.find(s => s.uri === uniqueId)
      if (summary) {
        return summary
      }
    }
  }
  
  return null
}

/**
 * Check if a post exists in summary cache using interval-based lookup
 * More efficient than getSummaryByUri which searches all intervals
 *
 * @param uniqueId - Post unique ID (uri for originals, `${did}:${uri}` for reposts)
 * @param postTimestamp - Timestamp of the post (used to determine which interval to check)
 * @returns true if summary exists, false otherwise
 */
export async function checkSummaryExists(uniqueId: string, postTimestamp: Date): Promise<boolean> {
  try {
    const interval = getIntervalString(postTimestamp)
    const summaries = await getSummaries(interval)
    return summaries?.some(s => s.uri === uniqueId) ?? false
  } catch (error) {
    console.warn('[checkSummaryExists] Error:', error)
    return false
  }
}

/**
 * Update curation status for a post in summaries cache
 * Called when curation parameters change
 */
export async function updateSummaryCurationStatus(
  uniqueId: string,
  curationStatus: string | undefined
): Promise<boolean> {
  await getDB() // Ensure DB is initialized
  const intervals = await getAllIntervals()
  
  // Find and update the summary in the appropriate interval
  for (const interval of intervals) {
    const summaries = await getSummaries(interval)
    if (summaries) {
      const index = summaries.findIndex(s => s.uri === uniqueId)
      if (index !== -1) {
        summaries[index].curation_dropped = curationStatus
        await saveSummaries(interval, summaries)
        return true
      }
    }
  }
  
  return false
}

/**
 * Clear all post summaries (useful for fixing interval format issues)
 */
export async function clearSummaries(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_SUMMARIES], 'readwrite')
    const store = transaction.objectStore(STORE_SUMMARIES)
    await store.clear()
    // Clear sessionStorage feed state to maintain consistency
    sessionStorage.removeItem('websky9_home_feed_state')
    sessionStorage.removeItem('websky9_home_scroll_state')
    console.log('Cleared all post summaries')
  } catch (error) {
    console.error('Failed to clear summaries:', error)
    throw error
  }
}

/**
 * Save follow information
 */
export async function saveFollow(follow: FollowInfo): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FOLLOWS], 'readwrite')
  const store = transaction.objectStore(STORE_FOLLOWS)
  await store.put(follow)
}

/**
 * Get follow information
 */
export async function getFollow(username: string): Promise<FollowInfo | null> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FOLLOWS], 'readonly')
  const store = transaction.objectStore(STORE_FOLLOWS)
  
  return new Promise((resolve, reject) => {
    const request = store.get(username)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get all follows
 */
export async function getAllFollows(): Promise<FollowInfo[]> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FOLLOWS], 'readonly')
  const store = transaction.objectStore(STORE_FOLLOWS)
  
  return new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

/**
 * Delete follow
 */
export async function deleteFollow(username: string): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FOLLOWS], 'readwrite')
  const store = transaction.objectStore(STORE_FOLLOWS)
  await store.delete(username)
}

/**
 * Save computed filter (stats and probabilities)
 */
export async function saveFilter(stats: GlobalStats, userFilter: UserFilter): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FILTER], 'readwrite')
  const store = transaction.objectStore(STORE_FILTER)
  await store.put({ id: 'current', stats, userFilter, timestamp: Date.now() })
}

/**
 * Get computed filter
 */
export async function getFilter(): Promise<[GlobalStats, UserFilter] | null> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FILTER], 'readonly')
  const store = transaction.objectStore(STORE_FILTER)
  
  return new Promise((resolve, reject) => {
    const request = store.get('current')
    request.onsuccess = () => {
      const result = request.result
      if (result) {
        resolve([result.stats, result.userFilter])
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get computed filter with timestamp
 */
export async function getFilterWithTimestamp(): Promise<[GlobalStats, UserFilter, number] | null> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FILTER], 'readonly')
  const store = transaction.objectStore(STORE_FILTER)
  
  return new Promise((resolve, reject) => {
    const request = store.get('current')
    request.onsuccess = () => {
      const result = request.result
      if (result) {
        resolve([result.stats, result.userFilter, result.timestamp || 0])
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Save edition post
 */
export async function saveEditionPost(uri: string, post: any, section: string): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_EDITIONS], 'readwrite')
  const store = transaction.objectStore(STORE_EDITIONS)
  await store.put({ uri, post, section, timestamp: Date.now() })
}

/**
 * Get edition posts for a section
 */
export async function getEditionPosts(section?: string): Promise<any[]> {
  const database = await getDB()
  const transaction = database.transaction([STORE_EDITIONS], 'readonly')
  const store = transaction.objectStore(STORE_EDITIONS)
  
  return new Promise((resolve, reject) => {
    const request = section
      ? store.index('section').getAll(section)
      : store.getAll()
    
    request.onsuccess = () => {
      const results = request.result || []
      resolve(results.map(r => r.post))
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Clear edition posts
 */
export async function clearEditionPosts(): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_EDITIONS], 'readwrite')
  const store = transaction.objectStore(STORE_EDITIONS)
  await store.clear()
}

/**
 * Remove old summaries before a given interval
 */
export async function removeSummariesBefore(beforeInterval: string): Promise<number> {
  const database = await getDB()
  const transaction = database.transaction([STORE_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_SUMMARIES)
  
  return new Promise((resolve, reject) => {
    const request = store.getAllKeys()
    request.onsuccess = () => {
      const keys = request.result as string[]
      let deletedCount = 0
      
      // Delete all intervals older than beforeInterval
      const deletePromises = keys
        .filter(interval => interval < beforeInterval)
        .map(interval => {
          return new Promise<void>((resolveDelete, rejectDelete) => {
            const deleteRequest = store.delete(interval)
            deleteRequest.onsuccess = () => {
              deletedCount++
              resolveDelete()
            }
            deleteRequest.onerror = () => rejectDelete(deleteRequest.error)
          })
        })
      
      Promise.all(deletePromises)
        .then(() => {
          console.log(`Removed ${deletedCount} old summary intervals before ${beforeInterval}`)
          resolve(deletedCount)
        })
        .catch(reject)
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Remove old edition posts before a given timestamp
 */
export async function removeOldEditionPosts(beforeTimestamp: number): Promise<number> {
  const database = await getDB()
  const transaction = database.transaction([STORE_EDITIONS], 'readwrite')
  const store = transaction.objectStore(STORE_EDITIONS)
  
  return new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => {
      const results = request.result || []
      let deletedCount = 0
      
      // Delete all edition posts older than beforeTimestamp
      const deletePromises = results
        .filter(item => item.timestamp < beforeTimestamp)
        .map(item => {
          return new Promise<void>((resolveDelete, rejectDelete) => {
            const deleteRequest = store.delete(item.uri)
            deleteRequest.onsuccess = () => {
              deletedCount++
              resolveDelete()
            }
            deleteRequest.onerror = () => rejectDelete(deleteRequest.error)
          })
        })
      
      Promise.all(deletePromises)
        .then(() => {
          console.log(`Removed ${deletedCount} old edition posts before ${new Date(beforeTimestamp).toISOString()}`)
          resolve(deletedCount)
        })
        .catch(reject)
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Save settings
 */
export async function saveSettings(settings: any): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_SETTINGS], 'readwrite')
  const store = transaction.objectStore(STORE_SETTINGS)
  await store.put({ id: 'current', ...settings, timestamp: Date.now() })
}

/**
 * Get settings
 */
export async function getSettings(): Promise<any> {
  const database = await getDB()
  const transaction = database.transaction([STORE_SETTINGS], 'readonly')
  const store = transaction.objectStore(STORE_SETTINGS)
  
  return new Promise((resolve, reject) => {
    const request = store.get('current')
    request.onsuccess = () => {
      const result = request.result
      if (result) {
        const { id, timestamp, ...settings } = result
        resolve(settings)
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Create new user entry
 */
export function newUserEntry(obj: Partial<UserEntry>): UserEntry {
  return {
    altname: obj.altname || '',
    acct_id: obj.acct_id || '',
    topics: obj.topics || '',
    amp_factor: obj.amp_factor ?? 1.0,
    motx_daily: 0,
    priority_daily: 0,
    post_daily: 0,
    boost_daily: 0,
    reblog2_daily: 0,
    engaged_daily: 0,
    total_daily: 0,
    net_prob: 0,
    priority_prob: 0,
    post_prob: 0,
    reblog2_avg: 0,
    ...obj,
  }
}

/**
 * Create new user accumulator
 */
export function newUserAccum(obj: Partial<UserAccumulator>): UserAccumulator {
  return {
    userEntry: obj.userEntry || newUserEntry({}),
    boost_total: 0,
    reblog2_total: 0,
    motx_total: 0,
    priority_total: 0,
    post_total: 0,
    engaged_total: 0,
    weight: 0,
    follow_weight: 1,
    normalized_daily: 0,
    ...obj,
  }
}

/**
 * Get statistics about summaries cache
 */
export interface SummariesCacheStats {
  totalCount: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
  droppedCount: number
}

export async function getSummariesCacheStats(): Promise<SummariesCacheStats> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_SUMMARIES], 'readonly')
    const summariesStore = transaction.objectStore(STORE_SUMMARIES)

    return new Promise((resolve, reject) => {
      const request = summariesStore.getAll()

      request.onsuccess = () => {
        const results = request.result || []
        let totalCount = 0
        let oldestTimestamp: number | null = null
        let newestTimestamp: number | null = null
        let droppedCount = 0
        const now = Date.now()
        const recentCutoff = now - FEED_CACHE_RETENTION_MS

        // Process all intervals
        for (const intervalData of results) {
          const summaries = intervalData.summaries || []
          totalCount += summaries.length

          // Track timestamps and count dropped posts
          for (const summary of summaries) {
            const timestamp = summary.timestamp instanceof Date
              ? summary.timestamp.getTime()
              : new Date(summary.timestamp).getTime()

            if (oldestTimestamp === null || timestamp < oldestTimestamp) {
              oldestTimestamp = timestamp
            }
            if (newestTimestamp === null || timestamp > newestTimestamp) {
              newestTimestamp = timestamp
            }

            // Count as dropped if recent (within last 48 hours) and has curation_dropped flag
            // This matches the logic used in getCurationInitStats for consistency
            if (timestamp >= recentCutoff && summary.curation_dropped) {
              droppedCount++
            }
          }
        }

        resolve({
          totalCount,
          oldestTimestamp,
          newestTimestamp,
          droppedCount,
        })
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('Failed to get summaries cache stats:', error)
    return {
      totalCount: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
      droppedCount: 0,
    }
  }
}

/**
 * Clear Skylimit settings - resets to defaults
 */
export async function clearSkylimitSettings(): Promise<void> {
  const database = await initDB()
  const transaction = database.transaction([STORE_SETTINGS], 'readwrite')
  const store = transaction.objectStore(STORE_SETTINGS)
  store.clear()

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })

  console.log('Skylimit settings cleared - defaults will be used')
}

// ============================================================================
// Secondary Feed Cache Operations
// Used for temporary storage during lookback gap-filling
// ============================================================================

/**
 * Secondary cache entry type (same as primary FeedCacheEntry)
 */
export interface SecondaryCacheEntry {
  uri: string
  post: any  // FeedViewPost
  timestamp: number              // feedReceivedTime
  postTimestamp: number          // actual post creation/repost time
  interval: string
  cachedAt: number
  reposterDid?: string
}

/**
 * Secondary cache statistics
 */
export interface SecondaryCacheStats {
  count: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
}

/**
 * Clear all entries from the secondary feed cache
 */
export async function clearSecondaryFeedCache(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readwrite')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)

    await new Promise<void>((resolve, reject) => {
      const request = store.clear()
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })

    console.log('[Secondary Cache] Cleared')
  } catch (error) {
    console.error('[Secondary Cache] Failed to clear:', error)
    throw error
  }
}

/**
 * Save a single post to the secondary feed cache
 */
export async function saveToSecondaryCache(entry: SecondaryCacheEntry): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readwrite')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)

    await new Promise<void>((resolve, reject) => {
      const request = store.put(entry)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Cache] Failed to save entry:', error)
    throw error
  }
}

/**
 * Save multiple posts to the secondary feed cache
 */
export async function saveMultipleToSecondaryCache(entries: SecondaryCacheEntry[]): Promise<number> {
  if (entries.length === 0) return 0

  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readwrite')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)

    let savedCount = 0

    // Queue all put requests
    await Promise.all(entries.map(entry => {
      return new Promise<void>((resolve, reject) => {
        const request = store.put(entry)
        request.onsuccess = () => {
          savedCount++
          resolve()
        }
        request.onerror = () => reject(request.error)
      })
    }))

    // Wait for transaction to commit before returning
    // This ensures data is persisted and visible to subsequent reads
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })

    return savedCount
  } catch (error) {
    console.error('[Secondary Cache] Failed to save multiple entries:', error)
    throw error
  }
}

/**
 * Get secondary cache statistics (count, oldest, newest timestamps)
 */
export async function getSecondaryCacheStats(): Promise<SecondaryCacheStats> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)
    const index = store.index('postTimestamp')

    // Get count
    const count = await new Promise<number>((resolve, reject) => {
      const request = store.count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    if (count === 0) {
      return { count: 0, oldestTimestamp: null, newestTimestamp: null }
    }

    // Get oldest (ascending order, first entry)
    const oldestTimestamp = await new Promise<number | null>((resolve, reject) => {
      const request = index.openCursor(null, 'next')
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          resolve((cursor.value as SecondaryCacheEntry).postTimestamp)
        } else {
          resolve(null)
        }
      }
      request.onerror = () => reject(request.error)
    })

    // Get newest (descending order, first entry)
    const newestTimestamp = await new Promise<number | null>((resolve, reject) => {
      const request = index.openCursor(null, 'prev')
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          resolve((cursor.value as SecondaryCacheEntry).postTimestamp)
        } else {
          resolve(null)
        }
      }
      request.onerror = () => reject(request.error)
    })

    return { count, oldestTimestamp, newestTimestamp }
  } catch (error) {
    console.error('[Secondary Cache] Failed to get stats:', error)
    return { count: 0, oldestTimestamp: null, newestTimestamp: null }
  }
}

/**
 * Check if a post URI exists in the secondary cache
 */
export async function isInSecondaryCache(uri: string): Promise<boolean> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)

    return new Promise((resolve, reject) => {
      const request = store.get(uri)
      request.onsuccess = () => resolve(request.result !== undefined)
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Cache] Failed to check existence:', error)
    return false
  }
}

/**
 * Get posts from secondary cache before a given timestamp (for Load More)
 * Returns posts sorted by postTimestamp descending (newest first)
 */
export async function getSecondaryPostsBefore(
  beforeTimestamp: number,
  limit: number
): Promise<SecondaryCacheEntry[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)
    const index = store.index('postTimestamp')

    const entries: SecondaryCacheEntry[] = []
    const range = IDBKeyRange.upperBound(beforeTimestamp, true) // exclusive

    return new Promise((resolve, reject) => {
      const request = index.openCursor(range, 'prev') // descending order

      request.onsuccess = () => {
        const cursor = request.result
        if (cursor && entries.length < limit) {
          entries.push(cursor.value as SecondaryCacheEntry)
          cursor.continue()
        } else {
          resolve(entries)
        }
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Cache] Failed to get posts before timestamp:', error)
    return []
  }
}

/**
 * Get all posts from secondary cache sorted by postTimestamp ascending (oldest first)
 * Used during merge to copy oldest posts first for contiguity
 */
export async function getAllSecondaryPostsOldestFirst(): Promise<SecondaryCacheEntry[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      const request = index.getAll()
      request.onsuccess = () => {
        // Sort by postTimestamp ascending (oldest first)
        const entries = (request.result as SecondaryCacheEntry[]).sort(
          (a, b) => a.postTimestamp - b.postTimestamp
        )
        resolve(entries)
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Cache] Failed to get all posts:', error)
    return []
  }
}

/**
 * Check if the oldest post in secondary cache overlaps with primary cache
 * Returns the overlap URI if found
 */
export async function checkSecondaryPrimaryOverlap(): Promise<{ hasOverlap: boolean; overlapUri?: string }> {
  try {
    const database = await getDB()

    // Get all URIs from secondary cache
    const secondaryTransaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readonly')
    const secondaryStore = secondaryTransaction.objectStore(STORE_FEED_CACHE_SECONDARY)

    const secondaryUris = await new Promise<string[]>((resolve, reject) => {
      const request = secondaryStore.getAllKeys()
      request.onsuccess = () => resolve(request.result as string[])
      request.onerror = () => reject(request.error)
    })

    if (secondaryUris.length === 0) {
      return { hasOverlap: false }
    }

    // Check each secondary URI against primary cache
    const primaryTransaction = database.transaction(['feed_cache'], 'readonly')
    const primaryStore = primaryTransaction.objectStore('feed_cache')

    for (const uri of secondaryUris) {
      const exists = await new Promise<boolean>((resolve, reject) => {
        const request = primaryStore.get(uri)
        request.onsuccess = () => resolve(request.result !== undefined)
        request.onerror = () => reject(request.error)
      })

      if (exists) {
        console.log(`[Secondary Cache] Found overlap at URI: ${uri}`)
        return { hasOverlap: true, overlapUri: uri }
      }
    }

    return { hasOverlap: false }
  } catch (error) {
    console.error('[Secondary Cache] Failed to check overlap:', error)
    return { hasOverlap: false }
  }
}

/**
 * Get the newest post timestamp from the primary feed cache
 * Used as failsafe boundary during secondary cache population
 */
export async function getPrimaryNewestTimestamp(): Promise<number | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_cache'], 'readonly')
    const store = transaction.objectStore('feed_cache')
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      const request = index.openCursor(null, 'prev') // descending, first = newest
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          resolve((cursor.value as SecondaryCacheEntry).postTimestamp)
        } else {
          resolve(null)
        }
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Cache] Failed to get primary newest timestamp:', error)
    return null
  }
}

/**
 * Check if a post URI exists in the primary feed cache
 */
export async function isInPrimaryCache(uri: string): Promise<boolean> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_cache'], 'readonly')
    const store = transaction.objectStore('feed_cache')

    return new Promise((resolve, reject) => {
      const request = store.get(uri)
      request.onsuccess = () => resolve(request.result !== undefined)
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Cache] Failed to check primary cache:', error)
    return false
  }
}

/**
 * Copy a single entry from secondary to primary cache
 * Used during merge (oldest first for contiguity)
 */
export async function copySecondaryEntryToPrimary(entry: SecondaryCacheEntry): Promise<boolean> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_cache'], 'readwrite')
    const store = transaction.objectStore('feed_cache')

    return new Promise((resolve, reject) => {
      const request = store.put(entry)
      request.onsuccess = () => resolve(true)
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('[Secondary Cache] Failed to copy entry to primary:', error)
    return false
  }
}

