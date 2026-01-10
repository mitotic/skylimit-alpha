import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useSession } from '../auth/SessionContext'
import { getUnreadCount } from '../api/notifications'
import { isRateLimited, getTimeUntilClear } from '../utils/rateLimitState'
import Avatar from './Avatar'

export default function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const { session, logout, agent } = useSession()
  const [unreadCount, setUnreadCount] = useState<number>(0)

  const isActive = (path: string) => location.pathname === path

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

  const navItems = [
    { path: '/', label: 'Home', icon: '🏠' },
    { path: '/notifications', label: 'Notifications', icon: '🔔', badge: unreadCount > 0 ? unreadCount : undefined },
    { path: '/search', label: 'Search', icon: '🔍' },
    { path: '/settings', label: 'Settings', icon: '⚙️' },
  ]

  const handleProfileClick = () => {
    if (session) {
      navigate(`/profile/${session.handle}`)
    }
  }

  return (
    <div className="flex md:flex-col h-full">
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
          <span className="font-medium">{item.label}</span>
          {item.badge !== undefined && item.badge > 0 && (
            <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center">
              {item.badge > 99 ? '99+' : item.badge}
            </span>
          )}
        </Link>
      ))}

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
            <Avatar
              src={undefined}
              alt={session.handle}
              size="sm"
            />
            <span className="font-medium">Profile</span>
          </button>

          <button
            onClick={logout}
            className="flex items-center gap-3 px-4 py-3 text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <span className="text-xl">🚪</span>
            <span className="font-medium">Logout</span>
          </button>
        </>
      )}

      {/* Compose button */}
      <Link
        to="/"
        className="md:hidden fixed bottom-20 right-4 w-14 h-14 bg-blue-500 hover:bg-blue-600 text-white rounded-full flex items-center justify-center shadow-lg text-2xl z-50"
        aria-label="Compose post"
      >
        ✏️
      </Link>
    </div>
  )
}

