import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useSession } from '../auth/SessionContext'
import { getUnreadCount } from '../api/notifications'
import { isRateLimited, getTimeUntilClear } from '../utils/rateLimitState'
import { resetEverything } from '../curation/skylimitCache'
import ConfirmModal from './ConfirmModal'

export default function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const { session, logout, agent } = useSession()
  const [unreadCount, setUnreadCount] = useState<number>(0)
  const [showResetAllModal, setShowResetAllModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const [clickToBlueSky, setClickToBlueSky] = useState(false)

  // Check if a nav item is active - compare pathname only (ignore query params)
  const isActive = (path: string) => {
    const pathWithoutQuery = path.split('?')[0]
    return location.pathname === pathWithoutQuery
  }

  // Fetch unread notification count
  useEffect(() => {
    if (!agent || !session) {
      setUnreadCount(0)
      return
    }

    const fetchUnreadCount = async () => {
      // Skip if rate limited
      if (isRateLimited()) {
        const timeUntilClear = getTimeUntilClear()
        console.log(`[Navigation] Skipping unread count fetch - rate limited for ${Math.ceil(timeUntilClear)}s`)
        return
      }

      try {
        const count = await getUnreadCount(agent)
        setUnreadCount(count)
      } catch (error) {
        console.warn('Failed to fetch unread count:', error)
        // Don't show error to user, just silently fail
      }
    }

    // Fetch immediately
    fetchUnreadCount()

    // Refresh count every 30 seconds, but back off when rate limited
    const intervalRef = { current: setInterval(() => {
      if (isRateLimited()) {
        // If rate limited, check again after the rate limit clears
        const timeUntilClear = getTimeUntilClear()
        clearInterval(intervalRef.current)
        setTimeout(() => {
          fetchUnreadCount()
          // Restart interval with longer delay (60s) after rate limit
          intervalRef.current = setInterval(fetchUnreadCount, 60000)
        }, Math.max(timeUntilClear * 1000, 1000))
      } else {
        fetchUnreadCount()
      }
    }, 30000) }

    // Refresh when navigating to/from notifications page
    if (location.pathname === '/notifications') {
      // Reset count when viewing notifications
      setUnreadCount(0)
    }

    return () => clearInterval(intervalRef.current)
  }, [agent, session, location.pathname])

  // Load click to Bluesky setting from localStorage
  useEffect(() => {
    setClickToBlueSky(localStorage.getItem('websky_click_to_bluesky') === 'true')
  }, [location.pathname]) // Reload on navigation to pick up settings changes

  const navItems = [
    { path: '/', label: 'Home', icon: '🏠' },
    { path: '/search', label: 'Search', icon: '🔍' },
    { path: '/settings?tab=basic', label: 'Settings', icon: '⚙️' },
  ]

  const handleProfileClick = () => {
    if (session) {
      if (clickToBlueSky) {
        window.location.href = `https://bsky.app/profile/${session.handle}`
      } else {
        navigate(`/profile/${session.handle}`)
      }
    }
  }

  const handleNotificationsClick = () => {
    if (clickToBlueSky) {
      window.location.href = 'https://bsky.app/notifications'
    } else {
      navigate('/notifications')
    }
  }

  const handleResetAll = () => {
    setIsResettingAll(true)
    resetEverything() // Redirects to /?reset=1
  }

  return (
    <div className="flex justify-around md:justify-start md:flex-col h-full">
      {navItems.map(item => (
        <Link
          key={item.path}
          to={item.path}
          className={`flex items-center gap-3 px-4 py-3 transition-colors relative ${
            isActive(item.path)
              ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
              : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
          }`}
        >
          <span className="text-xl">{item.icon}</span>
          <span className="hidden md:inline font-medium">{item.label}</span>
        </Link>
      ))}

      {/* Notifications - uses button for Click to Bluesky support */}
      <button
        onClick={handleNotificationsClick}
        className={`flex items-center gap-3 px-4 py-3 transition-colors relative ${
          isActive('/notifications')
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
        }`}
      >
        <span className={`text-xl ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full px-0.5' : ''}`}>🔔</span>
        <span className="hidden md:inline font-medium">Notifications</span>
        {unreadCount > 0 && (
          <span className="md:ml-auto absolute -top-1 -right-1 md:static bg-red-500 text-white text-xs font-bold rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {session && (
        <>
          <button
            onClick={handleProfileClick}
            className={`flex items-center gap-3 px-4 py-3 transition-colors ${
              location.pathname.startsWith('/profile')
                ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
            }`}
          >
            <span className={`text-xl ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full px-0.5' : ''}`}>👤</span>
            <span className="hidden md:inline font-medium">Profile</span>
          </button>

          <button
            onClick={logout}
            className="flex items-center gap-3 px-4 py-3 text-orange-600 dark:text-orange-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <span className="text-xl">⎋</span>
            <span className="hidden md:inline font-medium">Logout</span>
          </button>

          <button
            onClick={() => setShowResetAllModal(true)}
            className="flex items-center gap-3 px-4 py-3 text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <span className="text-xl">⏻</span>
            <span className="hidden md:inline font-medium">Reset all</span>
          </button>
        </>
      )}

      {/* Reset All Confirmation Modal */}
      <ConfirmModal
        isOpen={showResetAllModal}
        onClose={() => setShowResetAllModal(false)}
        onConfirm={handleResetAll}
        title="Reset All Data"
        message={`WARNING: This will completely wipe all Websky data:
• All cached posts and summaries
• All Skylimit settings
• Follow list data
• Login session (you will be logged out)

This is a complete reset to factory state. Use this only if the app is not working correctly.

This cannot be undone.`}
        confirmText={isResettingAll ? 'Resetting...' : 'Reset Everything'}
        cancelText="Cancel"
        isDangerous={true}
        isLoading={isResettingAll}
      />
    </div>
  )
}

