import { useState, useEffect, useCallback, useRef } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import type { BskyAgent } from '@atproto/api'
import { getHomeFeed } from '../api/feed'
import { CurationInitStatsDisplay } from '../components/CurationInitModal'
import { insertEditionPosts } from '../curation/skylimitTimeline'
import { initDB, closeDB, getFilter, getPostSummary, isPostSummariesCacheEmpty, getCurationInitStats, checkPostSummaryExists, isSummariesCacheFresh } from '../curation/skylimitCache'
import { getSettings } from '../curation/skylimitStore'
import { computeFilterFrac } from '../curation/skylimitStats'
import { probeForNewPosts, calculatePageRaw, getPagedUpdatesSettings } from '../curation/pagedUpdates'
import { flushExpiredParentPosts } from '../curation/parentPostCache'
import { scheduleStatsComputation, computeStatsInBackground } from '../curation/skylimitStatsWorker'
import { recomputeCurationDecisions } from '../curation/skylimitRecurate'
import { GlobalStats, CurationFeedViewPost, SecondaryEntry, getIntervalHoursSync, isStatusShow } from '../curation/types'
import { getCachedFeed, clearFeedCache, clearFeedMetadata, getLastFetchMetadata, getCachedFeedBefore, updateFeedCacheOldestPostTimestamp, getCachedFeedAfterPosts, shouldUseCacheOnLoad, createFeedCacheEntries, savePostsWithCuration, validateFeedCacheIntegrity, getLocalMidnight, fetchPageFromTimestamp, isCacheWithinLookback, getNewestCachedPostTimestamp, getFreshPrevPageCursor, clearPrevPageCursor, getPrevPageCursorStatus, markInitialLookbackCompleted, fetchToSecondaryFeedCache, transferSecondaryToPrimary, curateEntriesToSecondary, secondaryEntriesToCuratedFeed, filterSecondaryForDisplay } from '../curation/skylimitFeedCache'
import { getPostUniqueId, getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { numberUnnumberedPostsForDay, assignNumbersForDay } from '../curation/skylimitNumbering'
import { clientNow, clientDate, clientTimeout, clearClientTimeout, clientInterval, clearClientInterval } from '../utils/clientClock'
import { HomeTab, getFeedStateKey, getScrollStateKey, HOME_TAB_STATE_KEY, DEFAULT_MAX_DISPLAYED_FEED_SIZE, SavedFeedState, findLowestVisiblePostTimestamp, alignFeedToPageBoundary, RefreshDisplayedFeedOptions, RefreshDisplayedFeedResult } from './homePageTypes'

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
  showCurationInitModal: boolean
  setShowCurationInitModal: React.Dispatch<React.SetStateAction<boolean>>
  curationInitStats: CurationInitStatsDisplay | null
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
  // Callbacks
  loadFeed: (cursor?: string, useCache?: boolean) => Promise<void>
  redisplayFeed: () => Promise<void>
  refreshDisplayedFeed: (options?: RefreshDisplayedFeedOptions) => Promise<RefreshDisplayedFeedResult | null>
  clearCacheAndReloadHomePage: () => Promise<void>
  resetFeedAndReloadHomePage: () => Promise<void>
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
  const [showCurationInitModal, setShowCurationInitModal] = useState(false)
  const [curationInitStats, setCurationInitStats] = useState<CurationInitStatsDisplay | null>(null)
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
  const isInitialCurationRef = useRef(false)
  const forceInitialLoadRef = useRef(false)
  const previousPageFeedRef = useRef<CurationFeedViewPost[]>([])
  const isPrefetchingRef = useRef(false)
  const prevPageHadUnnumberedRef = useRef(false)

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
        console.warn('Failed to load infinite scrolling setting:', error)
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
          console.log('[Init] Feed cache was cleared due to missing summaries')
        }
        if (integrity.empty) {
          console.log('[Init] Feed cache is empty')
        }
        sessionStorage.removeItem(getFeedStateKey('curated'))
        console.log('[Init] Cleared sessionStorage saved feed state')
      }

      const summariesEmpty = await isPostSummariesCacheEmpty()
      if (summariesEmpty) {
        console.log('[Init] Summaries cache is empty - initial curation will be performed')
        isInitialCurationRef.current = true
      }

      console.log('[Failsafe] Setting dbInitialized=true')
      setDbInitialized(true)

      if (agent && session) {
        cleanup = scheduleStatsComputation(agent, session.handle, session.did)
      }

      loadSkylimitStats()

      flushExpiredParentPosts().catch(err => {
        console.warn('Failed to flush expired parent posts:', err)
      })
    }).catch(err => {
      console.error('Failed to initialize database:', err)
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
      flushExpiredParentPosts().catch(err => {
        console.warn('Failed to flush expired parent posts:', err)
      })
    }, 60 * 60 * 1000)

    return () => clearClientInterval(flushInterval)
  }, [dbInitialized])

  // Save feed state whenever it changes (debounced) - only for curated tab
  useEffect(() => {
    if (locationPathname !== '/') return
    if (activeTab !== 'curated') return
    if (isLoading) return

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
        console.warn('Failed to save feed state:', error)
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
      console.error('Failed to load Skylimit stats:', error)
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

    console.log(`[Trim] Removed ${actualTrimCount} oldest posts, saved ${adjacentPage.length} as previousPageFeed, new feed size: ${newFeed.length}`)

    return newFeed
  }, [])

  // Pre-fetch the next page for instant Prev Page
  const prefetchPrevPage = useCallback(async (afterTimestamp: number, targetSize?: number) => {
    if (!agent || !session) return

    try {
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const effectivePageLength = targetSize ?? pageLength
      const lookbackDays = settings?.lookbackDays || 1

      const newestCachedTimestamp = await getNewestCachedPostTimestamp()
      if (!isCacheWithinLookback(newestCachedTimestamp, lookbackDays, settings?.timezone)) {
        console.log('[Prefetch] Cache is stale, clearing and reloading')
        await clearFeedCache()
        await clearPrevPageCursor()
        setPreviousPageFeed([])
        return
      }

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

      if (prevPageHadUnnumberedRef.current && postsForNextPage.length > 0) {
        const newestFetched = postsForNextPage[0]
        const newestId = getPostUniqueId(newestFetched)
        const newestSummary = await getPostSummary(newestId)
        if (newestSummary?.postNumber != null && newestSummary.postNumber > 0) {
          const fetchDayStart = getLocalMidnight(new Date(afterTimestamp), settings?.timezone).getTime()
          const fetchDayEnd = fetchDayStart + 24 * 60 * 60 * 1000
          const preNumbered = await numberUnnumberedPostsForDay(fetchDayStart, fetchDayEnd, '[Prefetch]')
          if (preNumbered > 0) {
            console.log(`[Prefetch] Numbered ${preNumbered} unnumbered posts (previous page had unnumbered)`)
          }
          prevPageHadUnnumberedRef.current = false
        }
      }

      if (postsForNextPage.length < pageLength) {
        console.log('[Prefetch] Cache exhausted or partial, checking for cursor')

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

        if (cursorToUse && serverResult.posts.length === 0 && !serverResult.hasMore) {
          console.warn('[Prefetch] Cursor fetch failed - cursor may be invalid')
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
          console.log('[Prefetch] No more posts available')
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
          console.log(`[Prefetch] No new posts from batch of ${postsForNextPage.length} (stall ${consecutiveNoProgress}/${MAX_NO_PROGRESS})`)
          if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
            console.log(`[Prefetch] No progress for ${MAX_NO_PROGRESS} fetches, stopping with ${accumulatedFiltered.length} posts`)
            break
          }
        } else {
          consecutiveNoProgress = 0
          accumulatedFiltered = [...accumulatedFiltered, ...newFiltered]
          console.log(`[Prefetch] Added ${newFiltered.length} posts, total: ${accumulatedFiltered.length}/${effectivePageLength}`)
        }

        if (accumulatedFiltered.length >= effectivePageLength) {
          console.log(`[Prefetch] Reached target: ${accumulatedFiltered.length} posts`)
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
            console.log('[Prefetch] Server also exhausted')
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
              const dayStart = getLocalMidnight(new Date(nextTs), settings?.timezone).getTime()
              const dayEnd = dayStart + 24 * 60 * 60 * 1000
              console.log(`[Prefetch] Mid-day numbering trigger at post #${nextNum}`)
              await numberUnnumberedPostsForDay(dayStart, dayEnd, '[Prefetch]')
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
          console.log(`[Prefetch] Midnight filter: kept ${filtered.length}/${originalCount} posts from ${lastDate} (older day)`)

          const newerDayPost = accumulatedFiltered.find(p => getLocalDateString(p) === firstDate)
          if (newerDayPost) {
            const nTs = accumulatedTimestamps.get(getPostUniqueId(newerDayPost)) ?? accumulatedTimestamps.get(newerDayPost.post.uri)
            if (nTs && (newerDayPost as CurationFeedViewPost).curation?.postNumber == null) {
              const newerDayStart = getLocalMidnight(new Date(nTs), settings?.timezone).getTime()
              const newerDayEnd = newerDayStart + 24 * 60 * 60 * 1000
              console.log(`[Prefetch] Midnight trigger: numbering newer day ${firstDate}`)
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
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const lookbackDays = settings?.lookbackDays || 1
      const initialCacheLength = pageLength * 2

      setRateLimitStatus(null)

      const feedCacheIsFresh = await shouldUseCacheOnLoad(lookbackDays)
      const summariesCacheIsFresh = await isSummariesCacheFresh()
      console.log(`[Feed] Cache status: feedCache=${feedCacheIsFresh ? 'fresh' : 'stale'}, summariesCache=${summariesCacheIsFresh ? 'fresh' : 'stale'}`)

      const idleThreshold = settings?.feedRedisplayIdleInterval ?? 5 * 60 * 1000
      const metadata = await getLastFetchMetadata()
      const timeSinceLastFetch = metadata?.lastFetchTime ? clientNow() - metadata.lastFetchTime : Infinity
      const idleTimeExceeded = timeSinceLastFetch > idleThreshold

      let isIdleReturnMode = false
      let isInitialLoadMode = false
      let preIdleCacheNewest: number | null = null

      if (!summariesCacheIsFresh || forceInitialLoadRef.current) {
        forceInitialLoadRef.current = false
        isInitialLoadMode = true
        console.log(`[Feed] Mode: INITIAL LOAD - ${summariesCacheIsFresh ? 'forced by Reset Feed' : 'summaries cache stale (< 24h span)'}, clearing feed cache`)
        await clearFeedCache()
        await clearFeedMetadata()
      } else if (!feedCacheIsFresh) {
        isIdleReturnMode = true
        console.log('[Feed] Mode: IDLE RETURN - feed cache stale but summaries fresh, clearing feed cache')
        await clearFeedCache()
        await clearFeedMetadata()
      } else if (idleTimeExceeded) {
        isIdleReturnMode = true
        preIdleCacheNewest = metadata?.newestCachedPostTimestamp ?? null
        console.log(`[Feed] Mode: IDLE RETURN - idle time exceeded (${Math.round(timeSinceLastFetch / 60000)} min > ${Math.round(idleThreshold / 60000)} min threshold), preserving cache, pre-idle newest: ${preIdleCacheNewest ? new Date(preIdleCacheNewest).toLocaleString() : 'null'}`)
      } else {
        console.log(`[Feed] Mode: USE CACHE - both caches fresh, idle time ${Math.round(timeSinceLastFetch / 60000)} min within ${Math.round(idleThreshold / 60000)} min threshold`)
      }

      if (!cursor && useCache && !isIdleReturnMode && !isInitialLoadMode) {
        const result = await refreshDisplayedFeed({ triggerProbe: false, showAllNewPosts: false })
        if (result) {
          const cachedMetadata = await getLastFetchMetadata()
          setCursor(cachedMetadata?.lastCursor)
          setHasMorePosts(result.oldestTimestamp !== null || cachedMetadata?.lastCursor !== undefined)
          setIsInitialLoad(false)
          setIsLoading(false)
          console.log(`[Feed] Loaded ${result.alignedPosts.length} posts from cache via refreshDisplayedFeed`)

          const cachedPosts = await getCachedFeed(initialCacheLength)
          if (cachedPosts.length > 0) {
            const oldestCachedTs = getFeedViewPostTimestamp(cachedPosts[cachedPosts.length - 1], clientDate()).getTime()
            await updateFeedCacheOldestPostTimestamp(oldestCachedTs)
          }
          return
        }
      }

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

      if (newFeed.length > 0 && !cursor) {
        const newestPost = newFeed[0]
        const oldestPost = newFeed[newFeed.length - 1]
        const newestTime = new Date((newestPost.post.record as any)?.createdAt || newestPost.post.indexedAt || 0)
        const oldestTime = new Date((oldestPost.post.record as any)?.createdAt || oldestPost.post.indexedAt || 0)
        console.log(`[Feed] Fetched ${newFeed.length} posts. Newest: ${newestTime.toLocaleString()}, Oldest: ${oldestTime.toLocaleString()}`)
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
          console.log(`[Idle Return] All ${entries.length} posts already have cached summaries - gap already filled`)
        } else if (firstCachedSummaryIndex > 0) {
          entriesToSave = entries.slice(0, firstCachedSummaryIndex)
          console.log(`[Idle Return] ${entriesToSave.length} posts need curation, ${entries.length - firstCachedSummaryIndex} already have summaries`)
        } else {
          console.log(`[Idle Return] No cached summaries found in first page - full lookback needed`)
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
        console.log(`[Curation] Processed ${curatedFeed.length} posts (all posts, including dropped)`)
      }

      const feedWithEditions = await insertEditionPosts(curatedFeed)

      const feedReceivedTime = initialLastPostTime

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
        const combinedFeed = [...feed, ...filteredPosts]
        combinedFeed.sort((a, b) => {
          const aTime = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
          const bTime = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
          return bTime - aTime
        })
        setFeed(combinedFeed)
      } else {
        setFeed(filteredPosts)
        setPreviousPageFeed([])
        if (filteredPosts.length > 0) {
          const newestTimestamp = getFeedViewPostTimestamp(filteredPosts[0], feedReceivedTime).getTime()
          setNewestDisplayedPostTimestamp(newestTimestamp)
          console.log(`[New Posts] Set newestDisplayedPostTimestamp from displayed posts: ${new Date(newestTimestamp).toISOString()}`)

          const oldestDisplayedTimestamp = getFeedViewPostTimestamp(filteredPosts[filteredPosts.length - 1], feedReceivedTime).getTime()
          setOldestDisplayedPostTimestamp(oldestDisplayedTimestamp)
          console.log(`[Feed] Set oldestDisplayedPostTimestamp from displayed posts: ${new Date(oldestDisplayedTimestamp).toISOString()} (from ${filteredPosts.length} displayed posts)`)

          if (!initialSecondaryEntries) {
            const oldestFetchedTimestamp = feedWithEditions.length > 0
              ? getFeedViewPostTimestamp(feedWithEditions[feedWithEditions.length - 1], feedReceivedTime).getTime()
              : undefined
            if (oldestFetchedTimestamp !== undefined) {
              await updateFeedCacheOldestPostTimestamp(oldestFetchedTimestamp)
              console.log(`[Feed] Updated oldestCachedPostTimestamp in metadata to oldest fetched post: ${new Date(oldestFetchedTimestamp).toISOString()} (from ${feedWithEditions.length} fetched posts, ${filteredPosts.length} displayed)`)
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
            const fetchMode = isIdleReturnMode ? 'idle_return' as const : 'initial' as const
            console.log(`[Background Lookback] Starting unified fetch (mode: ${fetchMode})...`)

            if (isInitialLoadMode) {
              await clearPrevPageCursor()
            }

            setLookingBack(true)
            setLookbackProgress(0)

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

              let allEntries = fetchResult.entries
              if (initialSecondaryEntries) {
                allEntries = [...initialSecondaryEntries, ...allEntries]
                console.log(`[Background Lookback] Combined ${initialSecondaryEntries.length} initial + ${fetchResult.entries.length} lookback = ${allEntries.length} total entries`)
              }

              if (allEntries.length > 0) {
                const transferResult = await transferSecondaryToPrimary(allEntries, 'all', pageLength, isInitialLoadMode)
                console.log(`[Background Lookback] Transferred ${transferResult.postsTransferred} posts to primary`)
              }

              setLookingBack(false)
              setLookbackProgress(100)

              if (isInitialLoadMode) {
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
            console.log('[Idle Return] Gap already filled by first page - skipping background lookback')

            if (initialSecondaryEntries && initialSecondaryEntries.length > 0) {
              const transferResult = await transferSecondaryToPrimary(initialSecondaryEntries, 'all', pageLength, true)
              console.log(`[Idle Return] Persisted ${transferResult.postsTransferred} new posts to primary cache`)
            }

            if (entriesToSave.length > 0) {
              const idleReturnSettings = await getSettings()
              const todayMidnight = getLocalMidnight(clientDate(), idleReturnSettings?.timezone).getTime()
              const todayEnd = todayMidnight + 24 * 60 * 60 * 1000
              const yesterdayMidnight = todayMidnight - 24 * 60 * 60 * 1000
              const numberedYesterday = await numberUnnumberedPostsForDay(yesterdayMidnight, todayMidnight, '[Idle Return] (yesterday)')
              const numberedToday = await numberUnnumberedPostsForDay(todayMidnight, todayEnd, '[Idle Return]')

              if (numberedYesterday + numberedToday > 0) {
                sessionStorage.removeItem(getFeedStateKey('curated'))
                console.log('[Idle Return] Refreshing feed display with numbered posts...')
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
      console.error('Failed to load feed:', error)
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
        console.log('[Redisplay] No saved feed state, falling back to loadFeed')
        return loadFeed()
      }

      const savedState: SavedFeedState = JSON.parse(savedStateJson)

      if (savedState.sessionDid !== session.did) {
        console.log('[Redisplay] Saved state is for different user, falling back to loadFeed')
        sessionStorage.removeItem(getFeedStateKey('curated'))
        return loadFeed()
      }

      if (!savedState.displayedFeed || savedState.displayedFeed.length === 0) {
        console.log('[Redisplay] Saved state has no posts, falling back to loadFeed')
        return loadFeed()
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
        console.log(`[Redisplay] Settings changed to show more posts (suspended: ${savedCurationSuspended}→${currentCurationSuspended}, showAll: ${savedShowAllPosts}→${currentShowAllPosts}), falling back to loadFeed`)
        sessionStorage.removeItem(getFeedStateKey('curated'))
        return loadFeed()
      }

      if (settingsChanged) {
        console.log(`[Redisplay] Curation settings changed (suspended: ${savedCurationSuspended}→${currentCurationSuspended}, showAll: ${savedShowAllPosts}→${currentShowAllPosts}), will re-filter`)
      }

      let feedWithCuration = await lookupCurationAndFilter(
        savedState.displayedFeed as CurationFeedViewPost[],
        feedReceivedTime,
        undefined,
        !settingsChanged
      )

      feedWithCuration = alignFeedToPageBoundary(feedWithCuration, pageLength)

      const originalLength = feedWithCuration.length
      feedWithCuration = trimFeedIfNeeded(feedWithCuration, pageLength, feedReceivedTime, maxDisplayedFeedSize)
      const truncated = feedWithCuration.length < originalLength

      if (truncated) {
        console.log(`[Redisplay] Truncated feed from ${originalLength} to ${feedWithCuration.length} posts using trimFeedIfNeeded`)
      }

      setFeed(feedWithCuration)

      if (feedWithCuration.length > 0) {
        const newestTimestamp = getFeedViewPostTimestamp(feedWithCuration[0], feedReceivedTime).getTime()
        const oldestTimestamp = getFeedViewPostTimestamp(feedWithCuration[feedWithCuration.length - 1], feedReceivedTime).getTime()

        const rdFirst = feedWithCuration[0] as CurationFeedViewPost
        const rdLast = feedWithCuration[feedWithCuration.length - 1] as CurationFeedViewPost
        console.log(`[Redisplay DEBUG] Restored feed range: newest=${new Date(newestTimestamp).toLocaleTimeString()} (#${rdFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(oldestTimestamp).toLocaleTimeString()} (#${rdLast.curation?.curationNumber ?? '?'}), savedOldest=${savedState.oldestDisplayedPostTimestamp ? new Date(savedState.oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'}`)

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
        console.log('[Redisplay] previousPageFeed set by trimFeedIfNeeded')
      } else if (savedState.previousPageFeed && savedState.previousPageFeed.length > 0) {
        const previousWithCuration = await lookupCurationAndFilter(
          savedState.previousPageFeed as CurationFeedViewPost[],
          feedReceivedTime,
          undefined,
          true
        )
        setPreviousPageFeed(previousWithCuration)
        setInitialPrefetchDone(true)
        console.log(`[Redisplay] Restored previousPageFeed: ${previousWithCuration.length} posts`)
        if (previousWithCuration.length > 0) {
          const rpNewest = getFeedViewPostTimestamp(previousWithCuration[0], feedReceivedTime).getTime()
          const rpOldest = getFeedViewPostTimestamp(previousWithCuration[previousWithCuration.length - 1], feedReceivedTime).getTime()
          const rpFirst = previousWithCuration[0] as CurationFeedViewPost
          const rpLast = previousWithCuration[previousWithCuration.length - 1] as CurationFeedViewPost
          console.log(`[Redisplay DEBUG] Restored previousPageFeed range: newest=${new Date(rpNewest).toLocaleTimeString()} (#${rpFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(rpOldest).toLocaleTimeString()} (#${rpLast.curation?.curationNumber ?? '?'})`)
        }
      } else if (oldestTimestamp) {
        console.log(`[Redisplay DEBUG] Triggering prefetch with oldestTimestamp=${new Date(oldestTimestamp).toLocaleTimeString()} (${oldestTimestamp})`)
        setTimeout(async () => {
          await prefetchPrevPage(oldestTimestamp)
          setInitialPrefetchDone(true)
        }, 100)
      }

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
                console.log('[Redisplay] Updated new posts count:', count, `(${newPosts.length} in cache, ${count} after filtering)`)
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
          console.warn('Background new posts check failed:', err)
        }
      }, 0)

    } catch (error) {
      console.error('Failed to redisplay feed:', error)
      return loadFeed()
    }
  }, [agent, session, dbInitialized, loadFeed])

  const refreshDisplayedFeed = useCallback(async (options?: RefreshDisplayedFeedOptions): Promise<RefreshDisplayedFeedResult | null> => {
    if (!agent || !session || !dbInitialized || isLoadingMore || activeTab !== 'curated') {
      console.log('[Refresh] Guard: skipping refresh', { agent: !!agent, session: !!session, dbInitialized, isLoadingMore, activeTab })
      return null
    }

    const effectiveNewestTimestamp = options?.newestTimestamp ?? newestDisplayedPostTimestamp

    console.log(`[Refresh] Starting refresh (newestTimestamp=${effectiveNewestTimestamp ? new Date(effectiveNewestTimestamp).toLocaleTimeString() : 'null (newest from cache)'}, triggerProbe=${options?.triggerProbe !== false}, showAllNewPosts=${options?.showAllNewPosts !== false})`)

    if (options?.triggerProbe !== false) {
      forceProbeRef.current = true
      setForceProbeTrigger(n => n + 1)
    }

    if (options?.showAllNewPosts !== false) {
      setIdleTimerTriggered(true)
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
          console.log('[Refresh] Cache exhausted')
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

      const firstPost = alignedPosts[0] as CurationFeedViewPost
      const lastPost = alignedPosts[alignedPosts.length - 1] as CurationFeedViewPost
      console.log(`[Refresh] Feed updated: ${alignedPosts.length} posts, newest=#${firstPost.curation?.curationNumber ?? '?'} (${new Date(newNewestTimestamp).toLocaleTimeString()}), oldest=#${lastPost.curation?.curationNumber ?? '?'} (${new Date(newOldestTimestamp).toLocaleTimeString()})`)

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

  // Clear all caches and trigger fresh initial load
  const clearCacheAndReloadHomePage = useCallback(async () => {
    console.log('[Debug] clearCacheAndReloadHomePage: Starting...')

    try {
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)
      console.log('[Debug] Cleared sessionStorage')

      const database = await initDB()

      const summariesTx = database.transaction(['post_summaries'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = summariesTx.objectStore('post_summaries').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared summaries cache')

      const feedTx = database.transaction(['feed_cache'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = feedTx.objectStore('feed_cache').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared feed_cache')

      const metaTx = database.transaction(['feed_metadata'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = metaTx.objectStore('feed_metadata').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared feed_metadata')

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

      isInitialCurationRef.current = true
      console.log('[Debug] Set isInitialCurationRef to true for modal display')

      console.log('[Debug] Triggering fresh loadFeed with useCache=false...')
      await loadFeed(undefined, false)
      console.log('[Debug] clearCacheAndReloadHomePage: Complete!')

    } catch (error) {
      console.error('[Debug] clearCacheAndReloadHomePage failed:', error)
    }
  }, [loadFeed])

  // Reset feed only (preserve summaries)
  const resetFeedAndReloadHomePage = useCallback(async () => {
    console.log('[Debug] resetFeedAndReloadHomePage: Starting...')

    try {
      sessionStorage.removeItem(getFeedStateKey('curated'))
      sessionStorage.removeItem(getScrollStateKey('curated'))
      sessionStorage.removeItem(getFeedStateKey('editions'))
      sessionStorage.removeItem(getScrollStateKey('editions'))
      sessionStorage.removeItem(HOME_TAB_STATE_KEY)
      console.log('[Debug] Cleared sessionStorage')

      const database = await initDB()

      const feedTx = database.transaction(['feed_cache'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = feedTx.objectStore('feed_cache').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared feed_cache')

      const metaTx = database.transaction(['feed_metadata'], 'readwrite')
      await new Promise<void>((resolve, reject) => {
        const req = metaTx.objectStore('feed_metadata').clear()
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
      console.log('[Debug] Cleared feed_metadata')

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

      forceInitialLoadRef.current = true
      console.log('[Debug] Set forceInitialLoadRef to true')

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

      try {
        const savedStateJson = sessionStorage.getItem(getFeedStateKey('curated'))
        if (!savedStateJson) {
          console.log('[Navigation] No saved feed state, calling loadFeed')
          return loadFeed()
        }

        const savedState: SavedFeedState = JSON.parse(savedStateJson)

        if (savedState.sessionDid !== session?.did) {
          console.log('[Navigation] Saved state is for different user, calling loadFeed')
          sessionStorage.removeItem(getFeedStateKey('curated'))
          return loadFeed()
        }

        const settings = await getSettings()
        const idleInterval = settings?.feedRedisplayIdleInterval || 5 * 60 * 1000

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
          sessionStorage.removeItem(getScrollStateKey('curated'))
          return loadFeed()
        }
      } catch (error) {
        console.error('Failed to check feed state:', error)
        return loadFeed()
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

    const checkForNewPosts = async () => {
      if (probeInProgressRef.current !== null) {
        const elapsed = clientNow() - probeInProgressRef.current
        if (elapsed < PROBE_STALE_MS) {
          console.log('[Paged Updates] Skipping probe — previous probe still in progress')
          return
        }
        console.log(`[Paged Updates] Previous probe stale (${Math.round(elapsed / 1000)}s), starting new probe`)
      }

      const currentTimestamp = newestDisplayedPostTimestamp
      if (!currentTimestamp) return

      if (!agent || !session) return

      probeInProgressRef.current = clientNow()
      try {
        const [, currentProbs] = await getFilter() || [null, null]
        const currentFilterFrac = currentProbs ? computeFilterFrac(currentProbs) : 0.5

        const pagedSettings = await getPagedUpdatesSettings()
        const pageSize = pagedSettings.pageSize
        const varFactor = pagedSettings.varFactor

        const pageRaw = calculatePageRaw(pageSize * 3, currentFilterFrac, varFactor)

        console.log(`[Paged Updates] Probing for new posts (filterFrac=${currentFilterFrac.toFixed(2)}, pageRaw=${pageRaw}, newestDisplayed=${new Date(currentTimestamp).toLocaleTimeString()}, oldestDisplayed=${oldestDisplayedPostTimestamp ? new Date(oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'})...`)

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

        probeExpectedCountRef.current = probeResult.filteredPostCount

        const hasFullPage = probeResult.filteredPostCount >= pageSize
        const hasMultiplePages = probeResult.hasMultiplePages

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

        if (hasMultiplePages) {
          setMultiPageCount(probeResult.filteredPostCount)
          console.log(`[Paged Updates] Multi-page detected: ${probeResult.filteredPostCount} posts (${probeResult.pageCount} pages)`)
        }
        // Don't reset multiPageCount to 0 — once multi-page is detected,
        // keep it sticky until an explicit load action resets it.
        // This prevents flip-flop when probe filteredPostCount fluctuates
        // around the pageSize threshold due to probabilistic curation.

        if (nextPageReadyRef.current) {
          setNewPostsCount(probeResult.filteredPostCount)
          setPartialPageCount(probeResult.filteredPostCount)
          console.log(`[Paged Updates] Next Page already ready, skipping button state update (${probeResult.filteredPostCount} posts available)`)
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
              if (probeResult.filteredPostCount >= postsToNextBoundary) {
                needsBoundaryAlignment = true
              }
            }
          }
        }

        const isReady = hasFullPage || needsBoundaryAlignment
        const isPartialPage = needsBoundaryAlignment && postsToNextBoundary < pageSize
        setNextPageReady(isReady)
        setPostsNeededForPage(isPartialPage ? postsToNextBoundary : null)
        setNewPostsCount(probeResult.filteredPostCount)
        setPartialPageCount(probeResult.filteredPostCount)
        setShowNewPostsButton(isReady)

        if (isPartialPage) {
          console.log(`[Paged Updates] Partial page ready (boundary alignment): ${probeResult.filteredPostCount} posts (need ${postsToNextBoundary} to reach next boundary)`)
        } else if (hasFullPage) {
          console.log(`[Paged Updates] Full page ready: ${probeResult.filteredPostCount} posts`)
        } else {
          console.log(`[Paged Updates] Partial page: ${probeResult.filteredPostCount}/${pageSize} posts (idle timer will handle "All new posts" button)`)
        }
      } catch (error) {
        console.warn('[Paged Updates] Probe error:', error)
      } finally {
        probeInProgressRef.current = null
      }
    }

    checkForNewPosts()

    const interval = clientInterval(checkForNewPosts, 60000)

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
  useEffect(() => {
    if (!newestDisplayedPostTimestamp || isInitialLoad) {
      setIdleTimerTriggered(false)
      return
    }

    const checkIdleTime = async () => {
      const pagedSettings = await getPagedUpdatesSettings()
      const fullPageWaitMs = pagedSettings.fullPageWaitMinutes * 60 * 1000

      const timeSinceTopPost = clientNow() - newestDisplayedPostTimestamp

      if (timeSinceTopPost >= fullPageWaitMs && partialPageCount > 0) {
        setIdleTimerTriggered(true)
        console.log(`[Idle Timer] Triggered: ${Math.round(timeSinceTopPost / 60000)} min elapsed, ${partialPageCount} posts available`)
      } else {
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
    showCurationInitModal, setShowCurationInitModal,
    curationInitStats,
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
    loadFeed,
    redisplayFeed,
    refreshDisplayedFeed,
    clearCacheAndReloadHomePage,
    resetFeedAndReloadHomePage,
    prefetchPrevPage,
    lookupCurationAndFilter,
    trimFeedIfNeeded,
    forceProbeTrigger, setForceProbeTrigger,
  }
}
