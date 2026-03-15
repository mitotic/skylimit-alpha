/**
 * AggregatedNotification Component
 * 
 * Displays a notification that may be aggregated (multiple likes/reposts)
 * or a single notification (reply, mention, follow, etc.)
 */

import { useNavigate } from 'react-router-dom'
import { formatDistance } from 'date-fns'
import { clientDate } from '../utils/clientClock'
import { AggregatedNotification, formatAggregatedText } from '../utils/notificationAggregation'
import Avatar from './Avatar'
import NotificationPostPreview from './NotificationPostPreview'
import PostCard from './PostCard'
import Button from './Button'
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSession } from '../auth/SessionContext'
import { checkFollowStatus, follow } from '../api/social'
import ToastContainer, { ToastMessage } from './ToastContainer'
import log from '../utils/logger'

interface AggregatedNotificationProps {
  notification: AggregatedNotification
  onPostClick?: (uri: string) => void
}

export default function AggregatedNotificationComponent({ 
  notification, 
  onPostClick 
}: AggregatedNotificationProps) {
  const navigate = useNavigate()
  const { agent, session } = useSession()
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null)
  const [isFollowingLoading, setIsFollowingLoading] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })
  
  const isRead = notification.isRead
  const reason = notification.reason
  
  // Handle both string and object types for reason
  // The reason should already be normalized to 'like' or 'repost' from aggregation
  // but we need to handle it for display purposes
  let reasonStr: string = ''
  if (typeof reason === 'string') {
    reasonStr = reason
  } else if (reason && typeof reason === 'object') {
    reasonStr = (reason as any).$type || String(reason)
  } else {
    reasonStr = String(reason || '')
  }
  
  let normalizedReason = reasonStr.toLowerCase().trim()
  
  // Normalize compound reasons for switch statement matching
  if (normalizedReason === 'like-via-repost' || normalizedReason.includes('like-via-repost')) {
    normalizedReason = 'like'
  } else if (normalizedReason === 'repost-via-repost' || normalizedReason.includes('repost-via-repost')) {
    normalizedReason = 'repost'
  }
  
  const authors = notification.authors
  const mostRecent = notification.mostRecent
  
  // Check follow status for follow notifications
  useEffect(() => {
    if (normalizedReason === 'follow' && agent && session) {
      checkFollowStatus(agent, mostRecent.author.did)
        .then(followUri => {
          setIsFollowing(!!followUri)
        })
        .catch(error => {
          log.warn('Notifications', 'Failed to check follow status:', error)
          setIsFollowing(null)
        })
    }
  }, [reason, mostRecent.author.did, agent, session])

  useEffect(() => {
    if (!showUserMenu) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowUserMenu(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [showUserMenu])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }
  
  const handleFollowBack = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!agent || isFollowingLoading || isFollowing) return
    
    setIsFollowingLoading(true)
    try {
      await follow(agent, mostRecent.author.did)
      setIsFollowing(true)
      addToast('Now following', 'success')
    } catch (error) {
      log.error('Notifications', 'Failed to follow:', error)
      addToast(error instanceof Error ? error.message : 'Failed to follow user', 'error')
    } finally {
      setIsFollowingLoading(false)
    }
  }
  
  const handleClick = () => {
    if (normalizedReason === 'follow') {
      navigate(`/profile/${mostRecent.author.handle}`)
    } else {
      // Use post.uri if available (resolved), fallback to reasonSubject
      const targetUri = notification.post?.uri || notification.reasonSubject || mostRecent.uri
      if (targetUri) {
        if (onPostClick) {
          onPostClick(targetUri)
        } else {
          const encodedUri = encodeURIComponent(targetUri)
          navigate(`/post/${encodedUri}`)
        }
      }
    }
  }
  
  const handleAuthorClick = (authorDid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const author = authors.find(a => a.did === authorDid) || authors[0]
    if (author) {
      navigate(`/profile/${author.handle}`)
    }
  }
  
  const getNotificationIcon = (reason: string): JSX.Element => {
    const normalizedReason = String(reason || '').toLowerCase()
    const svgProps = { className: 'w-5 h-5', viewBox: '0 0 24 24', fill: 'none' as const, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
    switch (normalizedReason) {
      case 'like':
        return (
          <span className="text-red-500">
            <svg {...svgProps} fill="currentColor">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </span>
        )
      case 'repost':
        return (
          <span className="text-green-500">
            <svg {...svgProps}>
              <path d="M17 1l4 4-4 4" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <path d="M7 23l-4-4 4-4" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
          </span>
        )
      case 'reply':
        return (
          <span className="text-blue-500">
            <svg {...svgProps}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
        )
      case 'quote':
        return (
          <span className="text-blue-500">
            <svg {...svgProps}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
        )
      case 'mention':
        return (
          <span className="text-purple-500">
            <svg {...svgProps}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <text x="12" y="14" textAnchor="middle" fontSize="10" fontWeight="bold" fill="currentColor" stroke="none">@</text>
            </svg>
          </span>
        )
      case 'follow':
        return (
          <span className="text-blue-500">
            <svg {...svgProps}>
              <circle cx="12" cy="8" r="4" />
              <path d="M20 21c0-4.418-3.582-8-8-8s-8 3.582-8 8" />
            </svg>
          </span>
        )
      default:
        return (
          <span className="text-gray-400">
            <svg {...svgProps}>
              <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
          </span>
        )
    }
  }
  
  const notificationText = formatAggregatedText(authors, normalizedReason, notification.count, notification.isRepost)
  const timeAgo = formatDistance(new Date(mostRecent.indexedAt), clientDate(), { addSuffix: true })
  
  // Show up to 4 avatars
  const displayAvatars = authors.slice(0, 4)
  const remainingCount = authors.length > 4 ? authors.length - 4 : 0
  
  return (
    <div
      className={`border-b border-gray-200 dark:border-gray-700 ${
        !isRead ? 'bg-blue-50 dark:bg-blue-900/20' : ''
      }`}
    >
      <div
        onClick={handleClick}
        className="px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-start gap-3">
          {/* Avatar group with optional chevron */}
          <div className="flex-shrink-0 flex items-center">
            <div className="flex -space-x-2">
              {displayAvatars.map((author, index) => (
                <div
                  key={author.did}
                  onClick={(e) => handleAuthorClick(author.did, e)}
                  className="cursor-pointer"
                  style={{ zIndex: displayAvatars.length - index }}
                >
                  <Avatar
                    src={author.avatar}
                    alt={author.displayName || author.handle}
                    size="sm"
                  />
                </div>
              ))}
              {remainingCount > 0 && (
                <div className="w-8 h-8 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center text-xs font-semibold text-gray-700 dark:text-gray-300 border-2 border-white dark:border-gray-900">
                  +{remainingCount}
                </div>
              )}
            </div>
            {authors.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenuPosition({ x: rect.left, y: rect.bottom + 4 })
                  setShowUserMenu(prev => !prev)
                }}
                className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors ml-1 px-0.5"
                aria-label="Show all users"
              >
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              </button>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {getNotificationIcon(reason)}
              <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                {notificationText}
              </span>
              <span className="text-gray-400 dark:text-gray-500 text-xs ml-auto">
                {timeAgo}
              </span>
            </div>
            
            {/* Follow back button */}
            {normalizedReason === 'follow' && isFollowing === false && (
              <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                <Button
                  onClick={handleFollowBack}
                  disabled={isFollowingLoading}
                  className="text-sm px-4 py-1.5"
                >
                  {isFollowingLoading ? 'Following...' : '+ Follow back'}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Post preview for likes/reposts */}
      {notification.post && (normalizedReason === 'like' || normalizedReason === 'repost') && (
        <div onClick={(e) => e.stopPropagation()} className="px-4 pb-3">
          <NotificationPostPreview
            post={notification.post}
            onClick={() => {
              // Use post.uri (resolved) instead of reasonSubject (may be repost URI)
              const targetUri = notification.post?.uri || notification.reasonSubject
              if (targetUri) {
                if (onPostClick) {
                  onPostClick(targetUri)
                } else {
                  const encodedUri = encodeURIComponent(targetUri)
                  navigate(`/post/${encodedUri}`)
                }
              }
            }}
          />
        </div>
      )}

      {/* Full post card for replies/mentions/quotes */}
      {notification.post && (normalizedReason === 'reply' || normalizedReason === 'mention' || normalizedReason === 'quote') && (
        <div onClick={(e) => e.stopPropagation()} className="px-4 pb-3">
          <PostCard
            post={{
              post: notification.post,
              reason: {
                $type: `app.bsky.feed.defs#reason${reason.charAt(0).toUpperCase() + reason.slice(1)}`,
                by: mostRecent.author,
              } as any,
            }}
            showRootPost={false}
            hideAvatar={true}
          />
        </div>
      )}
      
      {showUserMenu && createPortal(
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => { e.stopPropagation(); setShowUserMenu(false) }}
          />
          <div
            className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[200px] max-w-[280px] max-h-60 overflow-y-auto"
            style={{
              left: `${Math.max(8, Math.min(menuPosition.x, window.innerWidth - 288))}px`,
              top: `${menuPosition.y}px`,
            }}
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
            {authors.map(author => (
              <button
                key={author.did}
                className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowUserMenu(false)
                  navigate(`/profile/${author.handle}`)
                }}
                role="menuitem"
              >
                <Avatar src={author.avatar} alt={author.displayName || author.handle} size="xs" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {author.displayName || author.handle}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    @{author.handle}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}

