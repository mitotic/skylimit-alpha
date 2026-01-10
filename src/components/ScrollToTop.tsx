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
    
    // Don't scroll to top if:
    // 1. We're on a thread page (let ThreadPage handle scroll restoration)
    // 2. We're navigating back to thread page (POP navigation)
    if (isOnThread || (wasOnThread && navigationType === 'POP')) {
      prevPathnameRef.current = pathname
      return
    }
    
    // Scroll to top for all other routes (including home page)
    window.scrollTo(0, 0)
    
    prevPathnameRef.current = pathname
  }, [pathname, navigationType])

  return null
}

