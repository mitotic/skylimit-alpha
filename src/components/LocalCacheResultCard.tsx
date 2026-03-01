import { formatDistance } from 'date-fns'
import { clientDate } from '../utils/clientClock'
import { PostSummary, isStatusShow, isEditionPostStatus } from '../curation/types'

interface LocalCacheResultCardProps {
  post: PostSummary
  displayName?: string
  onClick: () => void
}

export default function LocalCacheResultCard({ post, displayName, onClick }: LocalCacheResultCardProps) {
  const timeAgo = formatDistance(post.timestamp, clientDate(), { addSuffix: true })
  const text = post.postText || ''
  const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text
  const isShown = isStatusShow(post.curation_status) || isEditionPostStatus(post.curation_status)
  const isRepost = !!post.repostUri

  return (
    <div
      className="py-3 px-4 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors border-b border-gray-200 dark:border-gray-700"
      onClick={onClick}
    >
      {/* Row 1: Author info + time */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
          {displayName || post.username}
        </span>
        {displayName && (
          <span className="text-gray-500 dark:text-gray-400 text-xs">
            @{post.username}
          </span>
        )}
        <span className="text-gray-400 dark:text-gray-500 text-xs">·</span>
        <span className="text-gray-500 dark:text-gray-400 text-xs">{timeAgo}</span>
        {isRepost && (
          <>
            <span className="text-gray-400 dark:text-gray-500 text-xs">·</span>
            <span className="text-green-600 dark:text-green-400 text-xs">
              ↻ {post.orig_username ? `repost of @${post.orig_username}` : 'repost'}
            </span>
          </>
        )}
      </div>

      {/* Row 2: Post text */}
      {truncated && (
        <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-3 mt-1">
          {truncated}
        </p>
      )}

      {/* Quoted text */}
      {post.quotedText && (
        <div className="mt-1 pl-3 border-l-2 border-gray-300 dark:border-gray-600">
          <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
            {post.quotedText.length > 120 ? post.quotedText.slice(0, 120) + '...' : post.quotedText}
          </p>
        </div>
      )}

      {/* Row 3: Status + tags */}
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        {!isShown && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
            dropped
          </span>
        )}
        {post.curation_status && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {post.curation_status.replace(/_/g, ' ')}
          </span>
        )}
        {post.tags.length > 0 && post.tags.slice(0, 5).map((tag) => (
          <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
            #{tag}
          </span>
        ))}
      </div>
    </div>
  )
}
