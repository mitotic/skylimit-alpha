/**
 * Paged Fresh Updates Module
 *
 * Handles probing for new posts and managing paged updates functionality.
 * This delays viewing new posts so popularity metrics have time to accumulate.
 */

import { BskyAgent, AppBskyFeedDefs } from '@atproto/api'
import { curateSinglePost } from './skylimitFilter'
import { getFilter, getAllFollows, getPostSummariesInRange } from './skylimitCache'
import { getSettings } from './skylimitStore'
import { getCachedPostUniqueIds, getLocalMidnight, getNextLocalMidnight, getNewestCachedPostTimestamp } from './skylimitFeedCache'
import { getFeedViewPostTimestamp, getPostUniqueId, createPostSummary } from './skylimitGeneral'
import { getHomeFeed } from '../api/feed'
import { FollowInfo, PostSummary, isStatusShow, SecondaryEntry, FeedCacheEntryWithPost, SecondaryRepostIndex, addToRepostIndex } from './types'
import log from '../utils/logger'

// Standard batch size for all API fetches (initial load, idle return, probe)
export const FETCH_BATCH_SIZE = 100

// Default settings
export const PAGED_UPDATES_DEFAULTS = {
  newPostBatchFetches: 1,   // Number of API fetches per probe (1-3)
  fullPageWaitMinutes: 10,  // Time to wait for full page before showing partial page button
}

/**
 * Result of a probe for new posts
 */
export interface ProbeResult {
  hasFullPage: boolean        // True if PageSize or more displayable posts available
  hasMultiplePages: boolean   // True if more than 1 page available (filteredPostCount > pageSize)
  pageCount: number           // Number of full pages available (Math.floor(filteredPostCount / pageSize))
  rawPostCount: number        // Total posts fetched from server
  filteredPostCount: number   // Posts that would be displayed (not dropped)
  totalPostCount: number      // All posts considered (may include dropped)
  oldestProbeTimestamp: number // Timestamp of oldest probed post (after cache filtering)
  newestProbeTimestamp: number // Timestamp of newest probed post (after cache filtering)
  rawOldestTimestamp: number   // Timestamp of oldest raw post from API
  rawNewestTimestamp: number   // Timestamp of newest raw post from API
  hasGap: boolean             // True if probe didn't reach stopTimestamp (counts may be underestimates)
  isOverlappingBatch: boolean // True if overlap with primary cache was detected
  lastPostNumber?: number     // curationNumber of the newest overlapping displayable post
  nonOverlappingEntries?: SecondaryEntry[]  // Curated entries eligible for retention
  retentionDisplayableCount?: number  // Displayable count from full batch (for retention decision)
}

/**
 * Probe for new posts without caching.
 *
 * This fetches posts from the server and curates them to determine filter status,
 * but does NOT save to summaries cache or feed cache. This preserves access to
 * newer posts since Bluesky API cursor only goes backward.
 *
 * @param agent - BskyAgent instance
 * @param pageRaw - Number of posts to fetch
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @param newestDisplayedTimestamp - Timestamp of newest displayed post (only count posts newer than this)
 * @param stopTimestamp - If provided, stop looking back at this timestamp (posts already counted in prior probes)
 * @returns ProbeResult with availability information
 */
export async function probeForNewPosts(
  agent: BskyAgent,
  pageRaw: number,
  myUsername: string,
  myDid: string,
  newestDisplayedTimestamp: number,  // Defines "today" for midnight boundary calculation
  stopTimestamp?: number  // Stop boundary from prior probes — posts at or before this were already counted
): Promise<ProbeResult> {
  const result: ProbeResult = {
    hasFullPage: false,
    hasMultiplePages: false,
    pageCount: 0,
    rawPostCount: 0,
    filteredPostCount: 0,
    totalPostCount: 0,
    oldestProbeTimestamp: Number.MAX_SAFE_INTEGER,
    newestProbeTimestamp: 0,
    rawOldestTimestamp: Number.MAX_SAFE_INTEGER,
    rawNewestTimestamp: 0,
    hasGap: false,
    isOverlappingBatch: false,
  }

  try {
    // Get settings early — needed for multi-fetch config and curation
    const settings = await getSettings()

    // Get cached post IDs early — needed for overlap detection
    const cachedPostIds = await getCachedPostUniqueIds()

    // Fetch posts, potentially multiple batches to bridge gap to cached posts
    const maxFetches = Math.min(3, Math.max(1, settings?.newPostBatchFetches ?? PAGED_UPDATES_DEFAULTS.newPostBatchFetches))
    const newestCachedTimestamp = maxFetches > 1 ? await getNewestCachedPostTimestamp() : null

    const { feed: firstBatch, cursor: firstCursor } = await getHomeFeed(agent, { limit: pageRaw })

    if (firstBatch.length === 0) {
      return result
    }

    let feed = [...firstBatch]
    let currentCursor = firstCursor

    // Additional fetches if gap exists between fetched posts and cache
    if (maxFetches > 1 && newestCachedTimestamp != null) {
      for (let fetchNum = 2; fetchNum <= maxFetches; fetchNum++) {
        if (!currentCursor) break

        // Check if oldest post in combined batch is still newer than cache
        let oldestBatchTimestamp = Number.MAX_SAFE_INTEGER
        for (const post of feed) {
          const ts = getFeedViewPostTimestamp(post).getTime()
          if (ts < oldestBatchTimestamp) oldestBatchTimestamp = ts
        }
        if (oldestBatchTimestamp <= newestCachedTimestamp) break

        log.verbose('Probe', `Multi-fetch ${fetchNum}/${maxFetches}: gap detected (oldestBatch=${new Date(oldestBatchTimestamp).toLocaleTimeString()}, newestCached=${new Date(newestCachedTimestamp).toLocaleTimeString()})`)

        const { feed: nextBatch, cursor: nextCursor } = await getHomeFeed(agent, { limit: pageRaw, cursor: currentCursor })
        if (nextBatch.length === 0) break

        feed = feed.concat(nextBatch)
        currentCursor = nextCursor
      }
    }

    result.rawPostCount = feed.length

    // Track raw post timestamps before any filtering
    for (const post of feed) {
      const postTimestamp = getFeedViewPostTimestamp(post).getTime()
      if (postTimestamp < result.rawOldestTimestamp) {
        result.rawOldestTimestamp = postTimestamp
      }
      if (postTimestamp > result.rawNewestTimestamp) {
        result.rawNewestTimestamp = postTimestamp
      }
    }
    const [currentStats, currentProbs] = await getFilter() || [null, null]
    const currentFollows = await getAllFollows()
    const followMap: Record<string, FollowInfo> = {}
    for (const follow of currentFollows) {
      followMap[follow.username] = follow
    }

    const { getEditionTimeStrs } = await import('./skylimitGeneral')
    const editionTimeStrs = await getEditionTimeStrs()
    const editionCount = editionTimeStrs.length
    const secretKey = settings?.secretKey || 'default'

    // Calculate "next day" midnight boundary based on newest displayed post
    // "Today" = the day of newestDisplayedTimestamp, not actual current time
    const displayedDate = new Date(newestDisplayedTimestamp)
    const displayedDayMidnight = getLocalMidnight(displayedDate, settings?.timezone)
    const nextDayMidnightMs = getNextLocalMidnight(displayedDayMidnight, settings?.timezone).getTime()

    // In-memory secondary cache for cross-post curation context (discarded after probe)
    const secondaryEntries: SecondaryEntry[] = []
    const repostIndex: SecondaryRepostIndex = new Map()

    // Helper function to curate a single post and update result
    const processPost = async (post: AppBskyFeedDefs.FeedViewPost, postTimestamp: number): Promise<boolean> => {
      result.totalPostCount++

      // Track timestamp bounds
      if (postTimestamp < result.oldestProbeTimestamp) {
        result.oldestProbeTimestamp = postTimestamp
      }
      if (postTimestamp > result.newestProbeTimestamp) {
        result.newestProbeTimestamp = postTimestamp
      }

      // Curate the post (but don't save summary)
      const curation = await curateSinglePost(
        post,
        myUsername,
        myDid,
        followMap,
        currentStats,
        currentProbs,
        secretKey,
        editionCount,
        repostIndex
      )

      // Build summary and append to secondary cache for cross-post context
      const summary = createPostSummary(post, new Date(postTimestamp), myUsername)
      summary.curation_status = curation.curation_status
      summary.curation_msg = curation.curation_msg
      if (curation.edition_tag) summary.edition_tag = curation.edition_tag
      if (curation.matching_pattern) summary.matching_pattern = curation.matching_pattern
      if (curation.edition_status) summary.edition_status = curation.edition_status

      const uniqueId = getPostUniqueId(post)
      const entry: FeedCacheEntryWithPost = {
        uniqueId,
        post,
        timestamp: postTimestamp,
        postTimestamp,
        interval: '',
        cachedAt: Date.now(),
        originalPost: post,
      }
      secondaryEntries.push({ entry, summary })
      addToRepostIndex(repostIndex, summary)

      // Return true if post would be displayed (not dropped)
      if (isStatusShow(curation.curation_status)) {
        result.filteredPostCount++
        return true
      }
      return false
    }

    // Pre-fetch summaries for the day of the newest batch post (single IndexedDB query)
    // Used for overlap detection: finding cached posts with known curationNumbers
    const newestBatchDate = new Date(result.rawNewestTimestamp)
    const newestBatchDayStart = getLocalMidnight(newestBatchDate, settings?.timezone)
    const newestBatchDayEnd = getNextLocalMidnight(newestBatchDayStart, settings?.timezone)
    const daySummaries = await getPostSummariesInRange(newestBatchDayStart.getTime(), newestBatchDayEnd.getTime())
    const summaryMap = new Map<string, PostSummary>()
    for (const s of daySummaries) {
      summaryMap.set(s.uniqueId, s)
    }

    // Categorize posts: incremental (newer than stop) and all non-cached same-day
    const sameDayPosts: { post: AppBskyFeedDefs.FeedViewPost; timestamp: number }[] = []
    const nextDayPosts: { post: AppBskyFeedDefs.FeedViewPost; timestamp: number }[] = []
    const allNonCachedSameDay: { post: AppBskyFeedDefs.FeedViewPost; timestamp: number }[] = []

    let reachedStopBoundary = false
    let lastPostNumber: number | undefined

    for (const post of feed) {
      const postUniqueId = getPostUniqueId(post)
      const postTimestamp = getFeedViewPostTimestamp(post).getTime()

      // Check cached posts for overlap detection before skipping
      if (cachedPostIds.has(postUniqueId)) {
        // Look for the newest overlapping displayable post with a curationNumber
        if (lastPostNumber === undefined) {
          const summary = summaryMap.get(postUniqueId)
          if (summary && isStatusShow(summary.curation_status) &&
              summary.curationNumber != null && summary.curationNumber > 0) {
            lastPostNumber = summary.curationNumber
            result.isOverlappingBatch = true
            log.verbose('Probe', `Overlap detected: post ${postUniqueId} has curationNumber=${lastPostNumber}`)
          }
        }
        continue
      }

      // Collect ALL non-cached same-day posts (regardless of stopTimestamp, for retention)
      if (postTimestamp < nextDayMidnightMs) {
        allNonCachedSameDay.push({ post, timestamp: postTimestamp })
      }

      // Collect only newer-than-stop posts for incremental counting
      if (stopTimestamp && postTimestamp <= stopTimestamp) {
        reachedStopBoundary = true
        continue
      }
      if (postTimestamp < nextDayMidnightMs) {
        sameDayPosts.push({ post, timestamp: postTimestamp })
      } else {
        nextDayPosts.push({ post, timestamp: postTimestamp })
      }
    }

    // Curate based on overlap detection
    if (result.isOverlappingBatch && lastPostNumber !== undefined) {
      // Overlapping batch: curate ALL non-cached same-day posts (for retention)
      for (const { post, timestamp } of allNonCachedSameDay) {
        await processPost(post, timestamp)
      }

      // retentionDisplayableCount = total displayable from full batch
      result.retentionDisplayableCount = result.filteredPostCount

      // Recompute filteredPostCount/totalPostCount for incremental accumulation only
      if (stopTimestamp) {
        result.filteredPostCount = secondaryEntries
          .filter(e => e.entry.postTimestamp > stopTimestamp && isStatusShow(e.summary.curation_status)).length
        result.totalPostCount = secondaryEntries
          .filter(e => e.entry.postTimestamp > stopTimestamp).length
      }

      result.nonOverlappingEntries = secondaryEntries
      result.lastPostNumber = lastPostNumber
      log.verbose('Probe', `Overlapping batch: lastPostNumber=${lastPostNumber}, ${secondaryEntries.length} entries, retentionDisplayable=${result.retentionDisplayableCount}, incrementalFiltered=${result.filteredPostCount}`)
    } else {
      // Non-overlapping: curate only incremental posts (existing behavior)
      for (const { post, timestamp } of sameDayPosts) {
        await processPost(post, timestamp)
      }
      if (result.filteredPostCount === 0 && nextDayPosts.length > 0) {
        log.verbose('Probe', `No same-day posts available, processing ${nextDayPosts.length} next-day posts`)
        for (const { post, timestamp } of nextDayPosts) {
          await processPost(post, timestamp)
        }
      }
    }

    // Sanity check: all processed posts should be from the same day
    if (result.filteredPostCount > 0 &&
        result.newestProbeTimestamp > 0 &&
        result.oldestProbeTimestamp < Number.MAX_SAFE_INTEGER) {
      const newestDate = new Date(result.newestProbeTimestamp)
      const oldestDate = new Date(result.oldestProbeTimestamp)
      const newestMidnight = getLocalMidnight(newestDate, settings?.timezone).getTime()
      const oldestMidnight = getLocalMidnight(oldestDate, settings?.timezone).getTime()
      if (newestMidnight !== oldestMidnight) {
        log.warn('Probe', `WARNING: Probed posts span midnight boundary! ` +
          `Newest: ${newestDate.toLocaleString()}, Oldest: ${oldestDate.toLocaleString()}`)
      }
    }

    // Gap detection: if stopTimestamp was provided but we never reached it,
    // there are unprobed posts in the middle — counts may be underestimates
    if (stopTimestamp && !reachedStopBoundary) {
      result.hasGap = true
      log.verbose('Probe', `Gap detected: probe didn't reach stopTimestamp ${new Date(stopTimestamp).toLocaleTimeString()}`)
    }

    // Check page availability (based on incremental counts)
    const pageSize = settings?.feedPageLength || 25
    result.hasFullPage = result.filteredPostCount >= pageSize
    result.hasMultiplePages = result.filteredPostCount > pageSize
    result.pageCount = Math.floor(result.filteredPostCount / pageSize)

  } catch (error) {
    log.error('Probe', 'probeForNewPosts: Error probing for posts:', error)
  }

  return result
}

/**
 * Get paged updates settings with defaults
 */
export async function getPagedUpdatesSettings(): Promise<{
  fullPageWaitMinutes: number
  pageSize: number
  newPostBatchFetches: number
}> {
  const settings = await getSettings()

  return {
    fullPageWaitMinutes: settings?.pagedUpdatesFullPageWaitMinutes ?? PAGED_UPDATES_DEFAULTS.fullPageWaitMinutes,
    pageSize: settings?.feedPageLength ?? 25,
    newPostBatchFetches: settings?.newPostBatchFetches ?? PAGED_UPDATES_DEFAULTS.newPostBatchFetches,
  }
}


