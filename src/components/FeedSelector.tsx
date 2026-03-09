import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getSavedFeeds } from '../api/feed'
import log from '../utils/logger'

export default function FeedSelector() {
  const { agent } = useSession()
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [feeds, setFeeds] = useState<AppBskyFeedDefs.GeneratorView[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const fetchFeeds = useCallback(async () => {
    if (!agent) return
    setIsLoading(true)
    setError(null)
    try {
      const savedFeeds = await getSavedFeeds(agent)
      setFeeds(savedFeeds)
    } catch (err) {
      log.warn('FeedSelector', 'Failed to fetch saved feeds:', err)
      setError('Failed to load feeds')
    } finally {
      setIsLoading(false)
    }
  }, [agent])

  const handleToggle = () => {
    if (!isOpen) {
      fetchFeeds()
    }
    setIsOpen(!isOpen)
  }

  const handleFeedClick = (feedUri: string) => {
    setIsOpen(false)
    navigate(`/feed/${encodeURIComponent(feedUri)}`)
  }

  // Click outside and escape to close
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  // Position the dropdown below the button, right-aligned
  const getMenuPosition = () => {
    if (!buttonRef.current) return { top: 0, right: 0 }
    const rect = buttonRef.current.getBoundingClientRect()
    return {
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400"
        aria-label="Feeds"
        title="Feeds"
      >
        <span className="text-xl font-bold">#</span>
      </button>

      {isOpen && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-2 min-w-[240px] max-w-[320px] max-h-[400px] overflow-y-auto"
          style={{
            top: `${getMenuPosition().top}px`,
            right: `${getMenuPosition().right}px`,
          }}
          role="menu"
        >
          <div className="px-4 py-2 text-sm font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            Feeds
          </div>

          {isLoading && (
            <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
              Loading feeds...
            </div>
          )}

          {error && (
            <div className="px-4 py-3 text-sm text-red-500 dark:text-red-400">
              {error}
            </div>
          )}

          {!isLoading && !error && feeds.length === 0 && (
            <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
              No pinned feeds found
            </div>
          )}

          {feeds.map((feed) => (
            <button
              key={feed.uri}
              className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-3"
              onClick={() => handleFeedClick(feed.uri)}
              role="menuitem"
            >
              {feed.avatar ? (
                <img
                  src={feed.avatar}
                  alt=""
                  className="w-8 h-8 rounded-md object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-md bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                  <span className="text-blue-600 dark:text-blue-400 text-sm font-bold">#</span>
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {feed.displayName}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  by @{feed.creator.handle}
                </div>
              </div>
            </button>
          ))}

          <div className="border-t border-gray-200 dark:border-gray-700 mt-1 pt-1">
            <a
              href="https://bsky.app/feeds"
              className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-3 text-sm text-blue-600 dark:text-blue-400"
              onClick={() => setIsOpen(false)}
              role="menuitem"
            >
              View on Bluesky ↗
            </a>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
