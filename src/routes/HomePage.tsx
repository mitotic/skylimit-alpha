import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { useRateLimit } from '../contexts/RateLimitContext'
import { getHomeFeed } from '../api/feed'
import { likePost, unlikePost, repost, removeRepost, createPost, createQuotePost } from '../api/posts'
import PostCard from '../components/PostCard'
import Compose from '../components/Compose'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import RateLimitIndicator from '../components/RateLimitIndicator'
import SkylimitHomeDialog from '../components/SkylimitHomeDialog'
import CurationInitModal, { CurationInitStatsDisplay } from '../components/CurationInitModal'
import { insertEditionPosts } from '../curation/skylimitTimeline'
import { initDB, getFilter, getSummaryByUri, isSummariesCacheEmpty, getCurationInitStats } from '../curation/skylimitCache'
import { getSettings } from '../curation/skylimitStore'
import { computeFilterFrac } from '../curation/skylimitStats'
import { probeForNewPosts, calculatePageRaw, getPagedUpdatesSettings, PAGED_UPDATES_DEFAULTS } from '../curation/pagedUpdates'
import { flushExpiredParentPosts } from '../curation/parentPostCache'
import { scheduleStatsComputation, computeStatsInBackground } from '../curation/skylimitStatsWorker'
import { recomputeCurationStatus } from '../curation/skylimitRecurate'
import { GlobalStats, CurationFeedViewPost } from '../curation/types'
import { getCachedFeed, clearFeedCache, clearFeedMetadata, getLastFetchMetadata, saveFeedCache, getCachedFeedBefore, updateFeedCacheOldestPostTimestamp, getCachedFeedAfterPosts, shouldUseCacheOnLoad, getLookbackBoundary, performLookbackFetch, createFeedCacheEntries, savePostsWithCuration, validateFeedCacheIntegrity, limitedLookbackToMidnight, getLocalMidnight, fetchPageFromTimestamp, hasGapFromProbe, isCacheWithinLookback, getNewestCachedPostTimestamp } from '../curation/skylimitFeedCache'
import { getPostUniqueId, getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { isRateLimited, getTimeUntilClear } from '../utils/rateLimitState'
import { clearCounters } from '../curation/skylimitCounter'

// Saved feed state constant
const WEBSKY9_HOME_FEED_STATE = 'websky9_home_feed_state'
const SCROLL_STATE_KEY = 'websky9_home_scroll_state'

// Default maximum number of posts to keep in displayed feed (approximately 12 pages)
// Can be overridden via settings.maxDisplayedFeedSize
const DEFAULT_MAX_DISPLAYED_FEED_SIZE = 300

// Saved feed state interface
interface SavedFeedState {
  displayedFeed: AppBskyFeedDefs.FeedViewPost[]  // Renamed from 'feed' for clarity
  previousPageFeed: AppBskyFeedDefs.FeedViewPost[]  // Pre-fetched next page for instant Load More
  newestDisplayedPostTimestamp: number | null
  oldestDisplayedPostTimestamp: number | null
  hasMorePosts: boolean  // Deprecated - use previousPageFeed.length > 0
  cursor: string | undefined
  savedAt: number // timestamp when state was saved
  lowestVisiblePostTimestamp: number | null // timestamp of the lowest visible post (for feed pruning)
  newPostsCount: number // count of new posts available (for "New Posts" button)
  showNewPostsButton: boolean // whether to show the "New Posts" button
  sessionDid: string // DID of the user session when state was saved (to prevent restoring feed for different user)
}

// Helper function to find the timestamp of the lowest visible post
// This identifies which post is at the bottom of the viewport when state is saved (for feed pruning)
function findLowestVisiblePostTimestamp(feed: AppBskyFeedDefs.FeedViewPost[]): number | null {
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
          const timestamp = getFeedViewPostTimestamp(post, new Date())
          return timestamp.getTime()
        }
      }
    }
    
    return null
  } catch (error) {
    console.warn('Failed to find lowest visible post timestamp:', error)
    return null
  }
}

/**
 * Filters out immediate replies to a post by the same user.
 * If a post is a reply and its parent post appears in the feed (either before or after)
 * by the same author, the reply is filtered out.
 */
function filterSameUserReplies(feed: AppBskyFeedDefs.FeedViewPost[]): AppBskyFeedDefs.FeedViewPost[] {
  // First, build a map of all post URIs to their positions and author DIDs
  const postMap = new Map<string, { index: number; authorDid: string }>()
  feed.forEach((item, idx) => {
    postMap.set(item.post.uri, { index: idx, authorDid: item.post.author.did })
  })
  
  // Now filter: keep a reply only if its parent is NOT in the feed, or if parent is by different author
  return feed.filter((item, _index) => {
    const record = item.post.record as any
    
    // Check if this is a reply
    if (!record?.reply?.parent?.uri) {
      // Not a reply, keep it
      return true
    }
    
    const parentUri = record.reply.parent.uri
    const replyAuthorDid = item.post.author.did
    
    // Check if parent post exists in the feed
    const parentInfo = postMap.get(parentUri)
    if (!parentInfo) {
      // Parent not in feed, keep the reply
      return true
    }
    
    // Parent is in the feed - check if it's by the same author
    if (parentInfo.authorDid === replyAuthorDid) {
      // Parent is by same author and in feed - filter out this reply
      return false
    }
    
    // Parent is in feed but by different author - keep the reply
    return true
  })
}

export default function HomePage() {
  const location = useLocation()
  const { agent, session } = useSession()
  const { rateLimitStatus, setRateLimitStatus } = useRateLimit()
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [previousPageFeed, setPreviousPageFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])  // Pre-fetched next page for instant Load More
  const [isPrefetching, setIsPrefetching] = useState(false)  // True while fetching next page after Load More
  const [cursor, setCursor] = useState<string | undefined>()  // Keep for backward compatibility
  const [hasMorePosts, setHasMorePosts] = useState(false)  // Deprecated - use previousPageFeed.length > 0
  const [serverCursor, setServerCursor] = useState<string | undefined>(undefined)  // Cursor for server fallback fetches
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  const [replyToUri, setReplyToUri] = useState<string | null>(null)
  const [quotePost, setQuotePost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [dbInitialized, setDbInitialized] = useState(false)
  const [showSkylimitDialog, setShowSkylimitDialog] = useState(false)
  const [skylimitStats, setSkylimitStats] = useState<GlobalStats | null>(null)
  const [newPostsCount, setNewPostsCount] = useState(0)
  const [showNewPostsButton, setShowNewPostsButton] = useState(false)
  const [isScrolledDown, setIsScrolledDown] = useState(false)
  const [newestDisplayedPostTimestamp, setNewestDisplayedPostTimestamp] = useState<number | null>(null)
  const [oldestDisplayedPostTimestamp, setOldestDisplayedPostTimestamp] = useState<number | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [infiniteScrollingEnabled, setInfiniteScrollingEnabled] = useState(false)
  // Paged fresh updates state
  const [pagedUpdatesEnabled, setPagedUpdatesEnabled] = useState(true) // enabled by default
  const [nextPageReady, setNextPageReady] = useState(false) // true when full page of posts available
  const [firstProbeTimestamp, setFirstProbeTimestamp] = useState<number | null>(null) // for max wait timer
  const [partialPageCount, setPartialPageCount] = useState(0) // count when showing partial page
  // Multi-page and gap tracking state
  const [multiPageCount, setMultiPageCount] = useState(0) // total filtered posts when 2+ pages available
  const [hasProbeGap, setHasProbeGap] = useState(false) // true if gap between probe's oldest and cache's newest
  const [idleTimerTriggered, setIdleTimerTriggered] = useState(false) // true when idle time elapsed for partial page
  const [gapFillInProgress, setGapFillInProgress] = useState(false) // true during background gap fill (disables Load More)
  // Debug: track expected display count from probe for comparison
  const probeExpectedCountRef = useRef<number>(0)
  // Cooldown: track when we last displayed new posts to prevent button from immediately reappearing
  const lastDisplayTimeRef = useRef<number>(0)
  const DISPLAY_COOLDOWN_MS = 30000 // 30 second cooldown after displaying posts
  // Lookback caching state
  const [lookingBack, setLookingBack] = useState(false) // true during background lookback fetch
  const [lookbackProgress, setLookbackProgress] = useState<number | null>(null) // 0-100 progress percentage
  // Initial curation tracking state (for showing modal when curation completes on first load)
  const [showCurationInitModal, setShowCurationInitModal] = useState(false) // show modal when curation completes
  const [curationInitStats, setCurationInitStats] = useState<CurationInitStatsDisplay | null>(null)
  const isInitialCurationRef = useRef(false) // ref to track initial curation in callbacks
  const firstPostRef = useRef<HTMLDivElement>(null)
  const scrollSentinelRef = useRef<HTMLDivElement>(null)  // Sentinel element for intersection observer
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null)  // Observer instance
  
  // Scroll state refs (for UI state and restoration)
  const isProgrammaticScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const previousPathnameRef = useRef<string>(location.pathname)
  const scrollRestoredRef = useRef(false)  // Tracks if scroll has been restored
  const scrollRestoreBlockedRef = useRef(false)  // Blocks restoration if user is actively scrolling
  const scrollSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)  // For debouncing scroll saves
  const scrollSaveBlockedRef = useRef(false)  // Blocks scroll saves during restoration phase
  const loadMoreLastCallRef = useRef<number>(0)  // For debouncing Load More button

  // Save feed state when navigating away from home page
  useEffect(() => {
    const wasOnHome = previousPathnameRef.current === '/'
    const isOnHome = location.pathname === '/'
    
    // If we were on home page and are now navigating away, save feed state
    if (wasOnHome && !isOnHome) {
      // Reset scroll restoration flag for next visit
      scrollRestoredRef.current = false
      // Find the timestamp of the lowest visible post for feed pruning
      const lowestVisiblePostTimestamp = findLowestVisiblePostTimestamp(feed)
      
      const feedState: SavedFeedState = {
        displayedFeed: feed,
        previousPageFeed,
        newestDisplayedPostTimestamp,
        oldestDisplayedPostTimestamp,
        hasMorePosts,
        cursor,
        savedAt: Date.now(),
        lowestVisiblePostTimestamp,
        newPostsCount,
        showNewPostsButton,
        sessionDid: session?.did || '' // Save session DID to ensure we only restore for the same user
      }

      try {
        // Also save the current scroll position
        const currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
        sessionStorage.setItem(SCROLL_STATE_KEY, currentScrollY.toString())

        sessionStorage.setItem(WEBSKY9_HOME_FEED_STATE, JSON.stringify(feedState))
      } catch (error) {
        console.warn('Failed to save feed state:', error)
      }
    }
    
    previousPathnameRef.current = location.pathname
  }, [location.pathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, newPostsCount, showNewPostsButton, session])

  // Disable browser scroll restoration
  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual'
    }
  }, [])

  // Load infinite scrolling setting
  useEffect(() => {
    const loadInfiniteScrollingSetting = async () => {
      try {
        const settings = await getSettings()
        setInfiniteScrollingEnabled(settings?.infiniteScrollingOption || false)
      } catch (error) {
        console.warn('Failed to load infinite scrolling setting:', error)
        setInfiniteScrollingEnabled(false)
      }
    }

    if (dbInitialized) {
      loadInfiniteScrollingSetting()
    }
  }, [dbInitialized])

  // Load paged updates settings
  useEffect(() => {
    const loadPagedUpdatesSetting = async () => {
      try {
        const pagedSettings = await getPagedUpdatesSettings()
        setPagedUpdatesEnabled(pagedSettings.enabled)
      } catch (error) {
        console.warn('Failed to load paged updates setting:', error)
        setPagedUpdatesEnabled(PAGED_UPDATES_DEFAULTS.enabled)
      }
    }

    if (dbInitialized) {
      loadPagedUpdatesSetting()
    }
  }, [dbInitialized])

  // Initialize IndexedDB and schedule stats computation
  useEffect(() => {
    let cleanup: (() => void) | null = null
    
    initDB().then(async () => {
      // Validate feed cache integrity - ensure all feed entries have summaries
      const integrity = await validateFeedCacheIntegrity()
      if (integrity.cleared || integrity.empty) {
        if (integrity.cleared) {
          console.log('[Init] Feed cache was cleared due to missing summaries')
        }
        if (integrity.empty) {
          console.log('[Init] Feed cache is empty')
        }
        // Clear sessionStorage saved feed state to force fresh load
        // Otherwise redisplayFeed would restore posts without curation data
        sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE)
        console.log('[Init] Cleared sessionStorage saved feed state')
      }

      // Check if summaries cache is empty (initial curation needed)
      const summariesEmpty = await isSummariesCacheEmpty()
      if (summariesEmpty) {
        console.log('[Init] Summaries cache is empty - initial curation will be performed')
        isInitialCurationRef.current = true
      }

      setDbInitialized(true)

      // Schedule statistics computation if we have session
      if (agent && session) {
        cleanup = scheduleStatsComputation(agent, session.handle, session.did)
      }

      // Load statistics for display
      loadSkylimitStats()

      // Flush expired parent posts on initialization (runs in background)
      flushExpiredParentPosts().catch(err => {
        console.warn('Failed to flush expired parent posts:', err)
      })
    }).catch(err => {
      console.error('Failed to initialize database:', err)
      setDbInitialized(true) // Continue anyway
    })
    
    return () => {
      if (cleanup) cleanup()
    }
  }, [agent, session])
  
  // Periodically flush expired parent posts (every hour)
  useEffect(() => {
    if (!dbInitialized) return
    
    const flushInterval = setInterval(() => {
      flushExpiredParentPosts().catch(err => {
        console.warn('Failed to flush expired parent posts:', err)
      })
    }, 60 * 60 * 1000) // Every hour
    
    return () => clearInterval(flushInterval)
  }, [dbInitialized])

  // Save feed state whenever it changes (debounced)
  useEffect(() => {
    if (location.pathname !== '/') return
    
    // Don't save during initial load
    if (isLoading) return
    
    // Debounce saves to avoid excessive writes
    const timeoutId = setTimeout(() => {
      const lowestVisiblePostTimestamp = findLowestVisiblePostTimestamp(feed)
      
      const feedState: SavedFeedState = {
        displayedFeed: feed,
        previousPageFeed,
        newestDisplayedPostTimestamp,
        oldestDisplayedPostTimestamp,
        hasMorePosts,
        cursor,
        savedAt: Date.now(),
        lowestVisiblePostTimestamp,
        newPostsCount,
        showNewPostsButton,
        sessionDid: session?.did || '' // Save session DID to ensure we only restore for the same user
      }

      try {
        sessionStorage.setItem(WEBSKY9_HOME_FEED_STATE, JSON.stringify(feedState))
      } catch (error) {
        console.warn('Failed to save feed state:', error)
      }
    }, 1000) // 1 second debounce
    
    return () => clearTimeout(timeoutId)
  }, [location.pathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, isLoading, newPostsCount, showNewPostsButton, session])

  // Load Skylimit statistics
  const loadSkylimitStats = useCallback(async () => {
    try {
      const filterResult = await getFilter()
      if (filterResult) {
        const [globalStats] = filterResult
        setSkylimitStats(globalStats)
      }
    } catch (error) {
      console.error('Failed to load Skylimit stats:', error)
    }
  }, [])

  // Reload stats when feed is loaded (in case stats were updated)
  useEffect(() => {
    if (dbInitialized && feed.length > 0) {
      loadSkylimitStats()
    }
  }, [dbInitialized, feed.length, loadSkylimitStats])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  // Helper function to look up curation status and filter posts
  // NEVER uses deprecated post.curation field - always looks up from summaries cache
  // For pagination, uses stored postTimestamp from cache instead of recalculating
  // skipFiltering: When true, skip filtering and return all posts with metadata (for restoration)
  const lookupCurationAndFilter = useCallback(async (
    posts: CurationFeedViewPost[],
    feedReceivedTime: Date,
    postTimestamps?: Map<string, number>,
    skipFiltering: boolean = false
  ): Promise<CurationFeedViewPost[]> => {
    // Look up curation status for each post from summaries cache
    const postsWithStatus = await Promise.all(
      posts.map(async (post) => {
        // Construct unique ID for this post (works for both originals and reposts)
        const uniqueId = getPostUniqueId(post)
        
        // Look up curation information from summaries cache (single source of truth)
        const summary = await getSummaryByUri(uniqueId)
        
        // Reconstruct full curation object from summary
        // Always create curation object (even if empty) so counter is clickable
        const curation: any = {}
        if (summary?.curation_dropped) {
          curation.curation_dropped = summary.curation_dropped
        }
        if (summary?.curation_msg) {
          curation.curation_msg = summary.curation_msg
        }
        if (summary?.curation_high_boost) {
          curation.curation_high_boost = summary.curation_high_boost
        }
        
        return {
          ...post,
          curation: Object.keys(curation).length > 0 ? curation : {}  // Empty object so counter is clickable
        } as CurationFeedViewPost
      })
    )
    
    // Helper function to sort posts by timestamp
    const sortByTimestamp = (posts: CurationFeedViewPost[]) => {
      posts.sort((a, b) => {
        let aTime: number
        let bTime: number

        if (postTimestamps) {
          // Use stored postTimestamp from cache (pagination)
          const aUniqueId = getPostUniqueId(a)
          const bUniqueId = getPostUniqueId(b)
          aTime = postTimestamps.get(aUniqueId) ?? postTimestamps.get(a.post.uri) ?? 0
          bTime = postTimestamps.get(bUniqueId) ?? postTimestamps.get(b.post.uri) ?? 0
        } else {
          // Recalculate timestamp (initial load/refresh)
          aTime = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          bTime = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
        }

        return bTime - aTime
      })
    }

    // When skipFiltering=true, return all posts with metadata (for restoration)
    // Posts that were already displayed should not be filtered again
    if (skipFiltering) {
      sortByTimestamp(postsWithStatus)
      return postsWithStatus
    }

    // Filter based on curation status
    const settings = await getSettings()
    const curationDisabled = !settings || settings?.disabled
    const showAllStatus = settings?.showAllStatus || false

    const filteredPosts = postsWithStatus.filter(post => {
      if (curationDisabled || showAllStatus) {
        return true
      }
      return !post.curation?.curation_dropped
    })

    sortByTimestamp(filteredPosts)

    return filteredPosts
  }, [])

  // Helper function to trim feed to maxDisplayedFeedSize and save adjacent page as previousPageFeed
  // Returns the trimmed feed and updates state
  const trimFeedIfNeeded = useCallback((
    combinedFeed: CurationFeedViewPost[],
    pageSize: number,
    feedReceivedTime: Date,
    maxDisplayedFeedSize: number = DEFAULT_MAX_DISPLAYED_FEED_SIZE
  ): CurationFeedViewPost[] => {
    if (combinedFeed.length <= maxDisplayedFeedSize) {
      return combinedFeed
    }

    // Calculate how many posts to trim (trim in page-sized chunks)
    const trimCount = combinedFeed.length - maxDisplayedFeedSize
    const pagesToTrim = Math.ceil(trimCount / pageSize)
    const actualTrimCount = pagesToTrim * pageSize

    // Trim oldest entries (from end of array - oldest posts)
    const newFeed = combinedFeed.slice(0, combinedFeed.length - actualTrimCount)

    // Save ONLY ONE PAGE adjacent to new feed end as previousPageFeed
    // (discard the rest - they remain in feed cache for later retrieval)
    const adjacentPageStart = newFeed.length
    const adjacentPageEnd = Math.min(adjacentPageStart + pageSize, combinedFeed.length)
    const adjacentPage = combinedFeed.slice(adjacentPageStart, adjacentPageEnd)
    setPreviousPageFeed(adjacentPage as CurationFeedViewPost[])

    // Update oldestDisplayedPostTimestamp to new oldest post
    if (newFeed.length > 0) {
      const newOldest = newFeed[newFeed.length - 1]
      const newOldestTimestamp = getFeedViewPostTimestamp(newOldest, feedReceivedTime).getTime()
      setOldestDisplayedPostTimestamp(newOldestTimestamp)
    }

    console.log(`[Trim] Removed ${actualTrimCount} oldest posts, saved ${adjacentPage.length} as previousPageFeed, new feed size: ${newFeed.length}`)

    return newFeed
  }, [])

  // Helper function to pre-fetch the next page for instant Load More
  // This populates previousPageFeed for the NEXT Load More click
  const prefetchNextPage = useCallback(async (afterTimestamp: number) => {
    if (!agent || !session) return

    try {
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const lookbackDays = settings?.lookbackDays || 1

      // Check if cache is stale (newest cached post is older than lookback period)
      const newestCachedTimestamp = await getNewestCachedPostTimestamp()
      if (!isCacheWithinLookback(newestCachedTimestamp, lookbackDays)) {
        // Cache is stale - clear feed cache and trigger initial load instead of prefetching
        console.log('[Prefetch] Cache is stale, clearing and reloading')
        await clearFeedCache()
        // Don't continue prefetching - let loadFeed handle the fresh load
        setPreviousPageFeed([])
        return
      }

      // Step 1: Try to fetch from cache first (no midnight boundary)
      let { posts: postsForNextPage, postTimestamps: timestampsForNextPage } =
        await getCachedFeedBefore(afterTimestamp, pageLength)

      // Step 2: If cache doesn't have enough posts, fetch from server
      if (postsForNextPage.length < pageLength) {
        console.log('[Prefetch] Cache exhausted or partial, fetching from server')
        // Get the oldest timestamp from current posts (if any) to continue from
        const oldestCurrentTimestamp = postsForNextPage.length > 0
          ? Math.min(...postsForNextPage.map(p => {
              const uniqueId = getPostUniqueId(p)
              return timestampsForNextPage.get(uniqueId) ?? timestampsForNextPage.get(p.post.uri) ?? Infinity
            }))
          : afterTimestamp

        const serverResult = await fetchPageFromTimestamp(
          oldestCurrentTimestamp,
          agent,
          session.handle,
          session.did,
          pageLength - postsForNextPage.length,
          serverCursor
        )
        // Append server posts to existing posts
        postsForNextPage = [...postsForNextPage, ...serverResult.posts]
        serverResult.postTimestamps.forEach((value, key) => {
          timestampsForNextPage.set(key, value)
        })
        setServerCursor(serverResult.cursor)
      }

      // Filter and save with retry logic
      // If all posts are dropped by curation, try to fetch more
      const MAX_RETRY_ATTEMPTS = 3
      let retryAttempt = 0
      let filtered: CurationFeedViewPost[] = []
      let oldestProcessedTimestamp = afterTimestamp

      while (retryAttempt <= MAX_RETRY_ATTEMPTS) {
        if (postsForNextPage.length === 0) {
          // No posts to filter - truly exhausted
          break
        }

        filtered = await lookupCurationAndFilter(postsForNextPage, new Date(), timestampsForNextPage)

        if (filtered.length > 0) {
          // Found displayable posts
          break
        }

        // All posts dropped - need to retry with more posts
        retryAttempt++
        if (retryAttempt > MAX_RETRY_ATTEMPTS) {
          console.log(`[Prefetch] Max retry attempts reached, giving up`)
          break
        }

        console.log(`[Prefetch] All ${postsForNextPage.length} posts dropped, retry attempt ${retryAttempt}`)

        // Find oldest timestamp from the posts we just processed
        oldestProcessedTimestamp = Math.min(
          ...postsForNextPage.map(p => {
            const uniqueId = getPostUniqueId(p)
            return timestampsForNextPage.get(uniqueId) ?? timestampsForNextPage.get(p.post.uri) ?? Infinity
          })
        )

        // Try cache first
        const { posts: moreCachedPosts, postTimestamps: moreCachedTimestamps } =
          await getCachedFeedBefore(oldestProcessedTimestamp, pageLength)

        if (moreCachedPosts.length > 0) {
          postsForNextPage = moreCachedPosts
          timestampsForNextPage = moreCachedTimestamps
        } else {
          // Cache exhausted, try server
          console.log('[Prefetch] Cache exhausted in retry, fetching from server')
          const serverResult = await fetchPageFromTimestamp(
            oldestProcessedTimestamp,
            agent,
            session.handle,
            session.did,
            pageLength,
            serverCursor
          )
          if (serverResult.posts.length === 0) {
            // Truly no more posts
            console.log('[Prefetch] Server also exhausted')
            break
          }
          postsForNextPage = serverResult.posts
          timestampsForNextPage = serverResult.postTimestamps
          setServerCursor(serverResult.cursor)
        }
      }

      // Step 3: Apply midnight boundary filter after curation
      // If posts span multiple calendar days, keep only the newer day's posts
      if (filtered.length > 0) {
        const getLocalDateString = (post: CurationFeedViewPost) => {
          const uniqueId = getPostUniqueId(post)
          const timestamp = timestampsForNextPage.get(uniqueId) ?? timestampsForNextPage.get(post.post.uri)
          if (!timestamp) return ''
          return new Date(timestamp).toLocaleDateString()
        }
        const firstDate = getLocalDateString(filtered[0])
        const lastDate = getLocalDateString(filtered[filtered.length - 1])
        if (firstDate && lastDate && firstDate !== lastDate) {
          const originalCount = filtered.length
          filtered = filtered.filter(p => getLocalDateString(p) === firstDate)
          console.log(`[Prefetch] Midnight filter: kept ${filtered.length}/${originalCount} posts from ${firstDate}`)
        }
      }

      setPreviousPageFeed(filtered)
      if (filtered.length > 0) {
        console.log(`[Prefetch] Pre-fetched ${filtered.length} posts for next page`)
      } else {
        console.log('[Prefetch] No more displayable posts available')
      }
    } catch (error) {
      console.warn('[Prefetch] Failed:', error)
      setPreviousPageFeed([])
    }
  }, [agent, session, serverCursor, lookupCurationAndFilter])

  const loadFeed = useCallback(async (cursor?: string, useCache: boolean = true) => {
    if (!agent || !session || !dbInitialized) return

    try {
      // Get page length and lookback settings
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const lookbackDays = settings?.lookbackDays || 1
      const initialCacheLength = pageLength * 2 // Initial load from cache shows twice the page length

      // Clear rate limit status when starting a new request
      setRateLimitStatus(null)

      // Check if cache is fresh (lookback was completed within lookback period)
      const cacheIsFresh = await shouldUseCacheOnLoad(lookbackDays)
      console.log(`[Feed] Cache freshness check: ${cacheIsFresh ? 'fresh' : 'stale'}`)

      // ALWAYS try cache first (for initial load without cursor)
      if (!cursor && useCache) {
        const cachedPosts = await getCachedFeed(initialCacheLength)
        if (cachedPosts.length > 0) {
          // Get last cursor from metadata so "Load More" button appears
          const metadata = await getLastFetchMetadata()
          const lastCursor = metadata?.lastCursor
          
          // Look up curation status and filter
          const feedReceivedTime = new Date()
          const filteredPosts = await lookupCurationAndFilter(cachedPosts, feedReceivedTime)
          
          if (filteredPosts.length > 0) {
            setFeed(filteredPosts)
            setPreviousPageFeed([])  // Clear - will be populated by prefetch
            setCursor(lastCursor)  // Keep for backward compatibility
            
            // Track newest post timestamp for new posts detection
            const newestTimestamp = getFeedViewPostTimestamp(filteredPosts[0], feedReceivedTime).getTime()
            setNewestDisplayedPostTimestamp(newestTimestamp)
            
            // Track oldest post timestamp from displayed posts for pagination
            const oldestDisplayedTimestamp = getFeedViewPostTimestamp(filteredPosts[filteredPosts.length - 1], feedReceivedTime).getTime()
            setOldestDisplayedPostTimestamp(oldestDisplayedTimestamp)
            console.log(`[Feed] Set oldestDisplayedPostTimestamp from displayed posts: ${new Date(oldestDisplayedTimestamp).toISOString()} (from ${filteredPosts.length} displayed posts)`)
            
            // IMPORTANT: Update oldestCachedPostTimestamp in metadata to the oldest postTimestamp from ALL cached posts (not just filtered)
            // This ensures we don't query for posts that were already in the initial cache batch
            // Use the last post from cachedPosts (which are sorted newest first) as the boundary
            const oldestCachedTimestamp = getFeedViewPostTimestamp(cachedPosts[cachedPosts.length - 1], feedReceivedTime).getTime()
            await updateFeedCacheOldestPostTimestamp(oldestCachedTimestamp)
            console.log(`[Feed] Updated oldestCachedPostTimestamp in metadata to oldest cached post: ${new Date(oldestCachedTimestamp).toISOString()} (from ${cachedPosts.length} cached posts, ${filteredPosts.length} displayed)`)
            
            // Check if there are more posts available (based on oldestDisplayedPostTimestamp)
            // Use the local variable oldestDisplayedTimestamp (not state) since state updates are async
            // If oldestDisplayedTimestamp is set, there may be more posts in cache
            // Also check if there's a cursor from metadata, which indicates more posts from server
            const shouldShowLoadMore = oldestDisplayedTimestamp !== null || lastCursor !== undefined
            setHasMorePosts(shouldShowLoadMore)
            console.log(`[Feed] Set hasMorePosts to ${shouldShowLoadMore} (oldestDisplayedTimestamp: ${oldestDisplayedTimestamp !== null}, lastCursor: ${lastCursor !== undefined})`)
            
            // Mark initial load as complete
            setIsInitialLoad(false)
            
            setIsLoading(false)
            console.log(`[Feed] Loaded ${filteredPosts.length} posts from cache`)

            // Pre-fetch next page for instant Load More (NO SPINNER)
            // Use local variable since state updates are async
            setTimeout(async () => {
              await prefetchNextPage(oldestDisplayedTimestamp)
            }, 100)

            // Still fetch in background to update cache
            // But don't block UI
            setTimeout(async () => {
              try {
                // Get page length from settings for background fetch
                const bgSettings = await getSettings()
                const bgPageLength = bgSettings.feedPageLength || 25

                console.log('[New Posts] Starting background fetch...')
                const { feed: newFeed, cursor: newCursor } = await getHomeFeed(agent, { 
                  limit: bgPageLength,
                  onRateLimit: (info) => {
                    // Silently handle rate limit in background
                    console.warn('Rate limit in background fetch:', info)
                  }
                })
                
                console.log(`[New Posts] Background fetch got ${newFeed.length} posts`)
                
                const myUsername = session.handle
                const myDid = session.did

                // New flow: Create entries → Save → Curate
                // For background fetch (like initial fetch), use current time as initialLastPostTime
                const initialLastPostTime = new Date()
                const { entries } = createFeedCacheEntries(newFeed, initialLastPostTime)

                // Save to feed cache and curate (ensures both happen together for cache integrity)
                const { curatedFeed } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

                // Insert edition posts if needed
                await insertEditionPosts(curatedFeed)
                console.log(`[New Posts] Saved ${entries.length} posts to cache`)
                
                // Step 4: Now that posts are curated and cached, check for new posts
                // Always check the cache for posts newer than what's currently displayed
                // This ensures we detect new posts even if the background fetch got the same posts
                const currentNewest = newestDisplayedPostTimestamp || 0
                
                if (currentNewest > 0 && !isInitialLoad) {
                  console.log(`[New Posts] Checking cache for posts newer than ${new Date(currentNewest).toISOString()}`)
                  
                  // Get posts and filter by curation status to get accurate count
                  const newPosts = await getCachedFeedAfterPosts(currentNewest, 100)
                  
                  if (newPosts.length > 0) {
                    // Filter by curation status to get accurate count of displayable posts
                    const feedReceivedTime = new Date()
                    const filteredPosts = await lookupCurationAndFilter(newPosts, feedReceivedTime)
                    const count = filteredPosts.length
                    
                    console.log(`[New Posts] Background fetch found ${newPosts.length} posts in cache, ${count} after filtering (newer than displayed)`)
                    
                    if (count > 0) {
                      // New posts are available - always show the button (user clicks to update feed)
                      console.log('[New Posts] Showing New Posts button with count')
                      setNewPostsCount(count)
                      setShowNewPostsButton(true)
                      // Don't update newestDisplayedPostTimestamp here - it should only be updated when posts are displayed
                      // The displayed timestamp remains unchanged until user clicks "New Posts" button
                    } else {
                      // All posts were filtered out - don't show button
                      setNewPostsCount(0)
                      setShowNewPostsButton(false)
                    }
                  } else {
                    // No new posts found - don't update displayed timestamp
                    // It should remain as is until new posts are actually displayed
                    setNewPostsCount(0)
                    setShowNewPostsButton(false)
                  }
                }
                
                setCursor(newCursor)  // Update cursor from background fetch
                // Update hasMorePosts based on oldestDisplayedPostTimestamp (component-level pagination)
                // If oldestDisplayedPostTimestamp is set, there may be more posts available
                // Also check if there's a cursor, which indicates more posts from server
                // Use state variable here since this is async and state should be updated by now
                // Only update if we have a cursor OR if oldestDisplayedPostTimestamp is set
                // This ensures we don't accidentally clear hasMorePosts if it was already set correctly
                // Read current state to avoid stale closures
                setHasMorePosts(prevHasMore => {
                  const currentOldest = oldestDisplayedPostTimestamp
                  const shouldHaveMore = currentOldest !== null || newCursor !== undefined
                  // Only update if we should have more posts, preserve existing value if we shouldn't
                  // This prevents the background fetch from clearing hasMorePosts incorrectly
                  return shouldHaveMore ? true : prevHasMore
                })
                console.log(`[Background Fetch] Updated hasMorePosts (oldestDisplayedPostTimestamp: ${oldestDisplayedPostTimestamp !== null}, newCursor: ${newCursor !== undefined})`)

                // Start background lookback if cache was not fresh
                if (!cacheIsFresh) {
                  console.log('[Lookback] Cache is stale, clearing feed cache before lookback...')
                  await clearFeedCache()
                  await clearFeedMetadata()

                  setLookingBack(true)
                  setLookbackProgress(0)

                  const lookbackBoundary = getLookbackBoundary(lookbackDays)

                  // Perform lookback fetch in background
                  performLookbackFetch(
                    agent,
                    myUsername,
                    myDid,
                    lookbackBoundary,
                    bgPageLength,
                    (progress) => {
                      setLookbackProgress(progress)
                    }
                  ).then(async (completed) => {
                    console.log(`[Lookback] Background lookback ${completed ? 'completed' : 'interrupted'}`)
                    setLookingBack(false)
                    setLookbackProgress(100)

                    // If this was initial curation, compute stats and show modal
                    if (isInitialCurationRef.current && completed) {
                      try {
                        console.log('[Curation Init] Computing filter statistics...')
                        // Compute stats/filter first (this populates the filter cache)
                        await computeStatsInBackground(agent, myUsername, myDid, true)

                        // Recompute curation status for all cached posts (updates summaries with drop decisions)
                        console.log('[Curation Init] Updating curation decisions for cached posts...')
                        await recomputeCurationStatus(agent, myUsername, myDid)

                        console.log('[Curation Init] Getting curation statistics...')
                        const curationStats = await getCurationInitStats()

                        // Get followee count from filter (now populated)
                        const filterResult = await getFilter()
                        const followeeCount = filterResult
                          ? Object.keys(filterResult[1]).filter(k => !k.startsWith('#')).length
                          : 0

                        // Calculate days analyzed and posts per day
                        let daysAnalyzed = 0
                        let postsPerDay = 0
                        if (curationStats.oldestTimestamp && curationStats.newestTimestamp) {
                          const timeRangeMs = curationStats.newestTimestamp - curationStats.oldestTimestamp
                          daysAnalyzed = Math.max(1, Math.round(timeRangeMs / (24 * 60 * 60 * 1000)))
                          postsPerDay = Math.round(curationStats.totalCount / daysAnalyzed)
                        }

                        setCurationInitStats({
                          totalPosts: curationStats.totalCount,
                          droppedCount: curationStats.droppedCount,
                          followeeCount,
                          oldestTimestamp: curationStats.oldestTimestamp,
                          newestTimestamp: curationStats.newestTimestamp,
                          daysAnalyzed,
                          postsPerDay,
                        })

                        // Clear counter cache and sessionStorage to force fresh load from feed cache
                        // This ensures the feed is re-numbered with all lookback posts
                        clearCounters()
                        sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE)

                        // Reload feed with updated curation via redisplayFeed (will fall through to loadFeed)
                        console.log('[Curation Init] Reloading feed with curation data...')
                        await redisplayFeed()

                        // Show modal
                        setShowCurationInitModal(true)
                        isInitialCurationRef.current = false
                        console.log('[Curation Init] Modal displayed')
                      } catch (err) {
                        console.error('[Curation Init] Failed to compute stats:', err)
                        isInitialCurationRef.current = false
                      }
                    }
                  }).catch((err) => {
                    console.error('[Lookback] Background lookback failed:', err)
                    setLookingBack(false)
                    setLookbackProgress(null)
                  })
                }
              } catch (err) {
                // Silently fail background fetch
                console.warn('Background feed update failed:', err)
              }
            }, 0)
            return
          }
        }
      }
      
      // If cache insufficient or cursor provided, fetch from server
      // For initial fetch (no cursor), fetch more posts to account for curation filtering
      // Uses same pattern as paged updates probe
      let fetchLimit = pageLength
      if (!cursor) {
        const [, currentProbs] = await getFilter() || [null, null]
        const currentFilterFrac = currentProbs ? computeFilterFrac(currentProbs) : 0.5
        const pagedSettings = await getPagedUpdatesSettings()
        fetchLimit = calculatePageRaw(pageLength, currentFilterFrac, pagedSettings.varFactor)
        console.log(`[Initial Fetch] Using pageRaw=${fetchLimit} (filterFrac=${currentFilterFrac.toFixed(2)}, pageLength=${pageLength})`)
      }

      const { feed: newFeed, cursor: newCursor } = await getHomeFeed(agent, {
        cursor: cursor || undefined,
        limit: fetchLimit,
        onRateLimit: (info) => {
          setRateLimitStatus({
            isActive: true,
            retryAfter: info.retryAfter,
            message: info.message || 'Rate limit exceeded. Please wait before trying again.'
          })
        }
      })
      
      // Debug: Log feed info
      if (newFeed.length > 0 && !cursor) {
        const newestPost = newFeed[0]
        const oldestPost = newFeed[newFeed.length - 1]
        const newestTime = new Date((newestPost.post.record as any)?.createdAt || newestPost.post.indexedAt || 0)
        const oldestTime = new Date((oldestPost.post.record as any)?.createdAt || oldestPost.post.indexedAt || 0)
        console.log(`[Feed] Fetched ${newFeed.length} posts. Newest: ${newestTime.toLocaleString()}, Oldest: ${oldestTime.toLocaleString()}`)
      }
      
      // Clear rate limit status on success
      setRateLimitStatus(null)
      
      // Apply curation using new flow: Create entries → Save → Curate
      const myUsername = session.handle
      const myDid = session.did

      // For initial fetch, use current time as initialLastPostTime
      const initialLastPostTime = new Date()
      const { entries } = createFeedCacheEntries(newFeed, initialLastPostTime)

      // Save to feed cache and curate (ensures both happen together for cache integrity)
      const { curatedFeed } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

      // Debug: Log curation results
      if (newFeed.length > 0 && !cursor) {
        console.log(`[Curation] Processed ${curatedFeed.length} posts (all posts, including dropped)`)
      }

      // Insert edition posts if needed
      const feedWithEditions = await insertEditionPosts(curatedFeed)

      // Use feedReceivedTime for timestamp calculations (same as initialLastPostTime for initial fetch)
      const feedReceivedTime = initialLastPostTime
      
      // Look up curation status and filter for display
      const filteredPosts = await lookupCurationAndFilter(feedWithEditions, feedReceivedTime)
      
      if (cursor) {
        // For pagination, append to existing feed and maintain sort
        const combinedFeed = [...feed, ...filteredPosts]
        combinedFeed.sort((a, b) => {
          const aTime = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          const bTime = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
          return bTime - aTime
        })
        setFeed(combinedFeed)
      } else {
        setFeed(filteredPosts)
        setPreviousPageFeed([])  // Clear - will be populated by prefetch
        // Track newest and oldest post timestamps for new posts detection and pagination
        // Always set from displayed posts, never from metadata
        // This ensures displayed timestamp matches what's actually displayed
        if (filteredPosts.length > 0) {
          const newestTimestamp = getFeedViewPostTimestamp(filteredPosts[0], feedReceivedTime).getTime()
          setNewestDisplayedPostTimestamp(newestTimestamp)
          console.log(`[New Posts] Set newestDisplayedPostTimestamp from displayed posts: ${new Date(newestTimestamp).toISOString()}`)
          
          // Track oldest post timestamp from displayed posts for pagination
          const oldestDisplayedTimestamp = getFeedViewPostTimestamp(filteredPosts[filteredPosts.length - 1], feedReceivedTime).getTime()
          setOldestDisplayedPostTimestamp(oldestDisplayedTimestamp)
          console.log(`[Feed] Set oldestDisplayedPostTimestamp from displayed posts: ${new Date(oldestDisplayedTimestamp).toISOString()} (from ${filteredPosts.length} displayed posts)`)
          
          // IMPORTANT: Update oldestCachedPostTimestamp in metadata to the oldest postTimestamp from ALL fetched posts (not just filtered)
          // This ensures we don't query for posts that were already in the initial fetch batch
          // Use the last post from feedWithEditions (which are sorted newest first) as the boundary
          if (feedWithEditions.length > 0) {
            const oldestFetchedTimestamp = getFeedViewPostTimestamp(feedWithEditions[feedWithEditions.length - 1], feedReceivedTime).getTime()
            await updateFeedCacheOldestPostTimestamp(oldestFetchedTimestamp)
            console.log(`[Feed] Updated oldestCachedPostTimestamp in metadata to oldest fetched post: ${new Date(oldestFetchedTimestamp).toISOString()} (from ${feedWithEditions.length} fetched posts, ${filteredPosts.length} displayed)`)
          }
          
          // Mark initial load as complete
          setIsInitialLoad(false)

          // Pre-fetch next page for instant Load More (when no lookback needed)
          // If lookback will happen, prefetch is done after redisplayFeed
          if (cacheIsFresh && !cursor) {
            setTimeout(async () => {
              await prefetchNextPage(oldestDisplayedTimestamp)
            }, 100)
          }

          // Start background lookback if cache was not fresh (stale or empty)
          if (!cacheIsFresh && !cursor) {
            console.log('[Lookback] Cache is stale/empty, clearing feed cache before lookback...')
            await clearFeedCache()
            await clearFeedMetadata()

            setLookingBack(true)
            setLookbackProgress(0)

            const lookbackBoundary = getLookbackBoundary(lookbackDays)

            performLookbackFetch(
              agent,
              myUsername,
              myDid,
              lookbackBoundary,
              pageLength,
              (progress) => {
                setLookbackProgress(progress)
              }
            ).then(async (completed) => {
              console.log(`[Lookback] Background lookback ${completed ? 'completed' : 'interrupted'}`)
              setLookingBack(false)
              setLookbackProgress(100)

              // If this was initial curation, compute stats and show modal
              if (isInitialCurationRef.current && completed) {
                try {
                  console.log('[Curation Init] Computing filter statistics...')
                  // Compute stats/filter first (this populates the filter cache)
                  await computeStatsInBackground(agent, myUsername, myDid, true)

                  // Recompute curation status for all cached posts (updates summaries with drop decisions)
                  console.log('[Curation Init] Updating curation decisions for cached posts...')
                  await recomputeCurationStatus(agent, myUsername, myDid)

                  console.log('[Curation Init] Getting curation statistics...')
                  const curationStats = await getCurationInitStats()

                  // Get followee count from filter (now populated)
                  const filterResult = await getFilter()
                  const followeeCount = filterResult
                    ? Object.keys(filterResult[1]).filter(k => !k.startsWith('#')).length
                    : 0

                  // Calculate days analyzed and posts per day
                  let daysAnalyzed = 0
                  let postsPerDay = 0
                  if (curationStats.oldestTimestamp && curationStats.newestTimestamp) {
                    const timeRangeMs = curationStats.newestTimestamp - curationStats.oldestTimestamp
                    daysAnalyzed = Math.max(1, Math.round(timeRangeMs / (24 * 60 * 60 * 1000)))
                    postsPerDay = Math.round(curationStats.totalCount / daysAnalyzed)
                  }

                  setCurationInitStats({
                    totalPosts: curationStats.totalCount,
                    droppedCount: curationStats.droppedCount,
                    followeeCount,
                    oldestTimestamp: curationStats.oldestTimestamp,
                    newestTimestamp: curationStats.newestTimestamp,
                    daysAnalyzed,
                    postsPerDay,
                  })

                  // Clear counter cache and sessionStorage to force fresh load from feed cache
                  // This ensures the feed is re-numbered with all lookback posts
                  clearCounters()
                  sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE)

                  // Reload feed with updated curation via redisplayFeed (will fall through to loadFeed)
                  console.log('[Curation Init] Reloading feed with curation data...')
                  await redisplayFeed()

                  // Show modal
                  setShowCurationInitModal(true)
                  isInitialCurationRef.current = false
                  console.log('[Curation Init] Modal displayed')
                } catch (err) {
                  console.error('[Curation Init] Failed to compute stats:', err)
                  isInitialCurationRef.current = false
                }
              }
            }).catch((err) => {
              console.error('[Lookback] Background lookback failed:', err)
              setLookingBack(false)
              setLookbackProgress(null)
            })
          }

          // Update hasMorePosts based on oldestDisplayedTimestamp (use local variable, not state)
          // If oldestDisplayedTimestamp is set, there may be more posts available
          // Also check if there's a cursor, which indicates more posts from server
          setHasMorePosts(oldestDisplayedTimestamp !== null || newCursor !== undefined)
        } else {
          // No posts in filtered feed, no more posts available
          setHasMorePosts(false)
        }
      }
      
      setCursor(newCursor)  // Keep for backward compatibility
    } catch (error) {
      console.error('Failed to load feed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to load feed'
      
      // Only show error if not a background refresh
      if (useCache) {
        addToast(errorMessage, 'error')
      }
      
      // Check if it's a rate limit error and update status
      if (errorMessage.toLowerCase().includes('rate limit')) {
        const retryAfterMatch = errorMessage.match(/(\d+)\s*seconds?/i)
        const retryAfter = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : undefined
        setRateLimitStatus({
          isActive: true,
          retryAfter,
          message: errorMessage
        })
      }
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [agent, session, dbInitialized, setRateLimitStatus])

  const redisplayFeed = useCallback(async () => {
    if (!agent || !session || !dbInitialized) return

    try {
      // Get saved feed state
      const savedStateJson = sessionStorage.getItem(WEBSKY9_HOME_FEED_STATE)
      if (!savedStateJson) {
        console.log('[Redisplay] No saved feed state, falling back to loadFeed')
        return loadFeed()
      }

      const savedState: SavedFeedState = JSON.parse(savedStateJson)
      
      // Check if saved state is for the same user session
      if (savedState.sessionDid !== session.did) {
        console.log('[Redisplay] Saved state is for different user, falling back to loadFeed')
        // Clear saved state for different user
        sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE)
        return loadFeed()
      }
      
      // Check if saved state is still valid (not too old, has posts)
      if (!savedState.displayedFeed || savedState.displayedFeed.length === 0) {
        console.log('[Redisplay] Saved state has no posts, falling back to loadFeed')
        return loadFeed()
      }

      // Get settings for truncation threshold
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const maxDisplayedFeedSize = settings?.maxDisplayedFeedSize || DEFAULT_MAX_DISPLAYED_FEED_SIZE
      const feedReceivedTime = new Date()

      // Look up curation status for restored posts from summaries cache
      // This ensures posts have correct curation metadata for counter display
      // skipFiltering=true: Posts already passed curation, don't filter again
      let feedWithCuration = await lookupCurationAndFilter(
        savedState.displayedFeed as CurationFeedViewPost[],
        feedReceivedTime,
        undefined,  // no postTimestamps
        true        // skipFiltering - don't re-filter restored posts
      )

      // Use trimFeedIfNeeded for consistent truncation behavior
      // This also sets previousPageFeed to adjacent posts if truncated
      const originalLength = feedWithCuration.length
      feedWithCuration = trimFeedIfNeeded(feedWithCuration, pageLength, feedReceivedTime, maxDisplayedFeedSize)
      const truncated = feedWithCuration.length < originalLength

      if (truncated) {
        console.log(`[Redisplay] Truncated feed from ${originalLength} to ${feedWithCuration.length} posts using trimFeedIfNeeded`)
      }

      // Restore feed state
      setFeed(feedWithCuration)

      // Update timestamps based on displayed feed
      if (feedWithCuration.length > 0) {
        const newestTimestamp = getFeedViewPostTimestamp(feedWithCuration[0], feedReceivedTime).getTime()
        const oldestTimestamp = getFeedViewPostTimestamp(feedWithCuration[feedWithCuration.length - 1], feedReceivedTime).getTime()
        
        setNewestDisplayedPostTimestamp(newestTimestamp)
        setOldestDisplayedPostTimestamp(oldestTimestamp)
      } else {
        // Fallback to saved timestamps if feed is empty (shouldn't happen)
        setNewestDisplayedPostTimestamp(savedState.newestDisplayedPostTimestamp)
        setOldestDisplayedPostTimestamp(savedState.oldestDisplayedPostTimestamp)
      }
      
      setHasMorePosts(savedState.hasMorePosts)
      setCursor(savedState.cursor)
      setIsLoading(false)
      setIsInitialLoad(false)

      // Restore "New Posts" button state
      // Restore saved values first, then update in background if needed
      if (savedState.newPostsCount !== undefined) {
        setNewPostsCount(savedState.newPostsCount)
      }
      if (savedState.showNewPostsButton !== undefined) {
        setShowNewPostsButton(savedState.showNewPostsButton)
      }

      // Restore previousPageFeed or pre-fetch if not available
      // Handle previousPageFeed based on whether truncation occurred
      const oldestTimestamp = feedWithCuration.length > 0
        ? getFeedViewPostTimestamp(feedWithCuration[feedWithCuration.length - 1], feedReceivedTime).getTime()
        : savedState.oldestDisplayedPostTimestamp

      if (truncated) {
        // trimFeedIfNeeded already set previousPageFeed to adjacent posts
        console.log('[Redisplay] previousPageFeed set by trimFeedIfNeeded')
      } else if (savedState.previousPageFeed && savedState.previousPageFeed.length > 0) {
        // Restore from saved state (with curation lookup) - only when NOT truncated
        // skipFiltering=true: Posts already passed curation, don't filter again
        const previousWithCuration = await lookupCurationAndFilter(
          savedState.previousPageFeed as CurationFeedViewPost[],
          feedReceivedTime,
          undefined,  // no postTimestamps
          true        // skipFiltering - don't re-filter restored posts
        )
        setPreviousPageFeed(previousWithCuration)
        console.log(`[Redisplay] Restored previousPageFeed: ${previousWithCuration.length} posts`)
      } else if (oldestTimestamp) {
        // Pre-fetch if not saved (NO SPINNER)
        setTimeout(async () => {
          await prefetchNextPage(oldestTimestamp)
        }, 100)
      }

      // Reset flag to allow scroll restoration
      scrollRestoredRef.current = false

      console.log('[Redisplay] Restored feed state:', {
        feedLength: feedWithCuration.length,
        originalFeedLength: savedState.displayedFeed.length,
        truncated,
        hasMorePosts: savedState.hasMorePosts,
        newPostsCount: savedState.newPostsCount,
        showNewPostsButton: savedState.showNewPostsButton,
        age: Math.round((Date.now() - savedState.savedAt) / 1000) + 's'
      })
      
      // Still check for new posts in background to update count if cache has changed
      // This ensures the count is accurate even if new posts were added to cache while away
      setTimeout(async () => {
        try {
          const currentNewest = savedState.newestDisplayedPostTimestamp || 0
          if (currentNewest > 0) {
            // Get posts and filter by curation status to get accurate count
            const newPosts = await getCachedFeedAfterPosts(currentNewest, 100)
            
            if (newPosts.length > 0) {
              // Filter by curation status to get accurate count of displayable posts
              const feedReceivedTime = new Date()
              const filteredPosts = await lookupCurationAndFilter(newPosts, feedReceivedTime)
              const count = filteredPosts.length
              
              if (count > 0) {
                // Update count and show button if there are new posts
                setNewPostsCount(count)
                setShowNewPostsButton(true)
                console.log('[Redisplay] Updated new posts count:', count, `(${newPosts.length} in cache, ${count} after filtering)`)
              } else {
                // All posts were filtered out - hide button
                setNewPostsCount(0)
                setShowNewPostsButton(false)
              }
            } else if (savedState.showNewPostsButton) {
              // Hide button if there are no longer new posts (user might have viewed them in another tab)
              setNewPostsCount(0)
              setShowNewPostsButton(false)
            }
            // If count is 0 and button was hidden, keep it hidden (no change needed)
          }
        } catch (err) {
          console.warn('Background new posts check failed:', err)
          // Keep saved state if check fails
        }
      }, 0)
      
    } catch (error) {
      console.error('Failed to redisplay feed:', error)
      // Fall back to loadFeed if redisplay fails
      return loadFeed()
    }
  }, [agent, session, dbInitialized, loadFeed])

  // Debug function to clear all caches and trigger fresh initial load
  const clearCacheAndReloadHomePage = useCallback(async () => {
    console.log('[Debug] clearCacheAndReloadHomePage: Starting...')

    try {
      // 1. Clear sessionStorage feed state
      sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE)
      sessionStorage.removeItem(SCROLL_STATE_KEY)
      console.log('[Debug] Cleared sessionStorage')

      // 2. Clear IndexedDB caches
      const database = await initDB()

      // Clear summaries
      const summariesTx = database.transaction(['summaries'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = summariesTx.objectStore('summaries').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared summaries cache')

      // Clear feed_cache
      const feedTx = database.transaction(['feed_cache'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = feedTx.objectStore('feed_cache').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared feed_cache')

      // Clear feed_metadata
      const metaTx = database.transaction(['feed_metadata'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = metaTx.objectStore('feed_metadata').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared feed_metadata')

      // 3. Clear in-memory counter cache
      clearCounters()
      console.log('[Debug] Cleared counter cache')

      // 4. Reset React state
      setFeed([])
      setCursor(undefined)
      setServerCursor(undefined)
      setHasMorePosts(false)
      setPreviousPageFeed([])  // Clear pre-fetched posts to avoid stale data
      setIsLoading(true)
      setIsInitialLoad(true)
      setNewestDisplayedPostTimestamp(null)
      setOldestDisplayedPostTimestamp(null)
      setNewPostsCount(0)
      setShowNewPostsButton(false)
      setLookingBack(false)
      setLookbackProgress(null)
      console.log('[Debug] Reset React state')

      // 5. Mark as initial curation so modal will show after lookback
      isInitialCurationRef.current = true
      console.log('[Debug] Set isInitialCurationRef to true for modal display')

      // 6. Trigger fresh load (bypass cache)
      console.log('[Debug] Triggering fresh loadFeed with useCache=false...')
      await loadFeed(undefined, false)
      console.log('[Debug] clearCacheAndReloadHomePage: Complete!')

    } catch (error) {
      console.error('[Debug] clearCacheAndReloadHomePage failed:', error)
    }
  }, [loadFeed])

  // Re-filter feed from cache when showAllStatus setting changes
  // This re-reads from IndexedDB cache and re-applies curation filtering without clearing caches
  const refilterFeedFromCache = useCallback(async () => {
    console.log('[Refilter] refilterFeedFromCache: Starting...')

    try {
      // Get all posts from the feed cache (last 24 hours)
      const cachedPosts = await getCachedFeed(500) // Get enough posts to cover the feed
      console.log(`[Refilter] Got ${cachedPosts.length} posts from cache`)

      if (cachedPosts.length === 0) {
        console.log('[Refilter] No cached posts found')
        return
      }

      // Re-apply curation filtering with current settings
      const filteredPosts = await lookupCurationAndFilter(cachedPosts, new Date())
      console.log(`[Refilter] After filtering: ${filteredPosts.length} posts`)

      // Update timestamp boundaries
      if (filteredPosts.length > 0) {
        const newestTime = getFeedViewPostTimestamp(filteredPosts[0], new Date()).getTime()
        const oldestTime = getFeedViewPostTimestamp(filteredPosts[filteredPosts.length - 1], new Date()).getTime()
        setNewestDisplayedPostTimestamp(newestTime)
        setOldestDisplayedPostTimestamp(oldestTime)
      }

      // Update the feed state
      setFeed(filteredPosts)
      setPreviousPageFeed([])  // Clear - refiltering may change order
      console.log('[Refilter] refilterFeedFromCache: Complete!')

    } catch (error) {
      console.error('[Refilter] refilterFeedFromCache failed:', error)
    }
  }, [lookupCurationAndFilter])

  // Expose debug function globally
  useEffect(() => {
    (window as any).clearCacheAndReloadHomePage = clearCacheAndReloadHomePage
    ;(window as any).refilterFeedFromCache = refilterFeedFromCache
    return () => {
      delete (window as any).clearCacheAndReloadHomePage
      delete (window as any).refilterFeedFromCache
    }
  }, [clearCacheAndReloadHomePage, refilterFeedFromCache])

  useEffect(() => {
    // Only load/redisplay feed if we're on the home page
    if (location.pathname !== '/') {
      return
    }

    // Check if we need to refilter the feed (set by SkylimitSettingsPage when showAllStatus changes)
    const needsRefilter = sessionStorage.getItem('skylimit_needs_refilter')
    if (needsRefilter === 'true') {
      console.log('[HomePage] Detected refilter flag, triggering refilterFeedFromCache')
      sessionStorage.removeItem('skylimit_needs_refilter')
      // Clear saved feed state so it doesn't interfere with refilter
      sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE)
      refilterFeedFromCache()
      return // Don't continue with shouldRedisplay - let refilter handle the feed
    }

    // Reset scroll restoration flag when navigating to home page
    scrollRestoredRef.current = false

    // Clear thread scroll position when navigating to home to prevent interference
    // Thread pages use a different key, but clearing it ensures no conflicts
    try {
      sessionStorage.removeItem('websky9_thread_scroll_position')
    } catch (error) {
      // Ignore errors
    }
    
    // If we're navigating to home from another page (especially thread page),
    // reset scroll to top first (will be restored after feed loads)
    // This prevents thread page scroll position from interfering with home restoration
    const wasOnOtherPage = previousPathnameRef.current !== '/' && previousPathnameRef.current !== location.pathname
    if (wasOnOtherPage) {
      // Reset to top immediately when navigating from another page
      // The scroll will be restored after feed loads if we have a saved position
      window.scrollTo(0, 0)
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }

    const shouldRedisplay = async () => {
      try {
        // Get saved feed state
        const savedStateJson = sessionStorage.getItem(WEBSKY9_HOME_FEED_STATE)
        if (!savedStateJson) {
          console.log('[Navigation] No saved feed state, calling loadFeed')
          return loadFeed()
        }

        const savedState: SavedFeedState = JSON.parse(savedStateJson)
        
        // Check if saved state is for the same user session
        if (savedState.sessionDid !== session?.did) {
          console.log('[Navigation] Saved state is for different user, calling loadFeed')
          // Clear saved state for different user
          sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE)
          return loadFeed()
        }
        
        // Get idle interval from settings
        const settings = await getSettings()
        const idleInterval = settings?.feedRedisplayIdleInterval || 5 * 60 * 1000 // default 5 minutes
        
        const timeSinceSave = Date.now() - savedState.savedAt
        const isWithinIdleInterval = timeSinceSave < idleInterval
        
        if (isWithinIdleInterval && savedState.displayedFeed && savedState.displayedFeed.length > 0) {
          console.log('[Navigation] Within idle interval, redisplaying feed:', {
            timeSinceSave: Math.round(timeSinceSave / 1000) + 's',
            idleInterval: Math.round(idleInterval / 1000) + 's'
          })
          return redisplayFeed()
        } else {
          console.log('[Navigation] Outside idle interval or no saved feed, calling loadFeed:', {
            timeSinceSave: Math.round(timeSinceSave / 1000) + 's',
            idleInterval: Math.round(idleInterval / 1000) + 's',
            hasFeed: !!savedState.displayedFeed && savedState.displayedFeed.length > 0
          })
          // Clear scroll state if feed state expired
          sessionStorage.removeItem(SCROLL_STATE_KEY)
          return loadFeed()
        }
      } catch (error) {
        console.error('Failed to check feed state:', error)
        // Fall back to loadFeed on error
        return loadFeed()
      }
    }

    shouldRedisplay()
  }, [loadFeed, redisplayFeed, refilterFeedFromCache, location.pathname, session])

  // Restore scroll position when feed state is restored
  // Note: Scroll restoration works regardless of infinite scrolling setting
  useEffect(() => {
    if (location.pathname !== '/') {
      // Unblock scroll saves when leaving home page
      scrollSaveBlockedRef.current = false
      return
    }

    // Block scroll saves while restoration is pending (prevents browser scroll restoration from overwriting saved position)
    // Also reset scrollRestoreBlockedRef - browser's native scroll may have set this before our effect ran
    if (!scrollRestoredRef.current) {
      scrollSaveBlockedRef.current = true
      scrollRestoreBlockedRef.current = false  // Reset to allow our restoration to proceed
    }

    if (scrollRestoredRef.current) {
      return // Only restore once
    }
    if (isLoading) {
      return // Wait for feed to load
    }

    // Check if feed state was restored (not initial load)
    const savedStateJson = sessionStorage.getItem(WEBSKY9_HOME_FEED_STATE)
    if (!savedStateJson) {
      // No saved feed state, don't restore scroll - unblock saves and mark as restored
      scrollRestoredRef.current = true
      scrollSaveBlockedRef.current = false
      return
    }

    // Check for saved scroll position
    const savedScrollY = sessionStorage.getItem(SCROLL_STATE_KEY)
    if (!savedScrollY) {
      // No saved scroll position - unblock saves and mark as restored
      scrollRestoredRef.current = true
      scrollSaveBlockedRef.current = false
      return
    }

    const scrollY = parseInt(savedScrollY, 10)
    if (isNaN(scrollY) || scrollY < 0) {
      // Invalid scroll position - unblock saves and mark as restored
      scrollRestoredRef.current = true
      scrollSaveBlockedRef.current = false
      return
    }

    // Check if restoration is blocked
    if (scrollRestoreBlockedRef.current) {
      // Blocked by user scrolling - unblock saves and mark as restored
      scrollRestoredRef.current = true
      scrollSaveBlockedRef.current = false
      return
    }
    
    // Wait for DOM to be ready
    // Use a retry mechanism to ensure DOM is fully rendered
    const attemptRestore = (attempt: number = 1) => {
      const maxAttempts = 10
      const baseDelay = 100
      const delay = attempt * baseDelay

      setTimeout(() => {
        // Reset scrollRestoreBlockedRef at the start of each attempt
        // This prevents scroll events from previous attempts blocking retries
        scrollRestoreBlockedRef.current = false

        const scrollHeight = document.documentElement.scrollHeight
        const clientHeight = window.innerHeight
        const maxScroll = Math.max(scrollHeight - clientHeight, 0)
        const targetScroll = Math.min(scrollY, maxScroll)

        // Only restore if DOM is ready (has content) and target is valid
        if (targetScroll > 0 && scrollHeight > clientHeight && scrollHeight >= targetScroll) {
          // Restore scroll position
          isProgrammaticScrollRef.current = true
          window.scrollTo(0, targetScroll)
          document.documentElement.scrollTop = targetScroll
          document.body.scrollTop = targetScroll

          // Verify the scroll actually reached the ORIGINAL requested position (within tolerance)
          const actualScroll = window.scrollY
          const scrollTolerance = 100 // Allow 100px tolerance
          // Check if we reached the original requested position, not just the clamped target
          const reachedOriginalTarget = Math.abs(actualScroll - scrollY) < scrollTolerance
          // Also check if document was too short (targetScroll < scrollY means we couldn't scroll far enough)
          const documentTooShort = targetScroll < scrollY - scrollTolerance

          if (reachedOriginalTarget) {
            // Successfully reached the original requested position
            scrollRestoredRef.current = true

            // Reset flags after scroll completes
            setTimeout(() => {
              isProgrammaticScrollRef.current = false
              scrollSaveBlockedRef.current = false  // Allow scroll saves again
              lastScrollTopRef.current = window.scrollY
            }, 200)
          } else if (documentTooShort && attempt < maxAttempts) {
            // Document not tall enough yet (images/content still loading), retry
            isProgrammaticScrollRef.current = false
            attemptRestore(attempt + 1)
          } else if (attempt < maxAttempts) {
            // Scroll didn't reach target for other reason, retry
            isProgrammaticScrollRef.current = false
            attemptRestore(attempt + 1)
          } else {
            // Max attempts reached, accept current position
            scrollRestoredRef.current = true
            scrollSaveBlockedRef.current = false  // Allow scroll saves again
            setTimeout(() => {
              isProgrammaticScrollRef.current = false
              lastScrollTopRef.current = window.scrollY
            }, 200)
          }
        } else if (attempt < maxAttempts) {
          // DOM not ready yet, retry
          attemptRestore(attempt + 1)
        } else {
          // Max attempts reached, give up
          scrollRestoredRef.current = true
          scrollSaveBlockedRef.current = false  // Allow scroll saves again
        }
      }, delay)
    }
    
    attemptRestore()
  }, [location.pathname, isLoading, feed.length])

  // Check for new posts periodically
  // Check for new posts - uses different logic based on paged updates mode
  // Standard mode: checks feed cache for posts already fetched and curated
  // Paged updates mode: probes server without caching to preserve access to newer posts
  useEffect(() => {
    if (!newestDisplayedPostTimestamp || !dbInitialized) {
      // Reset count if no timestamp
      setNewPostsCount(0)
      setShowNewPostsButton(false)
      setNextPageReady(false)
      return
    }

    const checkForNewPosts = async () => {
      // Capture current timestamp to avoid stale closure
      const currentTimestamp = newestDisplayedPostTimestamp
      if (!currentTimestamp) return

      // Standard mode: check cache for new posts
      if (!pagedUpdatesEnabled) {
        // Get posts from cache and filter by curation status to get accurate count
        const newPosts = await getCachedFeedAfterPosts(currentTimestamp, 100)

        if (newPosts.length === 0) {
          setNewPostsCount(0)
          setShowNewPostsButton(false)
          return
        }

        // Filter by curation status to get accurate count of displayable posts
        const feedReceivedTime = new Date()
        const filteredPosts = await lookupCurationAndFilter(newPosts, feedReceivedTime)

        const count = filteredPosts.length
        console.log(`[New Posts] Checked for posts newer than ${new Date(currentTimestamp).toISOString()}, found ${newPosts.length} in cache, ${count} after filtering`)

        if (count > 0 && !isInitialLoad) {
          setNewPostsCount(count)
          setShowNewPostsButton(true)
        } else {
          setNewPostsCount(0)
          setShowNewPostsButton(false)
        }
        return
      }

      // Paged updates mode: probe server without caching
      if (!agent || !session) return

      try {
        // Get current filter fraction and settings
        const [, currentProbs] = await getFilter() || [null, null]
        const currentFilterFrac = currentProbs ? computeFilterFrac(currentProbs) : 0.5

        const pagedSettings = await getPagedUpdatesSettings()
        const pageSize = pagedSettings.pageSize
        const varFactor = pagedSettings.varFactor
        const maxWaitMinutes = pagedSettings.maxWaitMinutes

        // Calculate how many raw posts to fetch (use 3x pageSize for multi-page detection)
        const pageRaw = calculatePageRaw(pageSize * 3, currentFilterFrac, varFactor)

        console.log(`[Paged Updates] Probing for new posts (filterFrac=${currentFilterFrac.toFixed(2)}, pageRaw=${pageRaw}, newestDisplayed=${new Date(currentTimestamp).toLocaleTimeString()}, oldestDisplayed=${oldestDisplayedPostTimestamp ? new Date(oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'})...`)

        // Probe for new posts (does NOT cache)
        const probeResult = await probeForNewPosts(
          agent,
          pageRaw,
          session.handle,
          session.did,
          currentTimestamp
        )

        console.log(`[Paged Updates] Probe result: ${probeResult.filteredPostCount}/${pageSize} displayable posts (${probeResult.totalPostCount} newer, ${probeResult.rawPostCount} raw, pages=${probeResult.pageCount}, multiPage=${probeResult.hasMultiplePages})`)

        // Debug: save expected count for comparison when button is clicked
        probeExpectedCountRef.current = probeResult.filteredPostCount

        // Track first probe timestamp for max wait timer
        if (probeResult.filteredPostCount > 0 && !firstProbeTimestamp) {
          setFirstProbeTimestamp(Date.now())
        }

        // Check for gap between probe and cache
        const gapExists = probeResult.oldestProbeTimestamp < Number.MAX_SAFE_INTEGER
          ? await hasGapFromProbe(probeResult.oldestProbeTimestamp)
          : false
        setHasProbeGap(gapExists)

        // Check if we have a full page or max wait exceeded
        const hasFullPage = probeResult.filteredPostCount >= pageSize
        const hasMultiplePages = probeResult.hasMultiplePages
        const maxWaitExceeded = firstProbeTimestamp &&
          (Date.now() - firstProbeTimestamp) >= maxWaitMinutes * 60 * 1000

        // Check cooldown - don't show buttons immediately after displaying posts
        const inCooldown = Date.now() - lastDisplayTimeRef.current < DISPLAY_COOLDOWN_MS
        if (inCooldown) {
          console.log(`[Paged Updates] In cooldown (${Math.round((DISPLAY_COOLDOWN_MS - (Date.now() - lastDisplayTimeRef.current)) / 1000)}s remaining), skipping button updates`)
          return
        }

        // Update multi-page count (also set when gap exists with full page)
        if (hasMultiplePages || (gapExists && hasFullPage)) {
          setMultiPageCount(probeResult.filteredPostCount)
          console.log(`[Paged Updates] Multi-page/gap detected: ${probeResult.filteredPostCount} posts (${probeResult.pageCount} pages), gap=${gapExists}, hasMultiplePages=${hasMultiplePages}`)
        } else {
          setMultiPageCount(0)
          if (gapExists) {
            console.log(`[Paged Updates] Gap exists but not full page: ${probeResult.filteredPostCount} posts, gap=${gapExists}`)
          }
        }

        if (hasFullPage || (maxWaitExceeded && probeResult.filteredPostCount > 0)) {
          setNextPageReady(true)
          setNewPostsCount(probeResult.filteredPostCount)
          setPartialPageCount(maxWaitExceeded && !hasFullPage ? probeResult.filteredPostCount : 0)
          setShowNewPostsButton(true)
          console.log(`[Paged Updates] ${hasFullPage ? 'Full page ready' : 'Max wait exceeded'}: ${probeResult.filteredPostCount} posts → SHOWING BUTTON`)
        } else {
          // Not ready yet, keep tracking
          setNextPageReady(false)
          setNewPostsCount(probeResult.filteredPostCount) // Update count for display
          setPartialPageCount(probeResult.filteredPostCount) // Track partial count for idle timer
          setShowNewPostsButton(false) // Hide button until ready
          console.log(`[Paged Updates] Not ready yet: ${probeResult.filteredPostCount}/${pageSize} posts, maxWaitExceeded=${maxWaitExceeded}`)
        }
      } catch (error) {
        console.warn('[Paged Updates] Probe error:', error)
      }
    }

    // Check immediately
    checkForNewPosts()

    // Check every 60 seconds
    const interval = setInterval(checkForNewPosts, 60000)

    // Also check when page becomes visible (after being in background)
    // Browsers throttle setInterval when page is hidden, so we need this to
    // immediately probe when user returns from idle
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        console.log('[Paged Updates] Page became visible, triggering immediate probe')
        checkForNewPosts()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [newestDisplayedPostTimestamp, dbInitialized, isInitialLoad, pagedUpdatesEnabled, agent, session])

  // Idle timer for partial page display
  // When maxWaitMinutes has elapsed since newestDisplayedPostTimestamp and there are partial posts,
  // trigger the "All n new posts" button for partial page display
  useEffect(() => {
    if (!pagedUpdatesEnabled || !newestDisplayedPostTimestamp || isInitialLoad) {
      setIdleTimerTriggered(false)
      return
    }

    const checkIdleTime = async () => {
      // Get maxWaitMinutes from settings
      const pagedSettings = await getPagedUpdatesSettings()
      const maxWaitMs = pagedSettings.maxWaitMinutes * 60 * 1000

      // Calculate time since top post was displayed
      const timeSinceTopPost = Date.now() - newestDisplayedPostTimestamp

      // Trigger if idle time exceeded and partial posts available
      if (timeSinceTopPost >= maxWaitMs && partialPageCount > 0 && !nextPageReady) {
        setIdleTimerTriggered(true)
        console.log(`[Idle Timer] Triggered: ${Math.round(timeSinceTopPost / 60000)} min elapsed, ${partialPageCount} partial posts available`)
      } else {
        setIdleTimerTriggered(false)
      }
    }

    // Check immediately and then every 30 seconds
    checkIdleTime()
    const interval = setInterval(checkIdleTime, 30000)

    return () => clearInterval(interval)
  }, [newestDisplayedPostTimestamp, pagedUpdatesEnabled, isInitialLoad, partialPageCount, nextPageReady])

  // Periodically fetch new posts from Bluesky server to update cache
  // This ensures the cache stays fresh and the periodic cache check can detect new posts
  useEffect(() => {
    if (!agent || !session || !dbInitialized || !newestDisplayedPostTimestamp || isInitialLoad) {
      return
    }

    let isPageVisible = true
    let fetchInterval: NodeJS.Timeout | null = null

    // Check page visibility to pause fetching when tab is in background
    const handleVisibilityChange = () => {
      isPageVisible = !document.hidden
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const fetchNewPostsFromServer = async () => {
      // Don't fetch if paged updates is enabled - it manages its own probing
      if (pagedUpdatesEnabled) {
        console.log('[Periodic Fetch] Skipping - paged updates enabled')
        return
      }

      // Don't fetch if page is not visible
      if (!isPageVisible) {
        console.log('[Periodic Fetch] Skipping fetch - page not visible')
        return
      }

      // Don't fetch if rate limited
      if (isRateLimited()) {
        const timeUntilClear = getTimeUntilClear()
        console.log(`[Periodic Fetch] Skipping fetch - rate limited for ${Math.ceil(timeUntilClear)}s`)
        return
      }

      // Don't fetch if conditions changed
      if (!agent || !session || !dbInitialized) {
        return
      }

      try {
        // Get cache timestamp from metadata - this is what we've already cached
        // Periodic server fetch's job is to update the cache, not the display
        const metadata = await getLastFetchMetadata()
        const cachedNewestTimestamp = metadata?.newestCachedPostTimestamp || 0

        if (cachedNewestTimestamp === 0) {
          console.log('[Periodic Fetch] No cached timestamp, skipping fetch')
          return
        }

        console.log(`[Periodic Fetch] Fetching new posts from server (newer than cached: ${new Date(cachedNewestTimestamp).toLocaleTimeString()})...`)
        
        // Get page length from settings for periodic fetch
        const periodicSettings = await getSettings()
        const periodicPageLength = periodicSettings?.feedPageLength || 25
        
        // Fetch newest posts from server (no cursor = get latest)
        const { feed: newFeed, cursor: newCursor } = await getHomeFeed(agent, {
          limit: periodicPageLength,
          onRateLimit: (info) => {
            // Silently handle rate limit - don't spam server
            console.warn('[Periodic Fetch] Rate limit:', info)
          }
        })

        if (newFeed.length === 0) {
          console.log('[Periodic Fetch] No new posts from server')
          return
        }

        console.log(`[Periodic Fetch] Got ${newFeed.length} posts from server`)

        const feedReceivedTime = new Date()
        const myUsername = session.handle
        const myDid = session.did

        // Filter posts: only process posts newer than what's already in cache
        // Use getFeedViewPostTimestamp to get actual post timestamp
        const newPosts = newFeed.filter(post => {
          const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime).getTime()
          return postTimestamp > cachedNewestTimestamp
        })

        if (newPosts.length === 0) {
          console.log(`[Periodic Fetch] No posts newer than cached timestamp (${new Date(cachedNewestTimestamp).toISOString()})`)
          // Still update cursor in case metadata changed
          if (newCursor) {
            const updatedMetadata = await getLastFetchMetadata()
            if (updatedMetadata) {
              await saveFeedCache([], feedReceivedTime, newCursor)
            }
          }
          return
        }

        console.log(`[Periodic Fetch] Processing ${newPosts.length} new posts`)

        // New flow: Create entries → Save → Curate
        // For periodic fetch (like initial fetch), use current time as initialLastPostTime
        const initialLastPostTime = new Date()
        const { entries } = createFeedCacheEntries(newPosts, initialLastPostTime)

        // Save to feed cache and curate (ensures both happen together for cache integrity)
        const { curatedFeed } = await savePostsWithCuration(entries, newCursor, agent, myUsername, myDid)

        // Insert edition posts if needed
        await insertEditionPosts(curatedFeed)
        console.log(`[Periodic Fetch] Saved ${entries.length} new posts to cache`)

        // Perform limited lookback to fill gaps back to local midnight for consistent counter numbering
        // Only if we have entries and a cursor for pagination
        if (entries.length > 0 && newCursor) {
          const oldestEntryTimestamp = Math.min(...entries.map(e => e.postTimestamp))
          const localMidnight = getLocalMidnight().getTime()
          if (oldestEntryTimestamp > localMidnight) {
            console.log(`[Periodic Fetch] Starting limited lookback from ${new Date(oldestEntryTimestamp).toLocaleTimeString()} to midnight`)
            await limitedLookbackToMidnight(oldestEntryTimestamp, newCursor, agent, myUsername, myDid, periodicPageLength)
          }
        }

        // Step 4: Check for new posts in cache (only for standard mode)
        // Paged updates mode manages button state via its own probing effect
        if (!pagedUpdatesEnabled) {
          // Use displayed timestamp to check cache - this detects posts newer than what's displayed
          const currentNewest = newestDisplayedPostTimestamp || 0
          if (currentNewest > 0) {
            // Get posts and filter by curation status to get accurate count
            const newPosts = await getCachedFeedAfterPosts(currentNewest, 100)

            if (newPosts.length > 0) {
              // Filter by curation status to get accurate count of displayable posts
              const feedReceivedTime = new Date()
              const filteredPosts = await lookupCurationAndFilter(newPosts, feedReceivedTime)
              const count = filteredPosts.length

              console.log(`[Periodic Fetch] Found ${newPosts.length} posts in cache, ${count} after filtering`)

              if (count > 0) {
                setNewPostsCount(count)
                setShowNewPostsButton(true)
              } else {
                // All posts were filtered out
                setNewPostsCount(0)
                setShowNewPostsButton(false)
              }
            }
          }
        }

        // Don't update newestDisplayedPostTimestamp here - it should only be updated when posts are displayed
        // The periodic cache check will detect new posts using the current displayed timestamp
        // When user clicks "New Posts" button, handleLoadNewPosts will update displayed timestamp from displayed posts
      } catch (error) {
        // Silently fail - don't show errors for background fetches
        console.warn('[Periodic Fetch] Failed to fetch new posts:', error)
      }
    }

    // Fetch immediately after a short delay (don't run immediately on mount)
    const initialTimeout = setTimeout(() => {
      fetchNewPostsFromServer()
    }, 10000) // Wait 10 seconds after initial load

    // Then fetch every 60 seconds
    fetchInterval = setInterval(fetchNewPostsFromServer, 60000)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (initialTimeout) clearTimeout(initialTimeout)
      if (fetchInterval) clearInterval(fetchInterval)
    }
  }, [agent, session, dbInitialized, newestDisplayedPostTimestamp, isInitialLoad, pagedUpdatesEnabled])

  // Scroll event handler (for UI state and scroll position saving)
  useEffect(() => {
    // Only track scroll if we're on the home page
    if (location.pathname !== '/') return

    let scrollBlockResetTimeout: NodeJS.Timeout | null = null

    const handleScroll = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
      const threshold = 200
      
      // Update last scroll position
      const currentScrollTop = scrollY
      const lastScrollTop = lastScrollTopRef.current
      
      // Check if user is actively scrolling (movement > 10px)
      if (Math.abs(currentScrollTop - lastScrollTop) > 10) {
        scrollRestoreBlockedRef.current = true
        
        // Reset scrollRestoreBlockedRef after user stops scrolling
        if (scrollBlockResetTimeout) {
          clearTimeout(scrollBlockResetTimeout)
        }
        scrollBlockResetTimeout = setTimeout(() => {
          scrollRestoreBlockedRef.current = false
        }, 500) // Reset after 500ms of no scrolling
      }
      
      lastScrollTopRef.current = currentScrollTop
      
      // Update UI state - always update regardless of programmatic scroll
      const shouldShow = scrollY > threshold
      setIsScrolledDown(shouldShow)
      
      // Save scroll position (debounced, always save regardless of infinite scrolling setting)
      if (scrollSaveTimeoutRef.current) {
        clearTimeout(scrollSaveTimeoutRef.current)
      }
      
      scrollSaveTimeoutRef.current = setTimeout(() => {
        // Don't save during programmatic scrolls or restoration phase
        if (isProgrammaticScrollRef.current || scrollSaveBlockedRef.current) {
          return
        }
        
        // Clear saved position when scrolled to top
        if (scrollY < 50) {
          try {
            sessionStorage.removeItem(SCROLL_STATE_KEY)
          } catch (error) {
            console.warn('Failed to clear scroll position:', error)
          }
          return
        }
        
        // Save scroll position (always save, always restore when feed state is restored)
        try {
          sessionStorage.setItem(SCROLL_STATE_KEY, scrollY.toString())
        } catch (error) {
          console.warn('Failed to save scroll position:', error)
        }
      }, 150) // 150ms debounce
    }

    // Initialize isScrolledDown based on current scroll position
    const updateScrollState = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
      const threshold = 200
      const shouldShow = scrollY > threshold
      setIsScrolledDown(shouldShow)
    }
    
    // Initial check
    updateScrollState()
    
    // Also check after a short delay to catch cases where scroll position changes after render
    const initialCheckTimeout = setTimeout(updateScrollState, 100)
    
    // Periodic check to ensure state stays accurate (in case scroll events are missed)
    const periodicCheckInterval = setInterval(updateScrollState, 500)

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      clearTimeout(initialCheckTimeout)
      clearInterval(periodicCheckInterval)
      if (scrollSaveTimeoutRef.current) {
        clearTimeout(scrollSaveTimeoutRef.current)
      }
      if (scrollBlockResetTimeout) {
        clearTimeout(scrollBlockResetTimeout)
      }
    }
  }, [location.pathname, feed.length])


  // Handle loading new posts
  // Standard mode: loads posts from cache (already curated)
  // Paged updates mode: fetches fresh from server, curates one-by-one until PageSize displayed
  const handleLoadNewPosts = useCallback(async () => {
    // Prevent multiple simultaneous calls
    if (isLoadingMore) {
      console.log('[New Posts] Already loading, ignoring click')
      return
    }

    if (!agent || !session) {
      console.warn('[New Posts] Missing agent or session')
      addToast('Unable to load new posts: not authenticated', 'error')
      return
    }

    if (!newestDisplayedPostTimestamp) {
      console.warn('[New Posts] No newestDisplayedPostTimestamp available')
      // Still try to load - maybe timestamp wasn't set but posts exist
    }

    try {
      setIsLoadingMore(true)
      const feedReceivedTime = new Date()
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const maxDisplayedFeedSize = settings?.maxDisplayedFeedSize || DEFAULT_MAX_DISPLAYED_FEED_SIZE
      const timestampToUse = newestDisplayedPostTimestamp || 0

      // Paged updates mode: fetch fresh from server and curate one-by-one
      if (pagedUpdatesEnabled) {
        console.log('[Paged Updates] Loading next page with fresh data...')

        // Get filter fraction and calculate PageRaw
        const [, currentProbs] = await getFilter() || [null, null]
        const currentFilterFrac = currentProbs ? computeFilterFrac(currentProbs) : 0.5
        const pagedSettings = await getPagedUpdatesSettings()
        const pageRaw = calculatePageRaw(pageLength, currentFilterFrac, pagedSettings.varFactor)

        console.log(`[Paged Updates] Fetching ${pageRaw} posts (filterFrac=${currentFilterFrac.toFixed(2)})`)

        // Fetch fresh posts from server (capture cursor for potential limited lookback)
        const { feed: serverFeed, cursor: fetchCursor } = await getHomeFeed(agent, { limit: pageRaw })

        if (serverFeed.length === 0) {
          setNewPostsCount(0)
          setShowNewPostsButton(false)
          setNextPageReady(false)
          addToast('No new posts available', 'info')
          return
        }

        // Sort posts by timestamp (oldest first) for chronological processing
        const sortedPosts = [...serverFeed].sort((a, b) => {
          const timeA = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          const timeB = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
          return timeA - timeB // Oldest first
        })

        // Process posts ONE AT A TIME until PageSize displayed posts
        const postsToDisplay: CurationFeedViewPost[] = []
        const allCuratedPosts: CurationFeedViewPost[] = []
        let newestCuratedTimestamp = timestampToUse
        let displayedCount = 0

        // For paged updates (like initial fetch), use current time as initialLastPostTime
        let lastPostTime = new Date()

        console.log(`[Paged Updates] Processing ${sortedPosts.length} posts one-by-one...`)

        for (const post of sortedPosts) {
          // Skip posts not newer than currently displayed
          // Use createFeedCacheEntries to get proper timestamp
          const { entries: [entry], finalLastPostTime } = createFeedCacheEntries([post], lastPostTime)
          lastPostTime = finalLastPostTime  // Chain for next post
          const postTimestamp = entry.postTimestamp

          if (postTimestamp <= timestampToUse) {
            continue
          }

          // Stop if we've reached PageSize displayed posts
          if (displayedCount >= pageLength) {
            console.log(`[Paged Updates] Reached PageSize (${pageLength}), discarding remaining posts`)
            break
          }

          // Save to feed cache and curate (ensures both happen together for cache integrity)
          const { curatedFeed: curatedPosts } = await savePostsWithCuration([entry], undefined, agent, session.handle, session.did)
          const curatedPost = curatedPosts[0] as CurationFeedViewPost

          allCuratedPosts.push(curatedPost)

          // Track newest curated timestamp
          if (postTimestamp > newestCuratedTimestamp) {
            newestCuratedTimestamp = postTimestamp
          }

          // Check if post is displayed (not dropped)
          const isDisplayed = !curatedPost.curation?.curation_dropped
          if (isDisplayed) {
            postsToDisplay.push(curatedPost)
            displayedCount++
          }
        }

        console.log(`[Paged Updates] Curated ${allCuratedPosts.length} posts, ${postsToDisplay.length} to display`)

        if (postsToDisplay.length === 0) {
          setNewPostsCount(0)
          setShowNewPostsButton(false)
          setNextPageReady(false)
          addToast('No new posts to display (filtered by settings)', 'info')
          return
        }

        // Sort displayed posts newest first for feed display
        postsToDisplay.sort((a, b) => {
          const timeA = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          const timeB = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
          return timeB - timeA
        })

        // If there's a gap, do full reload instead of prepending
        // Save gap state before it's reset later
        const hadProbeGap = hasProbeGap
        let oldestDisplayedTimestamp: number | null = null

        if (hasProbeGap) {
          console.log(`[Paged Updates] Gap detected, doing full reload instead of prepend`)
          setFeed(postsToDisplay)
          setNewestDisplayedPostTimestamp(newestCuratedTimestamp)
          oldestDisplayedTimestamp = getFeedViewPostTimestamp(postsToDisplay[postsToDisplay.length - 1], feedReceivedTime).getTime()
          setOldestDisplayedPostTimestamp(oldestDisplayedTimestamp)

          // Clear stale previousPageFeed immediately - prefetch will repopulate after gap is filled
          setPreviousPageFeed([])
        } else {
          // Prepend new posts to feed
          const existingUris = new Set(feed.map(p => getPostUniqueId(p)))
          const newPostsToAdd = postsToDisplay.filter(p => !existingUris.has(getPostUniqueId(p)))

          let combinedFeed = [...newPostsToAdd, ...feed]
          // Trim feed if over maxDisplayedFeedSize (saves adjacent page as previousPageFeed)
          combinedFeed = trimFeedIfNeeded(combinedFeed, pageLength, feedReceivedTime, maxDisplayedFeedSize)

          setFeed(combinedFeed)
          setNewestDisplayedPostTimestamp(newestCuratedTimestamp)
        }

        setNewPostsCount(0)
        setShowNewPostsButton(false)
        setNextPageReady(false)
        setFirstProbeTimestamp(null) // Reset probe timer for next page
        setPartialPageCount(0)
        setMultiPageCount(0) // Reset multi-page count
        setHasProbeGap(false) // Reset gap flag
        lastDisplayTimeRef.current = Date.now() // Start cooldown

        // Debug: compare probe expected count vs actual display count
        console.log(`[Paged Updates] COUNT COMPARISON: Probe expected ${probeExpectedCountRef.current} posts, actually displayed ${postsToDisplay.length} posts (diff: ${probeExpectedCountRef.current - postsToDisplay.length})`)
        console.log(`[Paged Updates] Successfully loaded ${postsToDisplay.length} new posts (gap=${hasProbeGap})`)

        // Perform limited lookback to fill gaps back to local midnight for consistent counter numbering
        if (allCuratedPosts.length > 0 && fetchCursor) {
          const oldestCuratedTimestamp = Math.min(
            ...allCuratedPosts.map(p => getFeedViewPostTimestamp(p, feedReceivedTime).getTime())
          )
          const localMidnight = getLocalMidnight().getTime()
          if (oldestCuratedTimestamp > localMidnight) {
            console.log(`[Paged Updates] Starting limited lookback from ${new Date(oldestCuratedTimestamp).toLocaleTimeString()} to midnight`)
            await limitedLookbackToMidnight(oldestCuratedTimestamp, fetchCursor, agent, session.handle, session.did, pageLength)
          }
        }

        // After gap is filled, prefetch next page for Load More
        if (hadProbeGap && oldestDisplayedTimestamp !== null) {
          setTimeout(async () => {
            await prefetchNextPage(oldestDisplayedTimestamp)
          }, 100)
        }
      } else {
        // Standard mode: load from cache
        console.log('[New Posts] Loading new posts from cache...')

        const newPostsLength = pageLength * 2
        const newPosts = await getCachedFeedAfterPosts(timestampToUse, newPostsLength)

        if (newPosts.length === 0) {
          setNewPostsCount(0)
          setShowNewPostsButton(false)
          addToast('No new posts available', 'info')
          return
        }

        const filteredNewPosts = await lookupCurationAndFilter(newPosts, feedReceivedTime)

        if (filteredNewPosts.length === 0) {
          setNewPostsCount(0)
          setShowNewPostsButton(false)
          addToast('No new posts to display (filtered by settings)', 'info')
          return
        }

        const existingUris = new Set(feed.map(p => getPostUniqueId(p)))
        const newPostsToAdd = filteredNewPosts.filter(p => !existingUris.has(getPostUniqueId(p)))

        let combinedFeed = [...newPostsToAdd, ...feed]
        // Trim feed if over maxDisplayedFeedSize (saves adjacent page as previousPageFeed)
        combinedFeed = trimFeedIfNeeded(combinedFeed, pageLength, feedReceivedTime, maxDisplayedFeedSize)

        setFeed(combinedFeed)
        const newestTimestamp = getFeedViewPostTimestamp(filteredNewPosts[0], feedReceivedTime).getTime()
        setNewestDisplayedPostTimestamp(newestTimestamp)
        setNewPostsCount(0)
        setShowNewPostsButton(false)

        console.log(`[New Posts] Successfully loaded ${newPostsToAdd.length} new posts`)
      }

      // Scroll to top
      isProgrammaticScrollRef.current = true
      window.scrollTo({ top: 0, behavior: 'smooth' })
      setTimeout(() => {
        isProgrammaticScrollRef.current = false
        lastScrollTopRef.current = window.scrollY
      }, 1000)

    } catch (error) {
      console.error('Failed to load new posts:', error)
      addToast('Failed to load new posts', 'error')
    } finally {
      setIsLoadingMore(false)
    }
  }, [agent, session, newestDisplayedPostTimestamp, newPostsCount, lookupCurationAndFilter, isLoadingMore, feed, pagedUpdatesEnabled])

  // Handle "All n new posts" button click
  // Two flows: partial page (incremental) and multi-page (full re-display)
  const handleLoadAllNewPosts = useCallback(async () => {
    if (isLoadingMore || !agent || !session) {
      console.log('[All New Posts] Cannot load: isLoadingMore or missing agent/session')
      return
    }

    // Treat as multi-page if 2+ pages detected OR if there's a gap (probe couldn't count all posts)
    const isMultiPage = multiPageCount >= 50 || hasProbeGap

    if (isMultiPage) {
      // MULTI-PAGE FLOW: Full re-display
      console.log(`[All New Posts] Multi-page flow: ${multiPageCount} posts, hasGap=${hasProbeGap}`)

      setIsLoadingMore(true)
      setGapFillInProgress(true)

      try {
        const feedReceivedTime = new Date()
        const settings = await getSettings()
        const pageLength = settings?.feedPageLength || 25

        // Get filter fraction and calculate PageRaw for first page
        const [, currentProbs] = await getFilter() || [null, null]
        const currentFilterFrac = currentProbs ? computeFilterFrac(currentProbs) : 0.5
        const pagedSettings = await getPagedUpdatesSettings()
        const pageRaw = calculatePageRaw(pageLength * 2, currentFilterFrac, pagedSettings.varFactor)

        // Fetch fresh posts from server
        const { feed: serverFeed, cursor: fetchCursor } = await getHomeFeed(agent, { limit: pageRaw })

        if (serverFeed.length === 0) {
          addToast('No new posts available', 'info')
          return
        }

        // Sort posts by timestamp (NEWEST first - we want the newest page)
        const sortedPosts = [...serverFeed].sort((a, b) => {
          const timeA = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          const timeB = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
          return timeB - timeA  // newest first
        })

        // Process posts ONE AT A TIME until PageSize displayed posts
        const postsToDisplay: CurationFeedViewPost[] = []
        let newestCuratedTimestamp = 0
        let oldestCuratedTimestamp = Number.MAX_SAFE_INTEGER
        let displayedCount = 0
        let lastPostTime = new Date()

        for (const post of sortedPosts) {
          if (displayedCount >= pageLength) break

          const { entries: [entry], finalLastPostTime } = createFeedCacheEntries([post], lastPostTime)
          lastPostTime = finalLastPostTime
          const postTimestamp = entry.postTimestamp

          // Save to feed cache and curate
          const { curatedFeed: curatedPosts } = await savePostsWithCuration([entry], undefined, agent, session.handle, session.did)
          const curatedPost = curatedPosts[0] as CurationFeedViewPost

          // Track timestamps
          if (postTimestamp > newestCuratedTimestamp) newestCuratedTimestamp = postTimestamp
          if (postTimestamp < oldestCuratedTimestamp) oldestCuratedTimestamp = postTimestamp

          // Add to display if not dropped
          if (!curatedPost.curation?.curation_dropped) {
            postsToDisplay.push(curatedPost)
            displayedCount++
          }
        }

        if (postsToDisplay.length === 0) {
          addToast('No new posts to display (filtered by settings)', 'info')
          return
        }

        // Sort displayed posts newest first
        postsToDisplay.sort((a, b) => {
          const timeA = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          const timeB = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
          return timeB - timeA
        })

        // Replace feed with new posts (full re-display)
        setFeed(postsToDisplay)
        setPreviousPageFeed([])  // Clear - feed was completely replaced
        setNewestDisplayedPostTimestamp(newestCuratedTimestamp)
        setOldestDisplayedPostTimestamp(getFeedViewPostTimestamp(postsToDisplay[postsToDisplay.length - 1], feedReceivedTime).getTime())

        // Reset all button states and set cooldown
        setNewPostsCount(0)
        setShowNewPostsButton(false)
        setNextPageReady(false)
        setFirstProbeTimestamp(null)
        setPartialPageCount(0)
        setIdleTimerTriggered(false)
        setMultiPageCount(0)
        setHasProbeGap(false)
        lastDisplayTimeRef.current = Date.now() // Start cooldown

        // Debug: compare probe expected count vs actual display count
        console.log(`[All New Posts] COUNT COMPARISON: Probe expected ${probeExpectedCountRef.current} posts, actually displayed ${postsToDisplay.length} posts (diff: ${probeExpectedCountRef.current - postsToDisplay.length})`)
        console.log(`[All New Posts] Displayed ${postsToDisplay.length} posts, starting background gap fill...`)

        // Scroll to top
        isProgrammaticScrollRef.current = true
        window.scrollTo({ top: 0, behavior: 'smooth' })
        setTimeout(() => {
          isProgrammaticScrollRef.current = false
          lastScrollTopRef.current = window.scrollY
        }, 1000)

        // Start background gap fill
        if (fetchCursor && oldestCuratedTimestamp < Number.MAX_SAFE_INTEGER) {
          const localMidnight = getLocalMidnight().getTime()
          if (oldestCuratedTimestamp > localMidnight) {
            console.log(`[All New Posts] Gap fill: from ${new Date(oldestCuratedTimestamp).toLocaleTimeString()} to midnight`)
            try {
              await limitedLookbackToMidnight(oldestCuratedTimestamp, fetchCursor, agent, session.handle, session.did, pageLength)
              console.log('[All New Posts] Gap fill complete')
            } catch (gapError) {
              console.warn('[All New Posts] Gap fill error:', gapError)
            }
          }
        }
      } catch (error) {
        console.error('[All New Posts] Multi-page load failed:', error)
        addToast('Failed to load new posts', 'error')
      } finally {
        setIsLoadingMore(false)
        setGapFillInProgress(false)
      }
    } else {
      // PARTIAL PAGE FLOW: Use existing handleLoadNewPosts logic
      console.log(`[All New Posts] Partial page flow: ${partialPageCount} posts`)
      await handleLoadNewPosts()
      setIdleTimerTriggered(false)
    }
  }, [agent, session, isLoadingMore, multiPageCount, hasProbeGap, partialPageCount, handleLoadNewPosts])

  // Scroll to top handler
  const handleScrollToTop = useCallback(() => {
    isProgrammaticScrollRef.current = true
    
    if (firstPostRef.current) {
      firstPostRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    
    // Reset flag after scroll completes
    setTimeout(() => {
      isProgrammaticScrollRef.current = false
      lastScrollTopRef.current = window.scrollY
    }, 1000)
  }, [])

  const handleLoadMore = useCallback(async () => {
    // Guard: button shouldn't be visible if empty, but check anyway
    if (previousPageFeed.length === 0) return

    // Check if already loading or prefetching
    if (isPrefetching) return

    // Debounce: Skip if called within 300ms of last call
    const now = Date.now()
    if (now - loadMoreLastCallRef.current < 300) {
      console.log('[Load More] Debounced - called too quickly')
      return
    }
    loadMoreLastCallRef.current = now

    // Check if background lookback is in progress
    if (lookingBack) {
      addToast('Still syncing older posts... Please wait.', 'info')
      return
    }

    console.log(`[Load More] INSTANT: Displaying ${previousPageFeed.length} pre-fetched posts`)

    // 1. INSTANT: Display previousPageFeed (from memory, no IndexedDB access)
    const feedReceivedTime = new Date()
    const oldestInPrevious = getFeedViewPostTimestamp(
      previousPageFeed[previousPageFeed.length - 1],
      feedReceivedTime
    ).getTime()

    // Append pre-fetched posts to feed
    setFeed(prevFeed => {
      const existingUris = new Set(prevFeed.map(p => getPostUniqueId(p)))
      const newPosts = previousPageFeed.filter(p => !existingUris.has(getPostUniqueId(p)))
      console.log(`[Load More] Appending ${newPosts.length} pre-fetched posts`)
      return [...prevFeed, ...newPosts]
    })

    // Update pagination boundary
    setOldestDisplayedPostTimestamp(oldestInPrevious)

    // 2. Clear previousPageFeed and show loading spinner
    setPreviousPageFeed([])
    setIsPrefetching(true)

    // 3. Pre-fetch next page (awaited so we can update UI after)
    await prefetchNextPage(oldestInPrevious)
    setIsPrefetching(false)
  }, [previousPageFeed, isPrefetching, lookingBack, prefetchNextPage])

  // Set up IntersectionObserver for infinite scrolling
  useEffect(() => {
    // Only set up if infinite scrolling is enabled
    if (!infiniteScrollingEnabled) {
      // Clean up existing observer if disabling
      if (intersectionObserverRef.current) {
        intersectionObserverRef.current.disconnect()
        intersectionObserverRef.current = null
      }
      return
    }

    // Check if conditions are met - use previousPageFeed instead of hasMorePosts
    const canLoadMore = previousPageFeed.length > 0
    if (!scrollSentinelRef.current || !canLoadMore || isPrefetching) {
      return
    }

    // Clean up previous observer if exists
    if (intersectionObserverRef.current) {
      intersectionObserverRef.current.disconnect()
      intersectionObserverRef.current = null
    }

    // Create new IntersectionObserver
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && previousPageFeed.length > 0 && !isPrefetching) {
          // Call handleLoadMore when sentinel is visible
          handleLoadMore()
        }
      },
      {
        rootMargin: '200px', // Start loading 200px before bottom
      }
    )

    // Observe the sentinel element
    if (scrollSentinelRef.current) {
      observer.observe(scrollSentinelRef.current)
      intersectionObserverRef.current = observer
    }

    // Cleanup
    return () => {
      if (intersectionObserverRef.current) {
        intersectionObserverRef.current.disconnect()
        intersectionObserverRef.current = null
      }
    }
  }, [infiniteScrollingEnabled, previousPageFeed, isPrefetching, handleLoadMore])

  const handleLike = async (uri: string, cid: string) => {
    if (!agent) return

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalLikeUri = post.post.viewer?.like
    const isLiked = !!originalLikeUri

    // Optimistic update - only update count, not the like URI
    // This prevents issues if user double-clicks quickly
    setFeed(prev => prev.map(p => {
      if (p.post.uri === uri) {
        return {
          ...p,
          post: {
            ...p.post,
            likeCount: (p.post.likeCount || 0) + (isLiked ? -1 : 1),
          },
        }
      }
      return p
    }))

    try {
      if (isLiked && originalLikeUri) {
        await unlikePost(agent, originalLikeUri)
        // Update state to reflect unliked
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, like: undefined },
              },
            }
          }
          return p
        }))
      } else {
        const likeResponse = await likePost(agent, uri, cid)
        // Update state with real like URI so unlike works
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, like: likeResponse.uri },
              },
            }
          }
          return p
        }))
      }
    } catch (error) {
      // Revert optimistic update by reloading
      loadFeed(undefined, false)
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }

  const handleRepost = async (uri: string, cid: string) => {
    if (!agent) return

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalRepostUri = post.post.viewer?.repost
    const isReposted = !!originalRepostUri

    // Optimistic update - only update count, not the repost URI
    // This prevents issues if user double-clicks quickly
    setFeed(prev => prev.map(p => {
      if (p.post.uri === uri) {
        return {
          ...p,
          post: {
            ...p.post,
            repostCount: (p.post.repostCount || 0) + (isReposted ? -1 : 1),
          },
        }
      }
      return p
    }))

    try {
      if (isReposted && originalRepostUri) {
        await removeRepost(agent, originalRepostUri)
        // Update state to reflect unreposted
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, repost: undefined },
              },
            }
          }
          return p
        }))
      } else {
        const repostResponse = await repost(agent, uri, cid)
        // Update state with real repost URI so unrepost works
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, repost: repostResponse.uri },
              },
            }
          }
          return p
        }))
      }
    } catch (error) {
      // Revert optimistic update by reloading
      loadFeed(undefined, false)
      addToast(error instanceof Error ? error.message : 'Failed to update repost', 'error')
    }
  }

  const handleQuotePost = (post: AppBskyFeedDefs.PostView) => {
    setQuotePost(post)
    setReplyToUri(null)
    setShowCompose(true)
  }

  const handleReply = (uri: string) => {
    setReplyToUri(uri)
    setQuotePost(null)
    setShowCompose(true)
  }

  const handlePost = async (
    text: string, 
    replyTo?: { uri: string; cid: string; rootUri?: string; rootCid?: string }, 
    quotePost?: AppBskyFeedDefs.PostView,
    images?: Array<{ image: Blob; alt: string }>
  ) => {
    if (!agent) return

    try {
      if (quotePost) {
        await createQuotePost(agent, {
          text,
          quotedPost: {
            uri: quotePost.uri,
            cid: quotePost.cid,
          },
          embed: images && images.length > 0 ? { images } : undefined,
        })
        addToast('Quote post created!', 'success')
      } else {
        await createPost(agent, {
          text,
          replyTo,
          embed: images && images.length > 0 ? { images } : undefined,
        })
        addToast('Post created!', 'success')
      }
      // Clear cache and reload feed
      await clearFeedCache()
      sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE) // Clear saved state
      loadFeed(undefined, false)
    } catch (error) {
      throw error
    }
  }

  // Filter out immediate same-user replies
  const filteredFeed = useMemo(() => filterSameUserReplies(feed), [feed])

  const handleAmpChange = () => {
    // Clear cache and reload feed when amp factor changes
    clearFeedCache()
    sessionStorage.removeItem(WEBSKY9_HOME_FEED_STATE) // Clear saved state
    loadFeed(undefined, false)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="pb-20 md:pb-0 relative">
      <RateLimitIndicator status={rateLimitStatus} />
      
      {/* Skylimit Summary Header */}
      {skylimitStats && (
        <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center">
          <div className="flex items-center gap-4 text-sm">
            <a
              href="https://github.com/mitotic/skylimit-alpha#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline font-semibold"
              title="About Skylimit"
            >
              About Skylimit
            </a>
            <div className="text-gray-600 dark:text-gray-400">
              <span className="font-semibold">{skylimitStats.status_daily.toFixed(0)}</span> posts/day received
            </div>
            <div className="text-gray-400 dark:text-gray-500">→</div>
            <div className="text-gray-600 dark:text-gray-400">
              <span className="font-semibold">~{skylimitStats.shown_daily.toFixed(0)}</span> displayed
            </div>
          </div>
        </div>
      )}

      <div>
        {filteredFeed.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>No posts to show. Follow some users to see their posts here!</p>
          </div>
        ) : (
          <>
            {/* New Page / All New Posts buttons - paged updates mode uses two-button layout */}
            {pagedUpdatesEnabled ? (
              // Paged updates mode: Two-button layout
              <div className="sticky top-0 z-30 p-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                <div className="flex gap-2">
                  {/* "New Page" button - always visible, grayed out when inactive */}
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      console.log('[New Page] Button clicked', { newPostsCount, isLoadingMore, nextPageReady })
                      handleLoadNewPosts()
                    }}
                    disabled={isLoadingMore || !nextPageReady}
                    className={`flex-1 btn flex items-center justify-center gap-2 ${
                      nextPageReady
                        ? 'btn-primary'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                    } disabled:opacity-50`}
                    aria-label="Load next page of posts"
                  >
                    {isLoadingMore ? (
                      <>
                        <Spinner size="sm" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <span>📄</span>
                        New Page
                      </>
                    )}
                  </button>

                  {/* "All n new posts" button - shown when multi-page, gap with full page, or partial (after idle timer) */}
                  {(multiPageCount >= 50 || (hasProbeGap && multiPageCount > 0) || (idleTimerTriggered && partialPageCount > 0)) && (
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        const allCount = multiPageCount > 0 ? multiPageCount : partialPageCount
                        console.log('[All New Posts] Button clicked', { allCount, multiPageCount, partialPageCount, hasProbeGap, idleTimerTriggered, newPostsCount })
                        handleLoadAllNewPosts()
                      }}
                      disabled={isLoadingMore}
                      className="flex-1 btn btn-secondary flex items-center justify-center gap-2 disabled:opacity-50"
                      aria-label={`Load all ${multiPageCount > 0 ? multiPageCount : partialPageCount}${hasProbeGap ? '+' : ''} new posts`}
                    >
                      {isLoadingMore ? (
                        <>
                          <Spinner size="sm" />
                          Loading...
                        </>
                      ) : (
                        <>
                          <span>📬</span>
                          All {multiPageCount > 0 ? multiPageCount : partialPageCount}{hasProbeGap ? '+' : ''} new posts
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              // Standard mode: Single button (existing behavior)
              showNewPostsButton && newPostsCount > 0 && (
                <div className="sticky top-0 z-30 p-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      console.log('[New Posts] Button clicked', { newPostsCount, isLoadingMore, newestDisplayedPostTimestamp })
                      handleLoadNewPosts()
                    }}
                    disabled={isLoadingMore}
                    className="w-full btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={`Load ${newPostsCount} new post${newPostsCount !== 1 ? 's' : ''}`}
                  >
                    {isLoadingMore ? (
                      <>
                        <Spinner size="sm" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <span>📬</span>
                        {newPostsCount} new post{newPostsCount !== 1 ? 's' : ''}
                      </>
                    )}
                  </button>
                </div>
              )
            )}
            
            {filteredFeed.map((post, index) => (
              <div
                key={getPostUniqueId(post)}
                ref={index === 0 ? firstPostRef : null}
                data-post-uri={post.post.uri}
              >
                <PostCard
                  post={post}
                  onReply={handleReply}
                  onRepost={handleRepost}
                  onQuotePost={handleQuotePost}
                  onLike={handleLike}
                  showCounter={true}
                  onAmpChange={handleAmpChange}
                />
              </div>
            ))}
          </>
        )}

        {/* Infinite scroll sentinel - show when infinite scrolling enabled and more posts available */}
        {infiniteScrollingEnabled && !lookingBack && (previousPageFeed.length > 0 || isPrefetching) && (
          <div ref={scrollSentinelRef} className="py-4">
            {isPrefetching && (
              <div className="flex items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
                <Spinner size="sm" />
                <span>Loading more posts...</span>
              </div>
            )}
          </div>
        )}

        {/* Lookback progress indicator - show during background sync */}
        {lookingBack && (
          <div className="p-4 text-center text-gray-500 dark:text-gray-400">
            <div className="flex items-center justify-center gap-2">
              <Spinner size="sm" />
              <span>Syncing older posts... {lookbackProgress !== null ? `${lookbackProgress}%` : ''}</span>
            </div>
          </div>
        )}

        {/* Bottom of feed UI - spinner/button/no-more-posts */}
        {!infiniteScrollingEnabled && !lookingBack && (
          <div className="p-4 text-center">
            {isPrefetching ? (
              // State 1: After clicking Load More, prefetching next page - show spinner
              <div className="flex items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
                <Spinner size="sm" />
                <span>Loading...</span>
              </div>
            ) : previousPageFeed.length > 0 ? (
              // State 2: More posts available - show Load More button
              <button
                onClick={handleLoadMore}
                disabled={gapFillInProgress}
                className="btn btn-secondary"
              >
                {gapFillInProgress ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="sm" />
                    Filling gap...
                  </span>
                ) : (
                  'Load More'
                )}
              </button>
            ) : !isLoading && feed.length > 0 ? (
              // State 3: No more posts (only show after initial load completes)
              <span className="text-gray-500 dark:text-gray-400">No more posts</span>
            ) : null}
          </div>
        )}
      </div>

      {/* Scroll to top arrow - shown when scrolled down */}
      {/* Show arrow whenever scrolled down, but hide it if new posts button is showing (to avoid overlap) */}
      {isScrolledDown && (
        <button
          onClick={handleScrollToTop}
          className="fixed bottom-6 left-6 md:bottom-8 md:left-8 bg-gray-500 hover:bg-gray-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-12 h-12"
          aria-label="Scroll to top"
        >
          <span className="text-xl">↑</span>
        </button>
      )}

      {/* Floating compose button in bottom right */}
      <button
        onClick={() => setShowCompose(true)}
        className="fixed bottom-6 right-6 md:bottom-8 md:right-8 bg-blue-500 hover:bg-blue-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-14 h-14"
        aria-label="Compose new post"
      >
        <span className="text-2xl">✏️</span>
      </button>

      <Compose
        isOpen={showCompose}
        onClose={() => {
          setShowCompose(false)
          setReplyToUri(null)
          setQuotePost(null)
        }}
        replyTo={replyToUri ? filteredFeed.find(p => p.post.uri === replyToUri)?.post ? {
          uri: replyToUri,
          cid: filteredFeed.find(p => p.post.uri === replyToUri)!.post.cid,
        } : undefined : undefined}
        quotePost={quotePost || undefined}
        onPost={handlePost}
      />

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
      
      <SkylimitHomeDialog
        isOpen={showSkylimitDialog}
        onClose={() => setShowSkylimitDialog(false)}
      />

      <CurationInitModal
        isOpen={showCurationInitModal}
        onClose={() => setShowCurationInitModal(false)}
        stats={curationInitStats}
      />
    </div>
  )
}

