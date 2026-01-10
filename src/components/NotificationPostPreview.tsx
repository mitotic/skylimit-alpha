/**
 * NotificationPostPreview Component
 * 
 * Displays a simplified preview of a post for notifications
 * Shows only text content - no images, quoted posts, or actions
 */

import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistanceToNow } from 'date-fns'
import { useNavigate } from 'react-router-dom'
import Avatar from './Avatar'

interface NotificationPostPreviewProps {
  post: AppBskyFeedDefs.PostView
  onClick?: () => void
}

export default function NotificationPostPreview({ post, onClick }: NotificationPostPreviewProps) {
  const navigate = useNavigate()
  const record = post.record as any
  const author = post.author
  
  const handleClick = () => {
    if (onClick) {
      onClick()
    } else {
      const encodedUri = encodeURIComponent(post.uri)
      navigate(`/post/${encodedUri}`)
    }
  }
  
  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(`/profile/${author.handle}`)
  }
  
  const postedAt = new Date(record?.createdAt || post.indexedAt)
  const timeAgo = formatDistanceToNow(postedAt, { addSuffix: true })
  
  // Truncate text to max 3 lines (approximately 200 characters)
  const text = record?.text || ''
  const maxLength = 200
  const truncatedText = text.length > maxLength 
    ? text.substring(0, maxLength) + '...'
    : text
  
  return (
    <div
      onClick={handleClick}
      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors rounded-lg p-3 mt-2 border border-gray-200 dark:border-gray-700"
    >
      <div className="flex gap-2">
        <div onClick={handleAuthorClick} className="flex-shrink-0 cursor-pointer">
          <Avatar
            src={author.avatar}
            alt={author.displayName || author.handle}
            size="sm"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              onClick={handleAuthorClick}
              className="font-semibold text-sm hover:underline cursor-pointer"
            >
              {author.displayName || author.handle}
            </span>
            <span
              onClick={handleAuthorClick}
              className="text-gray-500 dark:text-gray-400 text-xs hover:underline cursor-pointer"
            >
              @{author.handle}
            </span>
            <span className="text-gray-500 dark:text-gray-400 text-xs">·</span>
            <span className="text-gray-500 dark:text-gray-400 text-xs">{timeAgo}</span>
          </div>
          
          {truncatedText && (
            <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words line-clamp-3">
              {truncatedText}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

