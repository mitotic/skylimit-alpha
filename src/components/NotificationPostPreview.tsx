/**
 * NotificationPostPreview Component
 *
 * Displays a simplified preview of a post for notifications
 * Shows only text content - no images, quoted posts, or actions
 */

import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistance } from 'date-fns'
import { clientDate } from '../utils/clientClock'
import { useNavigate } from 'react-router-dom'

interface NotificationPostPreviewProps {
  post: AppBskyFeedDefs.PostView
  onClick?: () => void
  size?: 'normal' | 'small'
}

export default function NotificationPostPreview({ post, onClick, size = 'normal' }: NotificationPostPreviewProps) {
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
  const timeAgo = formatDistance(postedAt, clientDate(), { addSuffix: true })

  // Truncate text to max 3 lines (approximately 200 characters)
  const text = record?.text || ''
  const maxLength = 200
  const truncatedText = text.length > maxLength
    ? text.substring(0, maxLength) + '...'
    : text

  const isSmall = size === 'small'

  return (
    <div
      onClick={handleClick}
      className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors rounded-lg border border-gray-200 dark:border-gray-700 ${isSmall ? 'p-2' : 'p-3'}`}
    >
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span
            onClick={handleAuthorClick}
            className={`font-semibold hover:underline cursor-pointer ${isSmall ? 'text-xs' : 'text-sm'}`}
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
          <div
            className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words line-clamp-3"
            style={{
              fontSize: isSmall ? 'var(--post-secondary-text-size)' : 'var(--post-text-size)',
              lineHeight: 'var(--post-text-leading)'
            }}
          >
            {truncatedText}
          </div>
        )}
      </div>
    </div>
  )
}
