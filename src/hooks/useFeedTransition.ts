import { useRef, useCallback } from 'react'

/**
 * Hook for smooth cross-fade transitions when the feed content is replaced.
 * Uses direct DOM manipulation (via ref) to avoid extra React re-renders.
 *
 * Usage:
 *   const { feedContainerRef, fadeOut, fadeIn } = useFeedTransition()
 *   // Wrap feed list: <div ref={feedContainerRef} className="feed-transition-container">...</div>
 *   // In handler:  await fadeOut(); setFeed(newPosts); fadeIn()
 *
 * @param duration  Half-transition time in ms (default 150).
 *                  Total cross-fade = 2 × duration.
 */
export function useFeedTransition(duration = 150) {
  const feedContainerRef = useRef<HTMLDivElement>(null)

  /** Fade the feed container to opacity 0. Resolves when fully invisible. */
  const fadeOut = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      const el = feedContainerRef.current
      if (!el) { resolve(); return }

      el.style.transition = `opacity ${duration}ms ease-in`
      void el.offsetHeight // force reflow
      el.style.opacity = '0'

      let resolved = false
      const done = () => {
        if (resolved) return
        resolved = true
        el.style.transition = 'none'
        el.style.opacity = '0'
        resolve()
      }
      el.addEventListener('transitionend', done, { once: true })
      setTimeout(done, duration + 50) // safety fallback
    })
  }, [duration])

  /** Fade the feed container back to opacity 1 (fire-and-forget). */
  const fadeIn = useCallback(() => {
    const el = feedContainerRef.current
    if (!el) return

    // Double-rAF: first frame lets React commit its render,
    // second frame starts the CSS transition on a painted frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = `opacity ${duration}ms ease-out`
        el.style.opacity = '1'
      })
    })
  }, [duration])

  return { feedContainerRef, fadeOut, fadeIn }
}
