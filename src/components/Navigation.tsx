import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useSession } from '../auth/SessionContext'
import { getUnreadCount } from '../api/notifications'
import { getUnreadChatCount } from '../api/chat'
import { isRateLimited, getTimeUntilClear } from '../utils/rateLimitState'
import { getNonStandardServerName } from '../api/atproto-client'
import { resetEverything } from '../curation/skylimitCache'
import { getSetting } from '../curation/skylimitStore'
import log from '../utils/logger'
import ConfirmModal from './ConfirmModal'
import BugReportModal from './BugReportModal'
import { HomeIcon, SearchIcon, BookmarkIcon, BellIcon, ChatIcon, PersonIcon, GearIcon, BugIcon } from './NavIcons'
import { clientInterval, clearClientInterval, clientTimeout } from '../utils/clientClock'

export default function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const { session, agent, avatarUrl } = useSession()
  const [unreadCount, setUnreadCount] = useState<number>(0)
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0)
  const [showResetAllModal, setShowResetAllModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const [showDebugMenu, setShowDebugMenu] = useState(false)
  const [showBugReportModal, setShowBugReportModal] = useState(false)
  const debugMenuRef = useRef<HTMLDivElement>(null)

  const [clickToBlueSky, setClickToBlueSky] = useState(false)
  const [debugMode, setDebugMode] = useState(false)

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
        log.verbose('Navigation', `Skipping unread count fetch - rate limited for ${Math.ceil(timeUntilClear)}s`)
        return
      }

      try {
        const [count, chatCount] = await Promise.all([
          getUnreadCount(agent),
          getNonStandardServerName() ? Promise.resolve(0) : getUnreadChatCount(agent).catch(() => 0),
        ])
        setUnreadCount(count)
        setUnreadChatCount(chatCount)
      } catch (error) {
        log.warn('Navigation', 'Failed to fetch unread count:', error)
        // Don't show error to user, just silently fail
      }
    }

    // Fetch immediately
    fetchUnreadCount()

    // Refresh count every 30 seconds, but back off when rate limited
    const intervalRef = { current: clientInterval(() => {
      if (isRateLimited()) {
        // If rate limited, check again after the rate limit clears
        const timeUntilClear = getTimeUntilClear()
        clearClientInterval(intervalRef.current)
        clientTimeout(() => {
          fetchUnreadCount()
          // Restart interval with longer delay (60s) after rate limit
          intervalRef.current = clientInterval(fetchUnreadCount, 60000)
        }, Math.max(timeUntilClear * 1000, 1000))
      } else {
        fetchUnreadCount()
      }
    }, 30000) }

    // Refresh when navigating to/from notifications or chat page
    if (location.pathname === '/notifications') {
      setUnreadCount(0)
    }
    if (location.pathname === '/chat' || location.pathname.startsWith('/chat/')) {
      setUnreadChatCount(0)
    }

    return () => clearClientInterval(intervalRef.current)
  }, [agent, session, location.pathname])

  // Load click to Bluesky setting from localStorage
  useEffect(() => {
    setClickToBlueSky(localStorage.getItem('websky_click_to_bluesky') === 'true')
  }, [location.pathname]) // Reload on navigation to pick up settings changes

  // Load debug mode setting from IndexedDB
  useEffect(() => {
    getSetting('debugMode').then(v => setDebugMode(!!v))
  }, [location.pathname])

  // Close debug menu on click outside
  useEffect(() => {
    if (!showDebugMenu) return
    const handleClick = (e: MouseEvent) => {
      if (debugMenuRef.current && !debugMenuRef.current.contains(e.target as Node)) {
        setShowDebugMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showDebugMenu])

  const navItems = [
    { path: '/', label: 'Home', icon: 'home' as const },
  ]

  const handleSearchClick = () => {
    if (clickToBlueSky) {
      window.location.href = 'https://bsky.app/search'
    } else {
      navigate('/search')
    }
  }

  const handleSavedClick = () => {
    if (clickToBlueSky) {
      window.location.href = 'https://bsky.app/saved'
    } else {
      navigate('/saved')
    }
  }

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

  const handleChatClick = () => {
    if (clickToBlueSky) {
      window.location.href = 'https://bsky.app/messages'
    } else {
      navigate('/chat')
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
          <HomeIcon />
          <span className="hidden md:inline font-medium">{item.label}</span>
        </Link>
      ))}

      {/* Search - uses button for Click to Bluesky support */}
      <button
        onClick={handleSearchClick}
        className={`flex items-center gap-3 px-4 py-3 transition-colors relative ${
          isActive('/search')
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
        }`}
      >
        <SearchIcon className={`w-6 h-6 ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full p-0.5 box-content' : ''}`} />
        <span className="hidden md:inline font-medium">Search</span>
      </button>

      {/* Notifications - uses button for Click to Bluesky support */}
      <button
        onClick={handleNotificationsClick}
        className={`flex items-center gap-3 px-4 py-3 transition-colors relative ${
          isActive('/notifications')
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
        }`}
      >
        <BellIcon className={`w-6 h-6 ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full p-0.5 box-content' : ''}`} />
        <span className="hidden md:inline font-medium">Notifications</span>
        {unreadCount > 0 && (
          <span className="md:ml-auto absolute -top-1 -right-1 md:static bg-red-500 text-white text-xs font-bold rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Saved - hidden on mobile bottom bar */}
      <button
        onClick={handleSavedClick}
        className={`hidden md:flex items-center gap-3 px-4 py-3 transition-colors relative ${
          isActive('/saved')
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
        }`}
      >
        <BookmarkIcon className={`w-6 h-6 ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full p-0.5 box-content' : ''}`} />
        <span className="hidden md:inline font-medium">Saved</span>
      </button>

      {/* Chat */}
      <button
        onClick={handleChatClick}
        className={`flex items-center gap-3 px-4 py-3 transition-colors relative ${
          isActive('/chat') || location.pathname.startsWith('/chat/')
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
        }`}
      >
        <ChatIcon className={`w-6 h-6 ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full p-0.5 box-content' : ''}`} />
        <span className="hidden md:inline font-medium">Chat</span>
        {unreadChatCount > 0 && (
          <span className="md:ml-auto absolute -top-1 -right-1 md:static bg-red-500 text-white text-xs font-bold rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center">
            {unreadChatCount > 99 ? '99+' : unreadChatCount}
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
            {avatarUrl ? (
              <img src={avatarUrl} alt="Profile" className={`w-6 h-6 rounded-full object-cover ${clickToBlueSky ? 'border-2 border-blue-500' : ''}`} />
            ) : (
              <PersonIcon className={`w-6 h-6 ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full p-0.5 box-content' : ''}`} />
            )}
            <span className="hidden md:inline font-medium">Profile</span>
          </button>

          <Link
            to="/settings?tab=basic"
            className={`flex items-center gap-3 px-4 py-3 transition-colors relative ${
              isActive('/settings')
                ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
            }`}
          >
            <GearIcon />
            <span className="hidden md:inline font-medium">Settings</span>
          </Link>

          {debugMode && (
            <div ref={debugMenuRef} className="relative">
              <button
                onClick={() => setShowDebugMenu(!showDebugMenu)}
                className="flex items-center gap-3 px-4 py-3 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                <BugIcon />
                <span className="hidden md:inline font-medium">Debug</span>
              </button>
              {showDebugMenu && (
                <div className="absolute bottom-full right-0 md:left-0 md:right-auto mb-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 min-w-[160px]">
                  <button
                    onClick={() => { setShowBugReportModal(true); setShowDebugMenu(false) }}
                    className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-t-lg transition-colors"
                  >
                    Report a bug
                  </button>
                  {getNonStandardServerName() && (
                    <button
                      onClick={() => { setShowResetAllModal(true); setShowDebugMenu(false) }}
                      className="w-full text-left px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-b-lg transition-colors"
                    >
                      Reset ALL
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Debug Modals */}
      {debugMode && (
        <>
          <ConfirmModal
            isOpen={showResetAllModal}
            onClose={() => setShowResetAllModal(false)}
            onConfirm={handleResetAll}
            title="Reset All Data"
            message={`WARNING: This will completely wipe all Websky data — settings, caches, and login.

Use this only if the app is not working correctly. This cannot be undone.`}
            confirmText={isResettingAll ? 'Resetting...' : 'Reset Everything'}
            cancelText="Cancel"
            isDangerous={true}
            isLoading={isResettingAll}
          />
          <BugReportModal
            isOpen={showBugReportModal}
            onClose={() => setShowBugReportModal(false)}
            initialLogLevel={2}
            agent={agent}
          />
        </>
      )}
    </div>
  )
}

