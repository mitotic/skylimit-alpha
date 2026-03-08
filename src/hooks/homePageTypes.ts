import { AppBskyFeedDefs } from '@atproto/api'
import { CurationFeedViewPost } from '../curation/types'
import { getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { clientDate } from '../utils/clientClock'
import log from '../utils/logger'

// Tab type for home page
export type HomeTab = 'curated' | 'editions'

// Storage key for active tab
export const HOME_TAB_STATE_KEY = 'websky_home_active_tab'

// Helper functions for per-tab storage keys
export const getFeedStateKey = (tab: HomeTab) =>
  tab === 'curated' ? 'websky_home_feed_state' : 'websky_home_editions_feed_state'
export const getScrollStateKey = (tab: HomeTab) =>
  tab === 'curated' ? 'websky_home_scroll_state' : 'websky_home_editions_scroll_state'

// Chunk size for fast-forward back to top (after feed is trimmed from newest end)
export const FAST_FORWARD_CHUNK_SIZE = 100

// Default maximum number of posts to keep in displayed feed
// Defined as a multiple of FAST_FORWARD_CHUNK_SIZE for alignment
// Can be overridden via settings.maxDisplayedFeedSize
export const DEFAULT_MAX_DISPLAYED_FEED_SIZE = 3 * FAST_FORWARD_CHUNK_SIZE

// Saved feed state interface
export interface SavedFeedState {
  displayedFeed: AppBskyFeedDefs.FeedViewPost[]  // Renamed from 'feed' for clarity
  previousPageFeed: AppBskyFeedDefs.FeedViewPost[]  // Pre-fetched next page for instant Prev Page
  newestDisplayedPostTimestamp: number | null
  oldestDisplayedPostTimestamp: number | null
  hasMorePosts: boolean  // Deprecated - use previousPageFeed.length > 0
  cursor: string | undefined
  savedAt: number // timestamp when state was saved
  lowestVisiblePostTimestamp: number | null // timestamp of the lowest visible post (for feed pruning)
  newPostsCount: number // count of new posts available (for "New Posts" button)
  showNewPostsButton: boolean // whether to show the "New Posts" button
  sessionDid: string // DID of the user session when state was saved (to prevent restoring feed for different user)
  curationSuspended?: boolean // whether curation was suspended when feed was saved
  showAllPosts?: boolean // whether "show all posts" was enabled when feed was saved
}

// Helper function to find the timestamp of the lowest visible post
// This identifies which post is at the bottom of the viewport when state is saved (for feed pruning)
export function findLowestVisiblePostTimestamp(feed: AppBskyFeedDefs.FeedViewPost[]): number | null {
  try {
    const postElements = document.querySelectorAll('[data-post-uri]')
    const viewportTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
    const viewportBottom = viewportTop + window.innerHeight

    // Find the post element closest to the bottom of the viewport
    let lowestElement: Element | null = null
    let lowestDistance = Infinity

    postElements.forEach((element) => {
      const rect = element.getBoundingClientRect()
      const elementTop = viewportTop + rect.top
      const elementBottom = elementTop + rect.height

      // Check if element is visible in viewport
      if (elementBottom >= viewportTop && elementTop <= viewportBottom) {
        // Calculate distance from bottom of viewport
        const distance = Math.max(0, viewportBottom - elementBottom)
        if (distance < lowestDistance) {
          lowestDistance = distance
          lowestElement = element
        }
      }
    })

    if (lowestElement) {
      const postUri = (lowestElement as Element).getAttribute('data-post-uri')
      if (postUri) {
        // Find the post in the feed array
        const post = feed.find(p => p.post.uri === postUri)
        if (post) {
          // Get timestamp using getFeedViewPostTimestamp
          // Use current time as feedReceivedTime fallback (for reposts)
          const timestamp = getFeedViewPostTimestamp(post, clientDate())
          return timestamp.getTime()
        }
      }
    }

    return null
  } catch (error) {
    log.warn('PageBoundary', 'Failed to find lowest visible post timestamp:', error)
    return null
  }
}

/** Options for refreshDisplayedFeed — designed for reuse across refresh triggers */
export interface RefreshDisplayedFeedOptions {
  newestTimestamp?: number   // Override which post appears at top (default: current newestDisplayedPostTimestamp)
  triggerProbe?: boolean     // Whether to force an immediate probe (default: true)
  showAllNewPosts?: boolean  // Whether to set idleTimerTriggered (default: true)
}

/** Result returned by refreshDisplayedFeed for caller use */
export interface RefreshDisplayedFeedResult {
  alignedPosts: CurationFeedViewPost[]
  newestTimestamp: number
  oldestTimestamp: number
}

/**
 * Trim a filtered feed array so the oldest displayed post aligns to a
 * curation page boundary (curationNumber = n * pageLength + 1).
 * Only trims a few posts from the tail to reach a clean boundary.
 * Does NOT enforce a max size — callers should use trimFeedIfNeeded() for that.
 * If the oldest post has no curation number, returns the feed unchanged.
 */
export function alignFeedToPageBoundary(
  filteredFeed: CurationFeedViewPost[],
  pageLength: number
): CurationFeedViewPost[] {
  // Guard: If feed is smaller than or equal to pageLength, never trim
  if (filteredFeed.length <= pageLength) {
    return filteredFeed
  }

  // Get curationNumber of the oldest post (last element)
  const oldestPost = filteredFeed[filteredFeed.length - 1] as CurationFeedViewPost
  const oldestCurationNumber = oldestPost.curation?.curationNumber

  // If no curation number (null/undefined) or is 0 (dropped), keep current behavior
  if (!oldestCurationNumber || oldestCurationNumber <= 0) {
    return filteredFeed
  }

  // Check if already at a page boundary
  // Page boundary means: curationNumber = (n * pageLength) + 1
  // i.e., (curationNumber - 1) % pageLength === 0
  const positionInPage = (oldestCurationNumber - 1) % pageLength
  if (positionInPage === 0) {
    // Already at boundary - no trimming needed
    return filteredFeed
  }

  // Trim oldest posts to reach the next page boundary going toward newer posts.
  // positionInPage = how far into the current page the oldest post is.
  // We need to remove (pageLength - positionInPage) posts to reach the next boundary above.
  const trimCount = pageLength - positionInPage
  const trimmedLength = filteredFeed.length - trimCount

  if (trimmedLength < pageLength) {
    // Trimming would reduce below pageLength - don't trim
    return filteredFeed
  }

  const finalLength = trimmedLength  // Already capped at 2 * pageLength above

  const newOldest = filteredFeed[finalLength - 1] as CurationFeedViewPost
  log.debug('PageBoundary', `Trimmed feed from ${filteredFeed.length} to ${finalLength} posts ` +
    `(removed ${filteredFeed.length - finalLength} oldest, ` +
    `oldest curationNumber was #${oldestCurationNumber}, ` +
    `now #${newOldest.curation?.curationNumber ?? '?'})`)

  return filteredFeed.slice(0, finalLength)
}
