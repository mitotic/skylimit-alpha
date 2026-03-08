import { useState, useEffect, useCallback, useRef } from 'react'
import { HomeTab, getFeedStateKey, getScrollStateKey } from './homePageTypes'
import log from '../utils/logger'

interface UseScrollManagementParams {
  locationPathname: string
  isLoading: boolean
  feedLength: number
  activeTab: HomeTab
  firstPostRef?: React.RefObject<HTMLDivElement | null>
  scrollRestoredRef?: React.MutableRefObject<boolean>  // Optional: if provided, shared with other hooks
}

export function useScrollManagement({
  locationPathname,
  isLoading,
  feedLength,
  activeTab,
  firstPostRef: _firstPostRef,
  scrollRestoredRef: externalScrollRestoredRef,
}: UseScrollManagementParams) {
  const [isScrolledDown, setIsScrolledDown] = useState(false)

  // Scroll state refs
  const isProgrammaticScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const internalScrollRestoredRef = useRef(false)
  const scrollRestoredRef = externalScrollRestoredRef ?? internalScrollRestoredRef
  const scrollRestoreBlockedRef = useRef(false)
  const scrollSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const scrollSaveBlockedRef = useRef(false)

  // Disable browser scroll restoration
  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual'
    }
  }, [])

  // Restore scroll position when feed state is restored
  // Note: Scroll restoration works regardless of infinite scrolling setting
  useEffect(() => {
    if (locationPathname !== '/') {
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
  }, [locationPathname, isLoading, feedLength, activeTab])

  // Scroll event handler (for UI state and scroll position saving)
  useEffect(() => {
    // Only track scroll if we're on the home page
    if (locationPathname !== '/') return

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
            log.warn('Scroll', 'Failed to clear scroll position:', error)
          }
          return
        }

        // Save scroll position (always save, always restore when feed state is restored)
        try {
          sessionStorage.setItem(getScrollStateKey(activeTab), scrollY.toString())
        } catch (error) {
          log.warn('Scroll', 'Failed to save scroll position:', error)
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
  }, [locationPathname, feedLength])

  // Scroll to top handler
  const handleScrollToTop = useCallback(() => {
    isProgrammaticScrollRef.current = true
    window.scrollTo({ top: 0, behavior: 'smooth' })

    // Reset flag after scroll completes
    setTimeout(() => {
      isProgrammaticScrollRef.current = false
      lastScrollTopRef.current = window.scrollY
    }, 1000)
  }, [])

  return {
    isScrolledDown,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    scrollRestoredRef,
    scrollRestoreBlockedRef,
    scrollSaveBlockedRef,
    handleScrollToTop,
  }
}
