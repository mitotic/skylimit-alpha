import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import { getUnreadCount } from '../api/notifications'
import { isRateLimited } from '../utils/rateLimitState'
import { resetEverything } from '../curation/skylimitCache'
import ConfirmModal from './ConfirmModal'

export default function BurgerMenu() {
  const [isOpen, setIsOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const { session, logout, agent } = useSession()
  const [unreadCount, setUnreadCount] = useState<number>(0)
  const [showResetAllModal, setShowResetAllModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const isActive = (path: string) => location.pathname === path

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
        const count = await getUnreadCount(agent)
        setUnreadCount(count)
      } catch (error) {
        console.warn('Failed to fetch unread count:', error)
      }
    }

    fetchUnreadCount()
  }, [agent, session])

  const navItems = [
    { path: '/', label: 'Home', icon: '🏠' },
    { path: '/notifications', label: 'Notifications', icon: '🔔', badge: unreadCount > 0 ? unreadCount : undefined },
    { path: '/search', label: 'Search', icon: '🔍' },
    { path: '/settings', label: 'Settings', icon: '⚙️' },
  ]

  const handleProfileClick = () => {
    if (session) {
      navigate(`/profile/${session.handle}`)
      setIsOpen(false)
    }
  }

  const handleLogout = () => {
    setIsOpen(false)
    logout()
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
                    <span className="text-xl">👤</span>
                    <span className="font-medium">Profile</span>
                  </button>

                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-3 px-4 py-3 text-orange-600 dark:text-orange-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    <span className="text-xl">⎋</span>
                    <span className="font-medium">Logout</span>
                  </button>

                  <button
                    onClick={() => setShowResetAllModal(true)}
                    className="flex items-center gap-3 px-4 py-3 text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    <span className="text-xl">⏻</span>
                    <span className="font-medium">Reset all</span>
                  </button>
                </>
              )}
            </nav>
          </div>
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
    </>
  )
}
