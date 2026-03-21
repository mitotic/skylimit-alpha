/**
 * Feed cache fetch — API fetch orchestration and curation bridge
 */

import { AppBskyFeedDefs, BskyAgent } from '@atproto/api'
import {
  getPostSummary,
  isInPrimaryCache,
  getFilter,
  getAllFollows,
  savePostsToPrimaryCache,
  savePostSummariesForce,
  clearRecentData,
} from './skylimitCache'
import { getFeedViewPostTimestamp, getPostUniqueId, createPostSummary, getEditionTimeStrs, checkAndStorePinnedPost } from './skylimitGeneral'
import { CurationFeedViewPost, FeedCacheEntryWithPost, PostSummary, isStatusShow, isStatusDrop, getIntervalHoursSync, FetchMode, FetchStopReason, SecondaryEntry, SecondaryFetchResult, SecondaryRepostIndex, addToRepostIndex, SL_REPOST_PREFIX, SL_EDITION_PREFIX } from './types'
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
  getNextLocalMidnight,
  updateFeedCacheNewestPostTimestamp,
  getLastFetchMetadata,
  DEFAULT_PAGE_LENGTH,
  MAX_FETCH_ITERATIONS,
  getAllFeedCacheEntries,
} from './feedCacheCore'
import {
  tryCreateEdition,
} from './skylimitEditionAssembly'
import { getParsedEditions, EDITION_PRE_OFFSET_MS, TAIL_EDITION_NUMBER } from './skylimitEditions'
import { isEditionInRegistry } from './editionRegistry'
import log from '../utils/logger'

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
  onProgress?: (percent: number) => void,
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
      summary = createPostSummary(entry.originalPost, new Date(entry.postTimestamp), myUsername)
      summary.curation_status = curationResult.curation_status
      summary.curation_msg = curationResult.curation_msg
      if (curationResult.edition_tag) summary.edition_tag = curationResult.edition_tag
      if (curationResult.matching_pattern) summary.matching_pattern = curationResult.matching_pattern
      if (curationResult.edition_status) summary.edition_status = curationResult.edition_status
    }
    checkAndStorePinnedPost(summary)
    result.push({ entry, summary })
    addToRepostIndex(repostIndex, summary)
    if (onProgress) {
      onProgress(Math.round((result.length / entries.length) * 100))
    }
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
    log.debug('Gap Fill', 'Already at or past midnight boundary, skipping')
    return 0
  }
  const intervalHours = getIntervalHoursSync(settings)

  log.debug('Gap Fill', `Filling gap from ${new Date(fromTimestamp).toLocaleTimeString()} to midnight ${new Date(localMidnight).toLocaleTimeString()}`)

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
        log.verbose('Gap Fill', 'No more posts from server, stopping')
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
          log.info('Gap Fill', `Reached cached post boundary: ${new Date(postTimestamp).toLocaleString()}`)
          hitCachedPost = true
          break
        }

        // Stop if post is before midnight
        if (postTimestamp < localMidnight) {
          log.info('Gap Fill', `Reached midnight boundary: ${new Date(localMidnight).toLocaleString()}`)
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

        log.debug('Gap Fill', `Cached ${newPosts.length} new posts (total: ${totalNewPosts})`)
      }

      if (hitCachedPost) {
        break
      }

      cursor = newCursor
      if (!cursor) {
        log.debug('Gap Fill', 'No more cursor, stopping')
        break
      }
    } catch (error) {
      log.warn('Gap Fill', 'Error during fetch:', error)
      break
    }
  }

  if (iterations >= maxIterations) {
    log.warn('Gap Fill', 'Hit max iterations limit')
  }

  log.info('Gap Fill', `Completed - cached ${totalNewPosts} new posts`)
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
  log.debug('Fetch Until Cached', `Starting from ${new Date(fromTimestamp).toLocaleTimeString()}, stopping at cached post`)

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
        log.verbose('Fetch Until Cached', 'No more posts from server')
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
            log.debug('Fetch Until Cached', `Skipping post at ${postTimestamp.toLocaleTimeString()} (newer than fromTimestamp)`)
          }
          continue
        }

        // Now we're past fromTimestamp - start collecting
        if (!startedCollecting) {
          startedCollecting = true
          log.debug('Fetch Until Cached', `Started collecting at ${postTimestamp.toLocaleTimeString()}`)
        }

        // Check if post already exists in feed cache - stop
        // (curatePosts will preserve existing curation decisions from summaries cache)
        const inFeedCache = await checkFeedCacheExists(uniqueId)
        if (inFeedCache) {
          log.info('Fetch Until Cached', `Reached cached post boundary: ${postTimestamp.toLocaleString()}`)
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

        log.debug('Fetch Until Cached', `Cached ${newPosts.length} posts (total: ${totalNewPosts})`)
      }

      if (hitCachedPost) {
        break
      }

      cursor = newCursor
      if (!cursor) {
        log.debug('Fetch Until Cached', 'No more cursor')
        break
      }
    } catch (error) {
      log.warn('Fetch Until Cached', 'Error during fetch:', error)
      break
    }
  }

  if (iterations >= maxIterations) {
    log.warn('Fetch Until Cached', 'Hit max iterations limit')
  }

  const reachedEnd = !cursor || hitCachedPost
  log.info('Fetch Until Cached', `Completed - returned ${allPosts.length} posts, reachedEnd: ${reachedEnd}`)
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
  log.debug('Server Fallback', `Fetching page from ${new Date(fromTimestamp).toLocaleTimeString()}, cursor: ${existingCursor ? 'provided' : 'none'}`)

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
        log.verbose('Server Fallback', 'No more posts from server')
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

      log.debug('Server Fallback', `Fetched ${curatedFeed.length} posts using cursor`)

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
      log.warn('Server Fallback', 'Error fetching with cursor:', error)
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
        log.debug('Server Fallback', 'No more posts while skipping')
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
          log.debug('Server Fallback', `Collected ${allPosts.length} posts after skipping ${skippedCount}`)
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
        log.debug('Server Fallback', 'No more cursor while collecting')
        break
      }
    } catch (error) {
      log.warn('Server Fallback', 'Error during fetch:', error)
      break
    }
  }

  if (iterations >= maxIterations) {
    log.warn('Server Fallback', 'Hit max iterations while skipping')
  }

  log.info('Server Fallback', `Completed - returned ${allPosts.length} posts after skipping ${skippedCount}`)

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
  const topic = `Fetch/${mode}`

  log.debug(topic, 'Starting fetch')

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

  // Calculate midnight boundary using mode-appropriate lookback days
  const today = clientDate()
  const todayMidnight = getLocalMidnight(today, settings?.timezone)
  const lookbackDays = mode === 'initial'
    ? (settings?.initialLookbackDays ?? 1)
    : (settings?.refillLookbackDays ?? 1)
  const midnightBoundary = todayMidnight.getTime() - lookbackDays * 24 * 60 * 60 * 1000
  log.debug(topic, ` Midnight boundary: ${new Date(midnightBoundary).toLocaleString()}`)

  // For non-initial modes, get primary cache newest timestamp for overlap detection
  let primaryNewestTimestamp: number | null = null
  if (mode !== 'initial') {
    if (options.overlapTargetTimestamp !== undefined) {
      // Use explicit overlap target (e.g., pre-idle cache boundary before metadata was overwritten)
      primaryNewestTimestamp = options.overlapTargetTimestamp
      log.debug(topic, ` Using explicit overlap target: ${new Date(primaryNewestTimestamp).toLocaleString()}`)
    } else {
      const metadata = await getLastFetchMetadata()
      primaryNewestTimestamp = metadata?.newestCachedPostTimestamp ?? null
    }
    if (primaryNewestTimestamp) {
      log.debug(topic, ` Primary newest: ${new Date(primaryNewestTimestamp).toLocaleString()}`)
    } else {
      log.warn(topic, ` No primary cache metadata, will stop on boundary only`)
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
        log.warn(topic, ` Rate limit encountered:`, info)
      }
    })

    if (feed.length === 0) {
      log.debug(topic, ` No more posts from server`)
      stopReason = 'exhausted'
      break
    }

    // Create feed cache entries with calculated postTimestamps
    const { entries, finalLastPostTime } = createFeedCacheEntries(feed, lastPostTime, intervalHours)
    lastPostTime = finalLastPostTime

    let batchStopped = false

    for (const entry of entries) {
      // Skip entries with invalid timestamps (NaN escapes comparison checks)
      if (isNaN(entry.postTimestamp)) {
        log.warn(topic, ` Skipping entry with invalid postTimestamp: ${entry.uniqueId}`)
        continue
      }
      // Check midnight boundary — stop if post is at or before boundary
      if (entry.postTimestamp <= midnightBoundary) {
        log.info(topic, ` Reached midnight boundary: ${new Date(midnightBoundary).toLocaleString()}`)
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
            log.info(topic, ` Reached cache overlap boundary: ${new Date(entry.postTimestamp).toLocaleString()}`)
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

        summary = createPostSummary(entry.originalPost, new Date(entry.postTimestamp), myUsername)
        summary.curation_status = curationResult.curation_status
        summary.curation_msg = curationResult.curation_msg
        if (curationResult.edition_tag) summary.edition_tag = curationResult.edition_tag
        if (curationResult.matching_pattern) summary.matching_pattern = curationResult.matching_pattern
        if (curationResult.edition_status) summary.edition_status = curationResult.edition_status
      }
      checkAndStorePinnedPost(summary)

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

    log.debug(topic, ` Batch ${iterations}: ${entries.length} entries, ${secondaryEntries.length} total in secondary`)

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
      log.debug(topic, ` Server cursor exhausted`)
      stopReason = 'exhausted'
      break
    }
  }

  if (iterations >= maxIterations) {
    log.warn(topic, ` Reached max iterations limit (${maxIterations})`)
    stopReason = 'max_iterations'
  }

  log.debug(topic, ` Complete: ${secondaryEntries.length} posts, stopReason=${stopReason}, ` +
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
  editionsAssembled: number
}

/**
 * Compute a UTC timestamp for an edition HH:MM on the calendar day of a
 * reference timestamp, with an optional day offset (0 = same day, 1 = next day).
 * Edition times are expressed in the configured timezone.
 */
function computeEditionTimestampForDay(
  editionTime: string,
  referenceDayTimestamp: number,
  timezone?: string,
  dayOffset: number = 0
): number {
  const [hours, minutes] = editionTime.split(':').map(Number)
  const refDate = new Date(referenceDayTimestamp)

  if (timezone) {
    // Get the calendar date in the configured timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
    const parts = formatter.formatToParts(refDate)
    const year = parseInt(parts.find(p => p.type === 'year')!.value)
    const month = parseInt(parts.find(p => p.type === 'month')!.value) - 1
    const day = parseInt(parts.find(p => p.type === 'day')!.value) + dayOffset

    // Note: Date.UTC and Intl.DateTimeFormat are real-time APIs, but they're
    // used here purely for calendar/timezone math on the input timestamp —
    // no reference to "now". The referenceDayTimestamp is already in client-time
    // space (accelerated timestamps from Skyspeed flow through the cache), and
    // these APIs correctly map any UTC ms value to the right calendar date/time
    // in the configured timezone, regardless of clock acceleration.

    // Start with a UTC guess: "HH:MM UTC on this calendar day"
    const utcGuess = Date.UTC(year, month, day, hours, minutes, 0, 0)

    // Check what time the configured TZ shows at this UTC moment
    const tzParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date(utcGuess))
    const tzHour = parseInt(tzParts.find(p => p.type === 'hour')!.value) % 24
    const tzMin = parseInt(tzParts.find(p => p.type === 'minute')!.value)

    // Difference = how far off the guess is from the desired time in the configured TZ
    let diffMs = ((tzHour - hours) * 60 + (tzMin - minutes)) * 60_000
    // Normalize for wrap-around (e.g., timezones far from UTC)
    if (diffMs > 12 * 3600_000) diffMs -= 24 * 3600_000
    if (diffMs < -12 * 3600_000) diffMs += 24 * 3600_000
    // If configured TZ shows a later time than desired, UTC guess is too late → subtract
    return utcGuess - diffMs
  }

  // No configured timezone: use browser local time
  return new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() + dayOffset, hours, minutes, 0, 0).getTime()
}

function makeEditionKey(editionTime: string, editionTimestamp: number): string {
  const d = new Date(editionTimestamp)
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${dateStr}_${editionTime}`
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
  const topic = `Transfer/${transferMode}`

  if (secondaryEntries.length === 0) {
    log.debug(topic, ` No entries to transfer`)
    return { postsTransferred: 0, displayableCount: 0, newestTransferredTimestamp: null, oldestTransferredTimestamp: null, editionsAssembled: 0 }
  }

  // Filter out entries with invalid timestamps, then sort oldest-first for correct numbering order
  const sorted = [...secondaryEntries]
    .filter(s => {
      if (isNaN(s.entry.postTimestamp)) {
        log.warn(topic, ` Skipping entry with invalid postTimestamp: ${s.entry.uniqueId}`)
        return false
      }
      return true
    })
    .sort((a, b) => a.entry.postTimestamp - b.entry.postTimestamp)

  if (sorted.length === 0) {
    log.debug(topic, ` No valid entries to transfer (all had invalid timestamps)`)
    return { postsTransferred: 0, displayableCount: 0, newestTransferredTimestamp: null, oldestTransferredTimestamp: null, editionsAssembled: 0 }
  }

  // Initialize numbering from the day of the oldest entry (unless skipping)
  const settings = await getSettings()
  const timezone = settings.timezone
  const oldestEntryTimestamp = sorted[0].entry.postTimestamp
  let currentDayMidnight = getLocalMidnight(new Date(oldestEntryTimestamp), timezone)
  let currentDayStart = currentDayMidnight.getTime()
  let currentDayEnd = getNextLocalMidnight(currentDayMidnight, timezone).getTime()
  let postNumber = 0
  let curationNumber = 0
  if (!skipNumbering) {
    const dayNumbers = await getMaxNumbersForDay(currentDayStart, currentDayEnd)
    postNumber = dayNumbers.maxPostNumber
    curationNumber = dayNumbers.maxCurationNumber
  }

  // --- Edition assembly setup ---
  // Get newest primary cache timestamp for edition gap detection
  const metadata = await getLastFetchMetadata()
  let newestPrimaryTimestamp = metadata?.newestCachedPostTimestamp ?? null
  log.debug(topic, ` newestPrimaryTimestamp=${newestPrimaryTimestamp !== null ? new Date(newestPrimaryTimestamp).toLocaleString() + ' (from metadata)' : 'null (no metadata)'}`)

  // Initialize edition state
  const parsedEditions = await getParsedEditions()

  // If primary cache is empty, use oldest secondary entry as the reference point
  if (newestPrimaryTimestamp === null) {
    newestPrimaryTimestamp = oldestEntryTimestamp
    log.debug(topic, ` Primary cache empty, using oldest entry as reference: ${new Date(oldestEntryTimestamp).toLocaleString()}`)
  }

  const newestEntryTimestamp = sorted[sorted.length - 1].entry.postTimestamp

  // Find all pending editions between newestPrimaryTimestamp and newestEntryTimestamp
  const pendingEditions: Array<{ editionNumber: number; editionTime: string; editionTimestamp: number }> = []
  const editionTimes = parsedEditions.editions
    .filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)
    .sort((a, b) => a.time.localeCompare(b.time))

  // Compute how many days the data spans to check all possible editions
  const dataSpanDays = Math.ceil((newestEntryTimestamp - newestPrimaryTimestamp) / (24 * 60 * 60 * 1000))
  const maxDayOffset = Math.max(1, dataSpanDays)

  let pastRange = false
  for (let dayOffset = 0; dayOffset <= maxDayOffset && !pastRange; dayOffset++) {
    for (const edition of editionTimes) {
      const editionTimestamp = computeEditionTimestampForDay(edition.time, newestPrimaryTimestamp, timezone, dayOffset)
      // If the current newest post is older than the edition time, postpone edition
      // creation because a future newer post closer to the edition time may arrive
      if (editionTimestamp >= newestEntryTimestamp) { pastRange = true; break }
      if (isEditionInRegistry(makeEditionKey(edition.time, editionTimestamp))) continue
      if (editionTimestamp < newestPrimaryTimestamp - EDITION_PRE_OFFSET_MS) continue
      pendingEditions.push({ editionNumber: edition.editionNumber, editionTime: edition.time, editionTimestamp })
    }
  }
  // Sort pending editions oldest-first for correct processing order
  pendingEditions.sort((a, b) => a.editionTimestamp - b.editionTimestamp)
  log.debug(topic, ` Transferring ${sorted.length} entries: oldest=${new Date(oldestEntryTimestamp).toLocaleString()}, newest=${new Date(newestEntryTimestamp).toLocaleString()}`)
  if (pendingEditions.length > 0) {
    log.debug(topic, ` Edition timestamps to check: ${pendingEditions.map(p => `${p.editionTime} (${new Date(p.editionTimestamp).toLocaleString()}, ts=${p.editionTimestamp})`).join(', ')}`)
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
  let editionsAssembled = 0
  let newestTransferredTimestamp: number | null = null
  let oldestTransferredTimestamp: number | null = null

  // --- Edition pre-processing: find gaps and create editions before transfer ---
  // Extract in-memory summaries for tryCreateEdition. On initial load, held posts
  // aren't in IndexedDB yet — they're only in the sorted entries being transferred.
  const inMemorySummaries = sorted.map(s => s.summary)

  const now = clientNow()
  const STALENESS_MS = 48 * 60 * 60 * 1000

  for (const pending of pendingEditions) {
    // Check lead time window (now >= editionTimestamp - 15 min)
    if (now < pending.editionTimestamp - EDITION_PRE_OFFSET_MS) {
      log.verbose('Transfer/edition', `${pending.editionTime} SKIPPED: lead time not met (now=${new Date(now).toLocaleString()}, earliest=${new Date(pending.editionTimestamp - EDITION_PRE_OFFSET_MS).toLocaleString()})`)
      continue
    }

    // Check staleness (edition must be within 48 hours of now)
    const ageMs = now - pending.editionTimestamp
    if (ageMs > STALENESS_MS) {
      log.verbose('Transfer/edition', `${pending.editionTime} SKIPPED: edition too old (${Math.round(ageMs / 3600000)}h ago)`)
      continue
    }

    // Find the best gap for this edition.
    // Scan consecutive entry pairs starting 15 min before edition time.
    // Prefer the gap closest to edition time without exceeding it.
    // If none found before, use the next gap found after.
    const searchStart = pending.editionTimestamp - EDITION_PRE_OFFSET_MS
    let bestGapIdx = -1        // index of the entry AFTER the best gap (before edition time)
    let bestGapBeforeTs = 0    // timestamp of the entry before the gap
    let fallbackGapIdx = -1    // first gap found at or after edition time
    let fallbackGapBeforeTs = 0

    for (let i = 0; i < sorted.length; i++) {
      const entryTs = sorted[i].entry.postTimestamp
      if (entryTs < searchStart) continue

      // Get the previous timestamp: either the previous entry, or newestPrimaryTimestamp
      const prevTs = i > 0 ? sorted[i - 1].entry.postTimestamp : newestPrimaryTimestamp
      if (prevTs === null) continue

      const gap = entryTs - prevTs
      if (gap < 1000) continue // need >= 1 second gap

      if (entryTs <= pending.editionTimestamp) {
        // Gap is before edition time — track the closest one
        bestGapIdx = i
        bestGapBeforeTs = prevTs
      } else if (fallbackGapIdx === -1) {
        // First gap at or after edition time — fallback
        fallbackGapIdx = i
        fallbackGapBeforeTs = prevTs
      }

      // If we found a fallback, stop scanning (we have the best pre-edition gap or the first post-edition gap)
      if (fallbackGapIdx !== -1) break
    }

    // Choose the gap to use
    let gapIdx: number
    let gapBeforeTs: number
    if (bestGapIdx !== -1) {
      gapIdx = bestGapIdx
      gapBeforeTs = bestGapBeforeTs
    } else if (fallbackGapIdx !== -1) {
      gapIdx = fallbackGapIdx
      gapBeforeTs = fallbackGapBeforeTs
    } else {
      log.verbose('Transfer/edition', `${pending.editionTime} (${new Date(pending.editionTimestamp).toLocaleString()}) SKIPPED: no suitable gap found`)
      continue
    }

    const gapAfterTs = sorted[gapIdx].entry.postTimestamp
    log.verbose('Transfer/edition', `Gap found: ${pending.editionTime} (${new Date(pending.editionTimestamp).toLocaleString()}) between [${new Date(gapBeforeTs).toLocaleString()}, ${new Date(gapAfterTs).toLocaleString()}] (gap=${gapAfterTs - gapBeforeTs}ms)`)

    // Determine the interval string from the entry at the gap
    const gapInterval = sorted[gapIdx].entry.interval

    // Create edition
    const syntheticPosts = await tryCreateEdition(
      pending.editionNumber,
      pending.editionTime,
      gapBeforeTs,
      gapAfterTs,
      inMemorySummaries,
      pending.editionTimestamp
    )

    if (syntheticPosts.length > 0) {
      // Insert synthetic posts into sorted array at the gap position
      // They get timestamps starting at gapBeforeTs + 1ms with 1ms spacing
      const syntheticEntries: typeof sorted[0][] = []
      for (const syntheticPost of syntheticPosts) {
        const insertTimestamp = getFeedViewPostTimestamp(syntheticPost).getTime()
        const syntheticUniqueId = getPostUniqueId(syntheticPost).replace(SL_REPOST_PREFIX, SL_EDITION_PREFIX)

        // Set reason.uri so getPostUniqueId() returns the sl-ed:// uniqueId when
        // the post is later retrieved from cache (fixes summary lookup mismatch)
        ;(syntheticPost.reason as any).uri = syntheticUniqueId

        // Follow repost convention: username = reposter (editor), orig_username = original author
        const editorBy = (syntheticPost.reason as any)?.by
        const syntheticSummary: PostSummary = {
          uniqueId: syntheticUniqueId,
          cid: syntheticPost.post.cid,
          username: editorBy?.handle || syntheticPost.post.author.handle,
          accountDid: editorBy?.did || syntheticPost.post.author.did,
          orig_username: syntheticPost.post.author.handle,
          repostUri: syntheticPost.post.uri,
          tags: [],
          repostCount: syntheticPost.post.repostCount ?? 0,
          timestamp: new Date(insertTimestamp),
          postTimestamp: insertTimestamp,
          postEngagement: undefined,
          curation_status: settings.showEditionsInFeed ? 'edition_publish_show' : 'edition_publish_drop',
          curation_msg: syntheticPost.curation?.curation_msg,
          edition_status: 'synthetic',
          postNumber: null,
          curationNumber: settings.showEditionsInFeed ? null : (syntheticPost.curation?.curationNumber ?? null),
        }

        syntheticEntries.push({
          entry: {
            uniqueId: syntheticUniqueId,
            post: syntheticPost,
            timestamp: insertTimestamp,
            postTimestamp: insertTimestamp,
            interval: gapInterval,
            cachedAt: clientNow(),
            originalPost: syntheticPost as any,
          },
          summary: syntheticSummary,
        })
      }

      // Insert synthetic entries into sorted array at gapIdx position
      sorted.splice(gapIdx, 0, ...syntheticEntries)
      editionsAssembled++

      log.verbose('Transfer/edition', `Injected ${syntheticPosts.length} synthetic edition posts`)
    }

  }

  // --- Main transfer loop ---
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
        currentDayMidnight = getLocalMidnight(new Date(entry.postTimestamp), timezone)
        currentDayStart = currentDayMidnight.getTime()
        currentDayEnd = getNextLocalMidnight(currentDayMidnight, timezone).getTime()
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

    // Update running newest primary timestamp as entries are processed
    newestPrimaryTimestamp = Math.max(newestPrimaryTimestamp ?? 0, entry.postTimestamp)
  }

  // Batch write to primary cache
  const savedCount = await savePostsToPrimaryCache(primaryEntries)

  // Batch save summaries (numbers assigned inline unless skipNumbering)
  await savePostSummariesForce(summariesToSave)

  // Ensure all synthetic edition entries are persisted even if skipped by page cutoff.
  // In page mode, the loop breaks after enough displayable posts, but synthetic edition
  // posts inserted at a gap deeper in the array may not have been processed yet.
  if (transferMode === 'page') {
    const savedIds = new Set(summariesToSave.map(s => s.uniqueId))
    const unsavedSynthetics = sorted.filter(item =>
      item.summary.edition_status === 'synthetic' && !savedIds.has(item.summary.uniqueId)
    )
    if (unsavedSynthetics.length > 0) {
      await savePostSummariesForce(unsavedSynthetics.map(s => s.summary))
      await savePostsToPrimaryCache(unsavedSynthetics.map(({ entry }) => ({
        uniqueId: entry.uniqueId,
        post: entry.post,
        timestamp: entry.timestamp,
        postTimestamp: entry.postTimestamp,
        interval: entry.interval,
        cachedAt: entry.cachedAt,
        reposterDid: entry.reposterDid,
      })))
      log.debug(topic, ` Saved ${unsavedSynthetics.length} synthetic edition entries skipped by page cutoff`)
    }
  }

  // Update primary cache metadata
  await updateFeedCacheNewestPostTimestamp()

  log.debug(topic, ` Complete: ${savedCount} saved to primary (${primaryEntries.length} processed), ${displayableCount} displayable${skipNumbering ? ', numbering deferred' : ''}`)

  return {
    postsTransferred: savedCount,
    displayableCount,
    newestTransferredTimestamp,
    oldestTransferredTimestamp,
    editionsAssembled,
  }
}

export interface RecurateResult extends TransferResult {
  totalEntriesRecurated: number
  oldestEntryTimestamp: number
  newestEntryTimestamp: number
}

/**
 * Re-curate posts from the feed cache without re-fetching from the server.
 * Reads cached entries, clears the cache, re-curates all entries through the
 * secondary→primary transfer pipeline with current curation settings.
 *
 * Since re-curation is fast (no network), the caller displays the final
 * numbered result directly after this function returns.
 *
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @param lookbackBoundaryMs - Timestamp boundary (entries >= this are re-curated)
 * @param pageLength - Number of displayable posts per page
 * @param onProgress - Callback with re-curation progress (0-100)
 * @returns RecurateResult or null if no entries to re-curate
 */
export async function recurateFromCache(
  myUsername: string,
  myDid: string,
  lookbackBoundaryMs: number,
  pageLength: number,
  onProgress: (percent: number) => void,
): Promise<RecurateResult | null> {
  const topic = 'Re-curate'

  // Phase A: Read entries from feed cache before clearing
  log.info(topic, `Reading feed cache entries >= ${new Date(lookbackBoundaryMs).toISOString()}`)
  const allEntries = await getAllFeedCacheEntries(lookbackBoundaryMs)
  const rawEntries = allEntries.filter(e => !e.uniqueId.startsWith(SL_EDITION_PREFIX))
  log.info(topic, `Found ${allEntries.length} entries (${allEntries.length - rawEntries.length} synthetic filtered out), ${rawEntries.length} to re-curate`)

  if (rawEntries.length === 0) {
    onProgress(100)
    return null
  }

  // Convert FeedCacheEntry → FeedCacheEntryWithPost (restore originalPost from stored post)
  const savedEntries: FeedCacheEntryWithPost[] = rawEntries.map(entry => ({
    ...entry,
    originalPost: entry.post,
  }))

  // Sort newest-first (matching loadFeed fetch order)
  savedEntries.sort((a, b) => b.postTimestamp - a.postTimestamp)
  const oldestEntryTimestamp = savedEntries[savedEntries.length - 1].postTimestamp
  const newestEntryTimestamp = savedEntries[0].postTimestamp
  const totalEntriesRecurated = savedEntries.length

  // Clear feed cache, metadata, recent summaries, and edition registry
  log.debug(topic, 'Clearing recent data...')
  await clearRecentData(lookbackBoundaryMs)

  // Phase B: Curate ALL entries in a single call (shared repostIndex for duplicate detection)
  log.debug(topic, `Curating ${savedEntries.length} entries...`)
  const secondaryEntries = await curateEntriesToSecondary(
    savedEntries, myUsername, myDid, onProgress
  )
  log.debug(topic, `Curation complete: ${secondaryEntries.length} entries`)

  // Phase C: Transfer all entries to primary cache (edition assembly, numbering deferred)
  log.debug(topic, 'Transferring to primary cache...')
  const transferResult = await transferSecondaryToPrimary(
    secondaryEntries, 'all', pageLength, true  // skipNumbering=true (same as idle return)
  )
  log.info(topic, `Complete: ${transferResult.postsTransferred} posts transferred, ${transferResult.displayableCount} displayable, ${transferResult.editionsAssembled} editions`)

  return {
    ...transferResult,
    totalEntriesRecurated,
    oldestEntryTimestamp,
    newestEntryTimestamp,
  }
}
