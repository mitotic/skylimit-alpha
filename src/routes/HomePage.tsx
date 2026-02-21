import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { useRateLimit } from '../contexts/RateLimitContext'
import { getHomeFeed, onSkyspeedCommand, offSkyspeedCommand, type SkyspeedCommand } from '../api/feed'
import PostCard from '../components/PostCard'
import Compose from '../components/Compose'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import RateLimitIndicator from '../components/RateLimitIndicator'
import CurationInitModal, { CurationInitStatsDisplay } from '../components/CurationInitModal'
import { insertEditionPosts } from '../curation/skylimitTimeline'
import { initDB, getFilter, getPostSummary, isPostSummariesCacheEmpty, getCurationInitStats, checkPostSummaryExists, isSummariesCacheFresh, updatePostSummaryViewedAt } from '../curation/skylimitCache'
import { getSettings, FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT } from '../curation/skylimitStore'
import { computeFilterFrac } from '../curation/skylimitStats'
import { probeForNewPosts, calculatePageRaw, getPagedUpdatesSettings } from '../curation/pagedUpdates'
import { flushExpiredParentPosts } from '../curation/parentPostCache'
import { scheduleStatsComputation, computeStatsInBackground } from '../curation/skylimitStatsWorker'
import { recomputeCurationDecisions } from '../curation/skylimitRecurate'
import { markPostViewed, getUnviewedPostsInfo, countUnviewedOlderThan, onUnviewedChange } from '../curation/skylimitUnviewedTracker'
import { GlobalStats, CurationFeedViewPost, SecondaryEntry, getIntervalHoursSync, isStatusShow } from '../curation/types'
import { getCachedFeed, clearFeedCache, clearFeedMetadata, getLastFetchMetadata, getCachedFeedBefore, updateFeedCacheOldestPostTimestamp, getCachedFeedAfterPosts, shouldUseCacheOnLoad, createFeedCacheEntries, savePostsWithCuration, validateFeedCacheIntegrity, getLocalMidnight, fetchPageFromTimestamp, isCacheWithinLookback, getNewestCachedPostTimestamp, getFreshPrevPageCursor, clearPrevPageCursor, getPrevPageCursorStatus, markInitialLookbackCompleted, fetchToSecondaryFeedCache, transferSecondaryToPrimary, curateEntriesToSecondary, secondaryEntriesToCuratedFeed, filterSecondaryForDisplay } from '../curation/skylimitFeedCache'
import { getPostUniqueId, getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { numberUnnumberedPostsForDay, assignNumbersForDay } from '../curation/skylimitNumbering'
import { getNonStandardServerName } from '../api/atproto-client'
import AcceleratedClock from '../components/AcceleratedClock'
import { clientNow, clientDate, clientTimeout, clientInterval, clearClientTimeout, clearClientInterval } from '../utils/clientClock'
import { HomeTab, HOME_TAB_STATE_KEY, getFeedStateKey, getScrollStateKey, DEFAULT_MAX_DISPLAYED_FEED_SIZE, SavedFeedState, findLowestVisiblePostTimestamp, alignFeedToPageBoundary } from '../hooks/homePageTypes'
import { usePostInteractions } from '../hooks/usePostInteractions'
import { useScrollManagement } from '../hooks/useScrollManagement'
import { usePullToRefresh } from '../hooks/usePullToRefresh'

/** Options for refreshDisplayedFeed — designed for reuse across refresh triggers */
interface RefreshDisplayedFeedOptions {
  newestTimestamp?: number   // Override which post appears at top (default: current newestDisplayedPostTimestamp)
  triggerProbe?: boolean     // Whether to force an immediate probe (default: true)
  showAllNewPosts?: boolean  // Whether to set idleTimerTriggered (default: true)
}

/** Result returned by refreshDisplayedFeed for caller use */
interface RefreshDisplayedFeedResult {
  alignedPosts: CurationFeedViewPost[]
  newestTimestamp: number
  oldestTimestamp: number
}

/** Minimum dwell time (ms) a post must remain visible and stationary to count as "viewed" */
const VIEW_DWELL_TIME_MS = 1000
/** Debounce interval (ms) after last scroll event before considering scroll "stopped" */
const SCROLL_STOP_DEBOUNCE_MS = 300

export default function HomePage() {
  const location = useLocation()
  const navigate = useNavigate()
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
  const loadFeedRef = useRef<((cursor?: string, useCache?: boolean) => Promise<void>) | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [dbInitialized, setDbInitialized] = useState(false)
  const [skylimitStats, setSkylimitStats] = useState<GlobalStats | null>(null)
  const [curationSuspended, setCurationSuspended] = useState(false)
  const [showAllPosts, setShowAllPosts] = useState(false)
  const [newPostsCount, setNewPostsCount] = useState(0)
  const [showNewPostsButton, setShowNewPostsButton] = useState(false)
  const [newestDisplayedPostTimestamp, setNewestDisplayedPostTimestamp] = useState<number | null>(null)
  const [oldestDisplayedPostTimestamp, setOldestDisplayedPostTimestamp] = useState<number | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [infiniteScrollingEnabled, setInfiniteScrollingEnabled] = useState(false)
  // Paged fresh updates state
  const [nextPageReady, setNextPageReady] = useState(false) // true when full page of posts available
  const nextPageReadyRef = useRef(false) // ref mirror for use in probe callback (avoids stale closure)
  nextPageReadyRef.current = nextPageReady // keep ref in sync during render
  const [partialPageCount, setPartialPageCount] = useState(0) // count when showing partial page (for "All new posts" button)
  const [postsNeededForPage, setPostsNeededForPage] = useState<number | null>(null) // null = full page; number = partial page posts needed to reach next boundary
  // Multi-page tracking state (kept for logging purposes)
  const [multiPageCount, setMultiPageCount] = useState(0) // total filtered posts when 2+ pages available
  const [idleTimerTriggered, setIdleTimerTriggered] = useState(false) // true when idle time elapsed for partial page
  // Secondary cache sync state (for paged updates lookback)
  const [syncInProgress, setSyncInProgress] = useState(false) // true when secondary cache is being merged
  const [syncProgress, setSyncProgress] = useState(0) // 0-100 sync progress percentage
  const [unviewedRevision, setUnviewedRevision] = useState(0) // tracks unviewed tracker mutations for memo invalidation
  // Debug: track expected display count from probe for comparison
  const probeExpectedCountRef = useRef<number>(0)
  // Cooldown: track when we last displayed new posts to prevent button from immediately reappearing
  const lastDisplayTimeRef = useRef<number>(0)
  const DISPLAY_COOLDOWN_MS = 30000 // 30 second cooldown after displaying posts
  // Force-probe: incrementing forceProbeTrigger re-runs the probe useEffect (cancels old interval, probes immediately)
  const [forceProbeTrigger, setForceProbeTrigger] = useState(0)
  const forceProbeRef = useRef(false)  // When true, probe bypasses display cooldown
  // Lookback caching state
  const [lookingBack, setLookingBack] = useState(false) // true during background lookback fetch
  const [lookbackProgress, setLookbackProgress] = useState<number | null>(null) // 0-100 progress percentage
  // Initial curation tracking state (for showing modal when curation completes on first load)
  const [showCurationInitModal, setShowCurationInitModal] = useState(false) // show modal when curation completes
  const [curationInitStats, setCurationInitStats] = useState<CurationInitStatsDisplay | null>(null)
  const isInitialCurationRef = useRef(false) // ref to track initial curation in callbacks
  const forceInitialLoadRef = useRef(false) // ref to force initial load mode (used by Reset Feed)
  const firstPostRef = useRef<HTMLDivElement>(null)
  const scrollSentinelRef = useRef<HTMLDivElement>(null)  // Sentinel element for intersection observer
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null)  // Observer instance
  const previousPageFeedRef = useRef<CurationFeedViewPost[]>([])  // Ref for observer callback (avoids stale closure)
  const isPrefetchingRef = useRef(false)  // Ref for observer callback (avoids stale closure)
  const prevPageHadUnnumberedRef = useRef(false)  // Tracks if previous Prev Page had unnumbered posts
  const viewTrackingObserverRef = useRef<IntersectionObserver | null>(null)  // Observer for post view tracking
  const viewedPostIdsRef = useRef<Set<string>>(new Set())  // In-session set of already-viewed post uniqueIds
  const pendingViewedUpdatesRef = useRef<Map<string, number>>(new Map())  // Batched viewedAt updates for feed state
  const viewedUpdateScheduledRef = useRef(false)  // Whether a batched feed state update is scheduled
  const dwellTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())  // Active dwell timers per postId
  const isScrollingRef = useRef(false)  // True while user is actively scrolling
  const scrollStopDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)  // Debounce handle for scroll-stop detection
  const visiblePostElementsRef = useRef<Map<string, HTMLElement>>(new Map())  // Currently-visible posts awaiting dwell

  const previousPathnameRef = useRef<string>(location.pathname)
  
  // Tab state - initialize from sessionStorage
  const getInitialTab = (): HomeTab => {
    const savedTab = sessionStorage.getItem(HOME_TAB_STATE_KEY)
    if (savedTab === 'editions') return 'editions'
    return 'curated'
  }
  const [activeTab, setActiveTab] = useState<HomeTab>(getInitialTab)

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = clientNow().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, type === 'error' ? 10000 : 5000)
  }

  const {
    showCompose, setShowCompose,
    replyToUri, setReplyToUri,
    quotePost, setQuotePost,
    handleLike, handleBookmark, handleRepost,
    handleQuotePost, handleReply, handlePost, handleAmpChange,
  } = usePostInteractions({ agent, feed, setFeed, loadFeedRef, addToast })

  const {
    isScrolledDown,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    scrollRestoredRef,
    handleScrollToTop,
  } = useScrollManagement({
    locationPathname: location.pathname,
    isLoading,
    feedLength: feed.length,
    activeTab,
    firstPostRef,
  })

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
          savedAt: clientNow(),
          lowestVisiblePostTimestamp,
          newPostsCount,
          showNewPostsButton,
          sessionDid: session?.did || '', // Save session DID to ensure we only restore for the same user
          curationSuspended,
          showAllPosts
        }

        try {
          sessionStorage.setItem(getFeedStateKey(activeTab), JSON.stringify(feedState))
          console.log(`[Save DEBUG] Saved feed state: feed=${feed.length} posts, previousPageFeed=${previousPageFeed.length} posts, oldestDisplayed=${oldestDisplayedPostTimestamp ? new Date(oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'}`)
        } catch (error) {
          console.warn('Failed to save feed state:', error)
        }
      }
    }

    previousPathnameRef.current = location.pathname
  }, [location.pathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, newPostsCount, showNewPostsButton, session, activeTab, curationSuspended, showAllPosts])

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
    
    const flushInterval = clientInterval(() => {
      flushExpiredParentPosts().catch(err => {
        console.warn('Failed to flush expired parent posts:', err)
      })
    }, 60 * 60 * 1000) // Every hour

    return () => clearClientInterval(flushInterval)
  }, [dbInitialized])

  // Save feed state whenever it changes (debounced) - only for curated tab
  useEffect(() => {
    if (location.pathname !== '/') return
    if (activeTab !== 'curated') return // Only save for curated tab

    // Don't save during initial load
    if (isLoading) return

    // Debounce saves to avoid excessive writes
    const timeoutId = clientTimeout(async () => {
      const lowestVisiblePostTimestamp = findLowestVisiblePostTimestamp(feed)
      const settings = await getSettings()

      const feedState: SavedFeedState = {
        displayedFeed: feed,
        previousPageFeed,
        newestDisplayedPostTimestamp,
        oldestDisplayedPostTimestamp,
        hasMorePosts,
        cursor,
        savedAt: clientNow(),
        lowestVisiblePostTimestamp,
        newPostsCount,
        showNewPostsButton,
        sessionDid: session?.did || '', // Save session DID to ensure we only restore for the same user
        curationSuspended: settings?.curationSuspended || false,
        showAllPosts: settings?.showAllPosts || false
      }

      try {
        sessionStorage.setItem(getFeedStateKey(activeTab), JSON.stringify(feedState))
      } catch (error) {
        console.warn('Failed to save feed state:', error)
      }
    }, 1000) // 1 second debounce

    return () => clearClientTimeout(timeoutId)
  }, [location.pathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, isLoading, newPostsCount, showNewPostsButton, session, activeTab])

  // Load Skylimit statistics and curation settings state
  const loadSkylimitStats = useCallback(async () => {
    try {
      const settings = await getSettings()
      setCurationSuspended(settings?.curationSuspended || false)
      setShowAllPosts(settings?.showAllPosts || false)

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
        if (summary?.viewedAt !== undefined) {
          curation.viewedAt = summary.viewedAt
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
    const curationSuspended = !settings || settings?.curationSuspended
    const showAllPosts = settings?.showAllPosts || false

    const filteredPosts = postsWithStatus.filter(post => {
      if (curationSuspended) {
        // Show all except reply_drop (Bluesky default behavior)
        return post.curation?.curation_status !== 'reply_drop'
      }
      if (showAllPosts) {
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
  // targetSize: optional target number of posts (for page boundary alignment), defaults to pageLength
  const prefetchPrevPage = useCallback(async (afterTimestamp: number, targetSize?: number) => {
    if (!agent || !session) return

    try {
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const effectivePageLength = targetSize ?? pageLength
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
      console.log(`[Prefetch DEBUG] Fetching posts before ${new Date(afterTimestamp).toLocaleTimeString()} (${afterTimestamp}), effectivePageLength=${effectivePageLength}`)
      let { posts: postsForNextPage, postTimestamps: timestampsForNextPage } =
        await getCachedFeedBefore(afterTimestamp, pageLength)

      if (postsForNextPage.length > 0) {
        const newestTs = Math.max(...Array.from(timestampsForNextPage.values()))
        const oldestTs = Math.min(...Array.from(timestampsForNextPage.values()))
        console.log(`[Prefetch DEBUG] Cache returned ${postsForNextPage.length} posts: newest=${new Date(newestTs).toLocaleTimeString()}, oldest=${new Date(oldestTs).toLocaleTimeString()}`)
      } else {
        console.log(`[Prefetch DEBUG] Cache returned 0 posts`)
      }

      // Step 1b: If previous Prev Page had unnumbered posts, check if the newest fetched post
      // is numbered to trigger incremental numbering before lookupCurationAndFilter runs
      if (prevPageHadUnnumberedRef.current && postsForNextPage.length > 0) {
        const newestFetched = postsForNextPage[0]
        const newestId = getPostUniqueId(newestFetched)
        const newestSummary = await getPostSummary(newestId)
        if (newestSummary?.postNumber != null && newestSummary.postNumber > 0) {
          const fetchDayStart = getLocalMidnight(new Date(afterTimestamp)).getTime()
          const fetchDayEnd = fetchDayStart + 24 * 60 * 60 * 1000
          const preNumbered = await numberUnnumberedPostsForDay(fetchDayStart, fetchDayEnd, '[Prefetch]')
          if (preNumbered > 0) {
            console.log(`[Prefetch] Numbered ${preNumbered} unnumbered posts (previous page had unnumbered)`)
          }
          prevPageHadUnnumberedRef.current = false
        }
      }

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

      // Filter with accumulation logic
      // Keep fetching until we have a full page OR 3 consecutive fetches yield no new posts
      const MAX_NO_PROGRESS = 3  // Give up after 3 fetches with no new filtered posts
      let filtered: CurationFeedViewPost[] = []
      let accumulatedFiltered: CurationFeedViewPost[] = []
      let accumulatedTimestamps = new Map<string, number>()
      let consecutiveNoProgress = 0
      let oldestProcessedTimestamp = afterTimestamp

      while (true) {
        if (postsForNextPage.length === 0) {
          // No posts to filter - truly exhausted
          console.log('[Prefetch] No more posts available')
          break
        }

        filtered = await lookupCurationAndFilter(postsForNextPage, clientDate(), timestampsForNextPage)

        // Accumulate filtered posts (deduplicate by uniqueId)
        const existingIds = new Set(accumulatedFiltered.map(p => getPostUniqueId(p)))
        const newFiltered = filtered.filter(p => !existingIds.has(getPostUniqueId(p)))

        // Merge timestamps from this batch
        timestampsForNextPage.forEach((value, key) => {
          if (!accumulatedTimestamps.has(key)) {
            accumulatedTimestamps.set(key, value)
          }
        })

        if (newFiltered.length === 0) {
          consecutiveNoProgress++
          console.log(`[Prefetch] No new posts from batch of ${postsForNextPage.length} (stall ${consecutiveNoProgress}/${MAX_NO_PROGRESS})`)
          if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
            console.log(`[Prefetch] No progress for ${MAX_NO_PROGRESS} fetches, stopping with ${accumulatedFiltered.length} posts`)
            break
          }
        } else {
          consecutiveNoProgress = 0  // Reset on progress
          accumulatedFiltered = [...accumulatedFiltered, ...newFiltered]
          console.log(`[Prefetch] Added ${newFiltered.length} posts, total: ${accumulatedFiltered.length}/${effectivePageLength}`)
        }

        if (accumulatedFiltered.length >= effectivePageLength) {
          console.log(`[Prefetch] Reached target: ${accumulatedFiltered.length} posts`)
          break
        }

        // Find oldest timestamp from the posts we just processed for next fetch
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
          console.log('[Prefetch] Cache exhausted, fetching from server')
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

      // Use accumulated results, capped at effectivePageLength (extra posts stay in cache for next Prev Page)
      filtered = accumulatedFiltered.slice(0, effectivePageLength)

      // Step 2b: Check for mid-day unnumbered→numbered transition within this prefetch
      // Posts sorted newest-first; if newer posts are unnumbered and older posts are numbered,
      // trigger incremental numbering for the day
      if (filtered.length > 1) {
        for (let i = 0; i < filtered.length - 1; i++) {
          const currentNum = (filtered[i] as CurationFeedViewPost).curation?.postNumber
          const nextNum = (filtered[i + 1] as CurationFeedViewPost).curation?.postNumber
          if ((currentNum == null) && nextNum != null && nextNum > 0) {
            const nextId = getPostUniqueId(filtered[i + 1])
            const nextTs = accumulatedTimestamps.get(nextId) ?? accumulatedTimestamps.get(filtered[i + 1].post.uri)
            if (nextTs) {
              const dayStart = getLocalMidnight(new Date(nextTs)).getTime()
              const dayEnd = dayStart + 24 * 60 * 60 * 1000
              console.log(`[Prefetch] Mid-day numbering trigger at post #${nextNum}`)
              await numberUnnumberedPostsForDay(dayStart, dayEnd, '[Prefetch]')
              filtered = await lookupCurationAndFilter(filtered, clientDate(), accumulatedTimestamps, true)
            }
            break
          }
        }
      }

      // Step 3: Apply midnight boundary filter after curation
      // If posts span multiple calendar days, keep only the older day's posts
      if (filtered.length > 0) {
        const getLocalDateString = (post: CurationFeedViewPost) => {
          const uniqueId = getPostUniqueId(post)
          const timestamp = accumulatedTimestamps.get(uniqueId) ?? accumulatedTimestamps.get(post.post.uri)
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

          // Number the newer day we're leaving behind (if unnumbered)
          const newerDayPost = accumulatedFiltered.find(p => getLocalDateString(p) === firstDate)
          if (newerDayPost) {
            const nTs = accumulatedTimestamps.get(getPostUniqueId(newerDayPost)) ?? accumulatedTimestamps.get(newerDayPost.post.uri)
            if (nTs && (newerDayPost as CurationFeedViewPost).curation?.postNumber == null) {
              const newerDayStart = getLocalMidnight(new Date(nTs)).getTime()
              const newerDayEnd = newerDayStart + 24 * 60 * 60 * 1000
              console.log(`[Prefetch] Midnight trigger: numbering newer day ${firstDate}`)
              await assignNumbersForDay(newerDayStart, newerDayEnd)
            }
          }

          // Re-read numbers for the kept older-day posts
          filtered = await lookupCurationAndFilter(filtered, clientDate(), accumulatedTimestamps, true)
        }
      }

      setPreviousPageFeed(filtered)

      // Track if this page has unnumbered posts for cross-prefetch detection
      prevPageHadUnnumberedRef.current = filtered.some(
        p => (p as CurationFeedViewPost).curation?.postNumber == null
      )

      if (filtered.length > 0) {
        const pfNewest = getFeedViewPostTimestamp(filtered[0], clientDate()).getTime()
        const pfOldest = getFeedViewPostTimestamp(filtered[filtered.length - 1], clientDate()).getTime()
        const pfFirst = filtered[0] as CurationFeedViewPost
        const pfLast = filtered[filtered.length - 1] as CurationFeedViewPost
        console.log(`[Prefetch] Pre-fetched ${filtered.length} posts for next page`)
        console.log(`[Prefetch DEBUG] previousPageFeed range: newest=${new Date(pfNewest).toLocaleTimeString()} (#${pfFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(pfOldest).toLocaleTimeString()} (#${pfLast.curation?.curationNumber ?? '?'})`)
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
      const timeSinceLastFetch = metadata?.lastFetchTime ? clientNow() - metadata.lastFetchTime : Infinity
      const idleTimeExceeded = timeSinceLastFetch > idleThreshold

      // Determine load mode based on decision matrix:
      // - Summaries stale → Initial load (regardless of feed cache)
      // - Summaries fresh + feed stale → Clear feed cache → Idle return load
      // - Summaries fresh + feed fresh + idle exceeded → Idle return load
      // - Both fresh + within idle interval → Use cache
      let isIdleReturnMode = false
      let isInitialLoadMode = false
      let preIdleCacheNewest: number | null = null  // Pre-idle cache boundary for lookback overlap

      if (!summariesCacheIsFresh || forceInitialLoadRef.current) {
        // Summaries stale or forced by Reset Feed → initial load mode
        // When forced, curatePosts will reuse existing summaries (fast on-the-fly curation)
        forceInitialLoadRef.current = false  // consume the flag
        isInitialLoadMode = true
        console.log(`[Feed] Mode: INITIAL LOAD - ${summariesCacheIsFresh ? 'forced by Reset Feed' : 'summaries cache stale (< 24h span)'}, clearing feed cache`)
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
        // Capture pre-idle boundary BEFORE metadata gets overwritten by the initial fetch
        preIdleCacheNewest = metadata?.newestCachedPostTimestamp ?? null
        console.log(`[Feed] Mode: IDLE RETURN - idle time exceeded (${Math.round(timeSinceLastFetch / 60000)} min > ${Math.round(idleThreshold / 60000)} min threshold), preserving cache, pre-idle newest: ${preIdleCacheNewest ? new Date(preIdleCacheNewest).toLocaleString() : 'null'}`)
      } else {
        // Both caches fresh and within idle interval → use cache
        console.log(`[Feed] Mode: USE CACHE - both caches fresh, idle time ${Math.round(timeSinceLastFetch / 60000)} min within ${Math.round(idleThreshold / 60000)} min threshold`)
      }

      // ALWAYS try cache first (for initial load without cursor)
      // EXCEPTION: Skip cache-only path for idle return mode or initial load mode
      if (!cursor && useCache && !isIdleReturnMode && !isInitialLoadMode) {
        // Use refreshDisplayedFeed with no newestTimestamp — starts from newest displayable post in cache
        const result = await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })
        if (result) {
          // Cache-only load specific state
          const cachedMetadata = await getLastFetchMetadata()
          setCursor(cachedMetadata?.lastCursor)
          setHasMorePosts(result.oldestTimestamp !== null || cachedMetadata?.lastCursor !== undefined)
          setIsInitialLoad(false)
          setIsLoading(false)
          console.log(`[Feed] Loaded ${result.alignedPosts.length} posts from cache via refreshDisplayedFeed`)

          // Update oldestCachedPostTimestamp in metadata (need raw cache count for boundary)
          const cachedPosts = await getCachedFeed(initialCacheLength)
          if (cachedPosts.length > 0) {
            const oldestCachedTs = getFeedViewPostTimestamp(cachedPosts[cachedPosts.length - 1], clientDate()).getTime()
            await updateFeedCacheOldestPostTimestamp(oldestCachedTs)
          }
          return
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
      const initialLastPostTime = clientDate()
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

      // Save to feed cache and curate
      // For forward fetches (initial load, idle return): curate to in-memory secondary, defer primary writes
      // For backward pagination (cursor): save directly to primary cache + summaries
      let curatedFeed: CurationFeedViewPost[]
      let initialSecondaryEntries: SecondaryEntry[] | null = null

      if ((isIdleReturnMode || isInitialLoadMode) && !cursor) {
        // Forward fetch: curate to in-memory secondary (don't write to primary yet)
        if (entriesToSave.length > 0) {
          const secondaryEntries = await curateEntriesToSecondary(entriesToSave, myUsername, myDid)
          initialSecondaryEntries = secondaryEntries
          curatedFeed = secondaryEntriesToCuratedFeed(secondaryEntries)
        } else {
          curatedFeed = []
        }
      } else {
        // Backward pagination path: save directly to primary cache + summaries
        const result = entriesToSave.length > 0
          ? await savePostsWithCuration(entriesToSave, newCursor, agent, myUsername, myDid)
          : { curatedFeed: [] }
        curatedFeed = result.curatedFeed
      }

      // Debug: Log curation results
      if (newFeed.length > 0 && !cursor) {
        console.log(`[Curation] Processed ${curatedFeed.length} posts (all posts, including dropped)`)
      }

      // Insert edition posts if needed
      const feedWithEditions = await insertEditionPosts(curatedFeed)

      // Use feedReceivedTime for timestamp calculations (same as initialLastPostTime for initial fetch)
      const feedReceivedTime = initialLastPostTime

      // Look up curation status and filter for display
      // For idle return with secondary entries: filter from in-memory summaries (not IndexedDB)
      let filteredPosts: CurationFeedViewPost[]
      if (initialSecondaryEntries) {
        const fetchSettings2 = await getSettings()
        const curationSuspended = !fetchSettings2 || fetchSettings2?.curationSuspended
        const showAllPosts = fetchSettings2?.showAllPosts || false
        filteredPosts = filterSecondaryForDisplay(initialSecondaryEntries, curationSuspended, showAllPosts)
      } else {
        filteredPosts = await lookupCurationAndFilter(feedWithEditions, feedReceivedTime)
      }
      
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
          // Skip for idle return with secondary entries — metadata is updated after transfer
          if (!initialSecondaryEntries) {
            const oldestFetchedTimestamp = feedWithEditions.length > 0
              ? getFeedViewPostTimestamp(feedWithEditions[feedWithEditions.length - 1], feedReceivedTime).getTime()
              : undefined
            if (oldestFetchedTimestamp !== undefined) {
              await updateFeedCacheOldestPostTimestamp(oldestFetchedTimestamp)
              console.log(`[Feed] Updated oldestCachedPostTimestamp in metadata to oldest fetched post: ${new Date(oldestFetchedTimestamp).toISOString()} (from ${feedWithEditions.length} fetched posts, ${filteredPosts.length} displayed)`)
            }
          }
          
          // Mark initial load as complete
          setIsInitialLoad(false)

          // Pre-fetch next page for instant Prev Page (when no lookback needed)
          // If lookback will happen, prefetch is done after redisplayFeed
          if (!isIdleReturnMode && !isInitialLoadMode && !cursor) {
            setTimeout(async () => {
              await prefetchPrevPage(oldestDisplayedTimestamp)
              setInitialPrefetchDone(true)
            }, 100)
          }

          // Start background lookback if in initial load mode or idle return mode
          // For idle return: skip if all entries had summaries OR if a cached summary was found in the first page
          const skipIdleReturnLookback = isIdleReturnMode && (allEntriesHadSummaries || firstCachedSummaryIndex > 0)
          if ((isInitialLoadMode || isIdleReturnMode) && !cursor && !skipIdleReturnLookback) {
            const fetchMode = isIdleReturnMode ? 'idle_return' as const : 'initial' as const
            console.log(`[Background Lookback] Starting unified fetch (mode: ${fetchMode})...`)

            if (isInitialLoadMode) {
              await clearPrevPageCursor()
            }

            setLookingBack(true)
            setLookbackProgress(0)

            // Unified background fetch + transfer
            fetchToSecondaryFeedCache(
              agent,
              myUsername,
              myDid,
              fetchMode,
              {
                pageLength,
                onProgress: (progress) => setLookbackProgress(progress),
                ...(preIdleCacheNewest !== null ? { overlapTargetTimestamp: preIdleCacheNewest } : {}),
                ...(newCursor ? { initialCursor: newCursor } : {}),
              }
            ).then(async (fetchResult) => {
              console.log(`[Background Lookback] Fetch complete: ${fetchResult.postsFetched} posts, stopReason=${fetchResult.stopReason}`)

              // Combine initial idle-return secondary entries with lookback entries before transfer
              let allEntries = fetchResult.entries
              if (initialSecondaryEntries) {
                allEntries = [...initialSecondaryEntries, ...allEntries]
                console.log(`[Background Lookback] Combined ${initialSecondaryEntries.length} initial + ${fetchResult.entries.length} lookback = ${allEntries.length} total entries`)
              }

              // Transfer all fetched posts to primary
              // Skip numbering on initial load — recomputeCurationDecisions will assign correct numbers after stats are computed
              if (allEntries.length > 0) {
                const transferResult = await transferSecondaryToPrimary(allEntries, 'all', pageLength, isInitialLoadMode)
                console.log(`[Background Lookback] Transferred ${transferResult.postsTransferred} posts to primary`)
              }

              setLookingBack(false)
              setLookbackProgress(100)

              if (isInitialLoadMode) {
                // INITIAL LOAD: compute stats, recompute curation, mark complete
                if (isInitialCurationRef.current) {
                  try {
                    console.log('[Curation Init] Computing filter statistics...')
                    await computeStatsInBackground(agent, myUsername, myDid, true)

                    console.log('[Curation Init] Updating curation decisions for cached posts...')
                    await recomputeCurationDecisions(agent, myUsername, myDid)

                    await markInitialLookbackCompleted()
                    console.log('[Curation Init] Initial lookback complete, flag set')

                    console.log('[Curation Init] Getting curation statistics...')
                    const curationStats = await getCurationInitStats()

                    const filterResult = await getFilter()
                    const followeeCount = filterResult
                      ? Object.keys(filterResult[1]).filter(k => !k.startsWith('#')).length
                      : 0

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

                    console.log('[Curation Init] Reloading feed with curation data...')
                    await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })

                    setShowCurationInitModal(true)
                    isInitialCurationRef.current = false
                    console.log('[Curation Init] Modal displayed')
                  } catch (err) {
                    console.error('[Curation Init] Failed to compute stats:', err)
                    isInitialCurationRef.current = false
                  }
                } else {
                  // Non-initial lookback (e.g., Reset Feed) — redisplay with numbers
                  try {
                    console.log('[Lookback] Non-initial lookback complete, redisplaying...')
                    await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })
                    setInitialPrefetchDone(true)
                  } catch (err) {
                    console.error('[Lookback] Post-lookback processing failed:', err)
                    setInitialPrefetchDone(true)
                  }
                }
              } else {
                // IDLE RETURN: numbers already assigned during transfer, just redisplay
                console.log('[Idle Return Lookback] Refreshing feed display with numbered posts...')
                await refreshDisplayedFeed({ triggerProbe: true, showAllNewPosts: true })
                setInitialPrefetchDone(true)
              }
            }).catch((err) => {
              console.error('[Background Lookback] Failed:', err)
              setLookingBack(false)
              setLookbackProgress(null)
              setInitialPrefetchDone(true)
            })
          } else if (skipIdleReturnLookback) {
            // Idle return with gap already filled - just assign numbers to any new posts and prefetch
            console.log('[Idle Return] Gap already filled by first page - skipping background lookback')

            // Persist new posts to IndexedDB (feed_cache + post_summaries) before numbering.
            // skipNumbering=true defers number assignment to numberUnnumberedPostsForDay below.
            if (initialSecondaryEntries && initialSecondaryEntries.length > 0) {
              const transferResult = await transferSecondaryToPrimary(initialSecondaryEntries, 'all', pageLength, true)
              console.log(`[Idle Return] Persisted ${transferResult.postsTransferred} new posts to primary cache`)
            }

            // Assign numbers to unnumbered summaries for yesterday and today (if any new posts were curated)
            if (entriesToSave.length > 0) {
              const todayMidnight = getLocalMidnight(clientDate()).getTime()
              const todayEnd = todayMidnight + 24 * 60 * 60 * 1000
              const yesterdayMidnight = todayMidnight - 24 * 60 * 60 * 1000
              const numberedYesterday = await numberUnnumberedPostsForDay(yesterdayMidnight, todayMidnight, '[Idle Return] (yesterday)')
              const numberedToday = await numberUnnumberedPostsForDay(todayMidnight, todayEnd, '[Idle Return]')

              if (numberedYesterday + numberedToday > 0) {
                // Clear sessionStorage to force fresh load with updated numbers
                sessionStorage.removeItem(getFeedStateKey('curated'))

                // Refresh feed display with numbered posts
                console.log('[Idle Return] Refreshing feed display with numbered posts...')
                await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })
              }
            }

            // Pre-fetch next page for instant Prev Page
            setTimeout(async () => {
              await prefetchPrevPage(oldestDisplayedTimestamp)
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

  // Keep ref current for usePostInteractions hook
  loadFeedRef.current = loadFeed

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
      const feedReceivedTime = clientDate()

      // Check if curation settings changed since feed was saved
      // If so, we need to re-filter the feed
      const currentCurationSuspended = settings?.curationSuspended || false
      const currentShowAllPosts = settings?.showAllPosts || false
      const savedCurationSuspended = savedState.curationSuspended ?? false
      const savedShowAllPosts = savedState.showAllPosts ?? false
      const settingsChanged = currentCurationSuspended !== savedCurationSuspended ||
                              currentShowAllPosts !== savedShowAllPosts

      // If we're switching to show MORE posts (suspending curation or enabling showAllPosts),
      // we need to reload from cache because saved feed doesn't have dropped posts
      const needsMorePosts = (currentCurationSuspended && !savedCurationSuspended) ||
                             (currentShowAllPosts && !savedShowAllPosts)

      if (needsMorePosts) {
        console.log(`[Redisplay] Settings changed to show more posts (suspended: ${savedCurationSuspended}→${currentCurationSuspended}, showAll: ${savedShowAllPosts}→${currentShowAllPosts}), falling back to loadFeed`)
        sessionStorage.removeItem(getFeedStateKey('curated'))
        return loadFeed()
      }

      if (settingsChanged) {
        console.log(`[Redisplay] Curation settings changed (suspended: ${savedCurationSuspended}→${currentCurationSuspended}, showAll: ${savedShowAllPosts}→${currentShowAllPosts}), will re-filter`)
      }

      // Look up curation status for restored posts from summaries cache
      // This ensures posts have correct curation metadata for counter display
      // skipFiltering: Only skip if settings haven't changed
      let feedWithCuration = await lookupCurationAndFilter(
        savedState.displayedFeed as CurationFeedViewPost[],
        feedReceivedTime,
        undefined,  // no postTimestamps
        !settingsChanged  // skipFiltering - only skip if settings unchanged
      )

      // Align to page boundary if curation numbers are available
      feedWithCuration = alignFeedToPageBoundary(feedWithCuration, pageLength)

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

        const rdFirst = feedWithCuration[0] as CurationFeedViewPost
        const rdLast = feedWithCuration[feedWithCuration.length - 1] as CurationFeedViewPost
        console.log(`[Redisplay DEBUG] Restored feed range: newest=${new Date(newestTimestamp).toLocaleTimeString()} (#${rdFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(oldestTimestamp).toLocaleTimeString()} (#${rdLast.curation?.curationNumber ?? '?'}), savedOldest=${savedState.oldestDisplayedPostTimestamp ? new Date(savedState.oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'}`)

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
        if (previousWithCuration.length > 0) {
          const rpNewest = getFeedViewPostTimestamp(previousWithCuration[0], feedReceivedTime).getTime()
          const rpOldest = getFeedViewPostTimestamp(previousWithCuration[previousWithCuration.length - 1], feedReceivedTime).getTime()
          const rpFirst = previousWithCuration[0] as CurationFeedViewPost
          const rpLast = previousWithCuration[previousWithCuration.length - 1] as CurationFeedViewPost
          console.log(`[Redisplay DEBUG] Restored previousPageFeed range: newest=${new Date(rpNewest).toLocaleTimeString()} (#${rpFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(rpOldest).toLocaleTimeString()} (#${rpLast.curation?.curationNumber ?? '?'})`)
        }
      } else if (oldestTimestamp) {
        // Pre-fetch if not saved (NO SPINNER)
        console.log(`[Redisplay DEBUG] Triggering prefetch with oldestTimestamp=${new Date(oldestTimestamp).toLocaleTimeString()} (${oldestTimestamp})`)
        setTimeout(async () => {
          await prefetchPrevPage(oldestTimestamp)
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
        age: Math.round((clientNow() - savedState.savedAt) / 1000) + 's'
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
              const feedReceivedTime = clientDate()
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

  // Refresh the displayed feed from the primary IndexedDB cache.
  // Triggered by pull-to-refresh (mobile) and soft-refresh interception (desktop).
  // Designed for future reuse: after initial load curation, after idle return, multi-page load.
  const refreshDisplayedFeed = useCallback(async (options?: RefreshDisplayedFeedOptions): Promise<RefreshDisplayedFeedResult | null> => {
    if (!agent || !session || !dbInitialized || isLoadingMore || activeTab !== 'curated') {
      console.log('[Refresh] Guard: skipping refresh', { agent: !!agent, session: !!session, dbInitialized, isLoadingMore, activeTab })
      return null
    }

    const effectiveNewestTimestamp = options?.newestTimestamp ?? newestDisplayedPostTimestamp

    console.log(`[Refresh] Starting refresh (newestTimestamp=${effectiveNewestTimestamp ? new Date(effectiveNewestTimestamp).toLocaleTimeString() : 'null (newest from cache)'}, triggerProbe=${options?.triggerProbe !== false}, showAllNewPosts=${options?.showAllNewPosts !== false})`)

    // Step 1: Force immediate probe (if requested)
    if (options?.triggerProbe !== false) {
      forceProbeRef.current = true
      setForceProbeTrigger(n => n + 1)
    }

    // Step 2: Trigger "All new posts" button visibility (if requested)
    if (options?.showAllNewPosts !== false) {
      setIdleTimerTriggered(true)
    }

    // Step 3: Redisplay feed from primary cache using accumulation loop
    try {
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const feedReceivedTime = clientDate()

      const MAX_NO_PROGRESS = 3
      let accumulatedFiltered: CurationFeedViewPost[] = []
      let consecutiveNoProgress = 0
      // fetchBeforeTimestamp: +1 to include the post at exactly effectiveNewestTimestamp, or null for "newest from cache"
      let fetchBeforeTimestamp: number | null = effectiveNewestTimestamp != null ? effectiveNewestTimestamp + 1 : null
      let isFirstBatch = true

      while (true) {
        let batchPosts: CurationFeedViewPost[]
        let batchTimestamps: Map<string, number>

        if (isFirstBatch && fetchBeforeTimestamp == null) {
          // No timestamp — start from newest in cache
          batchPosts = await getCachedFeed(2 * pageLength)
          batchTimestamps = new Map()  // getCachedFeed doesn't return timestamps
        } else {
          // Read before a specific timestamp (first batch with timestamp, or subsequent batches)
          const result = await getCachedFeedBefore(fetchBeforeTimestamp!, 2 * pageLength)
          batchPosts = result.posts as CurationFeedViewPost[]
          batchTimestamps = result.postTimestamps
        }
        isFirstBatch = false

        if (batchPosts.length === 0) {
          console.log('[Refresh] Cache exhausted')
          break
        }

        // Filter and apply curation
        const filtered = await lookupCurationAndFilter(
          batchPosts,
          feedReceivedTime,
          batchTimestamps.size > 0 ? batchTimestamps : undefined,
          false  // apply filtering
        )

        // Only keep posts at or before the effective newest timestamp (skip when no upper bound)
        const withinRange = effectiveNewestTimestamp != null
          ? filtered.filter(p => {
              const ts = getFeedViewPostTimestamp(p, feedReceivedTime).getTime()
              return ts <= effectiveNewestTimestamp
            })
          : filtered

        // Deduplicate against accumulated posts
        const existingIds = new Set(accumulatedFiltered.map(p => getPostUniqueId(p)))
        const newPosts = withinRange.filter(p => !existingIds.has(getPostUniqueId(p)))

        if (newPosts.length === 0) {
          consecutiveNoProgress++
          console.log(`[Refresh] No new posts from batch of ${batchPosts.length} (stall ${consecutiveNoProgress}/${MAX_NO_PROGRESS})`)
          if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
            console.log(`[Refresh] No progress for ${MAX_NO_PROGRESS} fetches, stopping with ${accumulatedFiltered.length} posts`)
            break
          }
        } else {
          consecutiveNoProgress = 0
          accumulatedFiltered = [...accumulatedFiltered, ...newPosts]
          console.log(`[Refresh] Added ${newPosts.length} posts, total: ${accumulatedFiltered.length}`)
        }

        if (accumulatedFiltered.length >= 2 * pageLength) {
          console.log(`[Refresh] Reached target: ${accumulatedFiltered.length} posts`)
          break
        }

        // Find oldest timestamp from this batch for next fetch
        const oldestBatchTimestamp = Math.min(
          ...batchPosts.map(p => {
            const ts = batchTimestamps.size > 0
              ? (batchTimestamps.get(getPostUniqueId(p)) ?? batchTimestamps.get(p.post.uri) ?? null)
              : null
            return ts ?? getFeedViewPostTimestamp(p, feedReceivedTime).getTime()
          })
        )
        fetchBeforeTimestamp = oldestBatchTimestamp
      }

      if (accumulatedFiltered.length === 0) {
        console.log('[Refresh] No displayable posts found in cache, keeping existing feed')
        return null
      }

      // Cap at 2 * pageLength before alignment (loop can overshoot due to batch accumulation)
      if (accumulatedFiltered.length > 2 * pageLength) {
        accumulatedFiltered = accumulatedFiltered.slice(0, 2 * pageLength)
      }

      // Sort newest-first (should already be, but ensure consistency)
      accumulatedFiltered.sort((a, b) => {
        const tsA = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
        const tsB = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
        return tsB - tsA
      })

      // Align to page boundary
      const alignedPosts = alignFeedToPageBoundary(accumulatedFiltered, pageLength)

      // Update feed and timestamps
      setFeed(alignedPosts)

      const newNewestTimestamp = getFeedViewPostTimestamp(alignedPosts[0], feedReceivedTime).getTime()
      const newOldestTimestamp = getFeedViewPostTimestamp(alignedPosts[alignedPosts.length - 1], feedReceivedTime).getTime()

      // Always update newestDisplayedPostTimestamp — safe for existing callers
      // (pull-to-refresh/soft-refresh value ≈ old value; cache-only/post-curation need the update)
      setNewestDisplayedPostTimestamp(newNewestTimestamp)
      setOldestDisplayedPostTimestamp(newOldestTimestamp)

      // Update display cooldown timestamp
      lastDisplayTimeRef.current = clientNow()

      const firstPost = alignedPosts[0] as CurationFeedViewPost
      const lastPost = alignedPosts[alignedPosts.length - 1] as CurationFeedViewPost
      console.log(`[Refresh] Feed updated: ${alignedPosts.length} posts, newest=#${firstPost.curation?.curationNumber ?? '?'} (${new Date(newNewestTimestamp).toLocaleTimeString()}), oldest=#${lastPost.curation?.curationNumber ?? '?'} (${new Date(newOldestTimestamp).toLocaleTimeString()})`)

      // Step 4: Prefetch for Prev Page
      setPreviousPageFeed([])
      setInitialPrefetchDone(false)
      setTimeout(async () => {
        await prefetchPrevPage(newOldestTimestamp)
        setInitialPrefetchDone(true)
      }, 100)

      return { alignedPosts, newestTimestamp: newNewestTimestamp, oldestTimestamp: newOldestTimestamp }

    } catch (error) {
      console.error('[Refresh] Error during feed refresh:', error)
      return null
    }
  }, [agent, session, dbInitialized, isLoadingMore, activeTab, newestDisplayedPostTimestamp, lookupCurationAndFilter, prefetchPrevPage])

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

      // Clear post summaries
      const summariesTx = database.transaction(['post_summaries'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = summariesTx.objectStore('post_summaries').clear()
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

  // Reset feed only (preserve summaries, force initial load mode for on-the-fly curation)
  const resetFeedAndReloadHomePage = useCallback(async () => {
    console.log('[Debug] resetFeedAndReloadHomePage: Starting...')

    try {
      // 1. Clear sessionStorage feed state (clear both tabs)
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)
      console.log('[Debug] Cleared sessionStorage')

      // 2. Clear IndexedDB feed caches only (preserve summaries)
      const database = await initDB()

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
      setPreviousPageFeed([])
      setIsLoading(true)
      setIsInitialLoad(true)
      setInitialPrefetchDone(false)
      setNewestDisplayedPostTimestamp(null)
      setOldestDisplayedPostTimestamp(null)
      setNewPostsCount(0)
      setShowNewPostsButton(false)
      setLookingBack(false)
      setLookbackProgress(null)
      console.log('[Debug] Reset React state')

      // 4. Force initial load mode (summaries preserved, curatePosts will reuse them)
      forceInitialLoadRef.current = true
      // NOTE: Do NOT set isInitialCurationRef — no stats modal wanted
      console.log('[Debug] Set forceInitialLoadRef to true')

      // 5. Trigger fresh load (bypass cache)
      console.log('[Debug] Triggering fresh loadFeed with useCache=false...')
      await loadFeed(undefined, false)
      console.log('[Debug] resetFeedAndReloadHomePage: Complete!')

    } catch (error) {
      console.error('[Debug] resetFeedAndReloadHomePage failed:', error)
    }
  }, [loadFeed])

  // Expose reset functions globally
  useEffect(() => {
    (window as any).clearCacheAndReloadHomePage = clearCacheAndReloadHomePage;
    (window as any).resetFeedAndReloadHomePage = resetFeedAndReloadHomePage
    return () => {
      delete (window as any).clearCacheAndReloadHomePage;
      delete (window as any).resetFeedAndReloadHomePage
    }
  }, [clearCacheAndReloadHomePage, resetFeedAndReloadHomePage])

  useEffect(() => {
    // Only load/redisplay feed if we're on the home page
    if (location.pathname !== '/') {
      return
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

        const timeSinceSave = clientNow() - savedState.savedAt
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
  }, [loadFeed, redisplayFeed, location.pathname, session, activeTab])

  // Check for new posts periodically
  // Check for new posts - uses different logic based on paged updates mode
  // Standard mode: checks feed cache for posts already fetched and curated
  // Paged updates mode: probes server without caching to preserve access to newer posts
  useEffect(() => {
    if (!newestDisplayedPostTimestamp || !dbInitialized || !initialPrefetchDone) {
      // Reset count if no timestamp or still initializing
      setNewPostsCount(0)
      setShowNewPostsButton(false)
      setNextPageReady(false)
      return
    }

    const probeInProgressRef = { current: null as number | null }
    const PROBE_STALE_MS = 5 * 60 * 1000  // 5 minutes real time

    const checkForNewPosts = async () => {
      // Guard against overlapping invocations (e.g., interval fires while retryWithBackoff is sleeping)
      if (probeInProgressRef.current !== null) {
        const elapsed = clientNow() - probeInProgressRef.current
        if (elapsed < PROBE_STALE_MS) {
          console.log('[Paged Updates] Skipping probe — previous probe still in progress')
          return
        }
        console.log(`[Paged Updates] Previous probe stale (${Math.round(elapsed / 1000)}s), starting new probe`)
      }

      // Capture current timestamp to avoid stale closure
      const currentTimestamp = newestDisplayedPostTimestamp
      if (!currentTimestamp) return

      // Paged updates: probe server without caching
      if (!agent || !session) return

      probeInProgressRef.current = clientNow()
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
        // Force-probe bypasses cooldown (e.g., triggered by pull-to-refresh)
        const isForceProbe = forceProbeRef.current
        if (isForceProbe) {
          forceProbeRef.current = false
          console.log('[Paged Updates] Force-probe: bypassing cooldown')
        }
        const inCooldown = !isForceProbe && clientNow() - lastDisplayTimeRef.current < DISPLAY_COOLDOWN_MS
        if (inCooldown) {
          console.log(`[Paged Updates] In cooldown (${Math.round((DISPLAY_COOLDOWN_MS - (clientNow() - lastDisplayTimeRef.current)) / 1000)}s remaining), skipping button updates`)
          return
        }

        // Update multi-page count when multiple pages detected (for logging)
        if (hasMultiplePages) {
          setMultiPageCount(probeResult.filteredPostCount)
          console.log(`[Paged Updates] Multi-page detected: ${probeResult.filteredPostCount} posts (${probeResult.pageCount} pages)`)
        } else {
          setMultiPageCount(0)
        }

        // If Next Page button is already showing, don't change its partial/full designation.
        // This prevents "Next Page *" from upgrading to "Next Page" between probes,
        // which would change click behavior from boundary-aligned to full-page.
        if (nextPageReadyRef.current) {
          // Still update counts for idle timer and logging
          setNewPostsCount(probeResult.filteredPostCount)
          setPartialPageCount(probeResult.filteredPostCount)
          console.log(`[Paged Updates] Next Page already ready, skipping button state update (${probeResult.filteredPostCount} posts available)`)
          return
        }

        // Calculate partial page: can we reach the next page boundary with fewer than pageSize posts?
        let postsToNextBoundary = pageSize  // default: need full page
        let isPartialPage = false

        if (!hasFullPage && feed.length > 0) {
          const newestCurationNum = (feed[0] as CurationFeedViewPost).curation?.curationNumber
          if (newestCurationNum && newestCurationNum > 0) {
            const remainder = newestCurationNum % pageSize
            if (remainder !== 0) {
              postsToNextBoundary = pageSize - remainder
              if (probeResult.filteredPostCount >= postsToNextBoundary) {
                isPartialPage = true
              }
            }
          }
        }

        // Button logic:
        // - "Next Page" button: active when hasFullPage OR partial page can reach next boundary
        // - "All new posts" button: controlled by idle timer (see separate useEffect)
        setNextPageReady(hasFullPage || isPartialPage)
        setPostsNeededForPage(isPartialPage ? postsToNextBoundary : null)
        setNewPostsCount(probeResult.filteredPostCount)
        setPartialPageCount(probeResult.filteredPostCount) // Always track for idle timer
        setShowNewPostsButton(hasFullPage || isPartialPage) // For standard mode compatibility

        if (hasFullPage) {
          console.log(`[Paged Updates] Full page ready: ${probeResult.filteredPostCount} posts`)
        } else if (isPartialPage) {
          console.log(`[Paged Updates] Partial page ready: ${probeResult.filteredPostCount} posts (need ${postsToNextBoundary} to reach next boundary)`)
        } else {
          console.log(`[Paged Updates] Partial page: ${probeResult.filteredPostCount}/${pageSize} posts (idle timer will handle "All new posts" button)`)
        }
      } catch (error) {
        console.warn('[Paged Updates] Probe error:', error)
      } finally {
        probeInProgressRef.current = null
      }
    }

    // Check immediately
    checkForNewPosts()

    // Check every 60 seconds
    const interval = clientInterval(checkForNewPosts, 60000)

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
      clearClientInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [newestDisplayedPostTimestamp, dbInitialized, isInitialLoad, initialPrefetchDone, agent, session, forceProbeTrigger])

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
      const timeSinceTopPost = clientNow() - newestDisplayedPostTimestamp

      // Trigger "All new posts" button if idle time exceeded and any posts available
      // This is independent of nextPageReady - shows "All new posts" even when "Next Page" is active
      if (timeSinceTopPost >= fullPageWaitMs && partialPageCount > 0) {
        setIdleTimerTriggered(true)
        console.log(`[Idle Timer] Triggered: ${Math.round(timeSinceTopPost / 60000)} min elapsed, ${partialPageCount} posts available`)
      } else {
        setIdleTimerTriggered(false)
      }
    }

    // Check immediately and then every 30 seconds
    checkIdleTime()
    const interval = clientInterval(checkIdleTime, 30000)

    return () => clearClientInterval(interval)
  }, [newestDisplayedPostTimestamp, isInitialLoad, partialPageCount])

  // Desktop soft-refresh interceptor: Ctrl+R / Cmd+R / F5 → refreshDisplayedFeed instead of full page reload
  useEffect(() => {
    if (activeTab !== 'curated') return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isRefreshShortcut =
        e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && e.key === 'r')

      if (isRefreshShortcut) {
        e.preventDefault()
        console.log('[Refresh] Desktop soft-refresh intercepted')
        refreshDisplayedFeed()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, refreshDisplayedFeed])

  // Pull-to-refresh for mobile touch gesture
  const { isPulling, pullFraction } = usePullToRefresh({
    onRefresh: refreshDisplayedFeed,
    enabled: activeTab === 'curated' && !isLoading && !isLoadingMore,
  })

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

      // Capture partial page count before async operations (state may change)
      const effectivePageLength = postsNeededForPage ?? pageLength

      // Paged updates: use unified secondary cache flow for contiguous caching
      console.log(`[New Posts] SINGLE PAGE: Loading via unified fetch (effectivePageLength=${effectivePageLength})...`)

      setSyncInProgress(true)
      setSyncProgress(0)

      try {
        // Phase 1: Fetch posts to in-memory secondary cache until overlap with primary
        const fetchResult = await fetchToSecondaryFeedCache(
          agent,
          session.handle,
          session.did,
          'next_page',
          {
            pageLength,
            onProgress: (progress) => setSyncProgress(Math.round(progress * 0.8)),  // 0-80% for fetch
          }
        )
        console.log(`[New Posts] SINGLE PAGE: Fetched ${fetchResult.postsFetched} posts to secondary`)

        // Phase 2: Transfer oldest-first from in-memory secondary to primary until 1 page of displayable posts
        setSyncProgress(80)
        const transferResult = await transferSecondaryToPrimary(fetchResult.entries, 'page', effectivePageLength)
        setSyncProgress(100)
        console.log(`[New Posts] SINGLE PAGE: Transferred ${transferResult.postsTransferred} posts, ` +
          `${transferResult.displayableCount} displayable`)

        // Numbering is done inside transferSecondaryToPrimary

        // Clear UI state
        setNewPostsCount(0)
        setShowNewPostsButton(false)
        setNextPageReady(false)
        setPostsNeededForPage(null)
        setPartialPageCount(0)
        setMultiPageCount(0)
        setIdleTimerTriggered(false)
        lastDisplayTimeRef.current = clientNow()

        // Display transferred posts from primary cache using refreshDisplayedFeed
        if (fetchResult.newestTimestamp) {
          const result = await refreshDisplayedFeed({
            newestTimestamp: fetchResult.newestTimestamp,
            triggerProbe: false,
            showAllNewPosts: false,
          })

          // Save to sessionStorage using returned values
          if (result) {
            console.log(`[Next Page] Displayed ${result.alignedPosts.length} posts via refreshDisplayedFeed`)
            const stateToSave: SavedFeedState = {
              displayedFeed: result.alignedPosts,
              previousPageFeed: [],
              newestDisplayedPostTimestamp: result.newestTimestamp,
              oldestDisplayedPostTimestamp: result.oldestTimestamp,
              hasMorePosts: true,
              cursor: undefined,
              savedAt: clientNow(),
              lowestVisiblePostTimestamp: null,
              newPostsCount: 0,
              showNewPostsButton: false,
              sessionDid: session.did,
              curationSuspended: settings?.curationSuspended || false,
              showAllPosts: settings?.showAllPosts || false,
            }
            sessionStorage.setItem(getFeedStateKey('curated'), JSON.stringify(stateToSave))
          }
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
  }, [agent, session, newestDisplayedPostTimestamp, isLoadingMore, refreshDisplayedFeed, postsNeededForPage, lookingBack])

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

    // Check for extended idle - use feedRedisplayIdleInterval setting
    const settings = await getSettings()
    const idleThreshold = settings?.feedRedisplayIdleInterval ?? FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT * 60 * 1000
    const timeSinceTopPost = newestDisplayedPostTimestamp ? clientNow() - newestDisplayedPostTimestamp : 0
    const isExtendedIdle = newestDisplayedPostTimestamp !== null && timeSinceTopPost > idleThreshold

    // Treat as multi-page if 2+ pages detected OR extended idle (needs gap fill)
    const isMultiPage = multiPageCount >= 50 || isExtendedIdle

    if (isExtendedIdle) {
      console.log(`[New Posts] Extended idle detected: ${Math.round(timeSinceTopPost / 60000)} min exceeds ${Math.round(idleThreshold / 60000)} min threshold`)
    }

    if (isMultiPage) {
      // MULTI-PAGE FLOW: Unified fetch + transfer all
      console.log(`[New Posts] MULTI-PAGE: Using unified fetch (${multiPageCount} posts expected)`)

      setIsLoadingMore(true)
      setSyncInProgress(true)

      try {
        const pageLength = settings?.feedPageLength || 25

        // Phase 1: Fetch all new posts to in-memory secondary cache
        const fetchResult = await fetchToSecondaryFeedCache(
          agent,
          session.handle,
          session.did,
          'all_new',
          {
            pageLength,
            onProgress: (progress) => setSyncProgress(Math.round(progress * 0.8)),
          }
        )
        console.log(`[New Posts] MULTI-PAGE: Fetched ${fetchResult.postsFetched} posts to secondary`)

        if (fetchResult.postsFetched === 0) {
          addToast('No new posts available', 'info')
          return
        }

        // Phase 2: Transfer all to primary with numbering
        setSyncProgress(80)
        const transferResult = await transferSecondaryToPrimary(fetchResult.entries, 'all', pageLength)
        setSyncProgress(100)
        console.log(`[New Posts] MULTI-PAGE: Transferred ${transferResult.postsTransferred} posts, ` +
          `${transferResult.displayableCount} displayable`)

        // Reset all button states and set cooldown
        setNewPostsCount(0)
        setShowNewPostsButton(false)
        setNextPageReady(false)
        setPartialPageCount(0)
        setIdleTimerTriggered(false)
        setMultiPageCount(0)
        lastDisplayTimeRef.current = clientNow()

        // Display 1 page from primary cache using refreshDisplayedFeed
        if (fetchResult.newestTimestamp) {
          const result = await refreshDisplayedFeed({
            newestTimestamp: fetchResult.newestTimestamp,
            triggerProbe: false,
            showAllNewPosts: false,
          })
          if (result) {
            console.log(`[New Posts] MULTI-PAGE: Displayed ${result.alignedPosts.length} posts via refreshDisplayedFeed`)
          } else {
            addToast('No new posts to display (filtered by settings)', 'info')
          }
        } else {
          addToast('No new posts to display', 'info')
        }

        // Scroll to top
        isProgrammaticScrollRef.current = true
        window.scrollTo({ top: 0, behavior: 'smooth' })
        setTimeout(() => {
          isProgrammaticScrollRef.current = false
          lastScrollTopRef.current = window.scrollY
        }, 1000)

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
  }, [agent, session, isLoadingMore, multiPageCount, partialPageCount, handleLoadNewPosts, newestDisplayedPostTimestamp, refreshDisplayedFeed, lookingBack])

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
    const feedReceivedTime = clientDate()

    // Calculate deduplication BEFORE setFeed to determine correct next prefetch timestamp
    const existingUris = new Set(feed.map(p => getPostUniqueId(p)))
    const newPosts = previousPageFeed.filter(p => !existingUris.has(getPostUniqueId(p)))
    console.log(`[Prev Page] Appending ${newPosts.length} pre-fetched posts`)
    if (newPosts.length > 0) {
      const ppNewest = getFeedViewPostTimestamp(newPosts[0], feedReceivedTime).getTime()
      const ppOldest = getFeedViewPostTimestamp(newPosts[newPosts.length - 1], feedReceivedTime).getTime()
      const ppFirst = newPosts[0] as CurationFeedViewPost
      const ppLast = newPosts[newPosts.length - 1] as CurationFeedViewPost
      console.log(`[Prev Page DEBUG] Appending range: newest=${new Date(ppNewest).toLocaleTimeString()} (#${ppFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(ppOldest).toLocaleTimeString()} (#${ppLast.curation?.curationNumber ?? '?'})`)
    }
    if (feed.length > 0) {
      const feedOldest = getFeedViewPostTimestamp(feed[feed.length - 1], feedReceivedTime).getTime()
      const feedOldestPost = feed[feed.length - 1] as CurationFeedViewPost
      console.log(`[Prev Page DEBUG] Current feed oldest: ${new Date(feedOldest).toLocaleTimeString()} (#${feedOldestPost.curation?.curationNumber ?? '?'})`)
    }

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

    console.log(`[Prev Page DEBUG] nextPrefetchTimestamp=${new Date(nextPrefetchTimestamp).toLocaleTimeString()} (${nextPrefetchTimestamp})`)

    // Append pre-fetched posts to feed
    setFeed(prevFeed => [...prevFeed, ...newPosts])

    // Update pagination boundary
    setOldestDisplayedPostTimestamp(nextPrefetchTimestamp)

    // 2. Calculate target size for page boundary alignment (before clearing previousPageFeed)
    // Based on the oldest post AFTER this append (from newPosts), not the original feed
    const settings = await getSettings()
    const curationSuspended = !settings || settings?.curationSuspended
    const pageLength = settings?.feedPageLength || 25
    let targetSize: number | undefined = undefined  // undefined = use default pageLength

    if (!curationSuspended && newPosts.length > 0) {
      // Get curationNumber of oldest post AFTER this append
      const oldestPostAfterAppend = newPosts[newPosts.length - 1] as CurationFeedViewPost
      const oldestCurationNumber = oldestPostAfterAppend.curation?.curationNumber

      if (oldestCurationNumber && oldestCurationNumber > 0) {
        // Check if at page boundary: curationNumber should be (n * pageLength) + 1
        // i.e., 1, 26, 51, 76... for pageLength=25
        const positionInPage = (oldestCurationNumber - 1) % pageLength

        if (positionInPage !== 0) {
          // Not at boundary - fetch only enough to complete current page
          targetSize = positionInPage
          console.log(`[Prev Page] Aligning to boundary: need ${targetSize} posts to reach curationNumber ${oldestCurationNumber - positionInPage}`)
        }
      }
    }

    // 3. Clear previousPageFeed and show loading spinner
    setPreviousPageFeed([])
    setIsPrefetching(true)

    // 4. Pre-fetch next page (awaited so we can update UI after)
    await prefetchPrevPage(nextPrefetchTimestamp, targetSize)
    setIsPrefetching(false)
  }, [feed, previousPageFeed, isPrefetching, lookingBack, prefetchPrevPage])

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

  // Start a dwell timer for a post that is visible and stationary.
  // After VIEW_DWELL_TIME_MS of continuous visibility without scrolling, mark the post as viewed.
  const startDwellTimer = useCallback((postId: string, el: HTMLElement) => {
    // Don't start if already has a timer or already viewed
    if (dwellTimersRef.current.has(postId)) return
    if (viewedPostIdsRef.current.has(postId)) return

    const timerId = setTimeout(() => {
      dwellTimersRef.current.delete(postId)
      visiblePostElementsRef.current.delete(postId)

      // Guard: re-check not already viewed (race condition protection)
      if (viewedPostIdsRef.current.has(postId)) return

      // Mark as viewed: same pipeline as before (IndexedDB + batched React state)
      viewedPostIdsRef.current.add(postId)
      viewTrackingObserverRef.current?.unobserve(el)

      const now = clientNow()
      updatePostSummaryViewedAt(postId, now)
      markPostViewed(postId)

      pendingViewedUpdatesRef.current.set(postId, now)
      if (!viewedUpdateScheduledRef.current) {
        viewedUpdateScheduledRef.current = true
        requestAnimationFrame(() => {
          viewedUpdateScheduledRef.current = false
          const updates = new Map(pendingViewedUpdatesRef.current)
          pendingViewedUpdatesRef.current.clear()
          setFeed(prev => prev.map(p => {
            const id = getPostUniqueId(p)
            const vt = updates.get(id)
            if (vt && 'curation' in p) {
              const cp = p as CurationFeedViewPost
              // Don't overwrite existing viewedAt (first view wins)
              if (cp.curation?.viewedAt) return p
              return { ...cp, curation: { ...cp.curation, viewedAt: vt } } as CurationFeedViewPost
            }
            return p
          }))
        })
      }
    }, VIEW_DWELL_TIME_MS)

    dwellTimersRef.current.set(postId, timerId)
  }, [])

  // Scroll listener for dwell-time tracking: cancel dwell timers while scrolling,
  // restart them when scrolling stops (after SCROLL_STOP_DEBOUNCE_MS of inactivity)
  useEffect(() => {
    const handleScroll = () => {
      isScrollingRef.current = true

      // Cancel all active dwell timers (scrolling invalidates them)
      for (const timerId of dwellTimersRef.current.values()) {
        clearTimeout(timerId)
      }
      dwellTimersRef.current.clear()

      // Reset scroll-stop debounce
      if (scrollStopDebounceRef.current !== null) {
        clearTimeout(scrollStopDebounceRef.current)
      }
      scrollStopDebounceRef.current = setTimeout(() => {
        isScrollingRef.current = false
        scrollStopDebounceRef.current = null

        // Restart dwell timers for all currently-visible, not-yet-viewed posts
        for (const [postId, el] of visiblePostElementsRef.current) {
          if (viewedPostIdsRef.current.has(postId)) continue
          startDwellTimer(postId, el)
        }
      }, SCROLL_STOP_DEBOUNCE_MS)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (scrollStopDebounceRef.current !== null) {
        clearTimeout(scrollStopDebounceRef.current)
      }
      for (const timerId of dwellTimersRef.current.values()) {
        clearTimeout(timerId)
      }
      dwellTimersRef.current.clear()
    }
  }, [startDwellTimer])

  // IntersectionObserver for post view tracking with dwell-time requirement.
  // Posts must remain 50% visible and stationary for VIEW_DWELL_TIME_MS to be marked as viewed.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement
          const uniqueId = el.dataset.postId
          if (!uniqueId) continue

          if (entry.isIntersecting) {
            // Post entered 50% visibility
            if (viewedPostIdsRef.current.has(uniqueId)) {
              observer.unobserve(el)
              continue
            }
            // Track as visible; start dwell timer if not scrolling
            visiblePostElementsRef.current.set(uniqueId, el)
            if (!isScrollingRef.current) {
              startDwellTimer(uniqueId, el)
            }
            // If scrolling, the scroll-stop handler will start the timer later
          } else {
            // Post left visibility: cancel any pending dwell timer
            visiblePostElementsRef.current.delete(uniqueId)
            const timerId = dwellTimersRef.current.get(uniqueId)
            if (timerId !== undefined) {
              clearTimeout(timerId)
              dwellTimersRef.current.delete(uniqueId)
            }
            // Do NOT unobserve: post may re-enter visibility on scroll-back
          }
        }
      },
      { threshold: 0.5 }
    )
    viewTrackingObserverRef.current = observer
    return () => {
      observer.disconnect()
      viewTrackingObserverRef.current = null
      visiblePostElementsRef.current.clear()
    }
  }, [startDwellTimer])

  // Observe post elements for view tracking whenever feed changes
  // Use requestAnimationFrame to ensure React has committed DOM updates before querying
  useEffect(() => {
    const observer = viewTrackingObserverRef.current
    if (!observer) return
    const rafId = requestAnimationFrame(() => {
      // Build set of posts that already have viewedAt from hydration (e.g., after navigation back)
      // These should not be re-observed since their viewedAt is already set
      const alreadyViewedFromFeed = new Set<string>()
      for (const p of feed) {
        if ('curation' in p && (p as CurationFeedViewPost).curation?.viewedAt) {
          alreadyViewedFromFeed.add(getPostUniqueId(p))
        }
      }

      const postElements = document.querySelectorAll('[data-post-id]')
      postElements.forEach(el => {
        const uniqueId = (el as HTMLElement).dataset.postId
        if (!uniqueId) return
        if (viewedPostIdsRef.current.has(uniqueId)) return
        // Skip posts that already have viewedAt from cache hydration
        if (alreadyViewedFromFeed.has(uniqueId)) {
          viewedPostIdsRef.current.add(uniqueId)
          return  // Don't observe - already viewed
        }
        observer.observe(el)
      })
    })
    return () => cancelAnimationFrame(rafId)
  }, [feed])

  // Subscribe to Skyspeed server commands (CLICK, SCROLL, SCROLL TO)
  useEffect(() => {
    const handleCommand = (command: SkyspeedCommand) => {
      if (command.type === 'CLICK') {
        console.log(`[Skyspeed Command] Executing: CLICK ${command.buttonName}`)
        switch (command.buttonName) {
          case 'NextPage':
            handleLoadNewPosts()
            break
          case 'AllNewPosts':
            handleLoadAllNewPosts()
            break
          case 'PrevPage':
            handlePrevPage()
            break
        }
      } else if (command.type === 'SCROLL') {
        console.log(`[Skyspeed Command] Executing: SCROLL ${command.direction}`)
        switch (command.direction) {
          case 'TOP':
            window.scrollTo({ top: 0, behavior: 'smooth' })
            break
          case 'BOTTOM':
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
            break
        }
      } else if (command.type === 'FIND') {
        console.log(`[Skyspeed Command] Executing: FIND ${command.target}`)
        const target = command.target

        // Search displayed posts for the target
        let matchUri: string | null = null

        if (target.startsWith('@')) {
          // Match by author handle
          const handle = target.slice(1)
          const match = feed.find(p => p.post.author.handle === handle)
          if (match) matchUri = match.post.uri
        } else if (/^\d{1,3}:\d{2}$/.test(target)) {
          // Match by timestamp (HH:MM)
          const [h, m] = target.split(':').map(Number)
          const targetMinutes = h * 60 + m
          const match = feed.find(p => {
            const ts = getFeedViewPostTimestamp(p)
            const d = new Date(ts)
            const postMinutes = d.getHours() * 60 + d.getMinutes()
            return postMinutes === targetMinutes
          })
          if (match) matchUri = match.post.uri
        } else if (target.startsWith('#')) {
          // Match by curation counter number
          const num = parseInt(target.slice(1), 10)
          if (!isNaN(num)) {
            const match = feed.find(p => {
              const curation = 'curation' in p ? (p as CurationFeedViewPost).curation : undefined
              return curation?.curationNumber === num || curation?.postNumber === num
            })
            if (match) matchUri = match.post.uri
          }
        } else {
          // Free text search (case-insensitive)
          const lowerTarget = target.toLowerCase()
          const match = feed.find(p => {
            const record = p.post.record as { text?: string }
            return record?.text?.toLowerCase().includes(lowerTarget)
          })
          if (match) matchUri = match.post.uri
        }

        if (matchUri) {
          const el = document.querySelector(`[data-post-uri="${matchUri}"]`)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          } else {
            console.warn(`[Skyspeed Command] FIND: DOM element not found for URI ${matchUri}`)
          }
        } else {
          console.warn(`[Skyspeed Command] FIND: No matching post found for "${target}"`)
        }
      }
    }

    onSkyspeedCommand(handleCommand)
    return () => offSkyspeedCommand(handleCommand)
  }, [feed, handleLoadNewPosts, handleLoadAllNewPosts, handlePrevPage])

  // Subscribe to unviewed tracker mutations so the memo below recomputes
  useEffect(() => {
    return onUnviewedChange((rev) => setUnviewedRevision(rev))
  }, [])

  // Compute label for unviewed posts next to Prev Page button
  // Shows above/below split relative to the oldest displayed post timestamp
  const prevPageUnviewedLabel: string | null = useMemo(() => {
    if (previousPageFeed.length === 0) return null
    const { count: totalUnviewed, boundary } = getUnviewedPostsInfo()
    if (boundary === 0) return null // stats not yet computed
    if (totalUnviewed === 0) return null
    if (!oldestDisplayedPostTimestamp) {
      return `(${totalUnviewed} unviewed posts below within last 24 hours)`
    }
    const below = countUnviewedOlderThan(oldestDisplayedPostTimestamp)
    // const above = totalUnviewed - below  // computed but not displayed for now
    if (below === 0) return null
    return `(${below} unviewed posts below within last 24 hours)`
  }, [previousPageFeed, oldestDisplayedPostTimestamp, feed, unviewedRevision])

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
        savedAt: clientNow(),
        lowestVisiblePostTimestamp,
        newPostsCount,
        showNewPostsButton,
        sessionDid: session?.did || '',
        curationSuspended,
        showAllPosts
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
      
      {/* Skylimit Summary Header - initialization indicator or normal summary */}
      {(!initialPrefetchDone || skylimitStats) && (
        <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center">
          {skylimitStats ? (
            <div className="flex items-center gap-4 text-sm w-full">
              <a
                href="https://github.com/mitotic/skylimit-alpha#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline font-semibold"
                title="About Skylimit"
              >
                About Skylimit
              </a>
              <div className="flex items-center gap-4 ml-auto">
                {getNonStandardServerName() && (
                  <span className="text-orange-500 dark:text-orange-400 font-medium">
                    {getNonStandardServerName()}
                  </span>
                )}
                <AcceleratedClock />
                <div className="text-gray-600 dark:text-gray-400">
                  <span className="font-semibold cursor-pointer hover:underline text-blue-600 dark:text-blue-400" onClick={() => navigate('/settings?tab=following')}>{skylimitStats.post_daily.toFixed(0)}</span> posts/day received
                </div>
                <div className="text-gray-500 dark:text-gray-400 text-base font-bold mx-[-4px]">→</div>
                <div className="text-gray-600 dark:text-gray-400">
                  {curationSuspended ? (
                    <span className="text-orange-500 dark:text-orange-400">(curation suspended)</span>
                  ) : (
                    <><span className="font-semibold cursor-pointer hover:underline text-blue-600 dark:text-blue-400" onClick={() => navigate('/settings?tab=curation')}>~{skylimitStats.shown_daily.toFixed(0)}</span> displayed</>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Spinner size="sm" />
              <span>Initializing...{lookbackProgress !== null ? ` (${lookbackProgress}%)` : ''}</span>
            </div>
          )}
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
        {feed.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>No posts to show. Follow some users to see their posts here!</p>
          </div>
        ) : (
          <>
            {/* Pull-to-refresh indicator */}
            {isPulling && (
              <div
                className="flex items-center justify-center py-2 text-gray-500 dark:text-gray-400 transition-opacity"
                style={{ opacity: pullFraction }}
              >
                <svg
                  className="w-5 h-5 mr-2 animate-spin"
                  style={{ animationDuration: pullFraction >= 1 ? '0.6s' : '1.5s' }}
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm">
                  {pullFraction >= 1 ? 'Release to refresh' : 'Pull to refresh'}
                </span>
              </div>
            )}

            {/* Next Page / All New Posts buttons - hidden during initialization */}
            {initialPrefetchDone && (
            <div className="sticky top-0 z-30 p-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
              <div className="flex gap-2">
                {/* "Next Page" button - always visible, grayed out when inactive or during lookback */}
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    console.log('[Next Page] Button clicked', { newPostsCount, isLoadingMore, nextPageReady, lookingBack })
                    handleLoadNewPosts()
                  }}
                  disabled={isLoadingMore || !nextPageReady || lookingBack}
                  className={`btn inline-flex items-center gap-2 ${
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
                      <span>▲</span>
                      Next Page{postsNeededForPage !== null ? ' *' : ''}
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
                        <svg className="w-4 h-4 inline-block" viewBox="0 0 24 24" fill="currentColor"><polygon points="4,21 12,11 20,21" /><polygon points="4,13 12,3 20,13" /></svg>
                        All new posts ({partialPageCount}+)
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
            )}

            {feed.map((post, index) => (
              <div
                key={getPostUniqueId(post)}
                ref={index === 0 ? firstPostRef : null}
                data-post-uri={post.post.uri}
                data-post-id={getPostUniqueId(post)}
              >
                <PostCard
                  post={post}
                  onReply={handleReply}
                  onRepost={handleRepost}
                  onQuotePost={handleQuotePost}
                  onLike={handleLike}
                  onBookmark={handleBookmark}
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
          <div className="p-4 flex items-center gap-3">
            {isPrefetching ? (
              // State 1: After clicking Prev Page, prefetching next page - show spinner
              <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                <Spinner size="sm" />
                <span>Loading...</span>
              </div>
            ) : previousPageFeed.length > 0 ? (
              // State 2: More posts available - show Prev Page button + unviewed label
              <>
                <button
                  onClick={handlePrevPage}
                  disabled={syncInProgress}
                  className="btn btn-primary inline-flex items-center gap-2"
                >
                  {syncInProgress ? (
                    <>
                      <Spinner size="sm" />
                      Synchronizing... {syncProgress}%
                    </>
                  ) : (
                    <>
                      <span>▼</span>
                      Prev Page
                    </>
                  )}
                </button>
                {prevPageUnviewedLabel && (
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {prevPageUnviewedLabel}
                  </span>
                )}
              </>
            ) : !isLoading && feed.length > 0 ? (
              // State 3: Initializing or No more posts
              !initialPrefetchDone ? (
                // Still initializing (prefetch not complete yet)
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
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
        replyTo={replyToUri ? feed.find(p => p.post.uri === replyToUri)?.post ? {
          uri: replyToUri,
          cid: feed.find(p => p.post.uri === replyToUri)!.post.cid,
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

