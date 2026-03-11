import { useCallback, useEffect, useRef } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import { CurationFeedViewPost } from '../curation/types'
import { getPostUniqueId } from '../curation/skylimitGeneral'
import { updatePostSummaryViewedAt } from '../curation/skylimitCache'
import { markPostViewed } from '../curation/skylimitUnviewedTracker'
import { clientNow } from '../utils/clientClock'

/** Minimum dwell time (ms) a post must remain visible and stationary to count as "viewed" */
const VIEW_DWELL_TIME_MS = 1000
/** Debounce interval (ms) after last scroll event before considering scroll "stopped" */
const SCROLL_STOP_DEBOUNCE_MS = 300

interface UseViewTrackingParams {
  feed: AppBskyFeedDefs.FeedViewPost[]
  setFeed: React.Dispatch<React.SetStateAction<AppBskyFeedDefs.FeedViewPost[]>>
}

export function useViewTracking({ feed, setFeed }: UseViewTrackingParams): void {
  const viewTrackingObserverRef = useRef<IntersectionObserver | null>(null)
  const viewedPostIdsRef = useRef<Set<string>>(new Set())
  const pendingViewedUpdatesRef = useRef<Map<string, number>>(new Map())
  const viewedUpdateScheduledRef = useRef(false)
  const dwellTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const isScrollingRef = useRef(false)
  const scrollStopDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visiblePostElementsRef = useRef<Map<string, HTMLElement>>(new Map())

  // Keep a ref to the latest setFeed so stale callbacks (startDwellTimer) always
  // call the current setter. This is critical for EditionView whose setFeedAdapter
  // changes on re-renders, unlike HomePage's stable useState setter.
  const setFeedRef = useRef(setFeed)
  setFeedRef.current = setFeed

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
          setFeedRef.current(prev => prev.map(p => {
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
      // Prune IDs not in current feed (handles edition switching where feed is replaced).
      // For HomePage's growing feed, viewed posts remain so their IDs are retained.
      const currentFeedIds = new Set(feed.map(getPostUniqueId))
      for (const id of viewedPostIdsRef.current) {
        if (!currentFeedIds.has(id)) {
          viewedPostIdsRef.current.delete(id)
        }
      }

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
}
