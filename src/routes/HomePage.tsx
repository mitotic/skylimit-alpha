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
import { curatePosts, insertEditionPosts } from '../curation/skylimitTimeline'
import { initDB, getFilter, getSummaryByUri } from '../curation/skylimitCache'
import { getSettings } from '../curation/skylimitStore'
import { computeFilterFrac } from '../curation/skylimitStats'
import { probeForNewPosts, calculatePageRaw, getPagedUpdatesSettings, PAGED_UPDATES_DEFAULTS } from '../curation/pagedUpdates'
import { flushExpiredParentPosts } from '../curation/parentPostCache'
import { scheduleStatsComputation } from '../curation/skylimitStatsWorker'
import { GlobalStats, CurationFeedViewPost } from '../curation/types'
import { getCachedFeed, clearFeedCache, getLastFetchMetadata, saveFeedCache, getCachedFeedBefore, extendFeedCache, updateFeedCacheOldestPostTimestamp, getCachedFeedAfterPosts, shouldUseCacheOnLoad, getLookbackBoundary, performLookbackFetch, createFeedCacheEntries, savePostsToFeedCache } from '../curation/skylimitFeedCache'
import { getPostUniqueId, getFeedViewPostTimestamp } from '../curation/skylimitGeneral'
import { isRateLimited, getTimeUntilClear } from '../utils/rateLimitState'

// Saved feed state constant
const WEBSKY9_HOME_FEED_STATE = 'websky9_home_feed_state'
const SCROLL_STATE_KEY = 'websky9_home_scroll_state'

// Saved feed state interface
interface SavedFeedState {
  feed: AppBskyFeedDefs.FeedViewPost[]
  newestDisplayedPostTimestamp: number | null
  oldestDisplayedPostTimestamp: number | null
  hasMorePosts: boolean
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
  const [cursor, setCursor] = useState<string | undefined>()  // Keep for backward compatibility
  const [hasMorePosts, setHasMorePosts] = useState(false)  // Based on oldestDisplayedPostTimestamp existence
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
  // Lookback caching state
  const [lookingBack, setLookingBack] = useState(false) // true during background lookback fetch
  const [lookbackProgress, setLookbackProgress] = useState<number | null>(null) // 0-100 progress percentage
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
        feed,
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
    
    initDB().then(() => {
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
        feed,
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
  const lookupCurationAndFilter = useCallback(async (
    posts: CurationFeedViewPost[],
    feedReceivedTime: Date,
    postTimestamps?: Map<string, number>
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
    
    // Sort by timestamp
    // For pagination (when postTimestamps map is provided), use stored postTimestamp from cache
    // For initial load/refresh (when postTimestamps not provided), recalculate using feedReceivedTime
    filteredPosts.sort((a, b) => {
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
    
    return filteredPosts
  }, [])

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

                // Save to feed cache first
                await savePostsToFeedCache(entries, newCursor)

                // Curate from entries (saves summaries)
                const curatedFeed = await curatePosts(entries, agent, myUsername, myDid)

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
                  console.log('[Lookback] Cache is stale, starting background lookback fetch...')
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
                  ).then((completed) => {
                    console.log(`[Lookback] Background lookback ${completed ? 'completed' : 'interrupted'}`)
                    setLookingBack(false)
                    setLookbackProgress(100)
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

      // Save to feed cache first
      await savePostsToFeedCache(entries, newCursor)

      // Curate from entries (saves summaries)
      const curatedFeed = await curatePosts(entries, agent, myUsername, myDid)

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

          // Start background lookback if cache was not fresh (stale or empty)
          if (!cacheIsFresh && !cursor) {
            console.log('[Lookback] Cache is stale/empty, starting background lookback fetch...')
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
            ).then((completed) => {
              console.log(`[Lookback] Background lookback ${completed ? 'completed' : 'interrupted'}`)
              setLookingBack(false)
              setLookbackProgress(100)
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
      if (!savedState.feed || savedState.feed.length === 0) {
        console.log('[Redisplay] Saved state has no posts, falling back to loadFeed')
        return loadFeed()
      }

      // Get page length from settings to determine if we need to truncate
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25
      const maxFeedLength = pageLength * 4 // 4 page lengths
      const minFeedLength = pageLength * 4 // Minimum length when truncated
      
      // Determine which feed to display
      let feedToDisplay = savedState.feed
      let truncated = false
      
      // If feed has more than 4 page lengths and we have lowestVisiblePostTimestamp, truncate
      if (savedState.feed.length > maxFeedLength && savedState.lowestVisiblePostTimestamp !== null && savedState.lowestVisiblePostTimestamp !== undefined) {
        // Find the post with the lowestVisiblePostTimestamp
        // Feed is sorted newest first, so we need to find the post and keep everything up to and including it
        const feedReceivedTime = new Date()
        let lowestPostIndex = -1
        
        for (let i = 0; i < savedState.feed.length; i++) {
          const post = savedState.feed[i]
          const postTimestamp = getFeedViewPostTimestamp(post, feedReceivedTime).getTime()
          
          // Find the post with timestamp matching or closest to (but not newer than) lowestVisiblePostTimestamp
          // Since feed is sorted newest first, we want the first post that is at or older than lowestVisiblePostTimestamp
          if (postTimestamp <= savedState.lowestVisiblePostTimestamp) {
            lowestPostIndex = i
            break
          }
        }
        
        // If we found the post, truncate to include it and all posts before it (newer posts)
        if (lowestPostIndex >= 0) {
          const truncationPoint = lowestPostIndex + 1
          
          // Ensure truncated feed is at least minFeedLength posts long
          // If truncating to lowestVisiblePostTimestamp would result in fewer posts, keep at least minFeedLength
          const finalLength = Math.max(truncationPoint, minFeedLength)
          
          // But don't exceed the original feed length
          const actualLength = Math.min(finalLength, savedState.feed.length)
          
          feedToDisplay = savedState.feed.slice(0, actualLength)
          truncated = true
          console.log(`[Redisplay] Truncated feed from ${savedState.feed.length} to ${feedToDisplay.length} posts (min: ${minFeedLength}, truncation point: ${truncationPoint})`)
        } else {
          // If we couldn't find the post, truncate to at least minFeedLength (keep newest posts)
          if (savedState.feed.length > minFeedLength) {
            feedToDisplay = savedState.feed.slice(0, minFeedLength)
            truncated = true
            console.warn(`[Redisplay] Could not find post with lowestVisiblePostTimestamp, truncated to ${minFeedLength} newest posts`)
          }
        }
      }
      
      // Look up curation status for restored posts from summaries cache
      // This ensures posts have correct curation metadata for counter display
      const feedReceivedTime = new Date()
      const feedWithCuration = await lookupCurationAndFilter(
        feedToDisplay as CurationFeedViewPost[],
        feedReceivedTime
      )

      // Restore feed state (using potentially truncated feed with curation)
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
      
      // Reset flag to allow scroll restoration
      scrollRestoredRef.current = false
      
      console.log('[Redisplay] Restored feed state:', {
        feedLength: feedWithCuration.length,
        truncatedLength: feedToDisplay.length,
        originalFeedLength: savedState.feed.length,
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

      // 3. Reset React state
      setFeed([])
      setCursor(undefined)
      setHasMorePosts(false)
      setIsLoading(true)
      setIsInitialLoad(true)
      setNewestDisplayedPostTimestamp(null)
      setOldestDisplayedPostTimestamp(null)
      setNewPostsCount(0)
      setShowNewPostsButton(false)
      setLookingBack(false)
      setLookbackProgress(null)
      console.log('[Debug] Reset React state')

      // 4. Trigger fresh load (bypass cache)
      console.log('[Debug] Triggering fresh loadFeed with useCache=false...')
      await loadFeed(undefined, false)
      console.log('[Debug] clearCacheAndReloadHomePage: Complete!')

    } catch (error) {
      console.error('[Debug] clearCacheAndReloadHomePage failed:', error)
    }
  }, [loadFeed])

  // Expose debug function globally
  useEffect(() => {
    (window as any).clearCacheAndReloadHomePage = clearCacheAndReloadHomePage
    return () => {
      delete (window as any).clearCacheAndReloadHomePage
    }
  }, [clearCacheAndReloadHomePage])

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
        
        if (isWithinIdleInterval && savedState.feed && savedState.feed.length > 0) {
          console.log('[Navigation] Within idle interval, redisplaying feed:', {
            timeSinceSave: Math.round(timeSinceSave / 1000) + 's',
            idleInterval: Math.round(idleInterval / 1000) + 's'
          })
          return redisplayFeed()
        } else {
          console.log('[Navigation] Outside idle interval or no saved feed, calling loadFeed:', {
            timeSinceSave: Math.round(timeSinceSave / 1000) + 's',
            idleInterval: Math.round(idleInterval / 1000) + 's',
            hasFeed: !!savedState.feed && savedState.feed.length > 0
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
  }, [loadFeed, redisplayFeed, location.pathname, session])

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

        // Calculate how many raw posts to fetch
        const pageRaw = calculatePageRaw(pageSize, currentFilterFrac, varFactor)

        console.log(`[Paged Updates] Probing for new posts (filterFrac=${currentFilterFrac.toFixed(2)}, pageRaw=${pageRaw}, newestDisplayed=${new Date(currentTimestamp).toLocaleTimeString()}, oldestDisplayed=${oldestDisplayedPostTimestamp ? new Date(oldestDisplayedPostTimestamp).toLocaleTimeString() : 'null'})...`)

        // Probe for new posts (does NOT cache)
        const probeResult = await probeForNewPosts(
          agent,
          pageRaw,
          session.handle,
          session.did,
          currentTimestamp
        )

        console.log(`[Paged Updates] Probe result: ${probeResult.filteredPostCount}/${pageSize} displayable posts (${probeResult.totalPostCount} newer, ${probeResult.rawPostCount} raw)`)

        // Track first probe timestamp for max wait timer
        if (probeResult.filteredPostCount > 0 && !firstProbeTimestamp) {
          setFirstProbeTimestamp(Date.now())
        }

        // Check if we have a full page or max wait exceeded
        const hasFullPage = probeResult.filteredPostCount >= pageSize
        const maxWaitExceeded = firstProbeTimestamp &&
          (Date.now() - firstProbeTimestamp) >= maxWaitMinutes * 60 * 1000

        if (hasFullPage || (maxWaitExceeded && probeResult.filteredPostCount > 0)) {
          setNextPageReady(true)
          setNewPostsCount(probeResult.filteredPostCount)
          setPartialPageCount(maxWaitExceeded && !hasFullPage ? probeResult.filteredPostCount : 0)
          if (!isInitialLoad) {
            setShowNewPostsButton(true)
            console.log(`[Paged Updates] ${hasFullPage ? 'Full page ready' : 'Max wait exceeded'}: ${probeResult.filteredPostCount} posts → SHOWING BUTTON`)
          } else {
            console.log(`[Paged Updates] ${hasFullPage ? 'Full page ready' : 'Max wait exceeded'}: ${probeResult.filteredPostCount} posts (isInitialLoad, not showing button)`)
          }
        } else {
          // Not ready yet, keep tracking
          setNextPageReady(false)
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
    return () => clearInterval(interval)
  }, [newestDisplayedPostTimestamp, dbInitialized, isInitialLoad, pagedUpdatesEnabled, agent, session])

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

        // Save to feed cache first
        await savePostsToFeedCache(entries, newCursor)

        // Curate from entries (saves summaries)
        const curatedFeed = await curatePosts(entries, agent, myUsername, myDid)

        // Insert edition posts if needed
        await insertEditionPosts(curatedFeed)
        console.log(`[Periodic Fetch] Saved ${entries.length} new posts to cache`)

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
  }, [agent, session, dbInitialized, newestDisplayedPostTimestamp, isInitialLoad])

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
      const maxFeedSize = pageLength * 4
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

        // Fetch fresh posts from server
        const { feed: serverFeed } = await getHomeFeed(agent, { limit: pageRaw })

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

          // Save to feed cache first
          await savePostsToFeedCache([entry])

          // Curate from entry (saves summaries)
          const curatedPosts = await curatePosts([entry], agent, session.handle, session.did)
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

        // Prepend new posts to feed
        const existingUris = new Set(feed.map(p => getPostUniqueId(p)))
        const newPostsToAdd = postsToDisplay.filter(p => !existingUris.has(getPostUniqueId(p)))

        let combinedFeed = [...newPostsToAdd, ...feed]
        if (combinedFeed.length > maxFeedSize) {
          combinedFeed = combinedFeed.slice(0, maxFeedSize)
          const oldestPost = combinedFeed[combinedFeed.length - 1]
          const newOldestTimestamp = getFeedViewPostTimestamp(oldestPost, feedReceivedTime).getTime()
          setOldestDisplayedPostTimestamp(newOldestTimestamp)
        }

        setFeed(combinedFeed)
        setNewestDisplayedPostTimestamp(newestCuratedTimestamp)
        setNewPostsCount(0)
        setShowNewPostsButton(false)
        setNextPageReady(false)
        setFirstProbeTimestamp(null) // Reset probe timer for next page
        setPartialPageCount(0)

        console.log(`[Paged Updates] Successfully loaded ${newPostsToAdd.length} new posts`)
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
        if (combinedFeed.length > maxFeedSize) {
          combinedFeed = combinedFeed.slice(0, maxFeedSize)
          const oldestPost = combinedFeed[combinedFeed.length - 1]
          const newOldestTimestamp = getFeedViewPostTimestamp(oldestPost, feedReceivedTime).getTime()
          setOldestDisplayedPostTimestamp(newOldestTimestamp)
        }

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
    if (isLoadingMore || !agent || !session) return

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

    setIsLoadingMore(true)

    try {
      // Get page length from settings
      const settings = await getSettings()
      const pageLength = settings?.feedPageLength || 25

      // 1. Use oldestDisplayedPostTimestamp from component state (not oldestCachedPostTimestamp from metadata)
      if (!oldestDisplayedPostTimestamp) {
        // No more posts available
        setCursor(undefined)
        setHasMorePosts(false)
        setIsLoadingMore(false)
        return
      }
      
      const beforeTimestamp = oldestDisplayedPostTimestamp
      console.log(`[Load More] Starting pagination with oldestDisplayedPostTimestamp: ${new Date(beforeTimestamp).toISOString()}`)
      
      // 2. Try to get posts from cache (older than oldestDisplayedPostTimestamp)
      // getCachedFeedBefore returns { posts, postTimestamps } - use stored postTimestamp from cache
      let cacheResult = await getCachedFeedBefore(beforeTimestamp, pageLength)
      let nextPosts = cacheResult.posts
      let postTimestamps = cacheResult.postTimestamps
      console.log(`[Load More] Found ${nextPosts.length} posts in cache older than oldestDisplayedPostTimestamp`)
      
      // 3. If not enough posts in cache, extend cache
      if (nextPosts.length < pageLength) {
        const fetchedCount = await extendFeedCache(agent, session.handle, session.did)
        
        if (fetchedCount > 0) {
          // After extending cache, retry getting posts using the same oldestDisplayedPostTimestamp
          // extendFeedCache may have fetched newer posts, but we still want to use our pagination boundary
          console.log(`[Load More] After extending cache, retrying with oldestDisplayedPostTimestamp: ${new Date(beforeTimestamp).toISOString()}`)
          
          // Retry getting posts from cache after extending
          cacheResult = await getCachedFeedBefore(beforeTimestamp, pageLength)
          nextPosts = cacheResult.posts
          postTimestamps = cacheResult.postTimestamps
          console.log(`[Load More] After extending, found ${nextPosts.length} posts in cache`)
        } else {
          // No more posts available (end of feed)
          setCursor(undefined)
          setHasMorePosts(false)
          setIsLoadingMore(false)
          return
        }
      }
      
      // 4. Look up curation status and filter posts
      // Pass postTimestamps map so lookupCurationAndFilter uses stored timestamps instead of recalculating
      // feedReceivedTime is still needed for lookupCurationAndFilter signature but won't be used for sorting
      const feedReceivedTime = new Date()
      const filteredPosts = await lookupCurationAndFilter(nextPosts, feedReceivedTime, postTimestamps)
      
      // Calculate oldest timestamp from ALL posts (before filtering) to advance cursor past them
      // This ensures we don't get stuck if all posts in a batch are filtered out
      const oldestTimestampFromBatch = Math.min(
        ...nextPosts.map(p => {
          const uniqueId = getPostUniqueId(p)
          return postTimestamps.get(uniqueId) ?? postTimestamps.get(p.post.uri) ?? Infinity
        }).filter(t => t !== Infinity)
      )
      
      console.log(`[Load More] Oldest timestamp from batch: ${oldestTimestampFromBatch !== Infinity ? new Date(oldestTimestampFromBatch).toISOString() : 'Infinity'}`)
      console.log(`[Load More] Filtered posts count: ${filteredPosts.length}`)
      
      // 5. Append to existing feed
      if (filteredPosts.length > 0) {
        // filteredPosts are already sorted (newest first) and are older than existing feed
        // Existing feed is already sorted (newest first)
        // Since we're paginating backward in time, new posts should be appended at the end
        // No need to re-sort - just append
        setFeed(prevFeed => {
          // Check for duplicates before appending
          const existingUris = new Set(prevFeed.map(p => getPostUniqueId(p)))
          const newPostsToAdd = filteredPosts.filter(p => !existingUris.has(getPostUniqueId(p)))
          console.log(`[Load More] Appending ${newPostsToAdd.length} new posts (${filteredPosts.length - newPostsToAdd.length} duplicates filtered)`)
          return [...prevFeed, ...newPostsToAdd]
        })
      }
      
      // 6. Update oldestDisplayedPostTimestamp based on unfiltered batch (regardless of filtering)
      // This ensures we advance past all posts in the batch, even if they were filtered out
      if (oldestTimestampFromBatch !== Infinity) {
        // Update component state with new oldestDisplayedPostTimestamp
        setOldestDisplayedPostTimestamp(oldestTimestampFromBatch)
        console.log(`[Load More] Updated oldestDisplayedPostTimestamp to: ${new Date(oldestTimestampFromBatch).toISOString()}`)
        
        // hasMorePosts will be determined by whether we found more posts in subsequent checks
        // For now, keep it true if we successfully loaded posts (will be set to false if no more posts found)
      } else {
        // No valid timestamps found, end pagination
        setCursor(undefined)
        setHasMorePosts(false)
      }
      
      // If no posts were displayed but we had posts in the batch, try loading more
      if (filteredPosts.length === 0 && nextPosts.length > 0 && oldestTimestampFromBatch !== Infinity) {
        // Posts were filtered out, try next batch using the updated oldestDisplayedPostTimestamp
        // Only retry once to avoid infinite loop
        const retryCacheResult = await getCachedFeedBefore(oldestTimestampFromBatch, pageLength)
        const retryPosts = retryCacheResult.posts
        const retryPostTimestamps = retryCacheResult.postTimestamps
        
        if (retryPosts.length > 0) {
          const retryFiltered = await lookupCurationAndFilter(retryPosts, feedReceivedTime, retryPostTimestamps)
          
          // Calculate oldest timestamp from retry batch (before filtering)
          const oldestTimestampFromRetry = Math.min(
            ...retryPosts.map(p => {
              const uniqueId = getPostUniqueId(p)
              return retryPostTimestamps.get(uniqueId) ?? retryPostTimestamps.get(p.post.uri) ?? Infinity
            }).filter(t => t !== Infinity)
          )
          
          if (retryFiltered.length > 0) {
            // retryFiltered are already sorted (newest first) and are older than existing feed
            // Just append at the end
            setFeed(prevFeed => [...prevFeed, ...retryFiltered])
          }
          
          // Update oldestDisplayedPostTimestamp from retry batch (regardless of filtering)
          if (oldestTimestampFromRetry !== Infinity) {
            setOldestDisplayedPostTimestamp(oldestTimestampFromRetry)
          } else {
            setCursor(undefined)
            setHasMorePosts(false)
          }
        } else {
          // No more posts in cache, end pagination
          setCursor(undefined)
          setHasMorePosts(false)
        }
      } else if (nextPosts.length === 0) {
        // No posts available, end pagination
        setCursor(undefined)
        setHasMorePosts(false)
      }
    } catch (error) {
      console.error('Failed to load more posts:', error)
      addToast('Failed to load more posts', 'error')
    } finally {
      setIsLoadingMore(false)
    }
  }, [isLoadingMore, agent, session, oldestDisplayedPostTimestamp, feed, lookupCurationAndFilter, lookingBack])

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
    
    // Check if conditions are met
    if (!scrollSentinelRef.current || !hasMorePosts || isLoadingMore) {
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
        if (entry.isIntersecting && hasMorePosts && !isLoadingMore) {
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
  }, [infiniteScrollingEnabled, hasMorePosts, isLoadingMore, handleLoadMore])

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
              <span className="font-semibold">{skylimitStats.shown_daily.toFixed(0)}</span> displayed
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
            {/* New posts / Next Page button - shown above first post when there are new posts */}
            {showNewPostsButton && newPostsCount > 0 && (
              <div className="sticky top-0 z-30 p-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    console.log('[New Posts] Button clicked', { newPostsCount, isLoadingMore, newestDisplayedPostTimestamp, pagedUpdatesEnabled, nextPageReady, partialPageCount })
                    handleLoadNewPosts()
                  }}
                  disabled={isLoadingMore}
                  className="w-full btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label={pagedUpdatesEnabled ? (partialPageCount > 0 ? `Load ${partialPageCount} posts` : 'Load next page') : `Load ${newPostsCount} new post${newPostsCount !== 1 ? 's' : ''}`}
                >
                  {isLoadingMore ? (
                    <>
                      <Spinner size="sm" />
                      Loading...
                    </>
                  ) : pagedUpdatesEnabled ? (
                    // Paged updates mode
                    partialPageCount > 0 ? (
                      // Partial page after max wait
                      <>
                        <span>📄</span>
                        {partialPageCount}/25 posts ready
                      </>
                    ) : (
                      // Full page ready
                      <>
                        <span>📄</span>
                        Next Page
                      </>
                    )
                  ) : (
                    // Standard mode
                    <>
                      <span>📬</span>
                      {newPostsCount} new post{newPostsCount !== 1 ? 's' : ''}
                    </>
                  )}
                </button>
              </div>
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

        {/* Infinite scroll sentinel - only show when infinite scrolling is enabled */}
        {infiniteScrollingEnabled && hasMorePosts && (
          <div ref={scrollSentinelRef} className="py-4">
            {isLoadingMore && (
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

        {/* "Load More" button - only show when infinite scrolling is disabled and not looking back */}
        {!infiniteScrollingEnabled && hasMorePosts && !lookingBack && (
          <div className="p-4 text-center">
            <button
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="btn btn-secondary"
            >
              {isLoadingMore ? (
                <span className="flex items-center gap-2">
                  <Spinner size="sm" />
                  Loading...
                </span>
              ) : (
                'Load More'
              )}
            </button>
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
    </div>
  )
}

