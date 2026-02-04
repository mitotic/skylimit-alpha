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
import CurationInitModal, { CurationInitStatsDisplay } from '../components/CurationInitModal'
import { insertEditionPosts } from '../curation/skylimitTimeline'
import { initDB, getFilter, getPostSummary, isPostSummariesCacheEmpty, getCurationInitStats, getPostSummariesInRange, getNewestSummaryTimestamp, checkPostSummaryExists, isSummariesCacheFresh } from '../curation/skylimitCache'
import { getSettings } from '../curation/skylimitStore'
import { computeFilterFrac } from '../curation/skylimitStats'
import { probeForNewPosts, calculatePageRaw, getPagedUpdatesSettings } from '../curation/pagedUpdates'
import { flushExpiredParentPosts } from '../curation/parentPostCache'
import { scheduleStatsComputation, computeStatsInBackground } from '../curation/skylimitStatsWorker'
import { recomputeCurationDecisions } from '../curation/skylimitRecurate'
import { GlobalStats, CurationFeedViewPost, getIntervalHoursSync, isStatusShow } from '../curation/types'
import { getCachedFeed, clearFeedCache, clearFeedMetadata, getLastFetchMetadata, getCachedFeedBefore, updateFeedCacheOldestPostTimestamp, getCachedFeedAfterPosts, shouldUseCacheOnLoad, getLookbackBoundary, performLookbackFetch, createFeedCacheEntries, savePostsWithCuration, validateFeedCacheIntegrity, limitedLookbackToMidnight, getLocalMidnight, fetchPageFromTimestamp, isCacheWithinLookback, getNewestCachedPostTimestamp, performLookbackFetchToSecondary, getFreshPrevPageCursor, clearPrevPageCursor, getPrevPageCursorStatus, markInitialLookbackCompleted } from '../curation/skylimitFeedCache'
import { clearSecondaryFeedCache } from '../curation/skylimitCache'
import { getPostUniqueId, getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { assignIncrementalNumbers, getMaxNumbersForDay } from '../curation/skylimitNumbering'

// Tab type for home page
type HomeTab = 'curated' | 'editions'

// Storage key for active tab
const HOME_TAB_STATE_KEY = 'websky_home_active_tab'

// Helper functions for per-tab storage keys
const getFeedStateKey = (tab: HomeTab) =>
  tab === 'curated' ? 'websky_home_feed_state' : 'websky_home_editions_feed_state'
const getScrollStateKey = (tab: HomeTab) =>
  tab === 'curated' ? 'websky_home_scroll_state' : 'websky_home_editions_scroll_state'

// Default maximum number of posts to keep in displayed feed (approximately 12 pages)
// Can be overridden via settings.maxDisplayedFeedSize
const DEFAULT_MAX_DISPLAYED_FEED_SIZE = 300

// Saved feed state interface
interface SavedFeedState {
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
  return feed.filter((item) => {
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
  const [previousPageFeed, setPreviousPageFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])  // Pre-fetched next page for instant Prev Page
  const [isPrefetching, setIsPrefetching] = useState(false)  // True while fetching next page after Prev Page
  const [initialPrefetchDone, setInitialPrefetchDone] = useState(false)  // True after first prefetch completes (to distinguish "Initializing..." from "No more posts")
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
  const [skylimitStats, setSkylimitStats] = useState<GlobalStats | null>(null)
  const [newPostsCount, setNewPostsCount] = useState(0)
  const [showNewPostsButton, setShowNewPostsButton] = useState(false)
  const [isScrolledDown, setIsScrolledDown] = useState(false)
  const [newestDisplayedPostTimestamp, setNewestDisplayedPostTimestamp] = useState<number | null>(null)
  const [oldestDisplayedPostTimestamp, setOldestDisplayedPostTimestamp] = useState<number | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [infiniteScrollingEnabled, setInfiniteScrollingEnabled] = useState(false)
  // Paged fresh updates state
  const [nextPageReady, setNextPageReady] = useState(false) // true when full page of posts available
  const [partialPageCount, setPartialPageCount] = useState(0) // count when showing partial page (for "All new posts" button)
  // Multi-page tracking state (kept for logging purposes)
  const [multiPageCount, setMultiPageCount] = useState(0) // total filtered posts when 2+ pages available
  const [idleTimerTriggered, setIdleTimerTriggered] = useState(false) // true when idle time elapsed for partial page
  // Secondary cache sync state (for paged updates lookback)
  const [syncInProgress, setSyncInProgress] = useState(false) // true when secondary cache is being merged
  const [syncProgress, setSyncProgress] = useState(0) // 0-100 sync progress percentage
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
  const previousPageFeedRef = useRef<CurationFeedViewPost[]>([])  // Ref for observer callback (avoids stale closure)
  const isPrefetchingRef = useRef(false)  // Ref for observer callback (avoids stale closure)

  // Scroll state refs (for UI state and restoration)
  const isProgrammaticScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const previousPathnameRef = useRef<string>(location.pathname)
  const scrollRestoredRef = useRef(false)  // Tracks if scroll has been restored
  const scrollRestoreBlockedRef = useRef(false)  // Blocks restoration if user is actively scrolling
  const scrollSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)  // For debouncing scroll saves
  const scrollSaveBlockedRef = useRef(false)  // Blocks scroll saves during restoration phase
  
  // Tab state - initialize from sessionStorage
  const getInitialTab = (): HomeTab => {
    const savedTab = sessionStorage.getItem(HOME_TAB_STATE_KEY)
    if (savedTab === 'editions') return 'editions'
    return 'curated'
  }
  const [activeTab, setActiveTab] = useState<HomeTab>(getInitialTab)

  // Save active tab to sessionStorage when it changes
  useEffect(() => {
    sessionStorage.setItem(HOME_TAB_STATE_KEY, activeTab)
  }, [activeTab])

  // Save feed state when navigating away from home page
  useEffect(() => {
    const wasOnHome = previousPathnameRef.current === '/'
    const isOnHome = location.pathname === '/'

    // If we were on home page and are now navigating away, save feed state
    if (wasOnHome && !isOnHome) {
      // Reset scroll restoration flag for next visit
      scrollRestoredRef.current = false

      // Save scroll position for current tab
      const currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
      sessionStorage.setItem(getScrollStateKey(activeTab), currentScrollY.toString())

      // Only save feed state for curated tab (editions is placeholder)
      if (activeTab === 'curated') {
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
          sessionStorage.setItem(getFeedStateKey(activeTab), JSON.stringify(feedState))
        } catch (error) {
          console.warn('Failed to save feed state:', error)
        }
      }
    }

    previousPathnameRef.current = location.pathname
  }, [location.pathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, newPostsCount, showNewPostsButton, session, activeTab])

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

  // Sync refs for IntersectionObserver callback (avoids stale closures)
  useEffect(() => {
    previousPageFeedRef.current = previousPageFeed
  }, [previousPageFeed])

  useEffect(() => {
    isPrefetchingRef.current = isPrefetching
  }, [isPrefetching])

  // Load paged updates settings

  // Initialize IndexedDB and schedule stats computation
  // Note: Reset flag (?reset=1) is handled in main.tsx BEFORE React mounts
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
        sessionStorage.removeItem(getFeedStateKey('curated'))
        console.log('[Init] Cleared sessionStorage saved feed state')
      }

      // Clear any incomplete secondary cache from interrupted lookback
      try {
        await clearSecondaryFeedCache()
        console.log('[Init] Cleared any incomplete secondary cache')
      } catch (err) {
        console.warn('[Init] Failed to clear secondary cache:', err)
      }

      // Check if summaries cache is empty (initial curation needed)
      const summariesEmpty = await isPostSummariesCacheEmpty()
      if (summariesEmpty) {
        console.log('[Init] Summaries cache is empty - initial curation will be performed')
        isInitialCurationRef.current = true
      }

      console.log('[Failsafe] Setting dbInitialized=true')
      setDbInitialized(true)

      // Note: Stuck load timer is started by a separate useEffect that monitors isLoading and feed state

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

  // Save feed state whenever it changes (debounced) - only for curated tab
  useEffect(() => {
    if (location.pathname !== '/') return
    if (activeTab !== 'curated') return // Only save for curated tab

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
        sessionStorage.setItem(getFeedStateKey(activeTab), JSON.stringify(feedState))
      } catch (error) {
        console.warn('Failed to save feed state:', error)
      }
    }, 1000) // 1 second debounce

    return () => clearTimeout(timeoutId)
  }, [location.pathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, isLoading, newPostsCount, showNewPostsButton, session, activeTab])

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
        const summary = await getPostSummary(uniqueId)
        
        // Reconstruct full curation object from summary
        // Always create curation object (even if empty) so counter is clickable
        const curation: any = {}
        if (summary?.curation_status) {
          curation.curation_status = summary.curation_status
        }
        if (summary?.curation_msg) {
          curation.curation_msg = summary.curation_msg
        }
        // Add number fields from summary to avoid IndexedDB lookups in PostCard
        if (summary?.postNumber !== undefined) {
          curation.postNumber = summary.postNumber
        }
        if (summary?.curationNumber !== undefined) {
          curation.curationNumber = summary.curationNumber
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
      return isStatusShow(post.curation?.curation_status)
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

  // Helper function to pre-fetch the next page for instant Prev Page
  // This populates previousPageFeed for the NEXT Prev Page click
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
        await clearPrevPageCursor()
        // Don't continue prefetching - let loadFeed handle the fresh load
        setPreviousPageFeed([])
        return
      }

      // Step 1: Try to fetch from cache first (no midnight boundary)
      let { posts: postsForNextPage, postTimestamps: timestampsForNextPage } =
        await getCachedFeedBefore(afterTimestamp, pageLength)

      // Step 2: If cache doesn't have enough posts, fetch from server
      if (postsForNextPage.length < pageLength) {
        console.log('[Prefetch] Cache exhausted or partial, checking for cursor')

        // Get the oldest timestamp from current posts (if any) to continue from
        const oldestCurrentTimestamp = postsForNextPage.length > 0
          ? Math.min(...postsForNextPage.map(p => {
              const uniqueId = getPostUniqueId(p)
              return timestampsForNextPage.get(uniqueId) ?? timestampsForNextPage.get(p.post.uri) ?? Infinity
            }))
          : afterTimestamp

        // Check for fresh Prev Page cursor first
        const prevPageCursor = await getFreshPrevPageCursor()
        const cursorStatus = await getPrevPageCursorStatus()

        let cursorToUse: string | undefined

        if (prevPageCursor) {
          console.log(`[Prefetch] Using fresh Prev Page cursor (${cursorStatus.message})`)
          cursorToUse = prevPageCursor.cursor
        } else if (serverCursor) {
          console.log(`[Prefetch] No fresh Prev Page cursor, using serverCursor`)
          cursorToUse = serverCursor
        } else {
          console.log(`[Prefetch] ${cursorStatus.message} - must skip from newest`)
        }

        const serverResult = await fetchPageFromTimestamp(
          oldestCurrentTimestamp,
          agent,
          session.handle,
          session.did,
          pageLength - postsForNextPage.length,
          cursorToUse
        )

        // Handle cursor failure
        if (cursorToUse && serverResult.posts.length === 0 && !serverResult.hasMore) {
          console.warn('[Prefetch] Cursor fetch failed - cursor may be invalid')
          await clearPrevPageCursor()
          addToast('Could not load older posts. Cursor expired.', 'error')
          setPreviousPageFeed([])
          return
        }

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
          // Keep OLDER day's posts (lastDate) since we're navigating backwards in time
          filtered = filtered.filter(p => getLocalDateString(p) === lastDate)
          console.log(`[Prefetch] Midnight filter: kept ${filtered.length}/${originalCount} posts from ${lastDate} (older day)`)
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

      // Check both feed cache and summaries cache freshness
      const feedCacheIsFresh = await shouldUseCacheOnLoad(lookbackDays)
      const summariesCacheIsFresh = await isSummariesCacheFresh()
      console.log(`[Feed] Cache status: feedCache=${feedCacheIsFresh ? 'fresh' : 'stale'}, summariesCache=${summariesCacheIsFresh ? 'fresh' : 'stale'}`)

      // Idle threshold check (uses feedRedisplayIdleInterval)
      const idleThreshold = settings?.feedRedisplayIdleInterval ?? 5 * 60 * 1000  // Default 5 min
      const metadata = await getLastFetchMetadata()
      const timeSinceLastFetch = metadata?.lastFetchTime ? Date.now() - metadata.lastFetchTime : Infinity
      const idleTimeExceeded = timeSinceLastFetch > idleThreshold

      // Determine load mode based on decision matrix:
      // - Summaries stale → Initial load (regardless of feed cache)
      // - Summaries fresh + feed stale → Clear feed cache → Idle return load
      // - Summaries fresh + feed fresh + idle exceeded → Idle return load
      // - Both fresh + within idle interval → Use cache
      let isIdleReturnMode = false
      let isInitialLoadMode = false

      if (!summariesCacheIsFresh) {
        // Summaries stale → must do initial load (compute stats first)
        isInitialLoadMode = true
        console.log('[Feed] Mode: INITIAL LOAD - summaries cache stale (< 24h span), clearing feed cache')
        await clearFeedCache()
        await clearFeedMetadata()
      } else if (!feedCacheIsFresh) {
        // Summaries fresh, feed stale → clear feed, do idle return load
        isIdleReturnMode = true
        console.log('[Feed] Mode: IDLE RETURN - feed cache stale but summaries fresh, clearing feed cache')
        await clearFeedCache()
        await clearFeedMetadata()
      } else if (idleTimeExceeded) {
        // Both fresh, but idle time exceeded → idle return load (don't clear cache)
        isIdleReturnMode = true
        console.log(`[Feed] Mode: IDLE RETURN - idle time exceeded (${Math.round(timeSinceLastFetch / 60000)} min > ${Math.round(idleThreshold / 60000)} min threshold), preserving cache`)
      } else {
        // Both caches fresh and within idle interval → use cache
        console.log(`[Feed] Mode: USE CACHE - both caches fresh, idle time ${Math.round(timeSinceLastFetch / 60000)} min within ${Math.round(idleThreshold / 60000)} min threshold`)
      }

      // ALWAYS try cache first (for initial load without cursor)
      // EXCEPTION: Skip cache-only path for idle return mode or initial load mode
      if (!cursor && useCache && !isIdleReturnMode && !isInitialLoadMode) {
        const cachedPosts = await getCachedFeed(initialCacheLength)
        if (cachedPosts.length > 0) {
          // Get last cursor from metadata so "Prev Page" button appears
          const cachedMetadata = await getLastFetchMetadata()
          const lastCursor = cachedMetadata?.lastCursor

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

            // Pre-fetch next page for instant Prev Page (NO SPINNER)
            // Use local variable since state updates are async
            setTimeout(async () => {
              await prefetchNextPage(oldestDisplayedTimestamp)
              setInitialPrefetchDone(true)
            }, 100)

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
      const fetchSettings = await getSettings()
      const fetchIntervalHours = getIntervalHoursSync(fetchSettings)
      const { entries } = createFeedCacheEntries(newFeed, initialLastPostTime, fetchIntervalHours)

      // For idle return mode, filter out entries that already have cached summaries
      // This avoids redundant curation work for posts we've already processed
      let entriesToSave = entries
      let allEntriesHadSummaries = false
      let firstCachedSummaryIndex = -1

      if (isIdleReturnMode && !cursor) {
        // Check each entry for existing summary (posts are newest-first, so check in order)
        for (let i = 0; i < entries.length; i++) {
          const summaryExists = await checkPostSummaryExists(entries[i].uniqueId)
          if (summaryExists) {
            firstCachedSummaryIndex = i
            break
          }
        }

        if (firstCachedSummaryIndex === 0) {
          // All entries already have summaries - gap is already filled
          entriesToSave = []
          allEntriesHadSummaries = true
          console.log(`[Idle Return] All ${entries.length} posts already have cached summaries - gap already filled`)
        } else if (firstCachedSummaryIndex > 0) {
          // Some entries need saving (newer posts), some already have summaries (older posts in gap)
          entriesToSave = entries.slice(0, firstCachedSummaryIndex)
          console.log(`[Idle Return] ${entriesToSave.length} posts need curation, ${entries.length - firstCachedSummaryIndex} already have summaries`)
        } else {
          // No cached summaries found in this page - need full lookback
          console.log(`[Idle Return] No cached summaries found in first page - full lookback needed`)
        }
      }

      // Save to feed cache and curate (ensures both happen together for cache integrity)
      // For idle return with some cached summaries, only save the new entries
      const { curatedFeed } = entriesToSave.length > 0
        ? await savePostsWithCuration(entriesToSave, newCursor, agent, myUsername, myDid)
        : { curatedFeed: [] }

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

          // Pre-fetch next page for instant Prev Page (when no lookback needed)
          // If lookback will happen, prefetch is done after redisplayFeed
          if (!isIdleReturnMode && !isInitialLoadMode && !cursor) {
            setTimeout(async () => {
              await prefetchNextPage(oldestDisplayedTimestamp)
              setInitialPrefetchDone(true)
            }, 100)
          }

          // Start background lookback if in initial load mode or idle return mode
          // For idle return: skip if all entries had summaries OR if a cached summary was found in the first page
          const skipIdleReturnLookback = isIdleReturnMode && (allEntriesHadSummaries || firstCachedSummaryIndex > 0)
          if ((isInitialLoadMode || isIdleReturnMode) && !cursor && !skipIdleReturnLookback) {
            const lookbackBoundary = getLookbackBoundary(lookbackDays)

            if (isIdleReturnMode) {
              // IDLE RETURN MODE: Curate while fetching, stop on cached summary
              console.log('[Idle Return Lookback] Starting idle return lookback...')

              // Get newest summary timestamp for progress calculation
              const newestSummaryTs = await getNewestSummaryTimestamp()

              setLookingBack(true)
              setLookbackProgress(0)

              performLookbackFetch(
                agent,
                myUsername,
                myDid,
                lookbackBoundary,
                pageLength,
                (progress) => {
                  setLookbackProgress(progress)
                },
                undefined,  // initialLastPostTimeParam
                {
                  isIdleReturn: true,
                  progressTargetTimestamp: newestSummaryTs ?? undefined
                }
              ).then(async (result) => {
                console.log(`[Idle Return Lookback] Completed: ${result.postsCached} posts cached, stoppedOnCachedSummary: ${result.stoppedOnCachedSummary}`)
                setLookingBack(false)
                setLookbackProgress(100)

                // Assign numbers to unnumbered summaries for today
                const todayMidnight = getLocalMidnight(new Date()).getTime()
                const todayEnd = todayMidnight + 24 * 60 * 60 * 1000
                const { maxPostNumber, maxCurationNumber } = await getMaxNumbersForDay(todayMidnight, todayEnd)
                const allSummaries = await getPostSummariesInRange(todayMidnight, todayEnd)
                const unnumbered = allSummaries.filter(s => s.postNumber === null || s.postNumber === undefined)

                if (unnumbered.length > 0) {
                  await assignIncrementalNumbers(unnumbered, maxPostNumber, maxCurationNumber)
                  console.log(`[Idle Return Lookback] Assigned numbers to ${unnumbered.length} posts`)
                }

                // Clear sessionStorage to force fresh load from feed cache with updated numbers
                sessionStorage.removeItem(getFeedStateKey('curated'))

                // Refresh feed display with numbered posts
                console.log('[Idle Return Lookback] Refreshing feed display with numbered posts...')
                await redisplayFeed()

                setInitialPrefetchDone(true)
              }).catch((err) => {
                console.error('[Idle Return Lookback] Failed:', err)
                setLookingBack(false)
                setLookbackProgress(null)
                setInitialPrefetchDone(true)
              })
            } else {
              // INITIAL LOAD MODE: Full lookback with delayed curation, stats computation
              console.log('[Initial Load] Starting full lookback...')
              await clearPrevPageCursor()

              setLookingBack(true)
              setLookbackProgress(0)

              performLookbackFetch(
                agent,
                myUsername,
                myDid,
                lookbackBoundary,
                pageLength,
                (progress) => {
                  setLookbackProgress(progress)
                }
              ).then(async (result) => {
                console.log(`[Lookback] Background lookback ${result.completed ? 'completed' : 'interrupted'}`)
                setLookingBack(false)
                setLookbackProgress(100)

                // If this was initial curation, compute stats and show modal
                if (isInitialCurationRef.current && result.completed) {
                  try {
                    console.log('[Curation Init] Computing filter statistics...')
                    // Compute stats/filter first (this populates the filter cache)
                    await computeStatsInBackground(agent, myUsername, myDid, true)

                    // Recompute curation status for all cached posts (updates summaries with drop decisions)
                    console.log('[Curation Init] Updating curation decisions for cached posts...')
                    await recomputeCurationDecisions(agent, myUsername, myDid)

                    // Mark that initial lookback is complete - subsequent rounds will use normal logic
                    await markInitialLookbackCompleted()
                    console.log('[Curation Init] Initial lookback complete, flag set')

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

                    // Clear sessionStorage to force fresh load from feed cache
                    // This ensures the feed is re-numbered with all lookback posts
                    sessionStorage.removeItem(getFeedStateKey('curated'))

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
                setInitialPrefetchDone(true)  // Mark done so we don't show "Initializing..." forever
              })
            }
          } else if (skipIdleReturnLookback) {
            // Idle return with gap already filled - just assign numbers to any new posts and prefetch
            console.log('[Idle Return] Gap already filled by first page - skipping background lookback')

            // Assign numbers to unnumbered summaries for today (if any new posts were curated)
            if (entriesToSave.length > 0) {
              const todayMidnight = getLocalMidnight(new Date()).getTime()
              const todayEnd = todayMidnight + 24 * 60 * 60 * 1000
              const { maxPostNumber, maxCurationNumber } = await getMaxNumbersForDay(todayMidnight, todayEnd)
              const allSummaries = await getPostSummariesInRange(todayMidnight, todayEnd)
              const unnumbered = allSummaries.filter(s => s.postNumber === null || s.postNumber === undefined)

              if (unnumbered.length > 0) {
                await assignIncrementalNumbers(unnumbered, maxPostNumber, maxCurationNumber)
                console.log(`[Idle Return] Assigned numbers to ${unnumbered.length} posts`)

                // Clear sessionStorage to force fresh load with updated numbers
                sessionStorage.removeItem(getFeedStateKey('curated'))

                // Refresh feed display with numbered posts
                console.log('[Idle Return] Refreshing feed display with numbered posts...')
                await redisplayFeed()
              }
            }

            // Pre-fetch next page for instant Prev Page
            setTimeout(async () => {
              await prefetchNextPage(oldestDisplayedTimestamp)
              setInitialPrefetchDone(true)
            }, 100)
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
      // Get saved feed state (use curated tab key since this function is for curated feed)
      const savedStateJson = sessionStorage.getItem(getFeedStateKey('curated'))
      if (!savedStateJson) {
        console.log('[Redisplay] No saved feed state, falling back to loadFeed')
        return loadFeed()
      }

      const savedState: SavedFeedState = JSON.parse(savedStateJson)

      // Check if saved state is for the same user session
      if (savedState.sessionDid !== session.did) {
        console.log('[Redisplay] Saved state is for different user, falling back to loadFeed')
        // Clear saved state for different user
        sessionStorage.removeItem(getFeedStateKey('curated'))
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
        setInitialPrefetchDone(true)  // Restored from saved state, so prefetch is already done
        console.log(`[Redisplay] Restored previousPageFeed: ${previousWithCuration.length} posts`)
      } else if (oldestTimestamp) {
        // Pre-fetch if not saved (NO SPINNER)
        setTimeout(async () => {
          await prefetchNextPage(oldestTimestamp)
          setInitialPrefetchDone(true)
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
      // 1. Clear sessionStorage feed state (clear both tabs)
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)
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

      // 3. Reset React state
      setFeed([])
      setCursor(undefined)
      setServerCursor(undefined)
      setHasMorePosts(false)
      setPreviousPageFeed([])  // Clear pre-fetched posts to avoid stale data
      setIsLoading(true)
      setIsInitialLoad(true)
      setInitialPrefetchDone(false)  // Reset so "Initializing..." shows during re-init
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
      sessionStorage.removeItem(getFeedStateKey('curated'))
      refilterFeedFromCache()
      return // Don't continue with shouldRedisplay - let refilter handle the feed
    }

    // Reset scroll restoration flag when navigating to home page
    scrollRestoredRef.current = false

    // Clear thread scroll position when navigating to home to prevent interference
    // Thread pages use a different key, but clearing it ensures no conflicts
    try {
      sessionStorage.removeItem('websky_thread_scroll_position')
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
      // Only try to redisplay for curated tab (editions is placeholder)
      if (activeTab !== 'curated') {
        return // Editions tab just shows placeholder, no feed to load
      }

      try {
        // Get saved feed state
        const savedStateJson = sessionStorage.getItem(getFeedStateKey('curated'))
        if (!savedStateJson) {
          console.log('[Navigation] No saved feed state, calling loadFeed')
          return loadFeed()
        }

        const savedState: SavedFeedState = JSON.parse(savedStateJson)

        // Check if saved state is for the same user session
        if (savedState.sessionDid !== session?.did) {
          console.log('[Navigation] Saved state is for different user, calling loadFeed')
          // Clear saved state for different user
          sessionStorage.removeItem(getFeedStateKey('curated'))
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
          sessionStorage.removeItem(getScrollStateKey('curated'))
          return loadFeed()
        }
      } catch (error) {
        console.error('Failed to check feed state:', error)
        // Fall back to loadFeed on error
        return loadFeed()
      }
    }

    shouldRedisplay()
  }, [loadFeed, redisplayFeed, refilterFeedFromCache, location.pathname, session, activeTab])

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

    // Check if feed state was restored (not initial load) - use current tab's key
    const savedStateJson = sessionStorage.getItem(getFeedStateKey(activeTab))
    if (!savedStateJson && activeTab === 'curated') {
      // No saved feed state for curated tab, don't restore scroll - unblock saves and mark as restored
      scrollRestoredRef.current = true
      scrollSaveBlockedRef.current = false
      return
    }

    // Check for saved scroll position - use current tab's key
    const savedScrollY = sessionStorage.getItem(getScrollStateKey(activeTab))
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
  }, [location.pathname, isLoading, feed.length, activeTab])

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

      // Paged updates: probe server without caching
      if (!agent || !session) return

      try {
        // Get current filter fraction and settings
        const [, currentProbs] = await getFilter() || [null, null]
        const currentFilterFrac = currentProbs ? computeFilterFrac(currentProbs) : 0.5

        const pagedSettings = await getPagedUpdatesSettings()
        const pageSize = pagedSettings.pageSize
        const varFactor = pagedSettings.varFactor

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

        const rawNewestTime = probeResult.rawNewestTimestamp > 0 ? new Date(probeResult.rawNewestTimestamp).toLocaleTimeString() : 'N/A'
        const rawOldestTime = probeResult.rawOldestTimestamp < Number.MAX_SAFE_INTEGER ? new Date(probeResult.rawOldestTimestamp).toLocaleTimeString() : 'N/A'
        console.log(`[Paged Updates] Probe result: ${probeResult.filteredPostCount}/${pageSize} displayable posts (${probeResult.totalPostCount} processed, ${probeResult.rawPostCount} raw, rawNewest=${rawNewestTime}, rawOldest=${rawOldestTime})`)

        // Debug: save expected count for comparison when button is clicked
        probeExpectedCountRef.current = probeResult.filteredPostCount

        // Check if we have a full page
        const hasFullPage = probeResult.filteredPostCount >= pageSize
        const hasMultiplePages = probeResult.hasMultiplePages

        // Check cooldown - don't show buttons immediately after displaying posts
        const inCooldown = Date.now() - lastDisplayTimeRef.current < DISPLAY_COOLDOWN_MS
        if (inCooldown) {
          console.log(`[Paged Updates] In cooldown (${Math.round((DISPLAY_COOLDOWN_MS - (Date.now() - lastDisplayTimeRef.current)) / 1000)}s remaining), skipping button updates`)
          return
        }

        // Update multi-page count when multiple pages detected (for logging)
        if (hasMultiplePages) {
          setMultiPageCount(probeResult.filteredPostCount)
          console.log(`[Paged Updates] Multi-page detected: ${probeResult.filteredPostCount} posts (${probeResult.pageCount} pages)`)
        } else {
          setMultiPageCount(0)
        }

        // Simplified button logic:
        // - "New Page" button: active when hasFullPage, grayed otherwise (always visible)
        // - "All new posts" button: controlled by idle timer (see separate useEffect)
        setNextPageReady(hasFullPage)
        setNewPostsCount(probeResult.filteredPostCount)
        setPartialPageCount(probeResult.filteredPostCount) // Always track for idle timer
        setShowNewPostsButton(hasFullPage) // For standard mode compatibility

        if (hasFullPage) {
          console.log(`[Paged Updates] Full page ready: ${probeResult.filteredPostCount} posts`)
        } else {
          console.log(`[Paged Updates] Partial page: ${probeResult.filteredPostCount}/${pageSize} posts (idle timer will handle "All new posts" button)`)
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
  }, [newestDisplayedPostTimestamp, dbInitialized, isInitialLoad, agent, session])

  // Idle timer for partial page display
  // When fullPageWaitMinutes has elapsed since newestDisplayedPostTimestamp and there are partial posts,
  // trigger the "All n new posts" button for partial page display
  useEffect(() => {
    if (!newestDisplayedPostTimestamp || isInitialLoad) {
      setIdleTimerTriggered(false)
      return
    }

    const checkIdleTime = async () => {
      // Get fullPageWaitMinutes from settings
      const pagedSettings = await getPagedUpdatesSettings()
      const fullPageWaitMs = pagedSettings.fullPageWaitMinutes * 60 * 1000

      // Calculate time since top post was displayed
      const timeSinceTopPost = Date.now() - newestDisplayedPostTimestamp

      // Trigger "All new posts" button if idle time exceeded and any posts available
      // This is independent of nextPageReady - shows "All new posts" even when "New Page" is active
      if (timeSinceTopPost >= fullPageWaitMs && partialPageCount > 0) {
        setIdleTimerTriggered(true)
        console.log(`[Idle Timer] Triggered: ${Math.round(timeSinceTopPost / 60000)} min elapsed, ${partialPageCount} posts available`)
      } else {
        setIdleTimerTriggered(false)
      }
    }

    // Check immediately and then every 30 seconds
    checkIdleTime()
    const interval = setInterval(checkIdleTime, 30000)

    return () => clearInterval(interval)
  }, [newestDisplayedPostTimestamp, isInitialLoad, partialPageCount])

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
            sessionStorage.removeItem(getScrollStateKey(activeTab))
          } catch (error) {
            console.warn('Failed to clear scroll position:', error)
          }
          return
        }

        // Save scroll position (always save, always restore when feed state is restored)
        try {
          sessionStorage.setItem(getScrollStateKey(activeTab), scrollY.toString())
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
    // Prevent loading during background lookback
    if (lookingBack) {
      console.log('[New Posts] Background lookback in progress, ignoring click')
      addToast('Still syncing posts... Please wait.', 'info')
      return
    }

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
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25

      // Paged updates: use secondary cache flow for contiguous caching
      console.log('[New Posts] SINGLE PAGE: Loading via secondary cache...')

      setSyncInProgress(true)
      setSyncProgress(0)

      try {
        // Use secondary cache flow - fetches, caches to secondary, merges to primary
        const result = await performLookbackFetchToSecondary(
          agent,
          session.handle,
          session.did,
          pageLength,
          (progress) => setSyncProgress(Math.round(progress * 0.8)),  // 0-80% for fetch
          (mergeProgress) => setSyncProgress(80 + Math.round(mergeProgress * 0.2))  // 80-100% for merge
        )

        console.log(`[New Posts] SINGLE PAGE: Secondary cache flow completed: ${result.postsMerged} posts merged`)

        // Assign numbers to merged posts
        if (result.postsMerged > 0) {
          // Use the day of the newest merged post, not current time
          // This handles the case where posts are from yesterday but user clicks after midnight
          const newestPostDate = new Date(result.newestTimestamp || Date.now())
          const dayStart = getLocalMidnight(newestPostDate).getTime()
          const dayEnd = dayStart + 24 * 60 * 60 * 1000
          const { maxPostNumber, maxCurationNumber } = await getMaxNumbersForDay(dayStart, dayEnd)

          // Get summaries for the day of the posts (not necessarily today)
          const allSummaries = await getPostSummariesInRange(dayStart, dayEnd)
          const unnumberedSummaries = allSummaries.filter(s =>
            s.postNumber === null || s.postNumber === undefined
          )

          if (unnumberedSummaries.length > 0) {
            await assignIncrementalNumbers(unnumberedSummaries, maxPostNumber, maxCurationNumber)
            console.log(`[New Posts] SINGLE PAGE: Assigned numbers to ${unnumberedSummaries.length} posts for ${newestPostDate.toLocaleDateString()} (max postNumber: ${maxPostNumber}, max curationNumber: ${maxCurationNumber})`)
          }
        }

        // Clear UI state
        setNewPostsCount(0)
        setShowNewPostsButton(false)
        setNextPageReady(false)
        setPartialPageCount(0)
        setMultiPageCount(0)
        setIdleTimerTriggered(false)
        lastDisplayTimeRef.current = Date.now()

        // Load exactly one page of curated posts from cache
        // (Don't use redisplayFeed which loads pageLength * 2)
        const pagedSettings = await getPagedUpdatesSettings()
        const [, currentProbs] = await getFilter() || [null, null]
        const currentFilterFrac = currentProbs ? computeFilterFrac(currentProbs) : 0.5
        const rawPostsNeeded = calculatePageRaw(pageLength, currentFilterFrac, pagedSettings.varFactor)

        const feedReceivedTime = new Date()
        const cachedPosts = await getCachedFeed(rawPostsNeeded)

        if (cachedPosts.length > 0) {
          // Apply curation filtering
          let filteredPosts = await lookupCurationAndFilter(
            cachedPosts,
            feedReceivedTime,
            undefined,
            false  // Apply filtering
          )

          // Trim to pageLength if we got more than expected
          if (filteredPosts.length > pageLength) {
            filteredPosts = filteredPosts.slice(0, pageLength)
          }

          console.log(`[New Page] Displaying ${filteredPosts.length} curated posts (from ${cachedPosts.length} raw, filterFrac=${currentFilterFrac.toFixed(2)})`)

          // Update feed state
          setFeed(filteredPosts)

          // Update timestamps
          const newestTimestamp = getFeedViewPostTimestamp(filteredPosts[0], feedReceivedTime).getTime()
          const oldestTimestamp = getFeedViewPostTimestamp(filteredPosts[filteredPosts.length - 1], feedReceivedTime).getTime()
          setNewestDisplayedPostTimestamp(newestTimestamp)
          setOldestDisplayedPostTimestamp(oldestTimestamp)

          // Save state to session storage
          const stateToSave: SavedFeedState = {
            displayedFeed: filteredPosts,
            previousPageFeed: [],
            newestDisplayedPostTimestamp: newestTimestamp,
            oldestDisplayedPostTimestamp: oldestTimestamp,
            hasMorePosts: true,
            cursor: undefined,
            savedAt: Date.now(),
            lowestVisiblePostTimestamp: null,
            newPostsCount: 0,
            showNewPostsButton: false,
            sessionDid: session.did
          }
          sessionStorage.setItem(getFeedStateKey('curated'), JSON.stringify(stateToSave))
        }

        // Scroll to top after loading new posts
        isProgrammaticScrollRef.current = true
        window.scrollTo({ top: 0, behavior: 'smooth' })
        setTimeout(() => {
          isProgrammaticScrollRef.current = false
          lastScrollTopRef.current = window.scrollY
        }, 1000)

      } finally {
        setSyncInProgress(false)
        setSyncProgress(0)
      }

    } catch (error) {
      console.error('Failed to load new posts:', error)
      addToast('Failed to load new posts', 'error')
    } finally {
      setIsLoadingMore(false)
    }
  }, [agent, session, newestDisplayedPostTimestamp, newPostsCount, lookupCurationAndFilter, isLoadingMore, feed])

  // Handle "All n new posts" button click
  // Two flows: partial page (incremental) and multi-page (full re-display)
  const handleLoadAllNewPosts = useCallback(async () => {
    // Prevent loading during background lookback
    if (lookingBack) {
      console.log('[All New Posts] Background lookback in progress, ignoring click')
      addToast('Still syncing posts... Please wait.', 'info')
      return
    }

    if (isLoadingMore || !agent || !session) {
      console.log('[All New Posts] Cannot load: isLoadingMore or missing agent/session')
      return
    }

    // Treat as multi-page if 2+ pages detected
    const isMultiPage = multiPageCount >= 50

    if (isMultiPage) {
      // MULTI-PAGE FLOW: Full re-display
      console.log(`[New Posts] MULTI-PAGE: Processing ${multiPageCount} posts one-by-one`)

      setIsLoadingMore(true)
      setSyncInProgress(true)

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
        const allNewIntervalHours = getIntervalHoursSync(settings)

        for (const post of sortedPosts) {
          if (displayedCount >= pageLength) break

          const { entries: [entry], finalLastPostTime } = createFeedCacheEntries([post], lastPostTime, allNewIntervalHours)
          lastPostTime = finalLastPostTime
          const postTimestamp = entry.postTimestamp

          // Save to feed cache and curate
          const { curatedFeed: curatedPosts } = await savePostsWithCuration([entry], undefined, agent, session.handle, session.did)
          const curatedPost = curatedPosts[0] as CurationFeedViewPost

          // Track timestamps
          if (postTimestamp > newestCuratedTimestamp) newestCuratedTimestamp = postTimestamp
          if (postTimestamp < oldestCuratedTimestamp) oldestCuratedTimestamp = postTimestamp

          // Add to display if not dropped
          if (isStatusShow(curatedPost.curation?.curation_status)) {
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
        setPartialPageCount(0)
        setIdleTimerTriggered(false)
        setMultiPageCount(0)
        lastDisplayTimeRef.current = Date.now() // Start cooldown

        // Assign numbers to the processed posts
        if (postsToDisplay.length > 0) {
          // Use the day of the newest curated post, not current time
          const newestPostDate = new Date(newestCuratedTimestamp)
          const dayStart = getLocalMidnight(newestPostDate).getTime()
          const dayEnd = dayStart + 24 * 60 * 60 * 1000
          const { maxPostNumber, maxCurationNumber } = await getMaxNumbersForDay(dayStart, dayEnd)

          const allSummaries = await getPostSummariesInRange(dayStart, dayEnd)
          const unnumberedSummaries = allSummaries.filter(s =>
            s.postNumber === null || s.postNumber === undefined
          )

          if (unnumberedSummaries.length > 0) {
            await assignIncrementalNumbers(unnumberedSummaries, maxPostNumber, maxCurationNumber)
            console.log(`[New Posts] MULTI-PAGE: Assigned numbers to ${unnumberedSummaries.length} posts for ${newestPostDate.toLocaleDateString()}`)
          }
        }

        // Debug: compare probe expected count vs actual display count
        console.log(`[New Posts] MULTI-PAGE: COUNT COMPARISON: Probe expected ${probeExpectedCountRef.current} posts, actually displayed ${postsToDisplay.length} posts (diff: ${probeExpectedCountRef.current - postsToDisplay.length})`)
        console.log(`[New Posts] MULTI-PAGE: Displayed ${postsToDisplay.length} posts, starting background gap fill...`)

        // Scroll to top
        isProgrammaticScrollRef.current = true
        window.scrollTo({ top: 0, behavior: 'smooth' })
        setTimeout(() => {
          isProgrammaticScrollRef.current = false
          lastScrollTopRef.current = window.scrollY
        }, 1000)

        // Start background gap fill
        if (fetchCursor && oldestCuratedTimestamp < Number.MAX_SAFE_INTEGER) {
          // Use the day of the newest curated post, not current time
          const newestPostDate = new Date(newestCuratedTimestamp)
          const prevMidnight = getLocalMidnight(newestPostDate).getTime()
          console.log(`[New Posts] MULTI-PAGE: Gap fill from ${new Date(oldestCuratedTimestamp).toLocaleTimeString()} to midnight of ${newestPostDate.toLocaleDateString()}`)
          try {
            await limitedLookbackToMidnight(oldestCuratedTimestamp, fetchCursor, agent, session.handle, session.did, pageLength, prevMidnight)
            console.log('[New Posts] MULTI-PAGE: Gap fill complete')
          } catch (gapError) {
            console.warn('[New Posts] MULTI-PAGE: Gap fill error:', gapError)
          }
        }
      } catch (error) {
        console.error('[All New Posts] Multi-page load failed:', error)
        addToast('Failed to load new posts', 'error')
      } finally {
        setIsLoadingMore(false)
        setSyncInProgress(false)
      }
    } else {
      // PARTIAL PAGE FLOW: Use existing handleLoadNewPosts logic
      console.log(`[New Posts] PARTIAL PAGE: ${partialPageCount} posts, using single page flow`)
      await handleLoadNewPosts()
      setIdleTimerTriggered(false)
    }
  }, [agent, session, isLoadingMore, multiPageCount, partialPageCount, handleLoadNewPosts])

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

  const handlePrevPage = useCallback(async () => {
    // Guard: button shouldn't be visible if empty, but check anyway
    if (previousPageFeed.length === 0) return

    // Check if already loading or prefetching
    if (isPrefetching) return

    // Check if background lookback is in progress
    if (lookingBack) {
      addToast('Still syncing older posts... Please wait.', 'info')
      return
    }

    console.log(`[Prev Page] INSTANT: Displaying ${previousPageFeed.length} pre-fetched posts`)

    // 1. INSTANT: Display previousPageFeed (from memory, no IndexedDB access)
    const feedReceivedTime = new Date()

    // Calculate deduplication BEFORE setFeed to determine correct next prefetch timestamp
    const existingUris = new Set(feed.map(p => getPostUniqueId(p)))
    const newPosts = previousPageFeed.filter(p => !existingUris.has(getPostUniqueId(p)))
    console.log(`[Prev Page] Appending ${newPosts.length} pre-fetched posts`)

    // Calculate timestamp for next prefetch based on what's actually new
    let nextPrefetchTimestamp: number
    if (newPosts.length > 0) {
      // Use oldest of the newly appended posts
      nextPrefetchTimestamp = getFeedViewPostTimestamp(
        newPosts[newPosts.length - 1],
        feedReceivedTime
      ).getTime()
    } else {
      // No new posts - all were duplicates
      // Use oldest from previousPageFeed to continue searching further back
      nextPrefetchTimestamp = getFeedViewPostTimestamp(
        previousPageFeed[previousPageFeed.length - 1],
        feedReceivedTime
      ).getTime()
    }

    // Append pre-fetched posts to feed
    setFeed(prevFeed => [...prevFeed, ...newPosts])

    // Update pagination boundary
    setOldestDisplayedPostTimestamp(nextPrefetchTimestamp)

    // 2. Clear previousPageFeed and show loading spinner
    setPreviousPageFeed([])
    setIsPrefetching(true)

    // 3. Pre-fetch next page (awaited so we can update UI after)
    await prefetchNextPage(nextPrefetchTimestamp)
    setIsPrefetching(false)
  }, [feed, previousPageFeed, isPrefetching, lookingBack, prefetchNextPage])

  // Set up IntersectionObserver for infinite scrolling
  // Note: Uses refs (previousPageFeedRef, isPrefetchingRef) to avoid stale closures in callback
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

    // Clean up previous observer if exists
    if (intersectionObserverRef.current) {
      intersectionObserverRef.current.disconnect()
      intersectionObserverRef.current = null
    }

    // Create new IntersectionObserver
    // Uses refs to read current state at callback time (avoids stale closure issue)
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting &&
            previousPageFeedRef.current.length > 0 &&
            !isPrefetchingRef.current) {
          // Call handlePrevPage when sentinel is visible
          handlePrevPage()
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
  }, [infiniteScrollingEnabled, handlePrevPage])

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
    await clearPrevPageCursor()
    sessionStorage.removeItem(getFeedStateKey('curated')) // Clear saved state
    loadFeed(undefined, false)
  }

  // Filter out immediate same-user replies
  const filteredFeed = useMemo(() => filterSameUserReplies(feed), [feed])

  const handleAmpChange = async () => {
    // Clear cache and reload feed when amp factor changes
    await clearFeedCache()
    await clearPrevPageCursor()
    sessionStorage.removeItem(getFeedStateKey('curated')) // Clear saved state
    loadFeed(undefined, false)
  }

  // Handle tab change - saves current tab's state and switches to new tab
  const handleTabChange = useCallback((newTab: HomeTab) => {
    if (newTab === activeTab) return

    // Save current tab's scroll position
    const currentScrollKey = getScrollStateKey(activeTab)
    const currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
    sessionStorage.setItem(currentScrollKey, currentScrollY.toString())

    // Save current tab's feed state (only for curated tab since editions is placeholder)
    if (activeTab === 'curated') {
      const currentFeedStateKey = getFeedStateKey(activeTab)
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
        sessionDid: session?.did || ''
      }
      try {
        sessionStorage.setItem(currentFeedStateKey, JSON.stringify(feedState))
      } catch (error) {
        console.warn('Failed to save feed state on tab change:', error)
      }
    }

    // Reset scroll restoration flag for new tab
    scrollRestoredRef.current = false

    // Switch tabs
    setActiveTab(newTab)
  }, [activeTab, feed, previousPageFeed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, newPostsCount, showNewPostsButton, session])

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
              <span className="font-semibold">{skylimitStats.post_daily.toFixed(0)}</span> posts/day received
            </div>
            <div className="text-gray-400 dark:text-gray-500">→</div>
            <div className="text-gray-600 dark:text-gray-400">
              <span className="font-semibold">~{skylimitStats.shown_daily.toFixed(0)}</span> displayed
            </div>
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        {(['curated', 'editions'] as HomeTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => handleTabChange(tab)}
            className={`flex-1 px-4 py-3 text-center font-medium transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-blue-500 text-blue-500'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab === 'curated' ? 'Curated Follow' : 'Periodic Editions'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'curated' ? (
      <div>
        {filteredFeed.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>No posts to show. Follow some users to see their posts here!</p>
          </div>
        ) : (
          <>
            {/* New Page / All New Posts buttons - two-button layout */}
            <div className="sticky top-0 z-30 p-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
              <div className="flex gap-2">
                {/* "New Page" button - always visible, grayed out when inactive or during lookback */}
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    console.log('[New Page] Button clicked', { newPostsCount, isLoadingMore, nextPageReady, lookingBack })
                    handleLoadNewPosts()
                  }}
                  disabled={isLoadingMore || !nextPageReady || lookingBack}
                  className={`flex-1 btn flex items-center justify-center gap-2 ${
                    nextPageReady && !lookingBack
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

                {/* "All n new posts" button - shown when idle timer triggered and posts available, hidden during lookback */}
                {idleTimerTriggered && partialPageCount > 0 && !lookingBack && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      console.log('[All New Posts] Button clicked', { partialPageCount, idleTimerTriggered, newPostsCount })
                      handleLoadAllNewPosts()
                    }}
                    disabled={isLoadingMore || lookingBack}
                    className="flex-1 btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50"
                    aria-label={`Load all ${partialPageCount} new posts`}
                  >
                    {isLoadingMore ? (
                      <>
                        <Spinner size="sm" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <span>📬</span>
                        All new posts ({partialPageCount})
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
            
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

        {/* Infinite scroll sentinel - always mounted when infinite scrolling enabled to avoid observer disconnection */}
        {infiniteScrollingEnabled && !lookingBack && (
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
              // State 1: After clicking Prev Page, prefetching next page - show spinner
              <div className="flex items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
                <Spinner size="sm" />
                <span>Loading...</span>
              </div>
            ) : previousPageFeed.length > 0 ? (
              // State 2: More posts available - show Prev Page button
              <button
                onClick={handlePrevPage}
                disabled={syncInProgress}
                className="btn btn-primary inline-flex items-center justify-center gap-2"
              >
                {syncInProgress ? (
                  <>
                    <Spinner size="sm" />
                    Synchronizing... {syncProgress}%
                  </>
                ) : (
                  <>
                    <span>📄</span>
                    Prev Page
                  </>
                )}
              </button>
            ) : !isLoading && feed.length > 0 ? (
              // State 3: Initializing or No more posts
              !initialPrefetchDone ? (
                // Still initializing (prefetch not complete yet)
                <div className="flex items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
                  <Spinner size="sm" />
                  <span>Initializing...</span>
                </div>
              ) : (
                // Prefetch done but no more posts available
                <span className="text-gray-500 dark:text-gray-400">No more posts</span>
              )
            ) : null}
          </div>
        )}
      </div>
      ) : (
        /* Periodic Editions placeholder */
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p className="text-lg font-medium mb-2">Periodic Editions</p>
          <p>(To be implemented)</p>
        </div>
      )}

      {/* Scroll to top arrow - shown when scrolled down (only for curated tab) */}
      {activeTab === 'curated' && isScrolledDown && (
        <button
          onClick={handleScrollToTop}
          className="fixed bottom-6 left-6 md:bottom-8 md:left-8 bg-gray-500 hover:bg-gray-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-12 h-12"
          aria-label="Scroll to top"
        >
          <span className="text-xl">↑</span>
        </button>
      )}

      {/* Floating compose button in bottom right (only for curated tab) */}
      {activeTab === 'curated' && (
        <button
          onClick={() => setShowCompose(true)}
          className="fixed bottom-20 right-6 md:bottom-8 md:right-8 bg-blue-500 hover:bg-blue-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-14 h-14"
          aria-label="Compose new post"
        >
          <span className="text-2xl">✏️</span>
        </button>
      )}

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

      <CurationInitModal
        isOpen={showCurationInitModal}
        onClose={() => setShowCurationInitModal(false)}
        stats={curationInitStats}
      />
    </div>
  )
}

