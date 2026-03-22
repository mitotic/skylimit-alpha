import { useState, useEffect, useCallback, useRef } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import type { BskyAgent } from '@atproto/api'
import { getHomeFeed } from '../api/feed'
import { CurationInitStatsDisplay } from '../components/CurationInitModal'
import { RecurateResultStats } from '../components/RecurateResultModal'
import { initDB, closeDB, getFilter, getPostSummary, isPostSummariesCacheEmpty, getCurationInitStats, checkPostSummaryExists, isSummariesCacheFresh, clearAllTimeVariantDataAndLogout, clearRecentData } from '../curation/skylimitCache'
import { getSettings } from '../curation/skylimitStore'
import { probeForNewPosts, FETCH_BATCH_SIZE, getPagedUpdatesSettings } from '../curation/pagedUpdates'
import { flushExpiredParentPosts } from '../curation/parentPostCache'
import { scheduleStatsComputation, computeStatsInBackground } from '../curation/skylimitStatsWorker'
import { recomputeCurationDecisions } from '../curation/skylimitRecurate'
import { GlobalStats, CurationFeedViewPost, SecondaryEntry, getIntervalHoursSync, isStatusShow } from '../curation/types'
import { getCachedFeed, clearFeedCache, clearFeedMetadata, getLastFetchMetadata, getCachedFeedBefore, updateFeedCacheOldestPostTimestamp, getCachedFeedAfterPosts, shouldUseCacheOnLoad, createFeedCacheEntries, savePostsWithCuration, validateFeedCacheIntegrity, getLocalMidnight, getNextLocalMidnight, getPrevLocalMidnight, fetchPageFromTimestamp, isCacheWithinLookback, getNewestCachedPostTimestamp, getFreshPrevPageCursor, clearPrevPageCursor, getPrevPageCursorStatus, markInitialLookbackCompleted, fetchToSecondaryFeedCache, transferSecondaryToPrimary, curateEntriesToSecondary, secondaryEntriesToCuratedFeed, filterSecondaryForDisplay, recurateFromCache } from '../curation/skylimitFeedCache'
import { getPostUniqueId, getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { numberUnnumberedPostsForDay, assignNumbersForDay, assignAllNumbers } from '../curation/skylimitNumbering'
import { clientNow, clientDate, clientTimeout, clearClientTimeout, clientInterval, clearClientInterval } from '../utils/clientClock'
import { isRateLimited, getTimeUntilClear } from '../utils/rateLimitState'
import { isTabDormant } from '../utils/tabGuard'
import { HomeTab, getFeedStateKey, getScrollStateKey, HOME_TAB_STATE_KEY, DEFAULT_MAX_DISPLAYED_FEED_SIZE, SavedFeedState, findLowestVisiblePostTimestamp, alignFeedToPageBoundary, RefreshDisplayedFeedOptions, RefreshDisplayedFeedResult } from './homePageTypes'
import log from '../utils/logger'

// Persists the initial page of curated posts across component remounts.
// Used to redisplay the initial page if the user navigates away during lookback.
let initialPagePosts: CurationFeedViewPost[] | null = null

// Persists retained secondary cache across component remounts.
// Used for faster "Next Page" — avoids re-fetching when cache is fresh.
// partPagePostCount: 0 for idle-time fetches, >0 for probe partial page completion
let retainedSecondaryCache: {
  entries: SecondaryEntry[]
  fetchedAt: number
  newestTimestamp: number | null
  partPagePostCount: number
} | null = null

export function getRetainedSecondaryCache() { return retainedSecondaryCache }
export function setRetainedSecondaryCache(cache: typeof retainedSecondaryCache) {
  retainedSecondaryCache = cache
  if (cache) {
    const displayable = cache.entries.filter(e => isStatusShow(e.summary.curation_status)).length
    log.debug('Retained Cache', `Created: raw=${cache.entries.length}, displayable=${displayable}, partPagePostCount=${cache.partPagePostCount}`)
  }
}
export function clearRetainedSecondaryCache() { retainedSecondaryCache = null }

/** Check if the retained secondary cache is valid (fresh and has enough displayable posts).
 *  For probe-retained caches (partPagePostCount > 0), uses that as the minimum threshold.
 *  For fetch-retained caches (partPagePostCount === 0), requires a full page of displayable posts. */
export async function isRetainedCacheValid(): Promise<boolean> {
  const cached = retainedSecondaryCache
  if (!cached) return false
  const pagedSettings = await getPagedUpdatesSettings()
  const cacheAge = clientNow() - cached.fetchedAt
  if (cacheAge >= pagedSettings.fullPageWaitMinutes * 60 * 1000) return false
  const displayable = cached.entries.filter(e => isStatusShow(e.summary.curation_status)).length
  const minRequired = cached.partPagePostCount > 0 ? cached.partPagePostCount : pagedSettings.pageSize
  return displayable >= minRequired
}

interface UseFeedPipelineParams {
  agent: BskyAgent | null
  session: { did: string; handle: string } | null
  activeTab: HomeTab
  scrollRestoredRef: React.MutableRefObject<boolean>
  addToast: (message: string, type: 'success' | 'error' | 'info') => void
  setRateLimitStatus: (status: any) => void
  locationPathname: string
}

export interface UseFeedPipelineReturn {
  // State
  feed: AppBskyFeedDefs.FeedViewPost[]
  setFeed: React.Dispatch<React.SetStateAction<AppBskyFeedDefs.FeedViewPost[]>>
  previousPageFeed: AppBskyFeedDefs.FeedViewPost[]
  setPreviousPageFeed: React.Dispatch<React.SetStateAction<AppBskyFeedDefs.FeedViewPost[]>>
  isPrefetching: boolean
  setIsPrefetching: React.Dispatch<React.SetStateAction<boolean>>
  feedTopTrimmed: number | null
  setFeedTopTrimmed: React.Dispatch<React.SetStateAction<number | null>>
  initialPrefetchDone: boolean
  setInitialPrefetchDone: React.Dispatch<React.SetStateAction<boolean>>
  cursor: string | undefined
  hasMorePosts: boolean
  serverCursor: string | undefined
  isLoading: boolean
  isLoadingMore: boolean
  setIsLoadingMore: React.Dispatch<React.SetStateAction<boolean>>
  dbInitialized: boolean
  skylimitStats: GlobalStats | null
  curationSuspended: boolean
  showAllPosts: boolean
  newestDisplayedPostTimestamp: number | null
  setNewestDisplayedPostTimestamp: React.Dispatch<React.SetStateAction<number | null>>
  oldestDisplayedPostTimestamp: number | null
  setOldestDisplayedPostTimestamp: React.Dispatch<React.SetStateAction<number | null>>
  isInitialLoad: boolean
  lookingBack: boolean
  lookbackProgress: number | null
  lookbackMessage: string
  initPhase: 'posts' | 'follows' | null
  showCurationInitModal: boolean
  setShowCurationInitModal: React.Dispatch<React.SetStateAction<boolean>>
  curationInitStats: CurationInitStatsDisplay | null
  showRefreshResultModal: boolean
  setShowRefreshResultModal: React.Dispatch<React.SetStateAction<boolean>>
  refreshResultStats: RecurateResultStats | null
  refreshResultTitle: string
  // Paged updates state
  newPostsCount: number
  setNewPostsCount: React.Dispatch<React.SetStateAction<number>>
  showNewPostsButton: boolean
  setShowNewPostsButton: React.Dispatch<React.SetStateAction<boolean>>
  nextPageReady: boolean
  setNextPageReady: React.Dispatch<React.SetStateAction<boolean>>
  partialPageCount: number
  setPartialPageCount: React.Dispatch<React.SetStateAction<number>>
  postsNeededForPage: number | null
  setPostsNeededForPage: React.Dispatch<React.SetStateAction<number | null>>
  multiPageCount: number
  setMultiPageCount: React.Dispatch<React.SetStateAction<number>>
  idleTimerTriggered: boolean
  setIdleTimerTriggered: React.Dispatch<React.SetStateAction<boolean>>
  syncInProgress: boolean
  setSyncInProgress: React.Dispatch<React.SetStateAction<boolean>>
  syncProgress: number
  setSyncProgress: React.Dispatch<React.SetStateAction<number>>
  infiniteScrollingEnabled: boolean
  // Refs
  loadFeedRef: React.MutableRefObject<((cursor?: string, useCache?: boolean) => Promise<void>) | null>
  previousPageFeedRef: React.MutableRefObject<CurationFeedViewPost[]>
  isPrefetchingRef: React.MutableRefObject<boolean>
  prevPageHadUnnumberedRef: React.MutableRefObject<boolean>
  lastDisplayTimeRef: React.MutableRefObject<number>
  forceProbeRef: React.MutableRefObject<boolean>
  probeExpectedCountRef: React.MutableRefObject<number>
  nextPageReadyRef: React.MutableRefObject<boolean>
  probeBoundaryTimestampRef: React.MutableRefObject<number | null>
  unprocessedRawCountRef: React.MutableRefObject<number>
  unprocessedShowCountRef: React.MutableRefObject<number>
  probeHasGapRef: React.MutableRefObject<boolean>
  idleTimerForcedRef: React.MutableRefObject<boolean>
  // Callbacks
  loadFeed: (cursor?: string, useCache?: boolean) => Promise<void>
  redisplayFeed: () => Promise<void>
  refreshDisplayedFeed: (options?: RefreshDisplayedFeedOptions) => Promise<RefreshDisplayedFeedResult | null>
  clearCacheAndReloadHomePage: () => Promise<void>
  resetFeedAndReloadHomePage: () => Promise<void>
  clearRecentAndReloadHomePage: () => Promise<void>
  recurateAndReloadHomePage: () => Promise<void>
  prefetchPrevPage: (afterTimestamp: number, targetSize?: number) => Promise<void>
  lookupCurationAndFilter: (posts: CurationFeedViewPost[], feedReceivedTime: Date, postTimestamps?: Map<string, number>, skipFiltering?: boolean) => Promise<CurationFeedViewPost[]>
  trimFeedIfNeeded: (combinedFeed: CurationFeedViewPost[], pageSize: number, feedReceivedTime: Date, maxDisplayedFeedSize?: number) => CurationFeedViewPost[]
  forceProbeTrigger: number
  setForceProbeTrigger: React.Dispatch<React.SetStateAction<number>>
}

export function useFeedPipeline({
  agent,
  session,
  activeTab,
  scrollRestoredRef,
  addToast,
  setRateLimitStatus,
  locationPathname,
}: UseFeedPipelineParams): UseFeedPipelineReturn {
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [previousPageFeed, setPreviousPageFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [isPrefetching, setIsPrefetching] = useState(false)
  const [feedTopTrimmed, setFeedTopTrimmed] = useState<number | null>(null)
  const [initialPrefetchDone, setInitialPrefetchDone] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  const [hasMorePosts, setHasMorePosts] = useState(false)
  const [serverCursor, setServerCursor] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [dbInitialized, setDbInitialized] = useState(false)
  const [skylimitStats, setSkylimitStats] = useState<GlobalStats | null>(null)
  const [curationSuspended, setCurationSuspended] = useState(false)
  const [showAllPosts, setShowAllPosts] = useState(false)
  const [newestDisplayedPostTimestamp, setNewestDisplayedPostTimestamp] = useState<number | null>(null)
  const [oldestDisplayedPostTimestamp, setOldestDisplayedPostTimestamp] = useState<number | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [lookingBack, setLookingBack] = useState(false)
  const [lookbackProgress, setLookbackProgress] = useState<number | null>(null)
  const [lookbackMessage, setLookbackMessage] = useState('Fetching posts')
  const [initPhase, setInitPhase] = useState<'posts' | 'follows' | null>(null)
  const [showCurationInitModal, setShowCurationInitModal] = useState(false)
  const [curationInitStats, setCurationInitStats] = useState<CurationInitStatsDisplay | null>(null)
  const [showRefreshResultModal, setShowRefreshResultModal] = useState(false)
  const [refreshResultStats, setRefreshResultStats] = useState<RecurateResultStats | null>(null)
  const [refreshResultTitle, setRefreshResultTitle] = useState('Re-curation complete')
  const refetchPendingRef = useRef(false)
  // Paged updates state
  const [newPostsCount, setNewPostsCount] = useState(0)
  const [showNewPostsButton, setShowNewPostsButton] = useState(false)
  const [nextPageReady, setNextPageReady] = useState(false)
  const nextPageReadyRef = useRef(false)
  nextPageReadyRef.current = nextPageReady
  const [partialPageCount, setPartialPageCount] = useState(0)
  const [postsNeededForPage, setPostsNeededForPage] = useState<number | null>(null)
  const [multiPageCount, setMultiPageCount] = useState(0)
  const [idleTimerTriggered, setIdleTimerTriggered] = useState(false)
  const [syncInProgress, setSyncInProgress] = useState(false)
  const [syncProgress, setSyncProgress] = useState(0)
  const [infiniteScrollingEnabled, setInfiniteScrollingEnabled] = useState(false)
  const [forceProbeTrigger, setForceProbeTrigger] = useState(0)

  // Refs
  const loadFeedRef = useRef<((cursor?: string, useCache?: boolean) => Promise<void>) | null>(null)
  const probeExpectedCountRef = useRef<number>(0)
  const lastDisplayTimeRef = useRef<number>(0)
  const DISPLAY_COOLDOWN_MS = 30000
  const forceProbeRef = useRef(false)
  // Probe boundary optimization: track already-probed range to avoid redundant API work
  const probeBoundaryTimestampRef = useRef<number | null>(null)
  const unprocessedRawCountRef = useRef<number>(0)
  const unprocessedShowCountRef = useRef<number>(0)
  const probeHasGapRef = useRef<boolean>(false)
  const idleTimerForcedRef = useRef<boolean>(false)
  const isInitialCurationRef = useRef(false)
  const forceInitialLoadRef = useRef(false)
  const previousPageFeedRef = useRef<CurationFeedViewPost[]>([])
  const isPrefetchingRef = useRef(false)
  const prevPageHadUnnumberedRef = useRef(false)
  const resetPendingRef = useRef(false)
  const lookbackInProgressRef = useRef(false)
  const lookbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Sync refs for IntersectionObserver callback (avoids stale closures)
  useEffect(() => {
    previousPageFeedRef.current = previousPageFeed
  }, [previousPageFeed])

  useEffect(() => {
    isPrefetchingRef.current = isPrefetching
  }, [isPrefetching])

  // Load infinite scrolling setting
  useEffect(() => {
    const loadInfiniteScrollingSetting = async () => {
      try {
        const settings = await getSettings()
        setInfiniteScrollingEnabled(settings?.infiniteScrollingOption || false)
      } catch (error) {
        log.warn('Init', 'Failed to load infinite scrolling setting:', error)
        setInfiniteScrollingEnabled(false)
      }
    }

    if (dbInitialized) {
      loadInfiniteScrollingSetting()
    }
  }, [dbInitialized])

  // Initialize IndexedDB and schedule stats computation
  useEffect(() => {
    let cleanup: (() => void) | null = null

    initDB().then(async () => {
      const integrity = await validateFeedCacheIntegrity()
      if (integrity.cleared || integrity.empty) {
        if (integrity.cleared) {
          log.info('Init', 'Feed cache was cleared due to missing summaries')
        }
        if (integrity.empty) {
          log.debug('Init', 'Feed cache is empty')
        }
        sessionStorage.removeItem(getFeedStateKey('curated'))
        log.debug('Init', 'Cleared sessionStorage saved feed state')
      }

      const summariesEmpty = await isPostSummariesCacheEmpty()
      if (summariesEmpty) {
        log.info('Init', 'Summaries cache is empty - initial curation will be performed')
        isInitialCurationRef.current = true
      }

      log.debug('Init', 'Setting dbInitialized=true')
      setDbInitialized(true)

      if (agent && session) {
        cleanup = scheduleStatsComputation(agent, session.handle, session.did)
      }

      loadSkylimitStats()

      flushExpiredParentPosts().catch(err => {
        log.warn('Init', 'Failed to flush expired parent posts:', err)
      })
    }).catch(err => {
      log.error('Init', 'Failed to initialize database:', err)
      setDbInitialized(true)
    })

    return () => {
      if (cleanup) cleanup()
      closeDB()
    }
  }, [agent, session])

  // Periodically flush expired parent posts (every hour)
  useEffect(() => {
    if (!dbInitialized) return

    const flushInterval = clientInterval(() => {
      if (isTabDormant()) return
      flushExpiredParentPosts().catch(err => {
        log.warn('Feed', 'Failed to flush expired parent posts:', err)
      })
    }, 60 * 60 * 1000)

    return () => clearClientInterval(flushInterval)
  }, [dbInitialized])

  // Save feed state whenever it changes (debounced) - only for curated tab
  useEffect(() => {
    if (locationPathname !== '/') return
    if (activeTab !== 'curated') return
    if (isLoading) return
    if (feed.length === 0) return

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
        sessionDid: session?.did || '',
        curationSuspended: settings?.curationSuspended || false,
        showAllPosts: settings?.showAllPosts || false
      }

      try {
        sessionStorage.setItem(getFeedStateKey(activeTab), JSON.stringify(feedState))
      } catch (error) {
        log.warn('Feed', 'Failed to save feed state:', error)
      }
    }, 1000)

    return () => clearClientTimeout(timeoutId)
  }, [locationPathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, isLoading, newPostsCount, showNewPostsButton, session, activeTab])

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
      log.error('Feed', 'Failed to load Skylimit stats:', error)
    }
  }, [])

  // Reload stats when feed is loaded
  useEffect(() => {
    if (dbInitialized && feed.length > 0) {
      loadSkylimitStats()
    }
  }, [dbInitialized, feed.length, loadSkylimitStats])

  // Helper function to look up curation status and filter posts
  const lookupCurationAndFilter = useCallback(async (
    posts: CurationFeedViewPost[],
    feedReceivedTime: Date,
    postTimestamps?: Map<string, number>,
    skipFiltering: boolean = false
  ): Promise<CurationFeedViewPost[]> => {
    const postsWithStatus = await Promise.all(
      posts.map(async (post) => {
        const uniqueId = getPostUniqueId(post)
        const summary = await getPostSummary(uniqueId)

        const curation: any = {}
        if (summary?.curation_status) {
          curation.curation_status = summary.curation_status
        }
        if (summary?.curation_msg) {
          curation.curation_msg = summary.curation_msg
        }
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
          curation: Object.keys(curation).length > 0 ? curation : {}
        } as CurationFeedViewPost
      })
    )

    const sortByTimestamp = (posts: CurationFeedViewPost[]) => {
      posts.sort((a, b) => {
        let aTime: number
        let bTime: number

        if (postTimestamps) {
          const aUniqueId = getPostUniqueId(a)
          const bUniqueId = getPostUniqueId(b)
          aTime = postTimestamps.get(aUniqueId) ?? postTimestamps.get(a.post.uri) ?? 0
          bTime = postTimestamps.get(bUniqueId) ?? postTimestamps.get(b.post.uri) ?? 0
        } else {
          aTime = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          bTime = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
        }

        return bTime - aTime
      })
    }

    if (skipFiltering) {
      sortByTimestamp(postsWithStatus)
      return postsWithStatus
    }

    const settings = await getSettings()
    const curationSuspended = !settings || settings?.curationSuspended
    const showAllPosts = settings?.showAllPosts || false

    const filteredPosts = postsWithStatus.filter(post => {
      if (curationSuspended) {
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

  // Helper function to trim feed to maxDisplayedFeedSize
  const trimFeedIfNeeded = useCallback((
    combinedFeed: CurationFeedViewPost[],
    pageSize: number,
    feedReceivedTime: Date,
    maxDisplayedFeedSize: number = DEFAULT_MAX_DISPLAYED_FEED_SIZE
  ): CurationFeedViewPost[] => {
    if (combinedFeed.length <= maxDisplayedFeedSize) {
      return combinedFeed
    }

    const trimCount = combinedFeed.length - maxDisplayedFeedSize
    const pagesToTrim = Math.ceil(trimCount / pageSize)
    const actualTrimCount = pagesToTrim * pageSize

    const newFeed = combinedFeed.slice(0, combinedFeed.length - actualTrimCount)

    const adjacentPageStart = newFeed.length
    const adjacentPageEnd = Math.min(adjacentPageStart + pageSize, combinedFeed.length)
    const adjacentPage = combinedFeed.slice(adjacentPageStart, adjacentPageEnd)
    setPreviousPageFeed(adjacentPage as CurationFeedViewPost[])

    if (newFeed.length > 0) {
      const newOldest = newFeed[newFeed.length - 1]
      const newOldestTimestamp = getFeedViewPostTimestamp(newOldest, feedReceivedTime).getTime()
      setOldestDisplayedPostTimestamp(newOldestTimestamp)
    }

    log.debug('Trim', `Removed ${actualTrimCount} oldest posts, saved ${adjacentPage.length} as previousPageFeed, new feed size: ${newFeed.length}`)

    return newFeed
  }, [])

  // Pre-fetch the next page for instant Prev Page
  const prefetchPrevPage = useCallback(async (afterTimestamp: number, targetSize?: number) => {
    if (!agent || !session) return

    try {
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const effectivePageLength = targetSize ?? pageLength
      const lookbackDays = settings?.initialLookbackDays ?? 1

      const newestCachedTimestamp = await getNewestCachedPostTimestamp()
      if (!isCacheWithinLookback(newestCachedTimestamp, lookbackDays, settings?.timezone)) {
        log.debug('Prefetch', 'Cache is stale, clearing and reloading')
        await clearFeedCache()
        await clearPrevPageCursor()
        setPreviousPageFeed([])
        return
      }

      log.verbose('Prefetch', `Fetching posts before ${new Date(afterTimestamp).toLocaleTimeString()} (${afterTimestamp}), effectivePageLength=${effectivePageLength}`)
      let { posts: postsForNextPage, postTimestamps: timestampsForNextPage } =
        await getCachedFeedBefore(afterTimestamp, pageLength)

      if (postsForNextPage.length > 0) {
        const newestTs = Math.max(...Array.from(timestampsForNextPage.values()))
        const oldestTs = Math.min(...Array.from(timestampsForNextPage.values()))
        log.verbose('Prefetch', `Cache returned ${postsForNextPage.length} posts: newest=${new Date(newestTs).toLocaleTimeString()}, oldest=${new Date(oldestTs).toLocaleTimeString()}`)
      } else {
        log.verbose('Prefetch', `Cache returned 0 posts`)
      }

      if (prevPageHadUnnumberedRef.current && postsForNextPage.length > 0) {
        const newestFetched = postsForNextPage[0]
        const newestId = getPostUniqueId(newestFetched)
        const newestSummary = await getPostSummary(newestId)
        if (newestSummary?.postNumber != null && newestSummary.postNumber > 0) {
          const fetchDayMidnight = getLocalMidnight(new Date(afterTimestamp), settings?.timezone)
          const fetchDayStart = fetchDayMidnight.getTime()
          const fetchDayEnd = getNextLocalMidnight(fetchDayMidnight, settings?.timezone).getTime()
          const preNumbered = await numberUnnumberedPostsForDay(fetchDayStart, fetchDayEnd, 'Prefetch')
          if (preNumbered > 0) {
            log.debug('Prefetch', `Numbered ${preNumbered} unnumbered posts (previous page had unnumbered)`)
          }
          prevPageHadUnnumberedRef.current = false
        }
      }

      if (postsForNextPage.length < pageLength) {
        log.debug('Prefetch', 'Cache exhausted or partial, checking for cursor')

        const oldestCurrentTimestamp = postsForNextPage.length > 0
          ? Math.min(...postsForNextPage.map(p => {
              const uniqueId = getPostUniqueId(p)
              return timestampsForNextPage.get(uniqueId) ?? timestampsForNextPage.get(p.post.uri) ?? Infinity
            }))
          : afterTimestamp

        const prevPageCursor = await getFreshPrevPageCursor()
        const cursorStatus = await getPrevPageCursorStatus()

        let cursorToUse: string | undefined

        if (prevPageCursor) {
          log.debug('Prefetch', `Using fresh Prev Page cursor (${cursorStatus.message})`)
          cursorToUse = prevPageCursor.cursor
        } else if (serverCursor) {
          log.debug('Prefetch', `No fresh Prev Page cursor, using serverCursor`)
          cursorToUse = serverCursor
        } else {
          log.debug('Prefetch', `${cursorStatus.message} - must skip from newest`)
        }

        const serverResult = await fetchPageFromTimestamp(
          oldestCurrentTimestamp,
          agent,
          session.handle,
          session.did,
          pageLength - postsForNextPage.length,
          cursorToUse
        )

        if (cursorToUse && serverResult.posts.length === 0 && !serverResult.hasMore) {
          log.warn('Prefetch', 'Cursor fetch failed - cursor may be invalid')
          await clearPrevPageCursor()
          addToast('Could not load older posts. Cursor expired.', 'error')
          setPreviousPageFeed([])
          return
        }

        postsForNextPage = [...postsForNextPage, ...serverResult.posts]
        serverResult.postTimestamps.forEach((value, key) => {
          timestampsForNextPage.set(key, value)
        })
        setServerCursor(serverResult.cursor)
      }

      // Filter with accumulation logic
      const MAX_NO_PROGRESS = 3
      let filtered: CurationFeedViewPost[] = []
      let accumulatedFiltered: CurationFeedViewPost[] = []
      let accumulatedTimestamps = new Map<string, number>()
      let consecutiveNoProgress = 0
      let oldestProcessedTimestamp = afterTimestamp

      while (true) {
        if (postsForNextPage.length === 0) {
          log.debug('Prefetch', 'No more posts available')
          break
        }

        filtered = await lookupCurationAndFilter(postsForNextPage, clientDate(), timestampsForNextPage)

        const existingIds = new Set(accumulatedFiltered.map(p => getPostUniqueId(p)))
        const newFiltered = filtered.filter(p => !existingIds.has(getPostUniqueId(p)))

        timestampsForNextPage.forEach((value, key) => {
          if (!accumulatedTimestamps.has(key)) {
            accumulatedTimestamps.set(key, value)
          }
        })

        if (newFiltered.length === 0) {
          consecutiveNoProgress++
          log.debug('Prefetch', `No new posts from batch of ${postsForNextPage.length} (stall ${consecutiveNoProgress}/${MAX_NO_PROGRESS})`)
          if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
            log.debug('Prefetch', `No progress for ${MAX_NO_PROGRESS} fetches, stopping with ${accumulatedFiltered.length} posts`)
            break
          }
        } else {
          consecutiveNoProgress = 0
          accumulatedFiltered = [...accumulatedFiltered, ...newFiltered]
          log.debug('Prefetch', `Added ${newFiltered.length} posts, total: ${accumulatedFiltered.length}/${effectivePageLength}`)
        }

        if (accumulatedFiltered.length >= effectivePageLength) {
          log.debug('Prefetch', `Reached target: ${accumulatedFiltered.length} posts`)
          break
        }

        oldestProcessedTimestamp = Math.min(
          ...postsForNextPage.map(p => {
            const uniqueId = getPostUniqueId(p)
            return timestampsForNextPage.get(uniqueId) ?? timestampsForNextPage.get(p.post.uri) ?? Infinity
          })
        )

        const { posts: moreCachedPosts, postTimestamps: moreCachedTimestamps } =
          await getCachedFeedBefore(oldestProcessedTimestamp, pageLength)

        if (moreCachedPosts.length > 0) {
          postsForNextPage = moreCachedPosts
          timestampsForNextPage = moreCachedTimestamps
        } else {
          log.debug('Prefetch', 'Cache exhausted, fetching from server')
          const serverResult = await fetchPageFromTimestamp(
            oldestProcessedTimestamp,
            agent,
            session.handle,
            session.did,
            pageLength,
            serverCursor
          )
          if (serverResult.posts.length === 0) {
            log.debug('Prefetch', 'Server also exhausted')
            break
          }
          postsForNextPage = serverResult.posts
          timestampsForNextPage = serverResult.postTimestamps
          setServerCursor(serverResult.cursor)
        }
      }

      filtered = accumulatedFiltered.slice(0, effectivePageLength)

      // Check for mid-day unnumbered→numbered transition
      if (filtered.length > 1) {
        for (let i = 0; i < filtered.length - 1; i++) {
          const currentNum = (filtered[i] as CurationFeedViewPost).curation?.postNumber
          const nextNum = (filtered[i + 1] as CurationFeedViewPost).curation?.postNumber
          if ((currentNum == null) && nextNum != null && nextNum > 0) {
            const nextId = getPostUniqueId(filtered[i + 1])
            const nextTs = accumulatedTimestamps.get(nextId) ?? accumulatedTimestamps.get(filtered[i + 1].post.uri)
            if (nextTs) {
              const dayMidnight = getLocalMidnight(new Date(nextTs), settings?.timezone)
              const dayStart = dayMidnight.getTime()
              const dayEnd = getNextLocalMidnight(dayMidnight, settings?.timezone).getTime()
              log.debug('Prefetch', `Mid-day numbering trigger at post #${nextNum}`)
              await numberUnnumberedPostsForDay(dayStart, dayEnd, 'Prefetch')
              filtered = await lookupCurationAndFilter(filtered, clientDate(), accumulatedTimestamps, true)
            }
            break
          }
        }
      }

      // Apply midnight boundary filter
      if (filtered.length > 0) {
        const getLocalDateString = (post: CurationFeedViewPost) => {
          const uniqueId = getPostUniqueId(post)
          const timestamp = accumulatedTimestamps.get(uniqueId) ?? accumulatedTimestamps.get(post.post.uri)
          if (!timestamp) return ''
          return new Date(timestamp).toLocaleDateString('en-US', settings?.timezone ? { timeZone: settings.timezone } : undefined)
        }
        const firstDate = getLocalDateString(filtered[0])
        const lastDate = getLocalDateString(filtered[filtered.length - 1])
        if (firstDate && lastDate && firstDate !== lastDate) {
          const originalCount = filtered.length
          filtered = filtered.filter(p => getLocalDateString(p) === lastDate)
          log.debug('Prefetch', `Midnight filter: kept ${filtered.length}/${originalCount} posts from ${lastDate} (older day)`)

          const newerDayPost = accumulatedFiltered.find(p => getLocalDateString(p) === firstDate)
          if (newerDayPost) {
            const nTs = accumulatedTimestamps.get(getPostUniqueId(newerDayPost)) ?? accumulatedTimestamps.get(newerDayPost.post.uri)
            if (nTs && (newerDayPost as CurationFeedViewPost).curation?.postNumber == null) {
              const newerDayMidnight = getLocalMidnight(new Date(nTs), settings?.timezone)
              const newerDayStart = newerDayMidnight.getTime()
              const newerDayEnd = getNextLocalMidnight(newerDayMidnight, settings?.timezone).getTime()
              log.debug('Prefetch', `Midnight trigger: numbering newer day ${firstDate}`)
              await assignNumbersForDay(newerDayStart, newerDayEnd)
            }
          }

          filtered = await lookupCurationAndFilter(filtered, clientDate(), accumulatedTimestamps, true)
        }
      }

      setPreviousPageFeed(filtered)

      prevPageHadUnnumberedRef.current = filtered.some(
        p => (p as CurationFeedViewPost).curation?.postNumber == null
      )

      if (filtered.length > 0) {
        const pfNewest = getFeedViewPostTimestamp(filtered[0], clientDate()).getTime()
        const pfOldest = getFeedViewPostTimestamp(filtered[filtered.length - 1], clientDate()).getTime()
        const pfFirst = filtered[0] as CurationFeedViewPost
        const pfLast = filtered[filtered.length - 1] as CurationFeedViewPost
        log.debug('Prefetch', `Pre-fetched ${filtered.length} posts for next page`)
        log.verbose('Prefetch', `previousPageFeed range: newest=${new Date(pfNewest).toLocaleTimeString()} (#${pfFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(pfOldest).toLocaleTimeString()} (#${pfLast.curation?.curationNumber ?? '?'})`)
      } else {
        log.debug('Prefetch', 'No more displayable posts available')
      }
    } catch (error) {
      log.warn('Prefetch', 'Failed:', error)
      setPreviousPageFeed([])
    }
  }, [agent, session, serverCursor, lookupCurationAndFilter])

  // Shared helper: render a set of filtered posts to the feed.
  // Used by both INITIAL LOAD and navigate-back-during-lookback paths.
  // Empty deps — only uses imported functions and stable React state setters.
  const displayInitialPage = useCallback((posts: CurationFeedViewPost[]) => {
    if (posts.length === 0) return
    const feedReceivedTime = clientDate()
    setFeed(posts)
    setPreviousPageFeed([])
    const newestTimestamp = getFeedViewPostTimestamp(posts[0], feedReceivedTime).getTime()
    setNewestDisplayedPostTimestamp(newestTimestamp)
    const oldestTimestamp = getFeedViewPostTimestamp(posts[posts.length - 1], feedReceivedTime).getTime()
    setOldestDisplayedPostTimestamp(oldestTimestamp)
    log.info('Feed', `Displayed ${posts.length} posts, newest=${new Date(newestTimestamp).toLocaleTimeString()}, oldest=${new Date(oldestTimestamp).toLocaleTimeString()}`)
  }, [])

  const loadFeed = useCallback(async (cursor?: string, useCache: boolean = true) => {
    if (!agent || !session || !dbInitialized) return

    try {
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const lookbackDays = settings?.initialLookbackDays ?? 1
      const initialCacheLength = pageLength * 2

      setRateLimitStatus(null)

      const feedCacheIsFresh = await shouldUseCacheOnLoad(lookbackDays)
      const summariesCacheIsFresh = await isSummariesCacheFresh()
      log.info('Feed', `Cache status: feedCache=${feedCacheIsFresh ? 'fresh' : 'stale'}, summariesCache=${summariesCacheIsFresh ? 'fresh' : 'stale'}`)

      const idleThreshold = settings?.feedRedisplayIdleInterval ?? 5 * 60 * 1000
      const metadata = await getLastFetchMetadata()
      const timeSinceLastFetch = metadata?.lastFetchTime ? clientNow() - metadata.lastFetchTime : Infinity
      const idleTimeExceeded = timeSinceLastFetch > idleThreshold

      let isIdleReturnMode = false
      let isInitialLoadMode = false
      let preIdleCacheNewest: number | null = null

      if (!summariesCacheIsFresh || forceInitialLoadRef.current) {
        // Check if a lookback is already in progress (navigate-away-and-back scenario)
        const lookbackActiveTs = sessionStorage.getItem('websky_lookback_active')
        const lookbackIsRecent = lookbackActiveTs && (clientNow() - Number(lookbackActiveTs)) < 5 * 60 * 1000
        if (!forceInitialLoadRef.current && lookbackIsRecent) {
          // A lookback is actively running — don't clear caches and restart.
          if (lookbackPollRef.current) {
            // Another loadFeed() already set up the poll — skip
            return
          }
          // Show loading indicator and poll for lookback completion, then reload.
          log.info('Feed', 'Lookback in progress — waiting for active lookback to complete')
          setInitPhase('posts')
          lookbackPollRef.current = setInterval(() => {
            const flag = sessionStorage.getItem('websky_lookback_active')
            if (!flag) {
              clearInterval(lookbackPollRef.current!)
              lookbackPollRef.current = null
              log.info('Feed', 'Lookback completed — reloading feed')
              setInitPhase(null)
              loadFeed()
            }
          }, 2000)
          // Redisplay initial page from module-level cache (survives component remount)
          if (initialPagePosts) {
            displayInitialPage(initialPagePosts)
          } else {
            log.info('Feed', 'No initial page cache available')
          }
          return
        } else {
        forceInitialLoadRef.current = false
        isInitialLoadMode = true
        log.info('Feed', `Mode: INITIAL LOAD - ${summariesCacheIsFresh ? 'forced by Reset Feed' : 'summaries cache stale (< 24h span)'}, clearing feed cache`)
        await clearFeedCache()
        await clearFeedMetadata()
        }
      } else if (!feedCacheIsFresh) {
        isIdleReturnMode = true
        log.info('Feed', 'Mode: IDLE RETURN - feed cache stale but summaries fresh, clearing feed cache')
        await clearFeedCache()
        await clearFeedMetadata()
      } else if (idleTimeExceeded) {
        isIdleReturnMode = true
        preIdleCacheNewest = metadata?.newestCachedPostTimestamp ?? null
        log.info('Feed', `Mode: IDLE RETURN - idle time exceeded (${Math.round(timeSinceLastFetch / 60000)} min > ${Math.round(idleThreshold / 60000)} min threshold), preserving cache, pre-idle newest: ${preIdleCacheNewest ? new Date(preIdleCacheNewest).toLocaleString() : 'null'}`)
      } else {
        log.info('Feed', `Mode: USE CACHE - both caches fresh, idle time ${Math.round(timeSinceLastFetch / 60000)} min within ${Math.round(idleThreshold / 60000)} min threshold`)
      }

      if (!cursor && useCache && !isIdleReturnMode && !isInitialLoadMode) {
        const result = await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })
        if (result) {
          const cachedMetadata = await getLastFetchMetadata()
          setCursor(cachedMetadata?.lastCursor)
          setHasMorePosts(result.oldestTimestamp !== null || cachedMetadata?.lastCursor !== undefined)
          setIsInitialLoad(false)
          setIsLoading(false)
          log.debug('Feed', `Loaded ${result.alignedPosts.length} posts from cache via refreshDisplayedFeed`)

          const cachedPosts = await getCachedFeed(initialCacheLength)
          if (cachedPosts.length > 0) {
            const oldestCachedTs = getFeedViewPostTimestamp(cachedPosts[cachedPosts.length - 1], clientDate()).getTime()
            await updateFeedCacheOldestPostTimestamp(oldestCachedTs)
          }
          setInitialPrefetchDone(true)
          return
        }
        // Cache metadata said fresh but no posts found — switch to idle return
        isIdleReturnMode = true
        log.info('Feed', 'Mode: USE CACHE → IDLE RETURN - cache metadata fresh but no posts found')
      }

      let fetchLimit = pageLength
      if (!cursor) {
        fetchLimit = FETCH_BATCH_SIZE
        log.debug('Feed', `Using fetchLimit=${fetchLimit} (pageLength=${pageLength})`)
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

      if (newFeed.length > 0 && !cursor) {
        const newestPost = newFeed[0]
        const oldestPost = newFeed[newFeed.length - 1]
        const newestTime = new Date((newestPost.post.record as any)?.createdAt || newestPost.post.indexedAt || 0)
        const oldestTime = new Date((oldestPost.post.record as any)?.createdAt || oldestPost.post.indexedAt || 0)
        log.info('Feed', `Fetched ${newFeed.length} posts. Newest: ${newestTime.toLocaleString()}, Oldest: ${oldestTime.toLocaleString()}`)
      }

      setRateLimitStatus(null)

      const myUsername = session.handle
      const myDid = session.did

      const initialLastPostTime = clientDate()
      const fetchSettings = await getSettings()
      const fetchIntervalHours = getIntervalHoursSync(fetchSettings)
      const { entries } = createFeedCacheEntries(newFeed, initialLastPostTime, fetchIntervalHours)

      let entriesToSave = entries
      let allEntriesHadSummaries = false
      let firstCachedSummaryIndex = -1

      if (isIdleReturnMode && !cursor) {
        for (let i = 0; i < entries.length; i++) {
          const summaryExists = await checkPostSummaryExists(entries[i].uniqueId)
          if (summaryExists) {
            firstCachedSummaryIndex = i
            break
          }
        }

        if (firstCachedSummaryIndex === 0) {
          entriesToSave = []
          allEntriesHadSummaries = true
          log.debug('Feed', `All ${entries.length} posts already have cached summaries - gap already filled`)
        } else if (firstCachedSummaryIndex > 0) {
          entriesToSave = entries.slice(0, firstCachedSummaryIndex)
          log.debug('Feed', `${entriesToSave.length} posts need curation, ${entries.length - firstCachedSummaryIndex} already have summaries`)
        } else {
          log.debug('Feed', `No cached summaries found in first page - full lookback needed`)
        }
      }

      let curatedFeed: CurationFeedViewPost[]
      let initialSecondaryEntries: SecondaryEntry[] | null = null

      if ((isIdleReturnMode || isInitialLoadMode) && !cursor) {
        if (entriesToSave.length > 0) {
          const secondaryEntries = await curateEntriesToSecondary(entriesToSave, myUsername, myDid)
          initialSecondaryEntries = secondaryEntries
          curatedFeed = secondaryEntriesToCuratedFeed(secondaryEntries)
        } else {
          curatedFeed = []
        }
      } else {
        const result = entriesToSave.length > 0
          ? await savePostsWithCuration(entriesToSave, newCursor, agent, myUsername, myDid)
          : { curatedFeed: [] }
        curatedFeed = result.curatedFeed
      }

      if (newFeed.length > 0 && !cursor) {
        log.info('Curation', `Processed ${curatedFeed.length} posts (all posts, including dropped)`)
      }

      const feedReceivedTime = initialLastPostTime

      let filteredPosts: CurationFeedViewPost[]
      if (initialSecondaryEntries) {
        const fetchSettings2 = await getSettings()
        const curationSuspended = !fetchSettings2 || fetchSettings2?.curationSuspended
        const showAllPosts = fetchSettings2?.showAllPosts || false
        filteredPosts = filterSecondaryForDisplay(initialSecondaryEntries, curationSuspended, showAllPosts)
      } else {
        filteredPosts = await lookupCurationAndFilter(curatedFeed, feedReceivedTime)
      }

      if (cursor) {
        const combinedFeed = [...feed, ...filteredPosts]
        combinedFeed.sort((a, b) => {
          const aTime = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          const bTime = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
          return bTime - aTime
        })
        setFeed(combinedFeed)
      } else {
        displayInitialPage(filteredPosts)
        // Persist for redisplay if user navigates away during lookback
        initialPagePosts = filteredPosts.length > 0 ? filteredPosts : null
        if (filteredPosts.length > 0) {
          const oldestDisplayedTimestamp = getFeedViewPostTimestamp(filteredPosts[filteredPosts.length - 1], feedReceivedTime).getTime()

          if (!initialSecondaryEntries) {
            const oldestFetchedTimestamp = curatedFeed.length > 0
              ? getFeedViewPostTimestamp(curatedFeed[curatedFeed.length - 1], feedReceivedTime).getTime()
              : undefined
            if (oldestFetchedTimestamp !== undefined) {
              await updateFeedCacheOldestPostTimestamp(oldestFetchedTimestamp)
              log.debug('Feed', `Updated oldestCachedPostTimestamp in metadata to oldest fetched post: ${new Date(oldestFetchedTimestamp).toISOString()} (from ${curatedFeed.length} fetched posts, ${filteredPosts.length} displayed)`)
            }
          }

          setIsInitialLoad(false)

          if (!isIdleReturnMode && !isInitialLoadMode && !cursor) {
            setTimeout(async () => {
              await prefetchPrevPage(oldestDisplayedTimestamp)
              setInitialPrefetchDone(true)
            }, 100)
          }

          const skipIdleReturnLookback = isIdleReturnMode && (allEntriesHadSummaries || firstCachedSummaryIndex > 0)
          if ((isInitialLoadMode || isIdleReturnMode) && !cursor && !skipIdleReturnLookback) {
            if (lookbackInProgressRef.current) {
              log.info('Lookback', 'Skipping — another lookback is already in progress')
            } else {
            const fetchMode = isIdleReturnMode ? 'idle_return' as const : 'initial' as const
            log.debug('Lookback', `Starting unified fetch (mode: ${fetchMode})...`)

            if (isInitialLoadMode) {
              await clearPrevPageCursor()
            }

            lookbackInProgressRef.current = true
            sessionStorage.setItem('websky_lookback_active', clientNow().toString())
            setLookingBack(true)
            setLookbackProgress(0)
            setInitPhase('posts')

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
              log.debug('Lookback', `Fetch complete: ${fetchResult.postsFetched} posts, stopReason=${fetchResult.stopReason}`)

              let allEntries = fetchResult.entries
              if (initialSecondaryEntries) {
                allEntries = [...initialSecondaryEntries, ...allEntries]
                log.debug('Lookback', `Combined ${initialSecondaryEntries.length} initial + ${fetchResult.entries.length} lookback = ${allEntries.length} total entries`)
              }

              let transferResult = null
              if (allEntries.length > 0) {
                transferResult = await transferSecondaryToPrimary(allEntries, 'all', pageLength, isInitialLoadMode)
                log.debug('Lookback', `Transferred ${transferResult.postsTransferred} posts to primary`)
              }

              lookbackInProgressRef.current = false
              setLookingBack(false)
              setLookbackProgress(100)

              if (isInitialLoadMode) {
                if (isInitialCurationRef.current) {
                  try {
                    log.debug('Curation/Init', 'Computing filter statistics...')
                    setInitPhase('follows')
                    setLookbackProgress(0)
                    await computeStatsInBackground(agent, myUsername, myDid, true, (p) => setLookbackProgress(p))

                    log.debug('Curation/Init', 'Updating curation decisions for cached posts...')
                    await recomputeCurationDecisions(agent, myUsername, myDid)

                    log.debug('Curation/Init', 'Recomputing statistics with curation decisions...')
                    await computeStatsInBackground(agent, myUsername, myDid, false)

                    await markInitialLookbackCompleted()
                    sessionStorage.removeItem('websky_lookback_active')
                    initialPagePosts = null
                    log.info('Curation/Init', 'Initial lookback complete, flag set')

                    log.debug('Curation/Init', 'Getting curation statistics...')
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
                      editedCount: curationStats.editedCount,
                      followeeCount,
                      oldestTimestamp: curationStats.oldestTimestamp,
                      newestTimestamp: curationStats.newestTimestamp,
                      daysAnalyzed,
                      postsPerDay,
                    })

                    log.debug('Curation/Init', 'Reloading feed with curation data...')
                    await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })

                    setInitPhase(null)
                    setShowCurationInitModal(true)
                    isInitialCurationRef.current = false
                    log.debug('Curation/Init', 'Modal displayed')
                  } catch (err) {
                    log.error('Curation/Init', 'Failed to compute stats:', err)
                    sessionStorage.removeItem('websky_lookback_active')
                    setInitPhase(null)
                    isInitialCurationRef.current = false
                  }
                } else {
                  try {
                    log.debug('Lookback', 'Non-initial lookback complete, assigning numbers and redisplaying...')
                    await assignAllNumbers()
                    sessionStorage.removeItem('websky_lookback_active')
                    await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })
                    setInitialPrefetchDone(true)
                  } catch (err) {
                    log.error('Lookback', 'Post-lookback processing failed:', err)
                    sessionStorage.removeItem('websky_lookback_active')
                    setInitialPrefetchDone(true)
                  }
                }
              } else {
                log.debug('Lookback', 'Refreshing feed display with numbered posts...')
                await refreshDisplayedFeed({ triggerProbe: true, showAllNewPosts: true })
                setInitialPrefetchDone(true)

                // Show refetch result modal if this was triggered by clearRecentAndReloadHomePage
                if (refetchPendingRef.current && transferResult && fetchResult.postsFetched > 0) {
                  refetchPendingRef.current = false
                  setRefreshResultStats({
                    totalEntriesRecurated: allEntries.length,
                    displayableCount: transferResult.displayableCount,
                    editionsAssembled: transferResult.editionsAssembled,
                    oldestEntryTimestamp: fetchResult.oldestTimestamp ?? 0,
                    newestEntryTimestamp: fetchResult.newestTimestamp ?? 0,
                  })
                  setRefreshResultTitle('Refetch complete')
                  setShowRefreshResultModal(true)
                } else if (refetchPendingRef.current) {
                  refetchPendingRef.current = false
                }
              }
            }).catch((err) => {
              log.error('Lookback', 'Failed:', err)
              lookbackInProgressRef.current = false
              sessionStorage.removeItem('websky_lookback_active')
              refetchPendingRef.current = false
              setLookingBack(false)
              setLookbackProgress(null)
              setInitPhase(null)
              setInitialPrefetchDone(true)
            })
            } // end lookbackInProgressRef guard
          } else if (skipIdleReturnLookback) {
            log.debug('Feed', 'Gap already filled by first page - skipping background lookback')

            if (initialSecondaryEntries && initialSecondaryEntries.length > 0) {
              const transferResult = await transferSecondaryToPrimary(initialSecondaryEntries, 'all', pageLength, true)
              log.debug('Feed', `Persisted ${transferResult.postsTransferred} new posts to primary cache`)
            }

            if (entriesToSave.length > 0) {
              const idleReturnSettings = await getSettings()
              const todayMidnightDate = getLocalMidnight(clientDate(), idleReturnSettings?.timezone)
              const todayMidnight = todayMidnightDate.getTime()
              const todayEnd = getNextLocalMidnight(todayMidnightDate, idleReturnSettings?.timezone).getTime()
              const yesterdayMidnight = getPrevLocalMidnight(todayMidnightDate, idleReturnSettings?.timezone).getTime()
              const numberedYesterday = await numberUnnumberedPostsForDay(yesterdayMidnight, todayMidnight, 'Idle Return (yesterday)')
              const numberedToday = await numberUnnumberedPostsForDay(todayMidnight, todayEnd, 'Idle Return')

              if (numberedYesterday + numberedToday > 0) {
                sessionStorage.removeItem(getFeedStateKey('curated'))
                log.debug('Feed', 'Refreshing feed display with numbered posts...')
                await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })
              }
            }

            setTimeout(async () => {
              await prefetchPrevPage(oldestDisplayedTimestamp)
              setInitialPrefetchDone(true)
            }, 100)
          }

          setHasMorePosts(oldestDisplayedTimestamp !== null || newCursor !== undefined)
        } else {
          setHasMorePosts(false)
        }
      }

      setCursor(newCursor)
    } catch (error) {
      log.error('Feed', 'Failed to load feed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to load feed'

      if (useCache) {
        addToast(errorMessage, 'error')
      }

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
      const savedStateJson = sessionStorage.getItem(getFeedStateKey('curated'))
      if (!savedStateJson) {
        log.debug('Redisplay', 'No saved feed state, nothing to redisplay')
        return
      }

      const savedState: SavedFeedState = JSON.parse(savedStateJson)

      if (savedState.sessionDid !== session.did) {
        log.debug('Redisplay', 'Saved state is for different user, skipping')
        sessionStorage.removeItem(getFeedStateKey('curated'))
        return
      }

      if (!savedState.displayedFeed || savedState.displayedFeed.length === 0) {
        log.debug('Redisplay', 'Saved state has no posts, nothing to redisplay')
        return
      }

      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const maxDisplayedFeedSize = settings?.maxDisplayedFeedSize || DEFAULT_MAX_DISPLAYED_FEED_SIZE
      const feedReceivedTime = clientDate()

      const currentCurationSuspended = settings?.curationSuspended || false
      const currentShowAllPosts = settings?.showAllPosts || false
      const savedCurationSuspended = savedState.curationSuspended ?? false
      const savedShowAllPosts = savedState.showAllPosts ?? false
      const settingsChanged = currentCurationSuspended !== savedCurationSuspended ||
                              currentShowAllPosts !== savedShowAllPosts

      const needsMorePosts = (currentCurationSuspended && !savedCurationSuspended) ||
                             (currentShowAllPosts && !savedShowAllPosts)

      if (needsMorePosts) {
        log.debug('Redisplay', `Settings changed to show more posts (suspended: ${savedCurationSuspended}→${currentCurationSuspended}, showAll: ${savedShowAllPosts}→${currentShowAllPosts}), falling back to loadFeed`)
        sessionStorage.removeItem(getFeedStateKey('curated'))
        return loadFeed()
      }

      if (settingsChanged) {
        log.debug('Redisplay', `Curation settings changed (suspended: ${savedCurationSuspended}→${currentCurationSuspended}, showAll: ${savedShowAllPosts}→${currentShowAllPosts}), will re-filter`)
      }

      let feedWithCuration = await lookupCurationAndFilter(
        savedState.displayedFeed as CurationFeedViewPost[],
        feedReceivedTime,
        undefined,
        !settingsChanged
      )

      // Check if any posts have curation data but are missing curation numbers.
      // This happens when the user navigated away before assignAllNumbers() ran during initialization.
      const hasUnnumberedPosts = feedWithCuration.some(post => {
        const c = (post as CurationFeedViewPost).curation
        return c && Object.keys(c).length > 0 && c.curationNumber === undefined
      })

      if (hasUnnumberedPosts) {
        log.debug('Redisplay', 'Found unnumbered posts, assigning numbers...')
        await assignAllNumbers()
        feedWithCuration = await lookupCurationAndFilter(
          savedState.displayedFeed as CurationFeedViewPost[],
          feedReceivedTime,
          undefined,
          false  // Re-filter to exclude posts that may now be dropped
        )
      }

      // Filter out posts that were shown during initial display but later
      // re-curated as dropped during the lookback (curationNumber === 0)
      const preFilterLength = feedWithCuration.length
      feedWithCuration = feedWithCuration.filter(post => {
        const c = (post as CurationFeedViewPost).curation
        return !c || c.curationNumber !== 0
      })
      if (feedWithCuration.length < preFilterLength) {
        log.debug('Redisplay', `Filtered out ${preFilterLength - feedWithCuration.length} dropped posts`)
      }

      feedWithCuration = alignFeedToPageBoundary(feedWithCuration, pageLength)

      const originalLength = feedWithCuration.length
      feedWithCuration = trimFeedIfNeeded(feedWithCuration, pageLength, feedReceivedTime, maxDisplayedFeedSize)
      const truncated = feedWithCuration.length < originalLength

      if (truncated) {
        log.debug('Redisplay', `Truncated feed from ${originalLength} to ${feedWithCuration.length} posts using trimFeedIfNeeded`)
      }

      setFeed(feedWithCuration)

      if (feedWithCuration.length > 0) {
        const newestTimestamp = getFeedViewPostTimestamp(feedWithCuration[0], feedReceivedTime).getTime()
        const oldestTimestamp = getFeedViewPostTimestamp(feedWithCuration[feedWithCuration.length - 1], feedReceivedTime).getTime()

        const rdFirst = feedWithCuration[0] as CurationFeedViewPost
        const rdLast = feedWithCuration[feedWithCuration.length - 1] as CurationFeedViewPost
        log.verbose('Redisplay', `Restored feed range: newest=${new Date(newestTimestamp).toLocaleTimeString()} (#${rdFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(oldestTimestamp).toLocaleTimeString()} (#${rdLast.curation?.curationNumber ?? '?'}), savedOldest=${savedState.oldestDisplayedPostTimestamp ? new Date(savedState.oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'}`)

        setNewestDisplayedPostTimestamp(newestTimestamp)
        setOldestDisplayedPostTimestamp(oldestTimestamp)
      } else {
        setNewestDisplayedPostTimestamp(savedState.newestDisplayedPostTimestamp)
        setOldestDisplayedPostTimestamp(savedState.oldestDisplayedPostTimestamp)
      }

      setHasMorePosts(savedState.hasMorePosts)
      setCursor(savedState.cursor)
      setIsLoading(false)
      setIsInitialLoad(false)

      if (savedState.newPostsCount !== undefined) {
        setNewPostsCount(savedState.newPostsCount)
      }
      if (savedState.showNewPostsButton !== undefined) {
        setShowNewPostsButton(savedState.showNewPostsButton)
      }

      const oldestTimestamp = feedWithCuration.length > 0
        ? getFeedViewPostTimestamp(feedWithCuration[feedWithCuration.length - 1], feedReceivedTime).getTime()
        : savedState.oldestDisplayedPostTimestamp

      if (truncated) {
        log.debug('Redisplay', 'previousPageFeed set by trimFeedIfNeeded')
      } else if (savedState.previousPageFeed && savedState.previousPageFeed.length > 0) {
        const previousWithCuration = await lookupCurationAndFilter(
          savedState.previousPageFeed as CurationFeedViewPost[],
          feedReceivedTime,
          undefined,
          true
        )
        setPreviousPageFeed(previousWithCuration)
        setInitialPrefetchDone(true)
        log.debug('Redisplay', `Restored previousPageFeed: ${previousWithCuration.length} posts`)
        if (previousWithCuration.length > 0) {
          const rpNewest = getFeedViewPostTimestamp(previousWithCuration[0], feedReceivedTime).getTime()
          const rpOldest = getFeedViewPostTimestamp(previousWithCuration[previousWithCuration.length - 1], feedReceivedTime).getTime()
          const rpFirst = previousWithCuration[0] as CurationFeedViewPost
          const rpLast = previousWithCuration[previousWithCuration.length - 1] as CurationFeedViewPost
          log.verbose('Redisplay', `Restored previousPageFeed range: newest=${new Date(rpNewest).toLocaleTimeString()} (#${rpFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(rpOldest).toLocaleTimeString()} (#${rpLast.curation?.curationNumber ?? '?'})`)
        }
      } else if (oldestTimestamp) {
        log.verbose('Redisplay', `Triggering prefetch with oldestTimestamp=${new Date(oldestTimestamp).toLocaleTimeString()} (${oldestTimestamp})`)
        setTimeout(async () => {
          await prefetchPrevPage(oldestTimestamp)
          setInitialPrefetchDone(true)
        }, 100)
      }

      scrollRestoredRef.current = false

      log.debug('Redisplay', 'Restored feed state:', {
        feedLength: feedWithCuration.length,
        originalFeedLength: savedState.displayedFeed.length,
        truncated,
        hasMorePosts: savedState.hasMorePosts,
        newPostsCount: savedState.newPostsCount,
        showNewPostsButton: savedState.showNewPostsButton,
        age: Math.round((clientNow() - savedState.savedAt) / 1000) + 's'
      })

      setTimeout(async () => {
        try {
          const currentNewest = savedState.newestDisplayedPostTimestamp || 0
          if (currentNewest > 0) {
            const newPosts = await getCachedFeedAfterPosts(currentNewest, 100)

            if (newPosts.length > 0) {
              const feedReceivedTime = clientDate()
              const filteredPosts = await lookupCurationAndFilter(newPosts, feedReceivedTime)
              const count = filteredPosts.length

              if (count > 0) {
                setNewPostsCount(count)
                setShowNewPostsButton(true)
                log.debug('Redisplay', 'Updated new posts count:', count, `(${newPosts.length} in cache, ${count} after filtering)`)
              } else {
                setNewPostsCount(0)
                setShowNewPostsButton(false)
              }
            } else if (savedState.showNewPostsButton) {
              setNewPostsCount(0)
              setShowNewPostsButton(false)
            }
          }
        } catch (err) {
          log.warn('Feed', 'Background new posts check failed:', err)
        }
      }, 0)

    } catch (error) {
      log.error('Feed', 'Failed to redisplay feed:', error)
    }
  }, [agent, session, dbInitialized])

  const refreshDisplayedFeed = useCallback(async (options?: RefreshDisplayedFeedOptions): Promise<RefreshDisplayedFeedResult | null> => {
    if (!agent || !session || !dbInitialized || isLoadingMore || activeTab !== 'curated') {
      log.debug('Refresh', `Guard: skipping refresh agent=${!!agent} session=${!!session} dbInit=${dbInitialized} loading=${isLoadingMore} tab=${activeTab}`)
      return null
    }

    const effectiveNewestTimestamp = options?.newestTimestamp ?? newestDisplayedPostTimestamp

    log.debug('Refresh', `Starting refresh (newestTimestamp=${effectiveNewestTimestamp ? new Date(effectiveNewestTimestamp).toLocaleTimeString() : 'null (newest from cache)'}, triggerProbe=${options?.triggerProbe !== false}, showAllNewPosts=${options?.showAllNewPosts !== false})`)

    if (options?.triggerProbe !== false) {
      forceProbeRef.current = true
      setForceProbeTrigger(n => n + 1)
    }

    if (options?.showAllNewPosts !== false) {
      setIdleTimerTriggered(true)
      idleTimerForcedRef.current = true
    }

    try {
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const feedReceivedTime = clientDate()

      const MAX_NO_PROGRESS = 3
      let accumulatedFiltered: CurationFeedViewPost[] = []
      let consecutiveNoProgress = 0
      let fetchBeforeTimestamp: number | null = effectiveNewestTimestamp != null ? effectiveNewestTimestamp + 1 : null
      let isFirstBatch = true

      while (true) {
        let batchPosts: CurationFeedViewPost[]
        let batchTimestamps: Map<string, number>

        if (isFirstBatch && fetchBeforeTimestamp == null) {
          batchPosts = await getCachedFeed(2 * pageLength)
          batchTimestamps = new Map()
        } else {
          const result = await getCachedFeedBefore(fetchBeforeTimestamp!, 2 * pageLength)
          batchPosts = result.posts as CurationFeedViewPost[]
          batchTimestamps = result.postTimestamps
        }
        isFirstBatch = false

        if (batchPosts.length === 0) {
          log.debug('Refresh', 'Cache exhausted')
          break
        }

        const filtered = await lookupCurationAndFilter(
          batchPosts,
          feedReceivedTime,
          batchTimestamps.size > 0 ? batchTimestamps : undefined,
          false
        )

        const withinRange = effectiveNewestTimestamp != null
          ? filtered.filter(p => {
              const ts = getFeedViewPostTimestamp(p, feedReceivedTime).getTime()
              return ts <= effectiveNewestTimestamp
            })
          : filtered

        const existingIds = new Set(accumulatedFiltered.map(p => getPostUniqueId(p)))
        const newPosts = withinRange.filter(p => !existingIds.has(getPostUniqueId(p)))

        if (newPosts.length === 0) {
          consecutiveNoProgress++
          log.debug('Refresh', `No new posts from batch of ${batchPosts.length} (stall ${consecutiveNoProgress}/${MAX_NO_PROGRESS})`)
          if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
            log.debug('Refresh', `No progress for ${MAX_NO_PROGRESS} fetches, stopping with ${accumulatedFiltered.length} posts`)
            break
          }
        } else {
          consecutiveNoProgress = 0
          accumulatedFiltered = [...accumulatedFiltered, ...newPosts]
          log.debug('Refresh', `Added ${newPosts.length} posts, total: ${accumulatedFiltered.length}`)
        }

        if (accumulatedFiltered.length >= 2 * pageLength) {
          log.debug('Refresh', `Reached target: ${accumulatedFiltered.length} posts`)
          break
        }

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
        log.debug('Refresh', 'No displayable posts found in cache, keeping existing feed')
        return null
      }

      if (accumulatedFiltered.length > 2 * pageLength) {
        accumulatedFiltered = accumulatedFiltered.slice(0, 2 * pageLength)
      }

      accumulatedFiltered.sort((a, b) => {
        const tsA = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
        const tsB = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
        return tsB - tsA
      })

      const alignedPosts = alignFeedToPageBoundary(accumulatedFiltered, pageLength)

      setFeed(alignedPosts)

      const newNewestTimestamp = getFeedViewPostTimestamp(alignedPosts[0], feedReceivedTime).getTime()
      const newOldestTimestamp = getFeedViewPostTimestamp(alignedPosts[alignedPosts.length - 1], feedReceivedTime).getTime()

      setNewestDisplayedPostTimestamp(newNewestTimestamp)
      setOldestDisplayedPostTimestamp(newOldestTimestamp)

      lastDisplayTimeRef.current = clientNow()

      // Reset probe boundary state — fresh display means start probing from scratch
      probeBoundaryTimestampRef.current = null
      unprocessedRawCountRef.current = 0
      unprocessedShowCountRef.current = 0
      probeHasGapRef.current = false

      const firstPost = alignedPosts[0] as CurationFeedViewPost
      const lastPost = alignedPosts[alignedPosts.length - 1] as CurationFeedViewPost
      log.info('Refresh', `Feed updated: ${alignedPosts.length} posts, newest=#${firstPost.curation?.curationNumber ?? '?'} (${new Date(newNewestTimestamp).toLocaleTimeString()}), oldest=#${lastPost.curation?.curationNumber ?? '?'} (${new Date(newOldestTimestamp).toLocaleTimeString()})`)

      setPreviousPageFeed([])
      setInitialPrefetchDone(false)
      setTimeout(async () => {
        await prefetchPrevPage(newOldestTimestamp)
        setInitialPrefetchDone(true)
      }, 100)

      return { alignedPosts, newestTimestamp: newNewestTimestamp, oldestTimestamp: newOldestTimestamp }

    } catch (error) {
      log.error('Refresh', 'Error during feed refresh:', error)
      return null
    }
  }, [agent, session, dbInitialized, isLoadingMore, activeTab, newestDisplayedPostTimestamp, lookupCurationAndFilter, prefetchPrevPage])

  // Clear all time-variant data and logout
  const clearCacheAndReloadHomePage = useCallback(async () => {
    log.info('Debug', 'clearCacheAndReloadHomePage: Starting...')
    retainedSecondaryCache = null
    resetPendingRef.current = true
    try {
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)
      log.debug('Debug', 'Cleared sessionStorage')

      await clearAllTimeVariantDataAndLogout()
    } catch (error) {
      log.error('Debug', 'clearCacheAndReloadHomePage failed:', error)
    } finally {
      resetPendingRef.current = false
      sessionStorage.removeItem('websky_reset_pending')
    }
  }, [])

  // Reset feed only (preserve summaries)
  const resetFeedAndReloadHomePage = useCallback(async () => {
    log.info('Debug', 'resetFeedAndReloadHomePage: Starting...')
    retainedSecondaryCache = null
    resetPendingRef.current = true
    lookbackInProgressRef.current = false
    sessionStorage.removeItem('websky_lookback_active')

    try {
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)
      localStorage.removeItem('websky_pinned_post_id')
      localStorage.removeItem('websky_pinned_post_text')
      log.debug('Debug', 'Cleared sessionStorage')

      const database = await initDB()

      const feedTx = database.transaction(['feed_cache'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = feedTx.objectStore('feed_cache').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      log.debug('Debug', 'Cleared feed_cache')

      const metaTx = database.transaction(['feed_metadata'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = metaTx.objectStore('feed_metadata').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      log.debug('Debug', 'Cleared feed_metadata')

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
      log.debug('Debug', 'Reset React state')

      forceInitialLoadRef.current = true
      log.debug('Debug', 'Set forceInitialLoadRef to true')

      log.debug('Debug', 'Triggering fresh loadFeed with useCache=false...')
      await loadFeed(undefined, false)
      log.debug('Debug', 'resetFeedAndReloadHomePage: Complete!')

    } catch (error) {
      log.error('Debug', 'resetFeedAndReloadHomePage failed:', error)
    } finally {
      resetPendingRef.current = false
      sessionStorage.removeItem('websky_reset_pending')
    }
  }, [loadFeed])

  // Clear recent data and reload (preserve old summaries, idle return behavior)
  const clearRecentAndReloadHomePage = useCallback(async () => {
    log.info('Debug', 'clearRecentAndReloadHomePage: Starting...')
    retainedSecondaryCache = null
    resetPendingRef.current = true
    lookbackInProgressRef.current = false
    sessionStorage.removeItem('websky_lookback_active')

    try {
      // Calculate lookback boundary
      const settings = await getSettings()
      const lookbackDays = settings?.initialLookbackDays ?? 1
      const { getLookbackBoundary } = await import('../curation/feedCacheCore')
      const boundary = getLookbackBoundary(lookbackDays, settings?.timezone)
      log.debug('Debug', `Lookback boundary: ${boundary.toISOString()} (${lookbackDays} days)`)

      // Clear sessionStorage
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)
      localStorage.removeItem('websky_pinned_post_id')
      localStorage.removeItem('websky_pinned_post_text')
      log.debug('Debug', 'Cleared sessionStorage')

      // Clear recent data (feed cache, recent summaries, recent editions)
      await clearRecentData(boundary.getTime())

      // Reset React state (same as resetFeedAndReloadHomePage)
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
      log.debug('Debug', 'Reset React state')

      // Do NOT set forceInitialLoadRef — let loadFeed detect idle return naturally
      // (feedCacheIsFresh=false with summariesCacheIsFresh=true → idle return mode)

      log.debug('Debug', 'Triggering fresh loadFeed with useCache=false...')
      refetchPendingRef.current = true
      await loadFeed(undefined, false)
      log.debug('Debug', 'clearRecentAndReloadHomePage: Complete!')

    } catch (error) {
      log.error('Debug', 'clearRecentAndReloadHomePage failed:', error)
    } finally {
      resetPendingRef.current = false
      sessionStorage.removeItem('websky_reset_pending')
    }
  }, [loadFeed])

  // Re-curate from cache (no server re-fetch)
  const recurateAndReloadHomePage = useCallback(async () => {
    log.info('Debug', 'recurateAndReloadHomePage: Starting...')
    retainedSecondaryCache = null
    resetPendingRef.current = true
    lookbackInProgressRef.current = false
    sessionStorage.removeItem('websky_lookback_active')

    try {
      if (!session) {
        log.error('Debug', 'recurateAndReloadHomePage: No session')
        return
      }
      const myUsername = session.handle
      const myDid = session.did

      // Calculate lookback boundary
      const settings = await getSettings()
      const lookbackDays = settings?.initialLookbackDays ?? 1
      const pageLength = settings?.feedPageLength || 25
      const { getLookbackBoundary } = await import('../curation/feedCacheCore')
      const boundary = getLookbackBoundary(lookbackDays, settings?.timezone)
      log.debug('Debug', `Re-curate lookback boundary: ${boundary.toISOString()} (${lookbackDays} days)`)

      // Clear sessionStorage
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)

      // Reset React state
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
      setLookingBack(true)
      setLookbackProgress(0)
      setLookbackMessage('Re-curating posts')

      const result = await recurateFromCache(
        myUsername,
        myDid,
        boundary.getTime(),
        pageLength,
        (percent) => setLookbackProgress(percent),
      )

      if (result) {
        log.debug('Debug', `Re-curation transferred ${result.postsTransferred} posts`)
        // Number posts (same as idle return post-transfer)
        const recurateSettings = await getSettings()
        const todayMidnightDate = getLocalMidnight(clientDate(), recurateSettings?.timezone)
        const todayMidnight = todayMidnightDate.getTime()
        const todayEnd = getNextLocalMidnight(todayMidnightDate, recurateSettings?.timezone).getTime()
        const yesterdayMidnight = getPrevLocalMidnight(todayMidnightDate, recurateSettings?.timezone).getTime()
        await numberUnnumberedPostsForDay(yesterdayMidnight, todayMidnight, 'Re-curate (yesterday)')
        await numberUnnumberedPostsForDay(todayMidnight, todayEnd, 'Re-curate')
        sessionStorage.removeItem(getFeedStateKey('curated'))
      }

      setLookingBack(false)
      setLookbackMessage('Fetching posts')
      setLookbackProgress(null)
      setIsLoading(false)
      setIsInitialLoad(false)

      if (result) {
        // Display final numbered feed
        await refreshDisplayedFeed({ triggerProbe: true, showAllNewPosts: true })

        // Show re-curation result modal
        setRefreshResultStats({
          totalEntriesRecurated: result.totalEntriesRecurated,
          displayableCount: result.displayableCount,
          editionsAssembled: result.editionsAssembled,
          oldestEntryTimestamp: result.oldestEntryTimestamp,
          newestEntryTimestamp: result.newestEntryTimestamp,
        })
        setRefreshResultTitle('Re-curation complete')
        setShowRefreshResultModal(true)
      }

      log.debug('Debug', 'recurateAndReloadHomePage: Complete!')
    } catch (error) {
      log.error('Debug', 'recurateAndReloadHomePage failed:', error)
      setLookingBack(false)
      setLookbackMessage('Fetching posts')
      setLookbackProgress(null)
    } finally {
      resetPendingRef.current = false
      sessionStorage.removeItem('websky_reset_pending')
    }
  }, [session, refreshDisplayedFeed])

  // Expose reset functions globally
  useEffect(() => {
    (window as any).clearCacheAndReloadHomePage = clearCacheAndReloadHomePage;
    (window as any).resetFeedAndReloadHomePage = resetFeedAndReloadHomePage;
    (window as any).clearRecentAndReloadHomePage = clearRecentAndReloadHomePage;
    (window as any).recurateAndReloadHomePage = recurateAndReloadHomePage
    return () => {
      delete (window as any).clearCacheAndReloadHomePage;
      delete (window as any).resetFeedAndReloadHomePage;
      delete (window as any).clearRecentAndReloadHomePage;
      delete (window as any).recurateAndReloadHomePage
    }
  }, [clearCacheAndReloadHomePage, resetFeedAndReloadHomePage, clearRecentAndReloadHomePage, recurateAndReloadHomePage])

  // Navigation/load feed effect
  useEffect(() => {
    if (locationPathname !== '/') {
      return
    }

    scrollRestoredRef.current = false

    try {
      sessionStorage.removeItem('websky_thread_scroll_position')
    } catch (error) {
      // Ignore errors
    }

    const shouldRedisplay = async () => {
      if (activeTab !== 'curated') {
        return
      }

      // Skip if a reset/refetch operation is pending — it will call loadFeed itself.
      // Check both the ref (for in-component resets) and sessionStorage (for cross-route
      // resets from Settings page, where navigate('/') mounts HomePage before the reset runs).
      if (resetPendingRef.current || sessionStorage.getItem('websky_reset_pending')) {
        log.info('Navigation', 'Skipping shouldRedisplay — reset pending')
        return
      }

      // If feed is already in React state, no need to do anything — it's already rendered.
      // This handles the case where e.g. clearRecentAndReloadHomePage just loaded the feed
      // but the debounced sessionStorage save hasn't fired yet.
      if (feed.length > 0 && initialPrefetchDone) {
        log.info('Navigation', 'Feed already loaded in React state, skipping redisplay')
        return
      }

      try {
        const savedStateJson = sessionStorage.getItem(getFeedStateKey('curated'))
        if (!savedStateJson) {
          // No saved state and feed not yet loaded: this is genuine initial load
          if (!initialPrefetchDone) {
            log.info('Navigation', 'No saved feed state, triggering initial loadFeed')
            return loadFeed()
          }
          // Feed was already loaded (e.g., refetch just ran but debounced save hasn't fired)
          log.info('Navigation', 'No saved feed state but feed already loaded, skipping')
          return
        }

        const savedState: SavedFeedState = JSON.parse(savedStateJson)

        if (savedState.sessionDid !== session?.did) {
          log.info('Navigation', 'Saved state is for different user, skipping (session change will handle)')
          return
        }

        if (savedState.displayedFeed && savedState.displayedFeed.length > 0) {
          log.info('Navigation', 'Redisplaying feed from saved state')
          return redisplayFeed()
        } else {
          log.info('Navigation', 'Saved state has no posts, skipping')
          return
        }
      } catch (error) {
        log.error('Feed', 'Failed to check feed state:', error)
      }
    }

    shouldRedisplay()
  }, [loadFeed, redisplayFeed, locationPathname, session, activeTab])

  // Probe for new posts effect
  useEffect(() => {
    if (!newestDisplayedPostTimestamp || !dbInitialized || !initialPrefetchDone) {
      setNewPostsCount(0)
      setShowNewPostsButton(false)
      setNextPageReady(false)
      return
    }

    const probeInProgressRef = { current: null as number | null }
    const PROBE_STALE_MS = 5 * 60 * 1000
    let cancelled = false

    let rateLimitLoggedRef = false

    const checkForNewPosts = async () => {
      if (isTabDormant()) return

      // Skip probe if retained secondary cache is valid (fresh and has enough posts)
      if (await isRetainedCacheValid()) {
        const cached = retainedSecondaryCache!
        const cacheSettings = await getSettings()
        const cachePageLength = cacheSettings?.feedPageLength || 25
        const remainingDisplayable = cached.entries.filter(e => isStatusShow(e.summary.curation_status)).length
        // Ensure button state reflects cached posts (may have been reset by effect re-run)
        setNextPageReady(true)
        setPartialPageCount(remainingDisplayable)
        setNewPostsCount(remainingDisplayable)
        if (remainingDisplayable >= cachePageLength) {
          setMultiPageCount(remainingDisplayable)
        }
        setIdleTimerTriggered(true)
        log.verbose('Paged Updates', `Skipping probe — valid retained cache (age=${Math.round((clientNow() - cached.fetchedAt) / 1000)}s, ${remainingDisplayable} displayable)`)
        return
      }

      if (isRateLimited()) {
        if (!rateLimitLoggedRef) {
          log.verbose('Paged Updates', `Rate limited, pausing probes (${Math.round(getTimeUntilClear())}s remaining)`)
          rateLimitLoggedRef = true
        }
        return
      }
      if (rateLimitLoggedRef) {
        log.verbose('Paged Updates', 'Rate limit cleared, resuming probes')
        rateLimitLoggedRef = false
      }

      if (probeInProgressRef.current !== null) {
        const elapsed = clientNow() - probeInProgressRef.current
        if (elapsed < PROBE_STALE_MS) {
          log.verbose('Paged Updates', 'Skipping probe — previous probe still in progress')
          return
        }
        log.verbose('Paged Updates', `Previous probe stale (${Math.round(elapsed / 1000)}s), starting new probe`)
      }

      const currentTimestamp = newestDisplayedPostTimestamp
      if (!currentTimestamp) return

      if (!agent || !session) return

      probeInProgressRef.current = clientNow()
      try {
        const pagedSettings = await getPagedUpdatesSettings()
        const pageSize = pagedSettings.pageSize

        const pageRaw = FETCH_BATCH_SIZE

        const currentBoundary = probeBoundaryTimestampRef.current
        log.verbose('Paged Updates/Probe', `Probing for new posts (pageRaw=${pageRaw}, newestDisplayed=${new Date(currentTimestamp).toLocaleTimeString()}, stopBoundary=${currentBoundary ? new Date(currentBoundary).toLocaleTimeString() : 'none'}, oldestDisplayed=${oldestDisplayedPostTimestamp ? new Date(oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'})...`)

        const probeResult = await probeForNewPosts(
          agent,
          pageRaw,
          session.handle,
          session.did,
          currentTimestamp,
          currentBoundary ?? undefined
        )

        // If effect was cleaned up while probe was in flight, discard results
        if (cancelled) {
          log.verbose('Paged Updates', 'Probe completed but effect was cleaned up, discarding results')
          return
        }

        const rawNewestTime = probeResult.rawNewestTimestamp > 0 ? new Date(probeResult.rawNewestTimestamp).toLocaleTimeString() : 'N/A'
        const rawOldestTime = probeResult.rawOldestTimestamp < Number.MAX_SAFE_INTEGER ? new Date(probeResult.rawOldestTimestamp).toLocaleTimeString() : 'N/A'

        log.verbose('Paged Updates/Probe', `Probe result: ${probeResult.filteredPostCount} new displayable (${probeResult.totalPostCount} processed, ${probeResult.rawPostCount} raw, rawNewest=${rawNewestTime}, rawOldest=${rawOldestTime}, gap=${probeResult.hasGap}, overlap=${probeResult.isOverlappingBatch}, lastPostNumber=${probeResult.lastPostNumber ?? 'none'})`)

        // Check if probe results should be retained in secondary cache
        if (probeResult.isOverlappingBatch && probeResult.lastPostNumber != null && probeResult.lastPostNumber > 0
            && probeResult.nonOverlappingEntries && probeResult.nonOverlappingEntries.length > 0
            && probeResult.retentionDisplayableCount != null) {

          const remainder = probeResult.lastPostNumber % pageSize
          const postsNeededForPage = remainder !== 0 ? (pageSize - remainder) : pageSize

          const displayableCount = probeResult.retentionDisplayableCount

          if (displayableCount >= postsNeededForPage) {
            // RETAIN probe results in secondary cache
            setRetainedSecondaryCache({
              entries: probeResult.nonOverlappingEntries,
              fetchedAt: clientNow(),
              newestTimestamp: probeResult.newestProbeTimestamp > 0
                ? probeResult.newestProbeTimestamp : null,
              partPagePostCount: postsNeededForPage < pageSize ? postsNeededForPage : 0,
            })

            // Update boundary
            if (probeResult.rawNewestTimestamp > 0) {
              probeBoundaryTimestampRef.current = Math.max(
                probeBoundaryTimestampRef.current ?? 0,
                probeResult.rawNewestTimestamp
              )
            }

            // Set button state
            const isPartialPage = remainder !== 0
            setNextPageReady(true)
            setPostsNeededForPage(isPartialPage ? postsNeededForPage : null)
            setNewPostsCount(displayableCount)
            setPartialPageCount(displayableCount)
            setShowNewPostsButton(true)
            setIdleTimerTriggered(true)
            if (displayableCount > postsNeededForPage) {
              setMultiPageCount(displayableCount)
            }

            // Reset accumulated counts (cache is authoritative)
            unprocessedRawCountRef.current = 0
            unprocessedShowCountRef.current = 0
            probeHasGapRef.current = probeResult.hasGap

            log.debug('Paged Updates', `Retained probe results: ${displayableCount} displayable, ${probeResult.nonOverlappingEntries.length} entries, postsNeededForPage=${postsNeededForPage}, partialPage=${isPartialPage}`)
            return  // Skip normal accumulation path
          } else {
            log.verbose('Paged Updates', `Not retaining: ${displayableCount} displayable < ${postsNeededForPage} needed for page completion`)
          }
        }

        // Non-retention path: accumulate counts across probes

        // Update probe boundary to newest raw post seen
        if (probeResult.rawNewestTimestamp > 0) {
          probeBoundaryTimestampRef.current = Math.max(
            probeBoundaryTimestampRef.current ?? 0,
            probeResult.rawNewestTimestamp
          )
        }

        // Accumulate counts from this probe
        unprocessedRawCountRef.current += probeResult.totalPostCount
        unprocessedShowCountRef.current += probeResult.filteredPostCount

        // Track gap state (sticky until reset by button click)
        if (probeResult.hasGap) {
          probeHasGapRef.current = true
        }

        const effectiveCount = unprocessedShowCountRef.current

        log.verbose('Paged Updates/Probe', `Accumulated: ${effectiveCount} show, ${unprocessedRawCountRef.current} raw`)

        probeExpectedCountRef.current = effectiveCount

        const hasFullPage = effectiveCount >= pageSize
        const hasMultiplePages = effectiveCount > pageSize

        const isForceProbe = forceProbeRef.current
        if (isForceProbe) {
          forceProbeRef.current = false
          log.verbose('Paged Updates', 'Force-probe: bypassing cooldown')
        }
        const inCooldown = !isForceProbe && clientNow() - lastDisplayTimeRef.current < DISPLAY_COOLDOWN_MS
        if (inCooldown) {
          log.verbose('Paged Updates', `In cooldown (${Math.round((DISPLAY_COOLDOWN_MS - (clientNow() - lastDisplayTimeRef.current)) / 1000)}s remaining), skipping button updates`)
          return
        }

        if (hasMultiplePages) {
          setMultiPageCount(effectiveCount)
          log.verbose('Paged Updates', `Multi-page detected: ${effectiveCount} posts`)
        }
        // Don't reset multiPageCount to 0 — once multi-page is detected,
        // keep it sticky until an explicit load action resets it.

        if (nextPageReadyRef.current) {
          setNewPostsCount(effectiveCount)
          setPartialPageCount(effectiveCount)
          log.verbose('Paged Updates', `Next Page already ready, skipping button state update (${effectiveCount} posts available)`)
          return
        }

        let postsToNextBoundary = pageSize
        let needsBoundaryAlignment = false

        if (feed.length > 0) {
          const newestCurationNum = (feed[0] as CurationFeedViewPost).curation?.curationNumber
          if (newestCurationNum && newestCurationNum > 0) {
            const remainder = newestCurationNum % pageSize
            if (remainder !== 0) {
              postsToNextBoundary = pageSize - remainder
              if (effectiveCount >= postsToNextBoundary) {
                needsBoundaryAlignment = true
              }
            }
          }
        }

        const isReady = hasFullPage || needsBoundaryAlignment
        const isPartialPage = needsBoundaryAlignment && postsToNextBoundary < pageSize
        setNextPageReady(isReady)
        setPostsNeededForPage(isPartialPage ? postsToNextBoundary : null)
        setNewPostsCount(effectiveCount)
        setPartialPageCount(effectiveCount)
        setShowNewPostsButton(isReady)

        if (isPartialPage) {
          log.verbose('Paged Updates', `Partial page ready (boundary alignment): ${effectiveCount} posts (need ${postsToNextBoundary} to reach next boundary)`)
        } else if (hasFullPage) {
          log.verbose('Paged Updates', `Full page ready: ${effectiveCount} posts`)
        } else {
          log.verbose('Paged Updates', `Partial page: ${effectiveCount}/${pageSize} posts (idle timer will handle "All new posts" button)`)
        }
      } catch (error) {
        log.warn('Paged Updates', 'Probe error:', error)
      } finally {
        probeInProgressRef.current = null
      }
    }

    checkForNewPosts()

    const interval = clientInterval(checkForNewPosts, 60000)

    const handleVisibilityChange = async () => {
      if (!document.hidden && !isTabDormant()) {
        log.verbose('Paged Updates', 'Page became visible, triggering immediate probe')
        checkForNewPosts()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      clearClientInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [newestDisplayedPostTimestamp, dbInitialized, isInitialLoad, initialPrefetchDone, agent, session, forceProbeTrigger])

  // Idle timer for partial page display
  useEffect(() => {
    if (!newestDisplayedPostTimestamp || isInitialLoad) {
      setIdleTimerTriggered(false)
      return
    }

    let idleLoggedWhileRateLimited = false

    const checkIdleTime = async () => {
      if (isTabDormant()) return
      if (isRateLimited()) {
        if (!idleLoggedWhileRateLimited) {
          log.verbose('Idle Timer', 'Paused during rate limit')
          idleLoggedWhileRateLimited = true
        }
        return
      }
      if (idleLoggedWhileRateLimited) {
        idleLoggedWhileRateLimited = false
      }

      const pagedSettings = await getPagedUpdatesSettings()
      const fullPageWaitMs = pagedSettings.fullPageWaitMinutes * 60 * 1000

      const timeSinceTopPost = clientNow() - newestDisplayedPostTimestamp

      if (timeSinceTopPost >= fullPageWaitMs && partialPageCount > 0) {
        setIdleTimerTriggered(true)
        log.verbose('Idle Timer', `Triggered: ${Math.round(timeSinceTopPost / 60000)} min elapsed, ${partialPageCount} posts available`)
      } else if (!idleTimerForcedRef.current) {
        setIdleTimerTriggered(false)
      }
    }

    checkIdleTime()
    const interval = clientInterval(checkIdleTime, 30000)

    return () => clearClientInterval(interval)
  }, [newestDisplayedPostTimestamp, isInitialLoad, partialPageCount])

  return {
    feed, setFeed,
    previousPageFeed, setPreviousPageFeed,
    isPrefetching, setIsPrefetching,
    feedTopTrimmed, setFeedTopTrimmed,
    initialPrefetchDone, setInitialPrefetchDone,
    cursor,
    hasMorePosts,
    serverCursor,
    isLoading,
    isLoadingMore, setIsLoadingMore,
    dbInitialized,
    skylimitStats,
    curationSuspended,
    showAllPosts,
    newestDisplayedPostTimestamp, setNewestDisplayedPostTimestamp,
    oldestDisplayedPostTimestamp, setOldestDisplayedPostTimestamp,
    isInitialLoad,
    lookingBack,
    lookbackProgress,
    lookbackMessage,
    initPhase,
    showCurationInitModal, setShowCurationInitModal,
    curationInitStats,
    showRefreshResultModal, setShowRefreshResultModal,
    refreshResultStats,
    refreshResultTitle,
    newPostsCount, setNewPostsCount,
    showNewPostsButton, setShowNewPostsButton,
    nextPageReady, setNextPageReady,
    partialPageCount, setPartialPageCount,
    postsNeededForPage, setPostsNeededForPage,
    multiPageCount, setMultiPageCount,
    idleTimerTriggered, setIdleTimerTriggered,
    syncInProgress, setSyncInProgress,
    syncProgress, setSyncProgress,
    infiniteScrollingEnabled,
    loadFeedRef,
    previousPageFeedRef,
    isPrefetchingRef,
    prevPageHadUnnumberedRef,
    lastDisplayTimeRef,
    forceProbeRef,
    probeExpectedCountRef,
    nextPageReadyRef,
    probeBoundaryTimestampRef,
    unprocessedRawCountRef,
    unprocessedShowCountRef,
    probeHasGapRef,
    idleTimerForcedRef,
    loadFeed,
    redisplayFeed,
    refreshDisplayedFeed,
    clearCacheAndReloadHomePage,
    resetFeedAndReloadHomePage,
    clearRecentAndReloadHomePage,
    recurateAndReloadHomePage,
    prefetchPrevPage,
    lookupCurationAndFilter,
    trimFeedIfNeeded,
    forceProbeTrigger, setForceProbeTrigger,
  }
}
