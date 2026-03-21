import { useEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * ScrollToTop component that scrolls to top when navigating to a new route
 * But preserves scroll position when navigating back to thread page
 */
export default function ScrollToTop() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()
  const prevPathnameRef = useRef(pathname)

  useEffect(() => {
    const wasOnThread = prevPathnameRef.current.startsWith('/post/')
    const isOnThread = pathname.startsWith('/post/')
    const isOnSearch = pathname === '/search'
    const isOnSaved = pathname === '/saved'
    const isOnNotifications = pathname === '/notifications'

    // Don't scroll to top if:
    // 1. We're on a thread page (let ThreadPage handle scroll restoration)
    // 2. We're navigating back to thread page (POP navigation)
    // 3. We're returning to search/saved/notifications page via back navigation (let them handle scroll restoration)
    if (isOnThread || (wasOnThread && navigationType === 'POP') || ((isOnSearch || isOnSaved || isOnNotifications) && navigationType === 'POP')) {
      prevPathnameRef.current = pathname
      return
    }
    
    // Scroll to top for all other routes (including home page)
    window.scrollTo(0, 0)
    
    prevPathnameRef.current = pathname
  }, [pathname, navigationType])

  return null
}

