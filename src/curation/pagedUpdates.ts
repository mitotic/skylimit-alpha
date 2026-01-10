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
import { getCachedPostUniqueIds } from './skylimitFeedCache'
import { getFeedViewPostTimestamp, getPostUniqueId } from './skylimitGeneral'
import { getHomeFeed } from '../api/feed'
import { FollowInfo, CurationFeedViewPost } from './types'

// Maximum PageRaw to prevent excessive API calls
const MAX_PAGE_RAW = 100

// Default settings
export const PAGED_UPDATES_DEFAULTS = {
  enabled: true,
  varFactor: 1.5,
  maxWaitMinutes: 30,
}

/**
 * Result of a probe for new posts
 */
export interface ProbeResult {
  hasFullPage: boolean        // True if PageSize or more displayable posts available
  rawPostCount: number        // Total posts fetched from server
  filteredPostCount: number   // Posts that would be displayed (not dropped)
  totalPostCount: number      // All posts considered (may include dropped)
  oldestProbeTimestamp: number // Timestamp of oldest probed post
  newestProbeTimestamp: number // Timestamp of newest probed post
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
  _newestDisplayedTimestamp: number  // Kept for API compatibility, but cache lookup is used instead
): Promise<ProbeResult> {
  const result: ProbeResult = {
    hasFullPage: false,
    rawPostCount: 0,
    filteredPostCount: 0,
    totalPostCount: 0,
    oldestProbeTimestamp: Number.MAX_SAFE_INTEGER,
    newestProbeTimestamp: 0,
  }

  try {
    // Fetch posts from server (no cursor = newest posts)
    const { feed } = await getHomeFeed(agent, { limit: pageRaw })
    result.rawPostCount = feed.length

    if (feed.length === 0) {
      return result
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
    const amplifyHighBoosts = settings?.amplifyHighBoosts || false
    const hideSelfReplies = settings?.hideSelfReplies || false

    // Get all cached post IDs to skip already-displayed posts
    const cachedPostIds = await getCachedPostUniqueIds()

    // Curate each post WITHOUT saving to cache
    for (const post of feed) {
      // Get post unique ID and skip if already in cache
      const postUniqueId = getPostUniqueId(post)
      if (cachedPostIds.has(postUniqueId)) {
        continue
      }

      // Get post timestamp (use repost time for reposts)
      const postTimestamp = getFeedViewPostTimestamp(post).getTime()

      // Track timestamp bounds
      if (postTimestamp < result.oldestProbeTimestamp) {
        result.oldestProbeTimestamp = postTimestamp
      }
      if (postTimestamp > result.newestProbeTimestamp) {
        result.newestProbeTimestamp = postTimestamp
      }

      result.totalPostCount++

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
        amplifyHighBoosts,
        hideSelfReplies
      )

      // Count if post would be displayed (not dropped)
      if (!curation.curation_dropped) {
        result.filteredPostCount++
      }
    }

    // Check if we have a full page
    const pageSize = settings?.feedPageLength || 25
    result.hasFullPage = result.filteredPostCount >= pageSize

  } catch (error) {
    console.error('probeForNewPosts: Error probing for posts:', error)
  }

  return result
}

/**
 * Get paged updates settings with defaults
 */
export async function getPagedUpdatesSettings(): Promise<{
  enabled: boolean
  varFactor: number
  maxWaitMinutes: number
  pageSize: number
}> {
  const settings = await getSettings()

  return {
    enabled: settings?.pagedUpdatesEnabled ?? PAGED_UPDATES_DEFAULTS.enabled,
    varFactor: settings?.pagedUpdatesVarFactor ?? PAGED_UPDATES_DEFAULTS.varFactor,
    maxWaitMinutes: settings?.pagedUpdatesMaxWaitMinutes ?? PAGED_UPDATES_DEFAULTS.maxWaitMinutes,
    pageSize: settings?.feedPageLength ?? 25,
  }
}

/**
 * Sort posts by timestamp (oldest first) for processing in chronological order.
 * Uses repost time for reposts, not original post time.
 *
 * @param posts - Array of posts to sort
 * @returns Sorted array (oldest first)
 */
export function sortPostsByTimestampOldestFirst(
  posts: AppBskyFeedDefs.FeedViewPost[]
): AppBskyFeedDefs.FeedViewPost[] {
  return [...posts].sort((a, b) => {
    const timeA = getFeedViewPostTimestamp(a).getTime()
    const timeB = getFeedViewPostTimestamp(b).getTime()
    return timeA - timeB // Ascending order (oldest first)
  })
}

/**
 * Process posts for Next Page display.
 *
 * This is called when the user clicks "Next Page". It:
 * 1. Sorts posts by timestamp (oldest first)
 * 2. Processes posts one at a time starting from first post newer than displayed
 * 3. Curates and caches each post
 * 4. Stops when PageSize displayed posts are reached
 * 5. Returns the posts to display (discards the rest)
 *
 * @param posts - Posts fetched from server (unsorted)
 * @param myUsername - Current user's username
 * @param myDid - Current user's DID
 * @param newestDisplayedTimestamp - Timestamp of newest displayed post
 * @param pageSize - Maximum number of displayed posts to return
 * @param curateAndCacheFn - Function to curate and cache a single post
 * @returns Object with posts to display and new newest timestamp
 */
export async function processPostsForNextPage(
  posts: AppBskyFeedDefs.FeedViewPost[],
  newestDisplayedTimestamp: number,
  pageSize: number,
  curateAndCacheFn: (post: AppBskyFeedDefs.FeedViewPost) => Promise<{
    curatedPost: CurationFeedViewPost
    isDisplayed: boolean
  }>
): Promise<{
  postsToDisplay: CurationFeedViewPost[]
  allCuratedPosts: CurationFeedViewPost[]
  newestCuratedTimestamp: number
}> {
  // Sort posts oldest first
  const sortedPosts = sortPostsByTimestampOldestFirst(posts)

  const postsToDisplay: CurationFeedViewPost[] = []
  const allCuratedPosts: CurationFeedViewPost[] = []
  let newestCuratedTimestamp = newestDisplayedTimestamp
  let displayedCount = 0

  for (const post of sortedPosts) {
    const postTimestamp = getFeedViewPostTimestamp(post).getTime()

    // Skip posts not newer than currently displayed
    if (postTimestamp <= newestDisplayedTimestamp) {
      continue
    }

    // Stop if we've reached PageSize displayed posts
    if (displayedCount >= pageSize) {
      break
    }

    // Curate and cache the post
    const { curatedPost, isDisplayed } = await curateAndCacheFn(post)

    allCuratedPosts.push(curatedPost)

    // Track newest curated timestamp
    if (postTimestamp > newestCuratedTimestamp) {
      newestCuratedTimestamp = postTimestamp
    }

    // Add to display if not dropped
    if (isDisplayed) {
      postsToDisplay.push(curatedPost)
      displayedCount++
    }
  }

  return {
    postsToDisplay,
    allCuratedPosts,
    newestCuratedTimestamp,
  }
}
