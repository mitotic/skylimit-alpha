import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import { getUnreadCount } from '../api/notifications'
import { getUnreadChatCount } from '../api/chat'
import { isRateLimited } from '../utils/rateLimitState'
import { getNonStandardServerName } from '../api/atproto-client'
import { resetEverything } from '../curation/skylimitCache'
import { getSetting } from '../curation/skylimitStore'
import ConfirmModal from './ConfirmModal'
import BugReportModal from './BugReportModal'
import { HomeIcon, SearchIcon, BookmarkIcon, BellIcon, ChatIcon, PersonIcon, GearIcon, BugIcon } from './NavIcons'
import log from '../utils/logger'

export default function BurgerMenu() {
  const [isOpen, setIsOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const { session, agent, avatarUrl } = useSession()
  const [unreadCount, setUnreadCount] = useState<number>(0)
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0)
  const [showResetAllModal, setShowResetAllModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const [showDebugMenu, setShowDebugMenu] = useState(false)
  const [showBugReportModal, setShowBugReportModal] = useState(false)

  const [debugMode, setDebugMode] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const debugMenuRef = useRef<HTMLDivElement>(null)

  // Check if a nav item is active - compare pathname only (ignore query params)
  const isActive = (path: string) => {
    const pathWithoutQuery = path.split('?')[0]
    return location.pathname === pathWithoutQuery
  }

  // Close menu when route changes
  useEffect(() => {
    setIsOpen(false)
  }, [location.pathname])

  // Close menu on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen])

  // Fetch unread notification count
  useEffect(() => {
    if (!agent || !session) {
      setUnreadCount(0)
      return
    }

    const fetchUnreadCount = async () => {
      if (isRateLimited()) return
      try {
        const [count, chatCount] = await Promise.all([
          getUnreadCount(agent),
          getUnreadChatCount(agent).catch(() => 0),
        ])
        setUnreadCount(count)
        setUnreadChatCount(chatCount)
      } catch (error) {
        log.warn('Navigation', 'Failed to fetch unread count:', error)
      }
    }

    fetchUnreadCount()
  }, [agent, session])

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
    { path: '/', label: 'Home', icon: <HomeIcon /> },
    { path: '/search', label: 'Search', icon: <SearchIcon /> },
    { path: '/notifications', label: 'Notifications', icon: <BellIcon />, badge: unreadCount > 0 ? unreadCount : undefined },
    { path: '/saved', label: 'Saved', icon: <BookmarkIcon /> },
    { path: '/chat', label: 'Chat', icon: <ChatIcon />, badge: unreadChatCount > 0 ? unreadChatCount : undefined },
  ]

  const handleProfileClick = () => {
    if (session) {
      navigate(`/profile/${session.handle}`)
      setIsOpen(false)
    }
  }

  const handleResetAll = () => {
    setIsResettingAll(true)
    resetEverything()
  }

  return (
    <>
      {/* Burger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
        aria-label={isOpen ? 'Close navigation menu' : 'Open navigation menu'}
        aria-expanded={isOpen}
      >
        <span className="text-xl">{isOpen ? '✕' : '☰'}</span>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />

          {/* Menu panel - positioned below header, auto-width */}
          <div
            ref={menuRef}
            className="fixed top-12 left-2 bg-white dark:bg-gray-900 z-50 shadow-lg border border-gray-200 dark:border-gray-700 rounded-lg max-h-[80vh] overflow-y-auto"
          >
            <nav className="flex flex-col py-2">
              {navItems.map(item => (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setIsOpen(false)}
                  className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                    isActive(item.path)
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {item.icon}
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
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="Profile" className="w-6 h-6 rounded-full object-cover" />
                    ) : (
                      <PersonIcon />
                    )}
                    <span className="font-medium">Profile</span>
                  </button>

                  <Link
                    to="/settings?tab=basic"
                    onClick={() => setIsOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                      isActive('/settings')
                        ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <GearIcon />
                    <span className="font-medium">Settings</span>
                  </Link>

                  {debugMode && (
                    <div ref={debugMenuRef} className="relative">
                      <button
                        onClick={() => setShowDebugMenu(!showDebugMenu)}
                        className="flex items-center gap-3 px-4 py-3 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors w-full"
                      >
                        <BugIcon />
                        <span className="font-medium">Debug</span>
                      </button>
                      {showDebugMenu && (
                        <div className="ml-8 border-l-2 border-gray-200 dark:border-gray-700">
                          <button
                            onClick={() => { setShowBugReportModal(true); setShowDebugMenu(false); setIsOpen(false) }}
                            className="w-full text-left px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                          >
                            Report a bug
                          </button>
                          {getNonStandardServerName() && (
                            <button
                              onClick={() => { setShowResetAllModal(true); setShowDebugMenu(false); setIsOpen(false) }}
                              className="w-full text-left px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
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
            </nav>
          </div>
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
    </>
  )
}
