/**
 * Feed cache fetch — API fetch orchestration and curation bridge
 */

import { AppBskyFeedDefs, BskyAgent } from '@atproto/api'
import {
  getPostSummary,
  isInPrimaryCache,
  saveEditionPost,
  getFilter,
  getAllFollows,
  savePostsToPrimaryCache,
  savePostSummariesForce,
} from './skylimitCache'
import { getFeedViewPostTimestamp, getPostUniqueId, createPostSummary, getEditionTimeStrs } from './skylimitGeneral'
import { CurationFeedViewPost, FeedCacheEntryWithPost, PostSummary, isStatusShow, isStatusDrop, getIntervalHoursSync, FetchMode, FetchStopReason, SecondaryEntry, SecondaryFetchResult, SecondaryRepostIndex, addToRepostIndex } from './types'
import { curatePosts } from './skylimitTimeline'
import { curateSinglePost } from './skylimitFilter'
import { getMaxNumbersForDay } from './skylimitNumbering'
import { getHomeFeed } from '../api/feed'
import { getSettings } from './skylimitStore'
import { clientNow, clientDate } from '../utils/clientClock'
import {
  createFeedCacheEntries,
  savePostsToFeedCache,
  checkFeedCacheExists,
  getOldestCachedPostTimestamp,
  savePrevPageCursor,
  getLocalMidnight,
  updateFeedCacheNewestPostTimestamp,
  getLastFetchMetadata,
  DEFAULT_PAGE_LENGTH,
  MAX_FETCH_ITERATIONS,
} from './feedCacheCore'

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
  const repostIndex: SecondaryRepostIndex = new Map()
  for (const entry of entries) {
    const existingSummary = await getPostSummary(entry.uniqueId)
    let summary: PostSummary
    if (existingSummary) {
      summary = existingSummary
    } else {
      const curationResult = await curateSinglePost(
        entry.originalPost, myUsername, myDid, followMap,
        currentStats, currentProbs, secretKey, editionCount,
        repostIndex
      )
      summary = createPostSummary(entry.originalPost, new Date(entry.postTimestamp))
      summary.curation_status = curationResult.curation_status
      summary.curation_msg = curationResult.curation_msg
      if (curationResult.curation_save) {
        summary.curation_save = curationResult.curation_save
      }
    }
    result.push({ entry, summary })
    addToRepostIndex(repostIndex, summary)
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
  // Get interval settings for cache entries
  const settings = await getSettings()

  // Use local midnight of the day containing fromTimestamp as the stop boundary
  const targetDate = new Date(fromTimestamp)
  const localMidnight = getLocalMidnight(targetDate, settings.timezone).getTime()

  // If fromTimestamp is already at or before midnight, no gap fill needed
  if (fromTimestamp <= localMidnight) {
    console.log('[Gap Fill] Already at or past midnight boundary, skipping')
    return 0
  }
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
    initialCursor?: string  // Continue from a previous fetch's cursor (avoids re-fetching from newest)
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
  const todayMidnight = getLocalMidnight(today, settings?.timezone)
  const midnightBoundary = todayMidnight.getTime() - 24 * 60 * 60 * 1000
  console.log(`${label} Midnight boundary: ${new Date(midnightBoundary).toLocaleString()}`)

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
  const repostIndex: SecondaryRepostIndex = new Map()
  let oldestTimestamp: number | null = null
  let newestTimestamp: number | null = null

  let cursor: string | undefined = options.initialCursor
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
          editionCount,
          repostIndex
        )

        summary = createPostSummary(entry.originalPost, new Date(entry.postTimestamp))
        summary.curation_status = curationResult.curation_status
        summary.curation_msg = curationResult.curation_msg
        if (curationResult.curation_save) {
          summary.curation_save = curationResult.curation_save
        }
      }

      // Append to in-memory array and update repost index
      secondaryEntries.push({ entry, summary })
      addToRepostIndex(repostIndex, summary)

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
  const settings = await getSettings()
  const timezone = settings.timezone
  const oldestTimestamp = sorted[0].entry.postTimestamp
  let currentDayStart = getLocalMidnight(new Date(oldestTimestamp), timezone).getTime()
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
        currentDayStart = getLocalMidnight(new Date(entry.postTimestamp), timezone).getTime()
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
