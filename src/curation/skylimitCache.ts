/**
 * IndexedDB storage for Skylimit curation data
 */

import { PostSummary, UserFilter, GlobalStats, FollowInfo, UserEntry, UserAccumulator, FeedCacheEntry } from './types'
import { FEED_CACHE_RETENTION_MS } from './skylimitFeedCache'

const DB_NAME = 'skylimit_db'
const DB_VERSION = 9 // Increment version: migrated summaries to post_summaries store keyed by uniqueId

// Store names
const STORE_POST_SUMMARIES = 'post_summaries'
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

      // Delete old summaries store if it exists (migrating to post_summaries)
      if (database.objectStoreNames.contains('summaries')) {
        database.deleteObjectStore('summaries')
      }

      // Post summaries store: keyed by uniqueId with postTimestamp index
      if (!database.objectStoreNames.contains(STORE_POST_SUMMARIES)) {
        const postSummariesStore = database.createObjectStore(STORE_POST_SUMMARIES, { keyPath: 'uniqueId' })
        postSummariesStore.createIndex('postTimestamp', 'postTimestamp', { unique: false })
        postSummariesStore.createIndex('repostUri', 'repostUri', { unique: false })
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
      // Delete and recreate to change keyPath from 'uri' to 'uniqueId'
      if (database.objectStoreNames.contains('feed_cache')) {
        database.deleteObjectStore('feed_cache')
      }
      const feedCacheStore = database.createObjectStore('feed_cache', { keyPath: 'uniqueId' })
      feedCacheStore.createIndex('timestamp', 'timestamp', { unique: false })
      feedCacheStore.createIndex('interval', 'interval', { unique: false })
      feedCacheStore.createIndex('cachedAt', 'cachedAt', { unique: false })
      feedCacheStore.createIndex('postTimestamp', 'postTimestamp', { unique: false })

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
      // Delete and recreate to change keyPath from 'uri' to 'uniqueId'
      if (database.objectStoreNames.contains(STORE_FEED_CACHE_SECONDARY)) {
        database.deleteObjectStore(STORE_FEED_CACHE_SECONDARY)
      }
      const secondaryFeedCacheStore = database.createObjectStore(STORE_FEED_CACHE_SECONDARY, { keyPath: 'uniqueId' })
      secondaryFeedCacheStore.createIndex('timestamp', 'timestamp', { unique: false })
      secondaryFeedCacheStore.createIndex('postTimestamp', 'postTimestamp', { unique: false })
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
 * Save post summaries to IndexedDB
 * Each summary is stored individually keyed by uniqueId
 * Existing entries are preserved to maintain original curation decisions
 */
export async function savePostSummaries(summaries: PostSummary[]): Promise<void> {
  if (summaries.length === 0) return

  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  let skippedCount = 0
  for (const summary of summaries) {
    // Check if already exists (preserve original curation decisions)
    const existing = await new Promise<PostSummary | undefined>((resolve, reject) => {
      const request = store.get(summary.uniqueId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    if (!existing) {
      await new Promise<void>((resolve, reject) => {
        const request = store.put(summary)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    } else {
      skippedCount++
    }
  }

  if (skippedCount > 0) {
    console.log(`[Post Summaries] Skipped ${skippedCount} already-cached summaries`)
  }
}

/**
 * Get post summaries within a time range using the postTimestamp index
 */
export async function getPostSummariesInRange(
  startTime: number,
  endTime: number
): Promise<PostSummary[]> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)
  const index = store.index('postTimestamp')
  const range = IDBKeyRange.bound(startTime, endTime)

  return new Promise((resolve, reject) => {
    const request = index.getAll(range)
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get all post summaries from the cache
 */
export async function getAllPostSummaries(): Promise<PostSummary[]> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  return new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

/**
 * Check if post summaries cache is empty
 */
export async function isPostSummariesCacheEmpty(): Promise<boolean> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  return new Promise((resolve, reject) => {
    const request = store.count()
    request.onsuccess = () => resolve(request.result === 0)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Get count of post summaries
 */
export async function getPostSummariesCount(): Promise<number> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  return new Promise((resolve, reject) => {
    const request = store.count()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
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
 * Get curation statistics from post summaries cache
 * Counts total posts and posts that were dropped by curation
 */
export async function getCurationInitStats(): Promise<CurationInitStats> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)

    return new Promise((resolve, reject) => {
      const request = store.getAll()

      request.onsuccess = () => {
        const summaries = request.result || []
        let droppedCount = 0
        let oldestTimestamp: number | null = null
        let newestTimestamp: number | null = null

        for (const summary of summaries) {
          // Count dropped posts (curation_dropped is truthy)
          if (summary.curation_dropped) {
            droppedCount++
          }

          // Track timestamps using postTimestamp field
          const timestamp = summary.postTimestamp

          if (oldestTimestamp === null || timestamp < oldestTimestamp) {
            oldestTimestamp = timestamp
          }
          if (newestTimestamp === null || timestamp > newestTimestamp) {
            newestTimestamp = timestamp
          }
        }

        resolve({
          totalCount: summaries.length,
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
 * Get post summary by unique ID (post URI for originals, `${did}:${uri}` for reposts)
 * Direct O(1) lookup by uniqueId key
 */
export async function getPostSummary(uniqueId: string): Promise<PostSummary | null> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  return new Promise((resolve, reject) => {
    const request = store.get(uniqueId)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Check if a post exists in post summaries cache
 * Direct O(1) lookup by uniqueId key
 *
 * @param uniqueId - Post unique ID (post URI for originals, `${did}:${uri}` for reposts)
 * @returns true if summary exists, false otherwise
 */
export async function checkPostSummaryExists(uniqueId: string): Promise<boolean> {
  const summary = await getPostSummary(uniqueId)
  return summary !== null
}

/**
 * Update curation status for a post in post summaries cache
 * Called when curation parameters change
 */
export async function updatePostSummaryCurationStatus(
  uniqueId: string,
  curationStatus: string | undefined,
  curationMsg?: string
): Promise<boolean> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  const summary = await getPostSummary(uniqueId)
  if (!summary) return false

  // Update curation fields
  summary.curation_dropped = curationStatus
  if (curationMsg !== undefined) summary.curation_msg = curationMsg

  return new Promise((resolve, reject) => {
    const request = store.put(summary)
    request.onsuccess = () => resolve(true)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Clear all post summaries
 */
export async function clearPostSummaries(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)

    await new Promise<void>((resolve, reject) => {
      const request = store.clear()
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })

    // Clear sessionStorage feed state to maintain consistency
    sessionStorage.removeItem('websky_home_feed_state')
    sessionStorage.removeItem('websky_home_scroll_state')
    console.log('Cleared all post summaries')
  } catch (error) {
    console.error('Failed to clear post summaries:', error)
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
 * Remove old post summaries before a given timestamp
 * Uses the postTimestamp index for efficient deletion
 */
export async function removePostSummariesBefore(beforeTimestamp: number): Promise<number> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)
  const index = store.index('postTimestamp')
  const range = IDBKeyRange.upperBound(beforeTimestamp, true) // exclusive

  return new Promise((resolve, reject) => {
    let deletedCount = 0
    const request = index.openCursor(range)

    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        cursor.delete()
        deletedCount++
        cursor.continue()
      } else {
        console.log(`Removed ${deletedCount} old post summaries before ${new Date(beforeTimestamp).toISOString()}`)
        resolve(deletedCount)
      }
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
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
/**
 * Create new user entry with default values.
 * Used for initializing per-user curation statistics.
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
    repost_daily: 0,
    engaged_daily: 0,
    total_daily: 0,
    net_prob: 0,
    priority_prob: 0,
    post_prob: 0,
    ...obj,
  }
}

/**
 * Create new user accumulator with default values.
 * Used for accumulating per-user statistics during interval processing.
 */
export function newUserAccum(obj: Partial<UserAccumulator>): UserAccumulator {
  return {
    userEntry: obj.userEntry || newUserEntry({}),
    repost_total: 0,
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
 * Get statistics about post summaries cache
 */
export interface PostSummariesCacheStats {
  totalCount: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
  droppedCount: number
}

export async function getPostSummariesCacheStats(): Promise<PostSummariesCacheStats> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)

    return new Promise((resolve, reject) => {
      const request = store.getAll()

      request.onsuccess = () => {
        const summaries = request.result || []
        let oldestTimestamp: number | null = null
        let newestTimestamp: number | null = null
        let droppedCount = 0
        const now = Date.now()
        const recentCutoff = now - FEED_CACHE_RETENTION_MS

        for (const summary of summaries) {
          const timestamp = summary.postTimestamp

          if (oldestTimestamp === null || timestamp < oldestTimestamp) {
            oldestTimestamp = timestamp
          }
          if (newestTimestamp === null || timestamp > newestTimestamp) {
            newestTimestamp = timestamp
          }

          // Count as dropped if recent (within last 48 hours) and has curation_dropped flag
          if (timestamp >= recentCutoff && summary.curation_dropped) {
            droppedCount++
          }
        }

        resolve({
          totalCount: summaries.length,
          oldestTimestamp,
          newestTimestamp,
          droppedCount,
        })
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.error('Failed to get post summaries cache stats:', error)
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
 *
 * IMPORTANT: uniqueId is NOT the same as the post's URI for reposts.
 * - For original posts: uniqueId equals post.post.uri
 * - For reposts: uniqueId is `${reposterDid}:${post.post.uri}`
 */
export interface SecondaryCacheEntry {
  uniqueId: string               // Unique identifier (see above for format)
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
 * Check if a post uniqueId exists in the secondary cache
 */
export async function isInSecondaryCache(uniqueId: string): Promise<boolean> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_FEED_CACHE_SECONDARY], 'readonly')
    const store = transaction.objectStore(STORE_FEED_CACHE_SECONDARY)

    return new Promise((resolve, reject) => {
      const request = store.get(uniqueId)
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
 * Returns the overlap URI, timestamp, and handle if found
 */
export async function checkSecondaryPrimaryOverlap(): Promise<{
  hasOverlap: boolean;
  overlapUri?: string;
  overlapTimestamp?: number;
  overlapHandle?: string;
}> {
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
      const entry = await new Promise<FeedCacheEntry | undefined>((resolve, reject) => {
        const request = primaryStore.get(uri)
        request.onsuccess = () => resolve(request.result as FeedCacheEntry | undefined)
        request.onerror = () => reject(request.error)
      })

      if (entry) {
        // Get handle - use reposter if it's a repost, otherwise post author
        const handle = entry.post.reason
          ? (entry.post.reason as { by?: { handle?: string } }).by?.handle
          : entry.post.post.author.handle

        console.log(`[Secondary Cache] Found overlap at URI: ${uri}`)
        return {
          hasOverlap: true,
          overlapUri: uri,
          overlapTimestamp: entry.postTimestamp,
          overlapHandle: handle || 'unknown'
        }
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
 * Check if a post uniqueId exists in the primary feed cache
 */
export async function isInPrimaryCache(uniqueId: string): Promise<boolean> {
  try {
    const database = await getDB()
    const transaction = database.transaction(['feed_cache'], 'readonly')
    const store = transaction.objectStore('feed_cache')

    return new Promise((resolve, reject) => {
      const request = store.get(uniqueId)
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

/**
 * Trigger a complete reset of all Websky data.
 * Redirects to /?reset=1 which handles the actual deletion.
 *
 * The reset is done via URL parameter because:
 * 1. IndexedDB deletion is blocked by active connections from initDB()
 * 2. The ?reset=1 handler runs BEFORE any DB connections are opened
 * 3. This ensures the deletion always succeeds
 */
export function resetEverything(): void {
  console.log('[Reset] Redirecting to /?reset=1 for clean reset')
  window.location.href = '/?reset=1'
}

