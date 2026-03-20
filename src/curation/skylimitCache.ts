/**
 * IndexedDB storage for Skylimit curation data
 */

import { PostSummary, UserFilter, GlobalStats, FollowInfo, UserEntry, UserAccumulator, CurationStatus, isPostDropped, isPostEdited, isStatusShow, SecondaryRepostIndex, TextSuggestions, SuggestionsMap, ENGAGEMENT_NONE, hasEngagementLevel } from './types'
import { FEED_CACHE_RETENTION_MS } from './skylimitFeedCache'
import { clientNow } from '../utils/clientClock'
import log from '../utils/logger'

const DB_NAME = 'skylimit_db'
const DB_VERSION = 1 // Reset to 1 for beta release (all test sites cleared via clobber=1)

// Store names
const STORE_POST_SUMMARIES = 'post_summaries'
const STORE_FOLLOWS = 'follows'
const STORE_FILTER = 'filter'
const STORE_SETTINGS = 'settings'
export const STORE_PARENT_POSTS = 'parent_posts'
export const STORE_FEED_CACHE_SECONDARY = 'feed_cache_secondary'

let db: IDBDatabase | null = null
let pendingInit: Promise<IDBDatabase> | null = null

/**
 * Initialize IndexedDB.
 * Deduplicates concurrent calls: if an init is already in progress,
 * all callers share the same promise instead of opening multiple connections.
 */
export async function initDB(): Promise<IDBDatabase> {
  if (db) return db
  if (pendingInit) return pendingInit

  pendingInit = openDB().finally(() => { pendingInit = null })
  return pendingInit
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 10000
    let settled = false

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        log.warn('InitDB', `Timed out after ${TIMEOUT_MS}ms waiting for IndexedDB open`)
        reject(new Error('IndexedDB open timed out'))
      }
    }, TIMEOUT_MS)

    // IMPORTANT: onupgradeneeded must be assigned first, before onerror/onsuccess
    // IndexedDB fires onupgradeneeded synchronously during version upgrades,
    // so the handler must be registered immediately after opening the request
    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result

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

    }

    request.onblocked = () => {
      log.warn('InitDB', 'Open blocked by another connection')
    }

    request.onerror = () => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(request.error)
      }
    }
    request.onsuccess = () => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        db = request.result
        resolve(request.result)
      }
    }
  })
}

/**
 * Close the database connection and reset the module-level reference.
 * Used by React effect cleanup to prevent open connections from blocking
 * subsequent initDB() calls (especially in StrictMode).
 */
export function closeDB(): void {
  if (db) {
    db.close()
    db = null
  }
  pendingInit = null
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
 * Execute a function with a DB connection, auto-reconnecting on InvalidStateError.
 * This handles the race condition where closeDB() (from React StrictMode cleanup)
 * closes the connection while other components are trying to use it.
 */
export async function withDB<T>(fn: (db: IDBDatabase) => T): Promise<T> {
  const database = await getDB()
  try {
    return fn(database)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'InvalidStateError') {
      // Connection was closing — force reconnect and retry once
      db = null
      pendingInit = null
      const freshDb = await initDB()
      db = freshDb
      return fn(freshDb)
    }
    throw err
  }
}

/**
 * Save post summaries to IndexedDB
 * Each summary is stored individually keyed by uniqueId
 * Existing entries are preserved to maintain original curation decisions
 */
export async function savePostSummaries(summaries: PostSummary[]): Promise<void> {
  if (summaries.length === 0) return

  const database = await getDB()

  // Single readwrite transaction: check existence and write atomically
  // (avoids race where a concurrent write sets viewedAt between read and write phases)
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  let skipped = 0
  for (const summary of summaries) {
    const existing = await new Promise<PostSummary | null>((resolve) => {
      const request = store.get(summary.uniqueId)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => resolve(null)
    })
    if (existing) {
      skipped++
      continue  // Skip existing summaries (preserve original curation decisions and viewedAt)
    }
    store.put(summary)
    log.trace('summary-cached', summary.username, summary.postTimestamp, summary.postText || '')
  }

  if (skipped > 0) {
    log.debug('Post Summaries', `Skipped ${skipped} already-cached summaries`)
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(new Error('Transaction aborted'))
  })
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
 * Clear postNumber and curationNumber from all post summaries.
 * Used when timezone changes to allow re-numbering with new day boundaries.
 */
export async function clearAllNumbering(): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  const allSummaries: PostSummary[] = await new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })

  for (const summary of allSummaries) {
    summary.postNumber = null
    summary.curationNumber = null
    store.put(summary)
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })

  log.debug('Cache', `Cleared numbering from ${allSummaries.length} summaries`)
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
  droppedCount: number  // Posts dropped by curation (excludes edition posts)
  editedCount: number   // Posts assigned to editions
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
        let editedCount = 0
        let oldestTimestamp: number | null = null
        let newestTimestamp: number | null = null

        for (const summary of summaries) {
          if (isPostDropped(summary.curation_status)) {
            droppedCount++
          }
          if (isPostEdited(summary.curation_status)) {
            editedCount++
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
          editedCount,
          oldestTimestamp,
          newestTimestamp,
        })
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.error('Cache', 'Failed to get curation init stats:', error)
    return {
      totalCount: 0,
      droppedCount: 0,
      editedCount: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
    }
  }
}

/**
 * Get the newest post timestamp from the post summaries cache
 * Uses the postTimestamp index for efficient O(1) lookup
 *
 * @returns Newest postTimestamp in summaries cache, or null if empty
 */
export async function getNewestSummaryTimestamp(): Promise<number | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Open cursor in descending order to get newest first
      const request = index.openCursor(null, 'prev')
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          resolve(cursor.value.postTimestamp)
        } else {
          resolve(null)  // Empty cache
        }
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.error('Cache', 'Failed to get newest summary timestamp:', error)
    return null
  }
}

/**
 * Get the oldest post timestamp from the post summaries cache
 * Uses the postTimestamp index for efficient O(1) lookup
 *
 * @returns Oldest postTimestamp in summaries cache, or null if empty
 */
export async function getOldestSummaryTimestamp(): Promise<number | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)
    const index = store.index('postTimestamp')

    return new Promise((resolve, reject) => {
      // Open cursor in ascending order to get oldest first
      const request = index.openCursor(null, 'next')
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          resolve(cursor.value.postTimestamp)
        } else {
          resolve(null)  // Empty cache
        }
      }
      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.error('Cache', 'Failed to get oldest summary timestamp:', error)
    return null
  }
}

/**
 * Check if summaries cache has at least 1 day of data.
 * Returns true if the time span between oldest and newest summaries is >= 24 hours.
 * This correctly handles the case where the user was idle for a long time
 * and only has stale summaries from days ago.
 */
export async function isSummariesCacheFresh(): Promise<boolean> {
  const oldestTimestamp = await getOldestSummaryTimestamp()
  const newestTimestamp = await getNewestSummaryTimestamp()

  if (!oldestTimestamp || !newestTimestamp) return false

  const timeSpan = newestTimestamp - oldestTimestamp
  const oneDayMs = 24 * 60 * 60 * 1000
  return timeSpan >= oneDayMs
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
 * Check if the original post or another repost was displayed within the interval window.
 * Handles bidirectional time navigation (forward for new posts, backward for lookback).
 *
 * @param repostUri - The URI of the original post being reposted
 * @param currentRepostTimestamp - The timestamp of the repost being curated (ms)
 * @param currentRepostUniqueId - The uniqueId of the repost being curated (to exclude self)
 * @param intervalMs - The interval window in milliseconds
 * @returns true if the original or another repost was displayed within the interval
 */
export async function wasRepostOrOriginalDisplayedWithinInterval(
  repostUri: string,
  currentRepostTimestamp: number,
  currentRepostUniqueId: string,
  intervalMs: number,
  secondaryRepostIndex?: SecondaryRepostIndex
): Promise<boolean> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)

    // Define the time window (bidirectional)
    const windowStart = currentRepostTimestamp - intervalMs
    const windowEnd = currentRepostTimestamp + intervalMs

    // Check 1: Was the original post displayed within the interval window?
    const originalPost = await new Promise<PostSummary | undefined>((resolve, reject) => {
      const request = store.get(repostUri)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    if (originalPost &&
        originalPost.postTimestamp >= windowStart &&
        originalPost.postTimestamp <= windowEnd &&
        isStatusShow(originalPost.curation_status)) {
      return true
    }

    // Check 2: Was another repost of this URI displayed within the interval window?
    const repostIndex = store.index('repostUri')
    const reposts = await new Promise<PostSummary[]>((resolve, reject) => {
      const request = repostIndex.getAll(repostUri)
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })

    for (const repost of reposts) {
      // Skip the current repost being curated
      if (repost.uniqueId === currentRepostUniqueId) {
        continue
      }
      if (repost.postTimestamp >= windowStart &&
          repost.postTimestamp <= windowEnd &&
          isStatusShow(repost.curation_status)) {
        return true
      }
    }

    // Check 3: Check in-memory secondary cache via index (entries curated earlier in this
    // fetch cycle, not yet persisted to IndexedDB). Uses O(1) map lookup instead of O(n) scan.
    if (secondaryRepostIndex && secondaryRepostIndex.size > 0) {
      const candidates = secondaryRepostIndex.get(repostUri)
      if (candidates) {
        for (const candidate of candidates) {
          if (candidate.uniqueId === currentRepostUniqueId) {
            continue
          }
          if (candidate.postTimestamp >= windowStart &&
              candidate.postTimestamp <= windowEnd &&
              isStatusShow(candidate.curation_status)) {
            return true
          }
        }
      }
    }

    return false
  } catch (error) {
    log.error('Repost Check', 'Failed to check interval display:', error)
    return false  // On error, allow the repost
  }
}

/**
 * Update curation status for a post in post summaries cache
 * Called when curation parameters change
 */
export async function updatePostSummaryCurationDecision(
  uniqueId: string,
  curationStatus: CurationStatus | undefined,
  curationMsg?: string
): Promise<boolean> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  // Read within the SAME transaction (don't call getPostSummary which opens its own
  // transaction, causing the readwrite transaction to auto-commit while awaiting)
  const summary = await new Promise<PostSummary | null>((resolve, reject) => {
    const request = store.get(uniqueId)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
  if (!summary) return false

  // Update curation fields
  summary.curation_status = curationStatus
  if (curationMsg !== undefined) summary.curation_msg = curationMsg

  return new Promise((resolve, reject) => {
    const request = store.put(summary)
    request.onsuccess = () => resolve(true)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Update a post summary's viewedAt timestamp (first view wins - won't overwrite existing).
 * Fire-and-forget: errors are silently ignored.
 */
export async function updatePostSummaryViewedAt(
  uniqueId: string,
  viewedAt: number
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)

    // Read within the SAME transaction (don't call getPostSummary which opens its own
    // transaction, causing the readwrite transaction to auto-commit while awaiting)
    const summary = await new Promise<PostSummary | null>((resolve, reject) => {
      const request = store.get(uniqueId)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
    if (!summary || summary.viewedAt) return  // No summary or already viewed

    summary.viewedAt = viewedAt
    store.put(summary)

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } catch {
    // Fire-and-forget: silently ignore errors
  }
}

/**
 * Update a post summary's engagement level (additive, idempotent).
 * Only adds the level if that engagement digit isn't already set.
 * Fire-and-forget: errors are silently ignored.
 */
export async function updatePostSummaryEngagement(
  uniqueId: string,
  level: number,
  myUsername?: string
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)

    const summary = await new Promise<PostSummary | null>((resolve, reject) => {
      const request = store.get(uniqueId)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
    if (!summary) return

    // Don't track engagement on self posts — it skews comparisons
    if (myUsername && summary.username === myUsername) return

    const current = summary.postEngagement || ENGAGEMENT_NONE
    if (hasEngagementLevel(current, level)) return  // Already set

    summary.postEngagement = current + level
    store.put(summary)

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } catch {
    // Fire-and-forget: silently ignore errors
  }
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
    log.debug('Cache', 'Cleared all post summaries')
  } catch (error) {
    log.error('Cache', 'Failed to clear post summaries:', error)
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
  return new Promise<void>((resolve, reject) => {
    const request = store.put(follow)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
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
  return new Promise<void>((resolve, reject) => {
    const request = store.delete(username)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/**
 * Save computed filter (stats and probabilities)
 */
export async function saveFilter(stats: GlobalStats, userFilter: UserFilter): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FILTER], 'readwrite')
  const store = transaction.objectStore(STORE_FILTER)
  await store.put({ id: 'current', stats, userFilter, timestamp: clientNow() })
}

/**
 * Save pre-computed text pattern suggestions (per-user hashtags and domains)
 */
export async function saveTextSuggestions(suggestions: Record<string, TextSuggestions>): Promise<void> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FILTER], 'readwrite')
  const store = transaction.objectStore(STORE_FILTER)
  await store.put({ id: 'text_suggestions', suggestions, timestamp: clientNow() })
}

/**
 * Get pre-computed text pattern suggestions keyed by username
 */
export async function getTextSuggestions(): Promise<SuggestionsMap | null> {
  const database = await getDB()
  const transaction = database.transaction([STORE_FILTER], 'readonly')
  const store = transaction.objectStore(STORE_FILTER)

  return new Promise((resolve, reject) => {
    const request = store.get('text_suggestions')
    request.onsuccess = () => {
      const result = request.result
      if (result?.suggestions) {
        resolve(new Map(Object.entries(result.suggestions)) as SuggestionsMap)
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
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
        log.debug('Cache', `Removed ${deletedCount} old post summaries before ${new Date(beforeTimestamp).toISOString()}`)
        resolve(deletedCount)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Remove recent post summaries at or after a given timestamp.
 * Uses the postTimestamp index for efficient deletion.
 * Inverse of removePostSummariesBefore — keeps old summaries,
 * removes recent ones so they can be re-created from re-fetched posts.
 */
export async function removePostSummariesAfter(afterTimestamp: number): Promise<number> {
  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)
  const index = store.index('postTimestamp')
  const range = IDBKeyRange.lowerBound(afterTimestamp) // inclusive: >= afterTimestamp

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
        log.debug('ClearRecent', `Removed ${deletedCount} post summaries after ${new Date(afterTimestamp).toISOString()}`)
        resolve(deletedCount)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * Clear recent curation data within the lookback window.
 * Clears feed_cache and feed_metadata entirely, removes post summaries
 * newer than the lookback boundary, and prunes recent edition registry entries.
 * Preserves session, follows, filter, settings, and parent posts cache.
 */
export async function clearRecentData(lookbackBoundaryMs: number): Promise<void> {
  log.debug('ClearRecent', `Starting with boundary ${new Date(lookbackBoundaryMs).toISOString()}`)

  const database = await getDB()

  // 1. Clear feed_cache entirely
  const feedTx = database.transaction(['feed_cache'], 'readwrite')
  await new Promise<void>((resolve, reject) => {
    const req = feedTx.objectStore('feed_cache').clear()
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
  log.debug('ClearRecent', 'Cleared feed_cache')

  // 2. Clear feed_metadata entirely (resets lookbackCompleted flags)
  const metaTx = database.transaction(['feed_metadata'], 'readwrite')
  await new Promise<void>((resolve, reject) => {
    const req = metaTx.objectStore('feed_metadata').clear()
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
  log.debug('ClearRecent', 'Cleared feed_metadata')

  // 3. Remove recent post summaries (>= boundary)
  const removedSummaries = await removePostSummariesAfter(lookbackBoundaryMs)
  log.debug('ClearRecent', `Removed ${removedSummaries} recent post summaries`)

  // 4. Prune recent edition registry entries
  const { cullRecentEditionRegistry } = await import('./editionRegistry')
  const removedEditions = cullRecentEditionRegistry(lookbackBoundaryMs)
  log.debug('ClearRecent', `Removed ${removedEditions} recent edition registry entries`)

  log.debug('ClearRecent', 'Complete')
}

/**
 * Save settings
 */
export async function saveSettings(settings: any): Promise<void> {
  await withDB(database => {
    const transaction = database.transaction([STORE_SETTINGS], 'readwrite')
    const store = transaction.objectStore(STORE_SETTINGS)
    store.put({ id: 'current', ...settings, timestamp: clientNow() })
  })
}

/**
 * Get settings
 */
export async function getSettings(): Promise<any> {
  return withDB(database => {
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
    priorityPatterns: obj.priorityPatterns || '',
    amp_factor: obj.amp_factor ?? 1.0,
    periodic_daily: 0,
    priority_daily: 0,
    original_daily: 0,
    followed_reply_daily: 0,
    unfollowed_reply_daily: 0,
    reposts_daily: 0,
    edited_daily: 0,
    edited_hold_daily: 0,
    engaged_daily: 0,
    total_daily: 0,
    shown_daily: 0,
    net_prob: 0,
    priority_prob: 0,
    regular_prob: 0,
    medianPop: 0,
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
    periodic_total: 0,
    priority_total: 0,
    original_total: 0,
    followed_reply_total: 0,
    unfollowed_reply_total: 0,
    edited_total: 0,
    engaged_total: 0,
    shown_total: 0,
    weight: 0,
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
  editedCount: number
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
        let editedCount = 0
        const now = clientNow()
        const recentCutoff = now - FEED_CACHE_RETENTION_MS

        for (const summary of summaries) {
          const timestamp = summary.postTimestamp

          if (oldestTimestamp === null || timestamp < oldestTimestamp) {
            oldestTimestamp = timestamp
          }
          if (newestTimestamp === null || timestamp > newestTimestamp) {
            newestTimestamp = timestamp
          }

          if (timestamp >= recentCutoff) {
            if (isPostDropped(summary.curation_status)) {
              droppedCount++
            }
            if (isPostEdited(summary.curation_status)) {
              editedCount++
            }
          }
        }

        resolve({
          totalCount: summaries.length,
          oldestTimestamp,
          newestTimestamp,
          droppedCount,
          editedCount,
        })
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    log.error('Cache', 'Failed to get post summaries cache stats:', error)
    return {
      totalCount: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
      droppedCount: 0,
      editedCount: 0,
    }
  }
}

/**
 * Get all postTimestamp values from post summaries cache, sorted ascending.
 * Uses the postTimestamp index key cursor to avoid loading full summary objects.
 */
export async function getPostSummaryTimestamps(): Promise<number[]> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
    const store = transaction.objectStore(STORE_POST_SUMMARIES)
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
    log.error('Cache', 'Failed to get post summary timestamps:', error)
    return []
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

  log.info('Cache', 'Skylimit settings cleared - defaults will be used')
}

// ============================================================================
// Secondary Feed Cache Operations
// Used for temporary storage during lookback gap-filling
// ============================================================================

// NOTE: Deprecated IndexedDB secondary cache types and functions removed.
// The secondary cache is now purely in-memory (SecondaryEntry[] from types.ts).

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
    log.error('Primary Cache', 'Failed to check existence:', error)
    return false
  }
}

// ============================================================================
// Batched IndexedDB Operations (for unified fetch/transfer)
// ============================================================================

/**
 * Check which uniqueIds exist in the primary feed cache (batched, single readonly transaction)
 * @param uniqueIds - Array of uniqueIds to check
 * @returns Set of uniqueIds that exist in primary cache
 */
export async function areInPrimaryCache(uniqueIds: string[]): Promise<Set<string>> {
  if (uniqueIds.length === 0) return new Set()

  const database = await getDB()
  const transaction = database.transaction(['feed_cache'], 'readonly')
  const store = transaction.objectStore('feed_cache')

  const existingIds = new Set<string>()
  await Promise.all(uniqueIds.map(id =>
    new Promise<void>((resolve) => {
      const request = store.get(id)
      request.onsuccess = () => {
        if (request.result !== undefined) existingIds.add(id)
        resolve()
      }
      request.onerror = () => resolve()
    })
  ))

  return existingIds
}

/**
 * Save multiple entries to primary feed cache (batched, single readwrite transaction)
 * Skips entries that already exist.
 * @param entries - Feed cache entries to save (without originalPost)
 * @returns Number of new entries saved
 */
export async function savePostsToPrimaryCache(entries: Array<{
  uniqueId: string
  post: any
  timestamp: number
  postTimestamp: number
  interval: string
  cachedAt: number
  reposterDid?: string
}>): Promise<number> {
  if (entries.length === 0) return 0

  const database = await getDB()

  // Step 1: Check which already exist (single readonly transaction)
  const existingIds = await areInPrimaryCache(entries.map(e => e.uniqueId))

  const newEntries = entries.filter(e => !existingIds.has(e.uniqueId))
  if (newEntries.length === 0) return 0

  // Step 2: Write new entries (single readwrite transaction, synchronous queuing)
  const writeTransaction = database.transaction(['feed_cache'], 'readwrite')
  const store = writeTransaction.objectStore('feed_cache')

  for (const entry of newEntries) {
    store.put(entry)  // Queue synchronously
  }

  await new Promise<void>((resolve, reject) => {
    writeTransaction.oncomplete = () => resolve()
    writeTransaction.onerror = () => reject(writeTransaction.error)
    writeTransaction.onabort = () => reject(new Error('Transaction aborted'))
  })

  return newEntries.length
}

/**
 * Get multiple post summaries by uniqueIds (batched, single readonly transaction)
 * @param uniqueIds - Array of uniqueIds to look up
 * @returns Map from uniqueId to PostSummary (only includes found summaries)
 */
export async function getPostSummariesByIds(uniqueIds: string[]): Promise<Map<string, PostSummary>> {
  if (uniqueIds.length === 0) return new Map()

  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readonly')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  const results = new Map<string, PostSummary>()
  await Promise.all(uniqueIds.map(id =>
    new Promise<void>((resolve) => {
      const request = store.get(id)
      request.onsuccess = () => {
        if (request.result) results.set(id, request.result)
        resolve()
      }
      request.onerror = () => resolve()
    })
  ))

  return results
}

/**
 * Save post summaries unconditionally (no existence check, for transfer use)
 * Uses single readwrite transaction with synchronous queuing.
 * @param summaries - Summaries to save (will overwrite existing)
 */
export async function savePostSummariesForce(summaries: PostSummary[]): Promise<void> {
  if (summaries.length === 0) return

  const database = await getDB()
  const transaction = database.transaction([STORE_POST_SUMMARIES], 'readwrite')
  const store = transaction.objectStore(STORE_POST_SUMMARIES)

  for (const summary of summaries) {
    // Preserve viewedAt from existing summary if present
    const existing = await new Promise<PostSummary | null>((resolve) => {
      const request = store.get(summary.uniqueId)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => resolve(null)
    })
    if (existing?.viewedAt && !summary.viewedAt) {
      summary.viewedAt = existing.viewedAt
    }
    store.put(summary)
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(new Error('Transaction aborted'))
  })
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
  log.info('Reset', 'Redirecting to /?reset=1 for clean reset')
  window.location.href = '/?reset=1'
}

/**
 * Clear all time-variant IndexedDB stores (post_summaries, feed_cache,
 * feed_metadata, parent_posts, filter, follows), scrub lastBrowserTimezone
 * from settings, clear the login session, and redirect to /login.
 * Skylimit settings (viewsPerDay, editionLayout, etc.) are preserved.
 */
export async function clearAllTimeVariantDataAndLogout(): Promise<void> {
  log.debug('Debug', 'clearAllTimeVariantDataAndLogout: Starting...')

  const database = await getDB()

  const storesToClear = [
    'post_summaries', 'feed_cache', 'feed_metadata',
    'parent_posts', 'filter', 'follows'
  ]

  for (const storeName of storesToClear) {
    const tx = database.transaction([storeName], 'readwrite')
    await new Promise<void>((resolve, reject) => {
      const req = tx.objectStore(storeName).clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    log.debug('Debug', `Cleared ${storeName}`)
  }

  // Scrub lastBrowserTimezone from settings (saveSettings resets timestamp)
  const { updateSettings } = await import('./skylimitStore')
  await updateSettings({ lastBrowserTimezone: undefined })
  log.debug('Debug', 'Scrubbed lastBrowserTimezone from settings')

  // Clear edition registry and legacy edition tracking
  const { clearEditionRegistry } = await import('./editionRegistry')
  clearEditionRegistry()
  localStorage.removeItem('lastCreatedEditionTimestamp') // legacy cleanup
  localStorage.removeItem('websky_pinned_post_id')
  localStorage.removeItem('websky_pinned_post_text')
  log.debug('Debug', 'Cleared edition registry')

  // Close DB so in-flight React effects get a fresh connection instead of a closing one
  closeDB()
  log.debug('Debug', 'Closed DB connection')

  // Clear session and redirect to login
  const { clearSession } = await import('../auth/session-storage')
  clearSession()
  log.debug('Debug', 'Cleared session, redirecting to /login')
  window.location.href = '/login'
}

// --- Storage usage utilities ---

export interface StorageUsage {
  localStorageBytes: number
  sessionStorageBytes: number
  indexedDBBytes: number | null
  indexedDBQuota: number | null
  storeRecordCounts: Record<string, number>
}

function measureWebStorage(storage: Storage): number {
  let bytes = 0
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!
    bytes += (key.length + storage.getItem(key)!.length) * 2 // UTF-16
  }
  return bytes
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const localStorageBytes = measureWebStorage(localStorage)
  const sessionStorageBytes = measureWebStorage(sessionStorage)

  let indexedDBBytes: number | null = null
  let indexedDBQuota: number | null = null
  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate()
      indexedDBBytes = estimate.usage ?? null
      indexedDBQuota = estimate.quota ?? null
    } catch {
      // estimate() not available or failed
    }
  }

  // Count records per store
  const storeRecordCounts: Record<string, number> = {}
  const allStores = [
    STORE_POST_SUMMARIES, 'feed_cache', STORE_FOLLOWS,
    STORE_PARENT_POSTS, STORE_FILTER, 'feed_metadata', STORE_SETTINGS
  ]

  try {
    const database = await getDB()
    for (const storeName of allStores) {
      if (!database.objectStoreNames.contains(storeName)) continue
      const count = await new Promise<number>((resolve, reject) => {
        const tx = database.transaction([storeName], 'readonly')
        const req = tx.objectStore(storeName).count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      storeRecordCounts[storeName] = count
    }
  } catch (error) {
    log.warn('StorageUsage', 'Failed to count store records:', error)
  }

  return { localStorageBytes, sessionStorageBytes, indexedDBBytes, indexedDBQuota, storeRecordCounts }
}

