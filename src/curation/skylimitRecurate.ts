/**
 * Recompute curation status for posts when parameters change
 * Updates summaries cache with new curation status
 */

import { BskyAgent } from '@atproto/api'
import { getAllPostSummaries, getFilter, getAllFollows, initDB } from './skylimitCache'
import { getSettings } from './skylimitStore'
import { curateSinglePost } from './skylimitFilter'
import { getEditionTimeStrs } from './skylimitGeneral'
import { getPostUniqueIdFromCache } from './skylimitFeedCache'
import { PostSummary } from './types'

/**
 * Recompute curation status for all posts in summaries cache
 * Called when curation parameters change
 * 
 * Note: This function requires full post data to re-curate. It attempts to find
 * posts in the feed cache, but if a post is not in cache, it cannot be re-curated.
 * In practice, this should work for recent posts (within 24 hours) which are in cache.
 */
export async function recomputeCurationDecisions(
  _agent: BskyAgent,
  myUsername: string,
  myDid: string
): Promise<{ updated: number; skipped: number }> {
  try {
    console.log('Starting curation status recomputation...')
    
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

    // Get all post summaries
    const allSummaries = await getAllPostSummaries()
    let updatedCount = 0
    let skippedCount = 0

    // Get feed cache to look up full post data
    const database = await initDB()
    const transaction = database.transaction(['feed_cache'], 'readonly')
    const feedStore = transaction.objectStore('feed_cache')

    const feedCacheEntries = await new Promise<any[]>((resolve, reject) => {
      const request = feedStore.getAll()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })

    // Build a map of unique ID -> feed cache entry
    // Use getPostUniqueIdFromCache for consistent ID generation that matches summaries
    const feedCacheMap = new Map<string, any>()
    for (const entry of feedCacheEntries) {
      const uniqueId = getPostUniqueIdFromCache(entry)
      feedCacheMap.set(uniqueId, entry)
    }

    // Track updated summaries to save
    const updatedSummaries: PostSummary[] = []

    // Process all summaries
    for (const summary of allSummaries) {
      // Try to find the post in feed cache
      const cacheEntry = feedCacheMap.get(summary.uniqueId)

      if (!cacheEntry) {
        // Post not in cache - skip (it's older than 24 hours or was never cached)
        skippedCount++
        continue
      }

      // Re-curate the post
      const post = cacheEntry.post
      const curation = await curateSinglePost(
        post,
        myUsername,
        myDid,
        followMap,
        currentStats,
        currentProbs,
        secretKey,
        editionCount
      )

      // Check if curation status changed
      const oldStatus = summary.curation_status
      if (oldStatus !== curation.curation_status) {
        // Update curation status in summary
        summary.curation_status = curation.curation_status
        summary.curation_msg = curation.curation_msg
        updatedSummaries.push(summary)
        updatedCount++
      }
    }

    // Save all updated summaries
    // Note: savePostSummaries will update existing entries since they already exist
    if (updatedSummaries.length > 0) {
      // For updates, we need to force overwrite existing entries
      const database2 = await initDB()
      const transaction2 = database2.transaction(['post_summaries'], 'readwrite')
      const store = transaction2.objectStore('post_summaries')
      for (const summary of updatedSummaries) {
        await new Promise<void>((resolve, reject) => {
          const request = store.put(summary)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
        })
      }
    }
    
    console.log(`Curation recomputation complete: ${updatedCount} updated, ${skippedCount} skipped`)
    return { updated: updatedCount, skipped: skippedCount }
  } catch (error) {
    console.error('Error during curation recomputation:', error)
    throw error
  }
}

