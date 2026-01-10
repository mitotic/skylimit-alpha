/**
 * Root posts cache for home timeline
 * Caches root posts indexed by rootUri to avoid redundant API calls
 * Used to display the root post of a thread when showing a reply
 */

import { AppBskyFeedDefs } from '@atproto/api'
import { getDB, STORE_PARENT_POSTS } from './skylimitCache'

// Cache configuration
const MAX_CACHE_SIZE = 500 // Maximum number of cached root posts
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
const FLUSH_BATCH_SIZE = 50 // Number of entries to remove in one flush operation

interface RootPostCacheEntry {
  rootUri: string // URI of the root post
  rootPost: AppBskyFeedDefs.PostView // The root post data
  cachedAt: number // Timestamp when cached
  lastAccessed: number // Timestamp when last accessed (for LRU)
}

/**
 * Get root post from cache by root URI
 */
export async function getCachedRootPost(
  rootUri: string
): Promise<AppBskyFeedDefs.PostView | null> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_PARENT_POSTS], 'readwrite')
    const store = transaction.objectStore(STORE_PARENT_POSTS)

    return new Promise((resolve, reject) => {
      const request = store.get(rootUri)

      request.onsuccess = () => {
        const entry = request.result as RootPostCacheEntry | undefined

        if (!entry) {
          resolve(null)
          return
        }

        // Check if cache entry is expired
        const now = Date.now()
        const age = now - entry.cachedAt
        if (age > CACHE_TTL) {
          // Entry expired, delete it
          store.delete(rootUri).onsuccess = () => {
            resolve(null)
          }
          return
        }

        // Update last accessed time (LRU)
        entry.lastAccessed = now
        store.put(entry).onsuccess = () => {
          resolve(entry.rootPost)
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.warn('Failed to get cached root post:', error)
    return null
  }
}

/**
 * Save root post to cache indexed by root URI
 */
export async function saveCachedRootPost(
  rootUri: string,
  rootPost: AppBskyFeedDefs.PostView
): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_PARENT_POSTS], 'readwrite')
    const store = transaction.objectStore(STORE_PARENT_POSTS)

    const entry: RootPostCacheEntry = {
      rootUri,
      rootPost,
      cachedAt: Date.now(),
      lastAccessed: Date.now(),
    }

    await store.put(entry)

    // Check cache size and flush if needed (async, don't block)
    checkAndFlushCache().catch(err => {
      console.warn('Failed to flush root post cache:', err)
    })
  } catch (error) {
    console.warn('Failed to save cached root post:', error)
  }
}

/**
 * Check cache size and flush old entries if needed
 */
async function checkAndFlushCache(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_PARENT_POSTS], 'readwrite')
    const store = transaction.objectStore(STORE_PARENT_POSTS)
    const lastAccessedIndex = store.index('lastAccessed')

    // Count total entries
    const countRequest = store.count()
    const count = await new Promise<number>((resolve, reject) => {
      countRequest.onsuccess = () => resolve(countRequest.result)
      countRequest.onerror = () => reject(countRequest.error)
    })

    // If cache is within limits, no flush needed
    if (count <= MAX_CACHE_SIZE) {
      return
    }

    // Need to flush: remove oldest accessed entries (LRU)
    const entriesToRemove = count - MAX_CACHE_SIZE + FLUSH_BATCH_SIZE // Remove extra to make room

    return new Promise((resolve, reject) => {
      // Get entries sorted by lastAccessed (ascending - oldest first)
      const request = lastAccessedIndex.openCursor(null, 'next')
      const entriesToDelete: string[] = []

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor && entriesToDelete.length < entriesToRemove) {
          const entry = cursor.value as RootPostCacheEntry
          entriesToDelete.push(entry.rootUri)
          cursor.continue()
        } else {
          // Delete all collected entries
          if (entriesToDelete.length === 0) {
            resolve()
            return
          }

          let deleted = 0
          entriesToDelete.forEach(rootUri => {
            const deleteRequest = store.delete(rootUri)
            deleteRequest.onsuccess = () => {
              deleted++
              if (deleted === entriesToDelete.length) {
                console.log(`[Root Post Cache] Flushed ${deleted} old entries`)
                resolve()
              }
            }
            deleteRequest.onerror = () => {
              deleted++
              if (deleted === entriesToDelete.length) {
                resolve() // Continue even if some deletes fail
              }
            }
          })
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.warn('Failed to check and flush root post cache:', error)
  }
}

/**
 * Clear all cached root posts
 */
export async function clearRootPostCache(): Promise<void> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_PARENT_POSTS], 'readwrite')
    const store = transaction.objectStore(STORE_PARENT_POSTS)
    await store.clear()
    console.log('[Root Post Cache] Cleared all cached root posts')
  } catch (error) {
    console.warn('Failed to clear root post cache:', error)
    throw error
  }
}

/**
 * Remove expired entries from cache (time-based flush)
 * Should be called periodically (e.g., on app startup or every hour)
 */
export async function flushExpiredRootPosts(): Promise<number> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_PARENT_POSTS], 'readwrite')
    const store = transaction.objectStore(STORE_PARENT_POSTS)
    const cachedAtIndex = store.index('cachedAt')

    const now = Date.now()
    const expiredBefore = now - CACHE_TTL

    return new Promise((resolve, reject) => {
      // Get all entries with cachedAt < expiredBefore
      const range = IDBKeyRange.upperBound(expiredBefore, true)
      const request = cachedAtIndex.openCursor(range)
      const entriesToDelete: string[] = []

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) {
          const entry = cursor.value as RootPostCacheEntry
          entriesToDelete.push(entry.rootUri)
          cursor.continue()
        } else {
          // Delete all expired entries
          if (entriesToDelete.length === 0) {
            resolve(0)
            return
          }

          let deleted = 0
          entriesToDelete.forEach(rootUri => {
            const deleteRequest = store.delete(rootUri)
            deleteRequest.onsuccess = () => {
              deleted++
              if (deleted === entriesToDelete.length) {
                console.log(`[Root Post Cache] Removed ${deleted} expired entries`)
                resolve(deleted)
              }
            }
            deleteRequest.onerror = () => {
              deleted++
              if (deleted === entriesToDelete.length) {
                resolve(deleted) // Continue even if some deletes fail
              }
            }
          })
        }
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.warn('Failed to flush expired root posts:', error)
    return 0
  }
}

/**
 * Get cache statistics
 */
export async function getRootPostCacheStats(): Promise<{
  totalEntries: number
  oldestEntry: number | null
  newestEntry: number | null
}> {
  try {
    const database = await getDB()
    const transaction = database.transaction([STORE_PARENT_POSTS], 'readonly')
    const store = transaction.objectStore(STORE_PARENT_POSTS)

    return new Promise((resolve, reject) => {
      const request = store.getAll()

      request.onsuccess = () => {
        const entries = request.result as RootPostCacheEntry[]

        if (entries.length === 0) {
          resolve({
            totalEntries: 0,
            oldestEntry: null,
            newestEntry: null,
          })
          return
        }

        const cachedAts = entries.map(e => e.cachedAt)
        const oldestEntry = Math.min(...cachedAts)
        const newestEntry = Math.max(...cachedAts)

        resolve({
          totalEntries: entries.length,
          oldestEntry,
          newestEntry,
        })
      }

      request.onerror = () => reject(request.error)
    })
  } catch (error) {
    console.warn('Failed to get root post cache stats:', error)
    return {
      totalEntries: 0,
      oldestEntry: null,
      newestEntry: null,
    }
  }
}

// Keep old function names as aliases for backward compatibility during transition
export const getCachedParentPost = getCachedRootPost
export const saveCachedParentPost = saveCachedRootPost
export const clearParentPostCache = clearRootPostCache
export const flushExpiredParentPosts = flushExpiredRootPosts
export const getParentPostCacheStats = getRootPostCacheStats
