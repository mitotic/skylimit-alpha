import { useState, useEffect, useRef, useCallback } from 'react'

interface UsePullToRefreshParams {
  onRefresh: () => void
  enabled: boolean
  threshold?: number  // Pull distance in px to trigger refresh (default: 80)
}

interface UsePullToRefreshResult {
  isPulling: boolean
  pullDistance: number
  pullFraction: number  // 0.0–1.0, clamped
}

/**
 * Custom pull-to-refresh hook for mobile touch gestures.
 * Activates when the user pulls down while scrolled to the top of the page.
 * Sets overscroll-behavior-y: contain on <body> to prevent the native
 * Chrome pull-to-refresh from racing with this custom implementation.
 */
export function usePullToRefresh({
  onRefresh,
  enabled,
  threshold = 80,
}: UsePullToRefreshParams): UsePullToRefreshResult {
  const [isPulling, setIsPulling] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)

  // Refs to track touch state across event handlers
  const startYRef = useRef(0)
  const startedAtTopRef = useRef(false)
  const pullDistanceRef = useRef(0)  // Mirrors state for use in touchend closure

  // Keep onRefresh stable via ref to avoid re-registering listeners
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  const handleTouchStart = useCallback((e: TouchEvent) => {
    // Only activate when scrolled to top
    if (window.scrollY > 0) {
      startedAtTopRef.current = false
      return
    }
    startedAtTopRef.current = true
    startYRef.current = e.touches[0].clientY
    pullDistanceRef.current = 0
  }, [])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!startedAtTopRef.current) return

    const currentY = e.touches[0].clientY
    const distance = Math.max(0, currentY - startYRef.current)

    // Apply resistance: distance slows down as you pull further
    const resistedDistance = distance * 0.5

    pullDistanceRef.current = resistedDistance
    setPullDistance(resistedDistance)
    setIsPulling(resistedDistance > 0)
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (!startedAtTopRef.current) return

    const distance = pullDistanceRef.current
    if (distance >= threshold) {
      onRefreshRef.current()
    }

    // Reset state
    setPullDistance(0)
    setIsPulling(false)
    pullDistanceRef.current = 0
    startedAtTopRef.current = false
  }, [threshold])

  useEffect(() => {
    if (!enabled) {
      // Clean up state when disabled
      setPullDistance(0)
      setIsPulling(false)
      return
    }

    // Suppress native Chrome pull-to-refresh so it doesn't race with ours
    const prevOverscroll = document.body.style.overscrollBehaviorY
    document.body.style.overscrollBehaviorY = 'contain'

    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchmove', handleTouchMove, { passive: true })
    window.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      document.body.style.overscrollBehaviorY = prevOverscroll
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [enabled, handleTouchStart, handleTouchMove, handleTouchEnd])

  const pullFraction = Math.min(1, pullDistance / threshold)

  return { isPulling, pullDistance, pullFraction }
}
