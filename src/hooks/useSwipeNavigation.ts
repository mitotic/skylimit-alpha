import { useEffect, useRef, useCallback } from 'react'

interface UseSwipeNavigationParams {
  container: HTMLElement | null  // direct element (re-runs effect when element appears)
  onSwipeLeft: () => void   // swipe left → navigate forward (next/newer)
  onSwipeRight: () => void  // swipe right → navigate back (prev/older)
  enabled?: boolean
  threshold?: number  // minimum horizontal distance in px (default: 50)
}

/**
 * Custom hook for horizontal swipe gesture navigation on mobile.
 * Attaches touch listeners to a container element.
 * Only triggers when horizontal movement exceeds vertical (avoids
 * interfering with normal scrolling).
 */
export function useSwipeNavigation({
  container,
  onSwipeLeft,
  onSwipeRight,
  enabled = true,
  threshold = 50,
}: UseSwipeNavigationParams): void {
  // Keep callbacks stable via refs to avoid re-registering listeners
  const onSwipeLeftRef = useRef(onSwipeLeft)
  onSwipeLeftRef.current = onSwipeLeft
  const onSwipeRightRef = useRef(onSwipeRight)
  onSwipeRightRef.current = onSwipeRight

  const startXRef = useRef(0)
  const startYRef = useRef(0)

  const handleTouchStart = useCallback((e: TouchEvent) => {
    startXRef.current = e.touches[0].clientX
    startYRef.current = e.touches[0].clientY
  }, [])

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (!e.changedTouches.length) return

    const deltaX = e.changedTouches[0].clientX - startXRef.current
    const deltaY = e.changedTouches[0].clientY - startYRef.current

    // Only trigger if horizontal movement dominates vertical
    if (Math.abs(deltaX) < threshold || Math.abs(deltaX) < Math.abs(deltaY)) {
      return
    }

    if (deltaX < 0) {
      // Swiped left → next
      onSwipeLeftRef.current()
    } else {
      // Swiped right → prev
      onSwipeRightRef.current()
    }
  }, [threshold])

  useEffect(() => {
    if (!enabled || !container) return

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchend', handleTouchEnd)
    }
  }, [enabled, container, handleTouchStart, handleTouchEnd])
}
