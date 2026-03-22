import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import { useRateLimit } from '../contexts/RateLimitContext'
import { onSkyspeedCommand, offSkyspeedCommand, type SkyspeedCommand } from '../api/feed'
import PostCard from '../components/PostCard'
import EditionView from '../components/EditionView'
import Compose from '../components/Compose'
import { PencilIcon } from '../components/NavIcons'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import RateLimitIndicator from '../components/RateLimitIndicator'
import CurationInitModal from '../components/CurationInitModal'
import RecurateResultModal from '../components/RecurateResultModal'
import Modal from '../components/Modal'
import { getSettings, updateSettings, FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT } from '../curation/skylimitStore'
import { getBrowserTimezone, timezonesAreDifferent } from '../utils/timezoneUtils'
import { fetchToSecondaryFeedCache, transferSecondaryToPrimary, getCachedFeedAfterPosts } from '../curation/skylimitFeedCache'
import { PAGED_UPDATES_DEFAULTS } from '../curation/pagedUpdates'
import { getPostUniqueId, getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { CurationFeedViewPost, isStatusShow, SecondaryEntry } from '../curation/types'
import { countUnviewedOlderThan, countUnviewedYesterdayOlderThan, getUnviewedPostsInfo, getUnviewedPostsYesterdayInfo, onUnviewedChange } from '../curation/skylimitUnviewedTracker'
import { getNonStandardServerName } from '../api/atproto-client'
import AcceleratedClock from '../components/AcceleratedClock'
import InstallHelp from '../components/InstallHelp'
import PinnedPostBanner from '../components/PinnedPostBanner'
import ReleaseBanner from '../components/ReleaseBanner'
import HelpMessage, { renderFormattedText } from '../components/HelpMessage'
import { helpGlossary } from '../data/helpGlossary'
import { version } from '../../package.json'
import { clientNow, clientDate } from '../utils/clientClock'
import { HomeTab, HOME_TAB_STATE_KEY, getFeedStateKey, getScrollStateKey, DEFAULT_MAX_DISPLAYED_FEED_SIZE, FAST_FORWARD_CHUNK_SIZE, SavedFeedState, findLowestVisiblePostTimestamp } from '../hooks/homePageTypes'
import { isNewestEditionUnviewed } from '../curation/editionRegistry'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import { usePostInteractions } from '../hooks/usePostInteractions'
import { useScrollManagement } from '../hooks/useScrollManagement'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { useViewTracking } from '../hooks/useViewTracking'
import { useFeedPipeline, getRetainedSecondaryCache, setRetainedSecondaryCache, clearRetainedSecondaryCache, isRetainedCacheValid } from '../hooks/useFeedPipeline'
import { checkForAppUpdate } from '../utils/versionCheck'
import { useFeedTransition } from '../hooks/useFeedTransition'
import log from '../utils/logger'

function incrementSessionCounter(key: string) {
  const current = parseInt(sessionStorage.getItem(key) || '0', 10)
  sessionStorage.setItem(key, String(current + 1))
}

export default function HomePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { agent, session } = useSession()
  const { rateLimitStatus, setRateLimitStatus } = useRateLimit()
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const firstPostRef = useRef<HTMLDivElement>(null)
  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null)

  const { feedContainerRef, fadeOut, fadeIn } = useFeedTransition()
  const previousPathnameRef = useRef<string>(location.pathname)
  const scrollRestoredRef = useRef(false)
  const [unviewedRevision, setUnviewedRevision] = useState(0)
  const [showViewedStatus, setShowViewedStatus] = useState(true)
  const [showEditionsInFeed, setShowEditionsInFeed] = useState(false)
  const [hasNewEdition, setHasNewEdition] = useState(() => isNewestEditionUnviewed())
  const [storedTimezone, setStoredTimezone] = useState<string | null>(null)
  const [timezoneMismatch, setTimezoneMismatch] = useState(false)
  const [timezoneBannerDismissed, setTimezoneBannerDismissed] = useState(false)
  const [showIntroMessage, setShowIntroMessage] = useState(() => !localStorage.getItem('skylimit_intro_shown'))
  const [showIntroModal, setShowIntroModal] = useState(false)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const [showAboutModal, setShowAboutModal] = useState(false)

  // Tab state - initialize from sessionStorage
  const getInitialTab = (): HomeTab => {
    const savedTab = sessionStorage.getItem(HOME_TAB_STATE_KEY)
    if (savedTab === 'editions') return 'editions'
    return 'curated'
  }
  const [activeTab, setActiveTab] = useState<HomeTab>(getInitialTab)
  const [searchParams, setSearchParams] = useSearchParams()
  const targetEditionKeyRef = useRef<string | null>(null)

  // Handle ?edition=YYYY-MM-DD_HH:MM URL parameter
  useEffect(() => {
    const editionParam = searchParams.get('edition')
    if (editionParam) {
      targetEditionKeyRef.current = editionParam
      setActiveTab('editions')
      // Clear the URL param to avoid re-triggering on back navigation
      searchParams.delete('edition')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = clientNow().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, type === 'error' ? 10000 : 5000)
  }

  // Feed pipeline hook - manages all feed state, loading, curation, and caching
  const pipeline = useFeedPipeline({
    agent,
    session,
    activeTab,
    scrollRestoredRef,
    addToast,
    setRateLimitStatus,
    locationPathname: location.pathname,
  })

  const {
    feed, setFeed,
    previousPageFeed, setPreviousPageFeed,
    isPrefetching, setIsPrefetching,
    feedTopTrimmed, setFeedTopTrimmed,
    initialPrefetchDone,
    cursor,
    hasMorePosts,
    isLoading,
    isLoadingMore, setIsLoadingMore,
    skylimitStats,
    curationSuspended,
    showAllPosts,
    newestDisplayedPostTimestamp, setNewestDisplayedPostTimestamp,
    oldestDisplayedPostTimestamp, setOldestDisplayedPostTimestamp,
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
    previousPageFeedRef,
    isPrefetchingRef,
    lastDisplayTimeRef,
    refreshDisplayedFeed,
    prefetchPrevPage,
    lookupCurationAndFilter,
    forceProbeRef,
    setForceProbeTrigger,
    probeBoundaryTimestampRef,
    unprocessedRawCountRef,
    unprocessedShowCountRef,
    probeHasGapRef,
    idleTimerForcedRef,
  } = pipeline

  const {
    showCompose, setShowCompose,
    replyToUri, setReplyToUri,
    quotePost, setQuotePost,
    handleLike, handleBookmark, handleRepost,
    handleQuotePost, handleReply, handlePost, handlePostThread, handleAmpChange,
    handleDeletePost, handlePinPost,
  } = usePostInteractions({ agent, feed, setFeed, addToast, forceProbeRef, setForceProbeTrigger, myUsername: session?.handle })

  const {
    isScrolledDown,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    handleScrollToTop,
  } = useScrollManagement({
    locationPathname: location.pathname,
    isLoading,
    feedLength: feed.length,
    activeTab,
    firstPostRef,
    scrollRestoredRef,
  })

  // View tracking hook
  useViewTracking({ feed, setFeed })

  // Check for app updates on mount and periodically
  useEffect(() => {
    const check = () => checkForAppUpdate().then(v => { if (v) setUpdateVersion(v) })
    const timer = setTimeout(check, 5000) // initial check after 5s
    const interval = setInterval(check, 30 * 60 * 1000) // re-check every 30 min
    return () => { clearTimeout(timer); clearInterval(interval) }
  }, [])

  // Save active tab to sessionStorage when it changes
  useEffect(() => {
    sessionStorage.setItem(HOME_TAB_STATE_KEY, activeTab)
  }, [activeTab])

  // Timezone change detection: check on load and initialize if needed
  useEffect(() => {
    const checkTimezone = async () => {
      const settings = await getSettings()
      const browserTz = getBrowserTimezone()

      if (!settings.timezone) {
        // First time: initialize stored timezone from browser
        await updateSettings({ timezone: browserTz, lastBrowserTimezone: browserTz })
        setStoredTimezone(browserTz)
      } else {
        setStoredTimezone(settings.timezone)
        // Compare browser timezone against what it was when user last saved settings
        // This way, intentionally choosing a different timezone won't trigger the banner
        const lastBrowserTz = settings.lastBrowserTimezone || settings.timezone
        if (timezonesAreDifferent(lastBrowserTz, browserTz)) {
          setTimezoneMismatch(true)
        }
      }
    }
    checkTimezone()
  }, [])

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
          log.verbose('Save', `Saved feed state: feed=${feed.length} posts, previousPageFeed=${previousPageFeed.length} posts, oldestDisplayed=${oldestDisplayedPostTimestamp ? new Date(oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'}`)
        } catch (error) {
          log.warn('Feed', 'Failed to save feed state:', error)
        }
      }
    }

    previousPathnameRef.current = location.pathname
  }, [location.pathname, feed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, newPostsCount, showNewPostsButton, session, activeTab, curationSuspended, showAllPosts])

  // Soft-refresh handler: refreshes displayed feed and resets feedTopTrimmed
  const handleSoftRefresh = useCallback(async () => {
    await refreshDisplayedFeed()
    setFeedTopTrimmed(null)
  }, [refreshDisplayedFeed])

  // Desktop soft-refresh interceptor: Ctrl+R / Cmd+R / F5 → refreshDisplayedFeed instead of full page reload
  useEffect(() => {
    if (activeTab !== 'curated') return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isRefreshShortcut =
        e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && e.key === 'r')

      if (isRefreshShortcut) {
        e.preventDefault()
        log.debug('Refresh', 'Desktop soft-refresh intercepted')
        handleSoftRefresh()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, handleSoftRefresh])

  // Pull-to-refresh for mobile touch gesture
  const { isPulling, pullFraction } = usePullToRefresh({
    onRefresh: handleSoftRefresh,
    enabled: activeTab === 'curated' && !isLoading && !isLoadingMore,
  })

  // Handle loading new posts
  const handleLoadNewPosts = useCallback(async (calledFromNewPosts?: boolean) => {
    if (lookingBack) {
      log.debug('New Posts', 'Background lookback in progress, ignoring click')
      addToast('Still syncing posts... Please wait.', 'info')
      return
    }

    if (isLoadingMore) {
      log.debug('New Posts', 'Already loading, ignoring click')
      return
    }

    if (!agent || !session) {
      log.warn('New Posts', 'Missing agent or session')
      addToast('Unable to load new posts: not authenticated', 'error')
      return
    }

    if (!newestDisplayedPostTimestamp) {
      log.warn('New Posts', 'No newestDisplayedPostTimestamp available')
    }

    try {
      setIsLoadingMore(true)
      const settings = await getSettings()
      setShowViewedStatus(settings?.showViewedStatus !== false)
      const pageLength = settings?.feedPageLength || 25

      const effectivePageLength = postsNeededForPage ?? pageLength
      const buttonName = postsNeededForPage !== null ? 'Next Page *' : 'Next Page'

      log.debug('New Posts', `SINGLE PAGE: Loading via unified fetch (effectivePageLength=${effectivePageLength})...`)

      setSyncInProgress(true)
      setSyncProgress(0)

      try {
        // Check for valid retained secondary cache
        const cached = getRetainedSecondaryCache()
        const cacheValid = await isRetainedCacheValid()

        let allEntries: SecondaryEntry[]
        let newestTimestamp: number | null
        let usedCache: boolean

        if (cacheValid && cached) {
          // Use retained secondary cache — skip network fetch
          allEntries = cached.entries
          newestTimestamp = cached.newestTimestamp
          usedCache = true
          const cacheAge = clientNow() - cached.fetchedAt
          log.debug('New Posts', `SINGLE PAGE: Using retained cache (${allEntries.length} entries, age=${Math.round(cacheAge / 1000)}s)`)
          setSyncProgress(80)
        } else {
          // Clear stale/insufficient cache
          if (cached) {
            const cacheAge = clientNow() - cached.fetchedAt
            const fullPageWaitMinutes = settings?.pagedUpdatesFullPageWaitMinutes ?? PAGED_UPDATES_DEFAULTS.fullPageWaitMinutes
            log.debug('New Posts', `SINGLE PAGE: Cache invalid (age=${Math.round(cacheAge / 1000)}s, fullPageWait=${fullPageWaitMinutes}min)`)
            clearRetainedSecondaryCache()
          }
          // Fetch from server
          const fetchResult = await fetchToSecondaryFeedCache(
            agent,
            session.handle,
            session.did,
            'next_page',
            {
              pageLength,
              onProgress: (progress) => setSyncProgress(Math.round(progress * 0.8)),
            }
          )
          log.debug('New Posts', `SINGLE PAGE: Fetched ${fetchResult.postsFetched} posts to secondary`)
          allEntries = fetchResult.entries
          newestTimestamp = fetchResult.newestTimestamp
          usedCache = false
          setSyncProgress(80)
        }

        // Track retained cache vs fetch usage
        if (usedCache) {
          incrementSessionCounter(calledFromNewPosts ? 'newPostsClicksRetained' : 'nextPageClicksRetained')
        } else {
          incrementSessionCounter(calledFromNewPosts ? 'newPostsClicksFetched' : 'nextPageClicksFetched')
        }

        const transferResult = await transferSecondaryToPrimary(allEntries, 'page', effectivePageLength)
        setSyncProgress(100)
        log.debug('New Posts', `SINGLE PAGE: Transferred ${transferResult.postsTransferred} posts, ` +
          `${transferResult.displayableCount} displayable${usedCache ? ' (from cache)' : ''}`)
        log.info('Page Load', `[${buttonName}] source=${usedCache ? 'retained cache' : 'fetch'}, raw=${allEntries.length}, displayed=${transferResult.displayableCount}/${transferResult.postsTransferred} transferred`)

        // Compute remaining entries not transferred.
        // transferSecondaryToPrimary sorts oldest-first and processes sequentially,
        // so transferred entries are the oldest postsTransferred entries.
        const sorted = [...allEntries].sort((a, b) => a.entry.postTimestamp - b.entry.postTimestamp)
        const remainingEntries = sorted.slice(transferResult.postsTransferred)

        // Count remaining displayable posts beyond what was transferred
        const totalDisplayable = allEntries.filter(
          e => isStatusShow(e.summary.curation_status)
        ).length
        const remaining = totalDisplayable - (transferResult.displayableCount || 0)
        log.debug('New Posts', `SINGLE PAGE: ${totalDisplayable} total displayable, ` +
          `${transferResult.displayableCount} transferred, ${remaining} remaining`)

        // Retain secondary cache if enough displayable posts remain for another page
        const fullPageWaitMinutes = settings?.pagedUpdatesFullPageWaitMinutes ?? PAGED_UPDATES_DEFAULTS.fullPageWaitMinutes
        if (remaining >= pageLength && fullPageWaitMinutes > 0 && remainingEntries.length > 0) {
          setRetainedSecondaryCache({
            entries: remainingEntries,
            fetchedAt: usedCache ? cached!.fetchedAt : clientNow(),
            newestTimestamp,
            partPagePostCount: 0,
          })
          log.debug('New Posts', `SINGLE PAGE: Retained ${remainingEntries.length} entries in secondary cache (${remaining} displayable)`)
        } else {
          clearRetainedSecondaryCache()
        }

        setNewPostsCount(remaining > 0 ? remaining : 0)
        setShowNewPostsButton(false)
        setPostsNeededForPage(null)
        setFeedTopTrimmed(null)

        // Fetch replaces accumulated probe counts (fetch is authoritative)
        const remainingRaw = remainingEntries.length
        unprocessedShowCountRef.current = remaining > 0 ? remaining : 0
        unprocessedRawCountRef.current = remainingRaw > 0 ? remainingRaw : 0
        // Update probe boundary to include newest timestamp
        if (newestTimestamp) {
          probeBoundaryTimestampRef.current = Math.max(
            probeBoundaryTimestampRef.current ?? 0,
            newestTimestamp
          )
        }
        // Reset gap since fetch/cache is authoritative
        probeHasGapRef.current = false

        if (remaining > 0) {
          // More posts available — immediately enable buttons without waiting for probe
          setNextPageReady(true)
          setPartialPageCount(remaining)
          if (remaining >= pageLength) {
            setMultiPageCount(remaining)
            setIdleTimerTriggered(true)
          } else {
            setMultiPageCount(0)
            setIdleTimerTriggered(true)
          }
          // Don't set lastDisplayTimeRef — avoid cooldown blocking immediate re-load
          log.debug('New Posts', `SINGLE PAGE: ${remaining} posts remaining — probe refs updated (show=${remaining}, raw=${remainingRaw})`)
        } else {
          setNextPageReady(false)
          setPartialPageCount(0)
          setMultiPageCount(0)
          setIdleTimerTriggered(false)
          idleTimerForcedRef.current = false
          lastDisplayTimeRef.current = clientNow()
          // Full reset — nothing remaining
          probeBoundaryTimestampRef.current = null
          unprocessedRawCountRef.current = 0
          unprocessedShowCountRef.current = 0
        }

        if (newestTimestamp) {
          await fadeOut()

          // Scroll to top while content is invisible
          isProgrammaticScrollRef.current = true
          window.scrollTo({ top: 0, behavior: 'instant' })

          const result = await refreshDisplayedFeed({
            newestTimestamp: newestTimestamp,
            triggerProbe: false,
            showAllNewPosts: false,
          })

          if (result) {
            log.debug('Next Page', `Displayed ${result.alignedPosts.length} posts via refreshDisplayedFeed`)
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

          fadeIn()
        } else {
          isProgrammaticScrollRef.current = true
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
        setTimeout(() => {
          isProgrammaticScrollRef.current = false
          lastScrollTopRef.current = window.scrollY
        }, 1000)

      } finally {
        setSyncInProgress(false)
        setSyncProgress(0)
      }

    } catch (error) {
      log.error('Feed', 'Failed to load new posts:', error)
      addToast('Failed to load new posts', 'error')
    } finally {
      setIsLoadingMore(false)
    }
  }, [agent, session, newestDisplayedPostTimestamp, isLoadingMore, refreshDisplayedFeed, postsNeededForPage, lookingBack, fadeOut, fadeIn])

  // Handle "All n new posts" button click
  const handleLoadAllNewPosts = useCallback(async () => {
    if (lookingBack) {
      log.debug('New Posts', 'Background lookback in progress, ignoring click')
      addToast('Still syncing posts... Please wait.', 'info')
      return
    }

    if (isLoadingMore || !agent || !session) {
      log.debug('New Posts', 'Cannot load: isLoadingMore or missing agent/session')
      return
    }

    const settings = await getSettings()
    const idleThreshold = settings?.feedRedisplayIdleInterval ?? FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT * 60 * 1000
    const timeSinceTopPost = newestDisplayedPostTimestamp ? clientNow() - newestDisplayedPostTimestamp : 0
    const isExtendedIdle = newestDisplayedPostTimestamp !== null && timeSinceTopPost > idleThreshold

    const isMultiPage = multiPageCount > 0 || isExtendedIdle

    if (isExtendedIdle) {
      log.debug('New Posts', `Extended idle detected: ${Math.round(timeSinceTopPost / 60000)} min exceeds ${Math.round(idleThreshold / 60000)} min threshold`)
    }

    if (isMultiPage) {
      log.debug('New Posts', `MULTI-PAGE: Using unified fetch (${multiPageCount} posts expected)`)

      setIsLoadingMore(true)
      setSyncInProgress(true)

      try {
        const pageLength = settings?.feedPageLength || 25

        // Check for valid retained secondary cache first
        const retainedCached = getRetainedSecondaryCache()
        const retainedCacheValid = await isRetainedCacheValid()

        let allEntries: SecondaryEntry[]
        let newestTimestamp: number | null
        let usedRetainedCache = false

        if (retainedCacheValid && retainedCached) {
          // Use retained cache — skip network fetch
          allEntries = retainedCached.entries
          newestTimestamp = retainedCached.newestTimestamp
          const cacheAge = clientNow() - retainedCached.fetchedAt
          usedRetainedCache = true
          log.debug('New Posts', `MULTI-PAGE: Using retained cache (${allEntries.length} entries, age=${Math.round(cacheAge / 1000)}s)`)
          setSyncProgress(80)
        } else {
          // Clear stale/insufficient cache
          if (retainedCached) clearRetainedSecondaryCache()

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
          log.debug('New Posts', `MULTI-PAGE: Fetched ${fetchResult.postsFetched} posts to secondary`)

          if (fetchResult.postsFetched === 0) {
            addToast('No new posts available', 'info')
            return
          }

          allEntries = fetchResult.entries
          newestTimestamp = fetchResult.newestTimestamp
          setSyncProgress(80)
        }

        // Track retained cache vs fetch usage
        incrementSessionCounter(usedRetainedCache ? 'allNewPostsClicksRetained' : 'allNewPostsClicksFetched')

        const transferResult = await transferSecondaryToPrimary(allEntries, 'all', pageLength)
        setSyncProgress(100)
        log.debug('New Posts', `MULTI-PAGE: Transferred ${transferResult.postsTransferred} posts, ` +
          `${transferResult.displayableCount} displayable`)
        const multiButtonName = isExtendedIdle ? 'New posts (idle)' : `All new posts (${multiPageCount})`
        log.info('Page Load', `[${multiButtonName}] source=${usedRetainedCache ? 'retained cache' : 'fetch'}, raw=${allEntries.length}, displayed=${transferResult.displayableCount}/${transferResult.postsTransferred} transferred`)

        setNewPostsCount(0)
        setShowNewPostsButton(false)
        setNextPageReady(false)
        setPartialPageCount(0)
        setIdleTimerTriggered(false)
        idleTimerForcedRef.current = false
        setMultiPageCount(0)
        setFeedTopTrimmed(null)
        lastDisplayTimeRef.current = clientNow()

        // Full reset of probe boundary state — all posts displayed
        probeBoundaryTimestampRef.current = null
        unprocessedRawCountRef.current = 0
        unprocessedShowCountRef.current = 0
        probeHasGapRef.current = false
        clearRetainedSecondaryCache()

        if (newestTimestamp) {
          await fadeOut()

          // Scroll to top while content is invisible
          isProgrammaticScrollRef.current = true
          window.scrollTo({ top: 0, behavior: 'instant' })

          const result = await refreshDisplayedFeed({
            newestTimestamp: newestTimestamp,
            triggerProbe: false,
            showAllNewPosts: false,
          })
          if (result) {
            log.debug('New Posts', `MULTI-PAGE: Displayed ${result.alignedPosts.length} posts via refreshDisplayedFeed`)
          } else {
            addToast('No new posts to display (filtered by settings)', 'info')
          }

          fadeIn()
        } else {
          addToast('No new posts to display', 'info')
          isProgrammaticScrollRef.current = true
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
        setTimeout(() => {
          isProgrammaticScrollRef.current = false
          lastScrollTopRef.current = window.scrollY
        }, 1000)

      } catch (error) {
        log.error('New Posts', 'Multi-page load failed:', error)
        addToast('Failed to load new posts', 'error')
      } finally {
        setIsLoadingMore(false)
        setSyncInProgress(false)
      }
    } else {
      log.debug('New Posts', `PARTIAL PAGE: ${partialPageCount} posts, using single page flow`)
      log.info('Page Load', `[New posts (${partialPageCount})] → delegating to single page handler`)
      await handleLoadNewPosts(true)
      setIdleTimerTriggered(false)
      idleTimerForcedRef.current = false
    }
  }, [agent, session, isLoadingMore, multiPageCount, partialPageCount, handleLoadNewPosts, newestDisplayedPostTimestamp, refreshDisplayedFeed, lookingBack, fadeOut, fadeIn])

  const handlePrevPage = useCallback(async () => {
    if (previousPageFeed.length === 0) return
    if (isPrefetching) return

    if (lookingBack) {
      addToast('Still syncing older posts... Please wait.', 'info')
      return
    }

    log.debug('Prev Page', `INSTANT: Displaying ${previousPageFeed.length} pre-fetched posts`)

    const feedReceivedTime = clientDate()

    const existingUris = new Set(feed.map(p => getPostUniqueId(p)))
    const newPosts = previousPageFeed.filter(p => !existingUris.has(getPostUniqueId(p)))
    log.debug('Prev Page', `Appending ${newPosts.length} pre-fetched posts`)
    if (newPosts.length > 0) {
      const ppNewest = getFeedViewPostTimestamp(newPosts[0], feedReceivedTime).getTime()
      const ppOldest = getFeedViewPostTimestamp(newPosts[newPosts.length - 1], feedReceivedTime).getTime()
      const ppFirst = newPosts[0] as CurationFeedViewPost
      const ppLast = newPosts[newPosts.length - 1] as CurationFeedViewPost
      log.verbose('Prev Page', `Appending range: newest=${new Date(ppNewest).toLocaleTimeString()} (#${ppFirst.curation?.curationNumber ?? '?'}), oldest=${new Date(ppOldest).toLocaleTimeString()} (#${ppLast.curation?.curationNumber ?? '?'})`)
    }
    if (feed.length > 0) {
      const feedOldest = getFeedViewPostTimestamp(feed[feed.length - 1], feedReceivedTime).getTime()
      const feedOldestPost = feed[feed.length - 1] as CurationFeedViewPost
      log.verbose('Prev Page', `Current feed oldest: ${new Date(feedOldest).toLocaleTimeString()} (#${feedOldestPost.curation?.curationNumber ?? '?'})`)
    }

    let nextPrefetchTimestamp: number
    if (newPosts.length > 0) {
      nextPrefetchTimestamp = getFeedViewPostTimestamp(
        newPosts[newPosts.length - 1],
        feedReceivedTime
      ).getTime()
    } else {
      nextPrefetchTimestamp = getFeedViewPostTimestamp(
        previousPageFeed[previousPageFeed.length - 1],
        feedReceivedTime
      ).getTime()
    }

    log.verbose('Prev Page', `nextPrefetchTimestamp=${new Date(nextPrefetchTimestamp).toLocaleTimeString()} (${nextPrefetchTimestamp})`)

    const settings = await getSettings()
    const curationSuspendedLocal = !settings || settings?.curationSuspended
    const pageLength = settings?.feedPageLength || 25
    const maxDisplayedFeedSize = settings?.maxDisplayedFeedSize || DEFAULT_MAX_DISPLAYED_FEED_SIZE

    const projectedLength = feed.length + newPosts.length
    if (projectedLength > maxDisplayedFeedSize) {
      const excess = projectedLength - maxDisplayedFeedSize
      const pagesToTrim = Math.ceil(excess / pageLength)
      let actualTrimCount = pagesToTrim * pageLength

      const combined = [...feed, ...newPosts]
      if (actualTrimCount < combined.length) {
        const candidateTop = combined[actualTrimCount] as CurationFeedViewPost
        const topCurationNumber = candidateTop.curation?.curationNumber
        if (topCurationNumber && topCurationNumber > 0) {
          const remainder = topCurationNumber % FAST_FORWARD_CHUNK_SIZE
          if (remainder !== 0) {
            const extraTrim = remainder
            const newTrimCount = actualTrimCount + extraTrim
            if (newTrimCount < combined.length - pageLength) {
              log.debug('Prev Page', `Aligning top to chunk boundary: #${topCurationNumber} → #${topCurationNumber - remainder} (trimming ${extraTrim} extra)`)
              actualTrimCount = newTrimCount
            }
          }
        }
      }

      setFeed(() => {
        const trimmed = combined.slice(actualTrimCount)
        log.debug('Prev Page', `Trimmed ${actualTrimCount} newest posts (${combined.length} → ${trimmed.length})`)
        return trimmed
      })
      if (actualTrimCount < combined.length) {
        const newTopPost = combined[actualTrimCount]
        const newTopTimestamp = getFeedViewPostTimestamp(newTopPost, feedReceivedTime).getTime()
        setNewestDisplayedPostTimestamp(newTopTimestamp)
        setFeedTopTrimmed(newTopTimestamp)
      }
    } else {
      setFeed(prevFeed => [...prevFeed, ...newPosts])
    }

    setOldestDisplayedPostTimestamp(nextPrefetchTimestamp)
    let targetSize: number | undefined = undefined

    if (!curationSuspendedLocal && newPosts.length > 0) {
      const oldestPostAfterAppend = newPosts[newPosts.length - 1] as CurationFeedViewPost
      const oldestCurationNumber = oldestPostAfterAppend.curation?.curationNumber

      if (oldestCurationNumber && oldestCurationNumber > 0) {
        const positionInPage = (oldestCurationNumber - 1) % pageLength

        if (positionInPage !== 0) {
          targetSize = positionInPage
          log.debug('Prev Page', `Aligning to boundary: need ${targetSize} posts to reach curationNumber ${oldestCurationNumber - positionInPage}`)
        }
      }
    }

    setPreviousPageFeed([])
    setIsPrefetching(true)

    await prefetchPrevPage(nextPrefetchTimestamp, targetSize)
    setIsPrefetching(false)
  }, [feed, previousPageFeed, isPrefetching, lookingBack, prefetchPrevPage])

  // Fast-forward back to top
  const handleFastForwardToTop = useCallback(async () => {
    if (!feedTopTrimmed) return

    const feedReceivedTime = clientDate()
    const settings = await getSettings()
    const pageLength = settings?.feedPageLength || 25

    const MAX_NO_PROGRESS = 3
    let accumulatedFiltered: CurationFeedViewPost[] = []
    let consecutiveNoProgress = 0
    let fetchAfterTimestamp = feedTopTrimmed
    let cacheExhausted = false

    while (accumulatedFiltered.length < FAST_FORWARD_CHUNK_SIZE) {
      const batchPosts = await getCachedFeedAfterPosts(fetchAfterTimestamp, 2 * pageLength, true)

      if (batchPosts.length === 0) {
        log.debug('Fast Forward', 'Cache exhausted')
        cacheExhausted = true
        break
      }

      if (batchPosts.length < 2 * pageLength) {
        cacheExhausted = true
      }

      const filtered = await lookupCurationAndFilter(batchPosts, feedReceivedTime)

      const existingIds = new Set(accumulatedFiltered.map(p => getPostUniqueId(p)))
      const newPosts = filtered.filter(p => !existingIds.has(getPostUniqueId(p)))

      if (newPosts.length === 0) {
        consecutiveNoProgress++
        log.debug('Fast Forward', `No new displayable posts from batch of ${batchPosts.length} (stall ${consecutiveNoProgress}/${MAX_NO_PROGRESS})`)
        if (consecutiveNoProgress >= MAX_NO_PROGRESS) break
      } else {
        consecutiveNoProgress = 0
        accumulatedFiltered = [...accumulatedFiltered, ...newPosts]
        log.debug('Fast Forward', `Added ${newPosts.length} displayable posts, total: ${accumulatedFiltered.length}`)
      }

      fetchAfterTimestamp = getFeedViewPostTimestamp(batchPosts[0], feedReceivedTime).getTime()

      if (cacheExhausted) break
    }

    log.debug('Fast Forward', `Accumulated ${accumulatedFiltered.length} displayable posts (cacheExhausted=${cacheExhausted})`)

    if (accumulatedFiltered.length === 0) {
      setFeedTopTrimmed(null)
      return
    }

    accumulatedFiltered.sort((a, b) => {
      const tsA = getFeedViewPostTimestamp(a, feedReceivedTime).getTime()
      const tsB = getFeedViewPostTimestamp(b, feedReceivedTime).getTime()
      return tsB - tsA
    })

    if (accumulatedFiltered.length > FAST_FORWARD_CHUNK_SIZE) {
      accumulatedFiltered = accumulatedFiltered.slice(-FAST_FORWARD_CHUNK_SIZE)
    }

    const removeCount = Math.ceil(FAST_FORWARD_CHUNK_SIZE / pageLength) * pageLength

    const combined = [...accumulatedFiltered, ...feed]
    const actualRemove = Math.min(removeCount, combined.length - pageLength)
    const trimmed = actualRemove > 0 ? combined.slice(0, combined.length - actualRemove) : combined
    log.debug('Fast Forward', `Feed: ${feed.length} → prepend ${accumulatedFiltered.length}, remove ${combined.length - trimmed.length} from bottom → ${trimmed.length}`)

    await fadeOut()

    setFeed(trimmed)

    const newNewest = getFeedViewPostTimestamp(trimmed[0], feedReceivedTime).getTime()
    setNewestDisplayedPostTimestamp(newNewest)
    if (trimmed.length > 0) {
      const newOldest = getFeedViewPostTimestamp(trimmed[trimmed.length - 1], feedReceivedTime).getTime()
      setOldestDisplayedPostTimestamp(newOldest)
    }

    if (cacheExhausted) {
      setFeedTopTrimmed(null)
    } else {
      setFeedTopTrimmed(newNewest)
    }

    window.scrollTo({ top: 0, behavior: 'instant' })
    fadeIn()
  }, [feed, feedTopTrimmed, lookupCurationAndFilter, fadeOut, fadeIn])

  // Set up IntersectionObserver for infinite scrolling
  useEffect(() => {
    if (!infiniteScrollingEnabled) {
      if (intersectionObserverRef.current) {
        intersectionObserverRef.current.disconnect()
        intersectionObserverRef.current = null
      }
      return
    }

    if (intersectionObserverRef.current) {
      intersectionObserverRef.current.disconnect()
      intersectionObserverRef.current = null
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting &&
            previousPageFeedRef.current.length > 0 &&
            !isPrefetchingRef.current) {
          handlePrevPage()
        }
      },
      {
        rootMargin: '200px',
      }
    )

    if (scrollSentinelRef.current) {
      observer.observe(scrollSentinelRef.current)
      intersectionObserverRef.current = observer
    }

    return () => {
      if (intersectionObserverRef.current) {
        intersectionObserverRef.current.disconnect()
        intersectionObserverRef.current = null
      }
    }
  }, [infiniteScrollingEnabled, handlePrevPage])

  // Subscribe to Skyspeed server commands (CLICK, SCROLL, SCROLL TO)
  useEffect(() => {
    const handleCommand = (command: SkyspeedCommand) => {
      if (command.type === 'CLICK') {
        log.debug('Skyspeed Command', `Executing: CLICK ${command.buttonName}`)
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
        log.debug('Skyspeed Command', `Executing: SCROLL ${command.direction}`)
        switch (command.direction) {
          case 'TOP':
            window.scrollTo({ top: 0, behavior: 'smooth' })
            break
          case 'BOTTOM':
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
            break
        }
      } else if (command.type === 'FIND') {
        log.debug('Skyspeed Command', `Executing: FIND ${command.target}`)
        const target = command.target

        let matchUri: string | null = null

        if (target.startsWith('@')) {
          const handle = target.slice(1)
          const match = feed.find(p => p.post.author.handle === handle)
          if (match) matchUri = match.post.uri
        } else if (/^\d{1,3}:\d{2}$/.test(target)) {
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
          const num = parseInt(target.slice(1), 10)
          if (!isNaN(num)) {
            const match = feed.find(p => {
              const curation = 'curation' in p ? (p as CurationFeedViewPost).curation : undefined
              return curation?.curationNumber === num || curation?.postNumber === num
            })
            if (match) matchUri = match.post.uri
          }
        } else {
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
            log.warn('Skyspeed Command', `FIND: DOM element not found for URI ${matchUri}`)
          }
        } else {
          log.warn('Skyspeed Command', `FIND: No matching post found for "${target}"`)
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

  // Load showViewedStatus setting on mount
  useEffect(() => {
    getSettings().then(s => {
      setShowViewedStatus(s?.showViewedStatus !== false)
      setShowEditionsInFeed(!!s?.showEditionsInFeed)
    })
  }, [])

  // Periodically check for new unviewed editions (for the tab dot indicator)
  useEffect(() => {
    const check = () => setHasNewEdition(isNewestEditionUnviewed())
    const interval = setInterval(check, 30_000)
    return () => clearInterval(interval)
  }, [])

  // Compute label for unviewed posts next to Prev Page button
  const prevPageUnviewedLabel: string | null = useMemo(() => {
    if (!showViewedStatus) return null
    if (previousPageFeed.length === 0) return null
    const { count: totalUnviewed, boundary } = getUnviewedPostsInfo()
    if (boundary === 0) return null
    if (totalUnviewed === 0) return null
    if (!oldestDisplayedPostTimestamp) {
      return `${totalUnviewed} unread posts below (today)`
    }
    const below = countUnviewedOlderThan(oldestDisplayedPostTimestamp)
    if (below === 0) return null
    return `${below} unread posts below (today)`
  }, [previousPageFeed, oldestDisplayedPostTimestamp, feed, unviewedRevision, showViewedStatus])

  // Compute label for unviewed posts from yesterday
  const prevPageUnviewedYesterdayLabel: string | null = useMemo(() => {
    if (!showViewedStatus) return null
    if (previousPageFeed.length === 0) return null
    const { count: totalUnviewed, boundary } = getUnviewedPostsYesterdayInfo()
    if (boundary === 0) return null
    if (totalUnviewed === 0) return null
    // Only show yesterday label once user has scrolled past today's posts
    const { boundary: todayBoundary } = getUnviewedPostsInfo()
    if (todayBoundary > 0 && (!oldestDisplayedPostTimestamp || oldestDisplayedPostTimestamp > todayBoundary)) {
      // Exception: if oldest displayed post is curation #1, we've reached
      // the bottom of today's posts — show yesterday label
      const oldestPost = feed[feed.length - 1] as CurationFeedViewPost | undefined
      if (!oldestPost || oldestPost.curation?.curationNumber !== 1) {
        return null
      }
    }
    if (!oldestDisplayedPostTimestamp) {
      return `${totalUnviewed} unread posts below (yesterday)`
    }
    const below = countUnviewedYesterdayOlderThan(oldestDisplayedPostTimestamp)
    if (below === 0) return null
    return `${below} unread posts below (yesterday)`
  }, [previousPageFeed, oldestDisplayedPostTimestamp, feed, unviewedRevision, showViewedStatus])

  // Handle tab change
  const handleTabChange = useCallback((newTab: HomeTab) => {
    if (newTab === activeTab) return

    const currentScrollKey = getScrollStateKey(activeTab)
    const currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
    sessionStorage.setItem(currentScrollKey, currentScrollY.toString())

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
        log.warn('Feed', 'Failed to save feed state on tab change:', error)
      }
    }

    scrollRestoredRef.current = false
    setActiveTab(newTab)
  }, [activeTab, feed, previousPageFeed, newestDisplayedPostTimestamp, oldestDisplayedPostTimestamp, hasMorePosts, cursor, newPostsCount, showNewPostsButton, session])

  if (isLoading && activeTab === 'curated') {
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
              {lookingBack ? (
                <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                  <Spinner size="sm" />
                  <span>{lookbackMessage}{lookbackProgress !== null ? ` (${lookbackProgress}%)` : ''}...</span>
                </div>
              ) : (
                <>
                  <span
                    onClick={() => setShowAboutModal(true)}
                    className="text-blue-600 dark:text-blue-400 hover:underline font-semibold cursor-pointer"
                    title="About Skylimit"
                  >
                    About
                  </span>
                  <InstallHelp />
                  {updateVersion && (
                    <span
                      onClick={() => setShowUpdateModal(true)}
                      className="text-red-600 dark:text-red-400 hover:underline font-semibold cursor-pointer"
                    >
                      Update available
                    </span>
                  )}
                </>
              )}
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
                <div className="text-gray-500 dark:text-gray-400 mx-[-4px] flex items-center">
                  <svg
                    className="w-5 h-4 sm:w-4 sm:h-4"
                    viewBox="0 0 20 16"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="2" y1="8" x2="16" y2="8" className="[stroke-width:3] sm:[stroke-width:2]" />
                    <polyline points="11,3 17,8 11,13" className="[stroke-width:3] sm:[stroke-width:2]" />
                  </svg>
                </div>
                <div className="text-gray-600 dark:text-gray-400">
                  {curationSuspended ? (
                    <span className="text-orange-500 dark:text-orange-400">(curation suspended)</span>
                  ) : (
                    <><span className="font-semibold cursor-pointer hover:underline text-blue-600 dark:text-blue-400" onClick={() => navigate('/settings?tab=curation')}>~{skylimitStats.shown_daily.toFixed(0)}</span> shown, <span className="font-semibold cursor-pointer hover:underline text-blue-600 dark:text-blue-400" onClick={() => navigate('/settings?tab=editions')}>{(skylimitStats.edited_daily ?? 0).toFixed(0)}</span> edited</>
                  )}
                </div>
                <button
                  onClick={() => setShowIntroModal(true)}
                  className="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 text-xs font-bold hover:bg-blue-200 dark:hover:bg-blue-800 flex items-center justify-center flex-shrink-0"
                  title="About Skylimit"
                >
                  ?
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-red-500 dark:text-red-400">
              <Spinner size="sm" />
              <span>{initPhase === 'follows' ? 'Initializing follows' : 'Initializing posts'}...{lookbackProgress !== null ? ` (${lookbackProgress}%)` : ''}</span>
            </div>
          )}
        </div>
      )}

      <PinnedPostBanner />
      <ReleaseBanner />

      {/* Intro message for first-time users */}
      {showIntroMessage && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-3 mx-2 mb-2 text-base">
          <div className="flex items-start justify-between gap-2">
            <div className="text-blue-800 dark:text-blue-200">
              <HelpMessage
                showInitWarning
                readOnlyNote={isReadOnlyMode() ? 'Skylimit is currently in read-only mode that will not modify your Bluesky state/configuration. Use Settings to disable this mode.' : undefined}
              />
            </div>
            <button
              onClick={() => {
                localStorage.setItem('skylimit_intro_shown', 'true')
                setShowIntroMessage(false)
              }}
              className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200 font-bold text-lg leading-none flex-shrink-0"
              aria-label="Dismiss intro message"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* Timezone mismatch banner */}
      {timezoneMismatch && !timezoneBannerDismissed && storedTimezone && (
        <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-700 rounded-lg p-3 mx-2 mb-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-yellow-800 dark:text-yellow-200">
              Timezone changed: {storedTimezone} &rarr; {getBrowserTimezone()}
            </span>
            <div className="flex gap-2 ml-2">
              <button
                onClick={async () => {
                  const browserTz = getBrowserTimezone()
                  await updateSettings({ timezone: browserTz, lastBrowserTimezone: browserTz })
                  const { clearAllNumbering } = await import('../curation/skylimitCache')
                  await clearAllNumbering()
                  const { assignAllNumbers } = await import('../curation/skylimitNumbering')
                  await assignAllNumbers()
                  setStoredTimezone(browserTz)
                  setTimezoneMismatch(false)
                  addToast(`Timezone updated to ${browserTz}. Posts re-numbered.`, 'success')
                }}
                className="px-2 py-1 bg-yellow-600 text-white rounded text-xs hover:bg-yellow-700"
              >
                Update
              </button>
              <button
                onClick={async () => {
                  // Acknowledge the browser timezone change without changing curation timezone
                  await updateSettings({ lastBrowserTimezone: getBrowserTimezone() })
                  setTimezoneBannerDismissed(true)
                }}
                className="px-2 py-1 bg-gray-300 dark:bg-gray-600 rounded text-xs hover:bg-gray-400 dark:hover:bg-gray-500"
              >
                Keep {storedTimezone.split('/').pop()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tab Bar — hidden when editions are shown inline in the feed */}
      {!showEditionsInFeed && (
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
            {tab === 'curated' ? (
              <>
                Curated Follow
                {timezoneMismatch && timezoneBannerDismissed && storedTimezone && (
                  <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">
                    ({storedTimezone.split('/').pop()})
                  </span>
                )}
              </>
            ) : <>Periodic Editions{hasNewEdition && <span className="text-red-500 text-xs align-super ml-0.5">●</span>}</>}
          </button>
        ))}
      </div>
      )}

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

            {/* Next Page / All New Posts buttons */}
            <div className="sticky top-0 z-30 p-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
              <div className="flex gap-2">
                {/* "Next Page" button - always visible, grayed out when inactive or during lookback */}
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    log.debug('Next Page', 'Button clicked', { newPostsCount, isLoadingMore, nextPageReady, lookingBack })
                    handleLoadNewPosts()
                  }}
                  disabled={isLoadingMore || !nextPageReady || lookingBack || feedTopTrimmed !== null}
                  className={`btn inline-flex items-center gap-2 ${
                    nextPageReady && !lookingBack && feedTopTrimmed === null
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

                {/* "New posts" button - partial (single-page) load, hidden when trimmed */}
                {idleTimerTriggered && partialPageCount > 0 && !lookingBack && multiPageCount === 0 && feedTopTrimmed === null && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      log.debug('New Posts', 'Partial button clicked', { partialPageCount, idleTimerTriggered, newPostsCount })
                      handleLoadAllNewPosts()
                    }}
                    disabled={isLoadingMore || lookingBack}
                    className="ml-auto btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50"
                    aria-label={`Load ${partialPageCount} new posts`}
                  >
                    {isLoadingMore ? (
                      <>
                        <Spinner size="sm" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
                        New posts ({partialPageCount}{probeHasGapRef.current ? '+' : ''})
                      </>
                    )}
                  </button>
                )}

                {/* "All new posts" button - multi-page full refresh, shown even when trimmed */}
                {idleTimerTriggered && partialPageCount > 0 && !lookingBack && multiPageCount > 0 && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      log.debug('New Posts', 'Multi-page button clicked', { multiPageCount, idleTimerTriggered, newPostsCount })
                      handleLoadAllNewPosts()
                    }}
                    disabled={isLoadingMore || lookingBack}
                    className="flex-1 btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50"
                    aria-label={`Load all ${multiPageCount} new posts`}
                  >
                    {isLoadingMore ? (
                      <>
                        <Spinner size="sm" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4 inline-block" viewBox="0 0 24 24" fill="currentColor"><polygon points="4,21 12,11 20,21" /><polygon points="4,13 12,3 20,13" /></svg>
                        All new posts ({multiPageCount}{probeHasGapRef.current ? '+' : ''})
                      </>
                    )}
                  </button>
                )}

                {/* "Back to top" fast-forward button - shown when feed was trimmed from newest end during Prev Page */}
                {feedTopTrimmed !== null && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleFastForwardToTop()
                    }}
                    className="btn btn-primary inline-flex items-center gap-2"
                    aria-label="Fast-forward back to newest cached posts"
                  >
                    <svg className="w-4 h-4 inline-block" viewBox="0 0 24 24" fill="currentColor"><polygon points="4,21 12,11 20,21" /><polygon points="4,13 12,3 20,13" /></svg>
                    Scroll up
                  </button>
                )}
              </div>
            </div>

            <div ref={feedContainerRef} className="feed-transition-container">
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
                  onDeletePost={handleDeletePost}
                  onPinPost={handlePinPost}
                  showCounter={true}
                  onAmpChange={handleAmpChange}
                />
              </div>
            ))}
            </div>
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
                {(prevPageUnviewedLabel || prevPageUnviewedYesterdayLabel) && (
                  <div className="flex flex-col text-sm text-gray-500 dark:text-gray-400">
                    {prevPageUnviewedLabel && <span>{prevPageUnviewedLabel}</span>}
                    {prevPageUnviewedYesterdayLabel && <span>{prevPageUnviewedYesterdayLabel}</span>}
                  </div>
                )}
              </>
            ) : !isLoading && feed.length > 0 ? (
              // State 3: Initializing or No more posts
              !initialPrefetchDone ? (
                // Still initializing (prefetch not complete yet)
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                  <Spinner size="sm" />
                  <span>{initPhase === 'follows' ? 'Initializing follows' : 'Initializing posts'}...</span>
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
        /* Periodic Editions tab */
        <EditionView
          agent={agent}
          onReply={handleReply}
          onRepost={handleRepost}
          onQuotePost={handleQuotePost}
          onLike={handleLike}
          onBookmark={handleBookmark}
          onDeletePost={handleDeletePost}
          onPinPost={handlePinPost}
          onEditionViewed={() => setHasNewEdition(isNewestEditionUnviewed())}
          targetEditionKey={targetEditionKeyRef.current}
          onTargetConsumed={() => { targetEditionKeyRef.current = null }}
        />
      )}

      {/* Scroll to top arrow - shown when scrolled down */}
      {(activeTab === 'curated' || activeTab === 'editions') && isScrolledDown && (
        <button
          onClick={handleScrollToTop}
          className="fixed bottom-6 left-6 md:bottom-8 md:left-8 bg-blue-100 hover:bg-blue-200 text-blue-600 dark:bg-blue-900/40 dark:hover:bg-blue-900/60 dark:text-blue-400 p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-12 h-12"
          aria-label="Scroll to top"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
        </button>
      )}

      {/* Floating compose button in bottom right (only for curated tab) */}
      {activeTab === 'curated' && (
        <button
          onClick={() => {
            if (isReadOnlyMode()) {
              addToast('Disable Read-only mode in Settings to do this', 'error')
              return
            }
            setShowCompose(true)
          }}
          className="fixed bottom-20 right-6 md:bottom-8 md:right-8 bg-blue-500 hover:bg-blue-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-14 h-14"
          aria-label="Compose new post"
        >
          <PencilIcon className="w-7 h-7" />
          {isReadOnlyMode() && (
            <span className="absolute inset-0 flex items-center justify-center text-red-500 text-6xl font-thin pointer-events-none -mt-1">&times;</span>
          )}
        </button>
      )}

      <Compose
        isOpen={showCompose}
        onClose={() => {
          setShowCompose(false)
          setReplyToUri(null)
          setQuotePost(null)
        }}
        replyTo={replyToUri ? (() => {
          const parentPost = feed.find(p => p.post.uri === replyToUri)?.post
          if (!parentPost) return undefined
          const record = parentPost.record as any
          return {
            uri: replyToUri,
            cid: parentPost.cid,
            text: record?.text,
            facets: record?.facets,
            authorName: parentPost.author.displayName,
            authorHandle: parentPost.author.handle,
          }
        })() : undefined}
        quotePost={quotePost || undefined}
        onPost={handlePost}
        onPostThread={handlePostThread}
      />

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />

      <CurationInitModal
        isOpen={showCurationInitModal}
        onClose={() => setShowCurationInitModal(false)}
        stats={curationInitStats}
      />

      <RecurateResultModal
        isOpen={showRefreshResultModal}
        onClose={() => setShowRefreshResultModal(false)}
        stats={refreshResultStats}
        title={refreshResultTitle}
        verb={refreshResultTitle === 'Refetch complete' ? 'Refetched' : 'Re-curated'}
      />

      <Modal isOpen={showUpdateModal} onClose={() => setShowUpdateModal(false)} title="Update Available" size="md">
        <p className="text-gray-700 dark:text-gray-300 text-base leading-relaxed">
          Pull-to-refresh on mobile phone or hard refresh on desktop (usually Ctrl/Cmd-Shift-R) to update the web app to version {updateVersion}.
        </p>
      </Modal>

      <Modal isOpen={showIntroModal} onClose={() => setShowIntroModal(false)} title="Skylimit Help" size="md">
        <div className="text-gray-700 dark:text-gray-300 text-base leading-relaxed">
          <HelpMessage showTitle={false} />
        </div>
      </Modal>

      <Modal isOpen={showAboutModal} onClose={() => setShowAboutModal(false)} title={`About Skylimit (version: ${version})`} size="md">
        <div className="text-gray-700 dark:text-gray-300 text-base leading-relaxed">
          {helpGlossary['about'].split('\n\n').map((para, i) => (
            <p key={i} className={i > 0 ? 'mt-2' : ''}>{renderFormattedText(para, navigate)}</p>
          ))}
        </div>
      </Modal>
    </div>
  )
}
