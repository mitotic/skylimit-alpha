/**
 * Paged Fresh Updates Module
 *
 * Handles probing for new posts and managing paged updates functionality.
 * This delays viewing new posts so popularity metrics have time to accumulate.
 */

import { BskyAgent, AppBskyFeedDefs } from '@atproto/api'
import { curateSinglePost } from './skylimitFilter'
import { getFilter, getAllFollows } from './skylimitCache'
import { getSettings } from './skylimitStore'
import { getCachedPostUniqueIds, getLocalMidnight, getNextLocalMidnight } from './skylimitFeedCache'
import { getFeedViewPostTimestamp, getPostUniqueId, createPostSummary } from './skylimitGeneral'
import { getHomeFeed } from '../api/feed'
import { FollowInfo, isStatusShow, SecondaryEntry, FeedCacheEntryWithPost, SecondaryRepostIndex, addToRepostIndex } from './types'
import log from '../utils/logger'

// Maximum PageRaw to prevent excessive API calls
const MAX_PAGE_RAW = 100

// Default settings
export const PAGED_UPDATES_DEFAULTS = {
  varFactor: 2,
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
}

/**
 * Calculate the number of raw posts to fetch for one filtered page.
 *
 * PageRaw = VarFactor * PageSize / FilterFrac
 *
 * @param pageSize - Number of posts per page (e.g., 25)
 * @param filterFrac - Fraction of posts surviving curation (0 to 1)
 * @param varFactor - Variability factor to account for filtering variance (default 1.5)
 * @returns Number of raw posts to fetch
 */
export function calculatePageRaw(
  pageSize: number,
  filterFrac: number,
  varFactor: number = PAGED_UPDATES_DEFAULTS.varFactor
): number {
  // Ensure filterFrac is valid (avoid division by zero)
  const safeFrac = Math.max(0.01, Math.min(1.0, filterFrac))

  // Calculate PageRaw
  const pageRaw = Math.ceil(varFactor * pageSize / safeFrac)

  // Cap at maximum to prevent excessive API calls
  return Math.min(pageRaw, MAX_PAGE_RAW)
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
 * @returns ProbeResult with availability information
 */
export async function probeForNewPosts(
  agent: BskyAgent,
  pageRaw: number,
  myUsername: string,
  myDid: string,
  newestDisplayedTimestamp: number  // Defines "today" for midnight boundary calculation
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
  }

  try {
    // Get cached post IDs early — needed for adaptive fetch decision
    const cachedPostIds = await getCachedPostUniqueIds()

    // Fetch posts from server (no cursor = newest posts)
    const { feed: initialFeed, cursor } = await getHomeFeed(agent, { limit: pageRaw })
    let feed = [...initialFeed]

    if (initialFeed.length === 0) {
      return result
    }

    // Adaptive fetch: if many posts in the initial batch are already cached,
    // the probe is undersampling new posts. Fetch a second batch for better accuracy.
    if (initialFeed.length >= pageRaw && cursor) {
      let cachedInSample = 0
      for (const post of initialFeed) {
        if (cachedPostIds.has(getPostUniqueId(post))) {
          cachedInSample++
        }
      }
      if (cachedInSample > initialFeed.length / 2) {
        log.verbose('Probe', `High cache-hit rate (${cachedInSample}/${initialFeed.length}), fetching additional batch`)
        const { feed: moreFeed } = await getHomeFeed(agent, { limit: pageRaw, cursor })
        feed = [...feed, ...moreFeed]
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

    // Get settings and filter data for curation
    const settings = await getSettings()
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

    // Separate posts into same-day and next-day buckets
    const sameDayPosts: { post: AppBskyFeedDefs.FeedViewPost; timestamp: number }[] = []
    const nextDayPosts: { post: AppBskyFeedDefs.FeedViewPost; timestamp: number }[] = []

    for (const post of feed) {
      // Get post unique ID and skip if already in cache
      const postUniqueId = getPostUniqueId(post)
      if (cachedPostIds.has(postUniqueId)) {
        continue
      }

      // Get post timestamp (use repost time for reposts)
      const postTimestamp = getFeedViewPostTimestamp(post).getTime()

      // Categorize by midnight boundary
      if (postTimestamp < nextDayMidnightMs) {
        sameDayPosts.push({ post, timestamp: postTimestamp })
      } else {
        nextDayPosts.push({ post, timestamp: postTimestamp })
      }
    }

    // Phase 1: Process same-day posts first (before next day's midnight)
    for (const { post, timestamp } of sameDayPosts) {
      await processPost(post, timestamp)
    }

    // Phase 2: If no displayable posts in same day, process next-day posts
    if (result.filteredPostCount === 0 && nextDayPosts.length > 0) {
      log.verbose('Probe', `No same-day posts available, processing ${nextDayPosts.length} next-day posts`)
      for (const { post, timestamp } of nextDayPosts) {
        await processPost(post, timestamp)
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

    // Check page availability
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
  varFactor: number
  fullPageWaitMinutes: number
  pageSize: number
}> {
  const settings = await getSettings()

  return {
    varFactor: settings?.pagedUpdatesVarFactor ?? PAGED_UPDATES_DEFAULTS.varFactor,
    fullPageWaitMinutes: settings?.pagedUpdatesFullPageWaitMinutes ?? PAGED_UPDATES_DEFAULTS.fullPageWaitMinutes,
    pageSize: settings?.feedPageLength ?? 25,
  }
}


