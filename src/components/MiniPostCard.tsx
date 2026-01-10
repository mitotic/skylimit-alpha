import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistanceToNow } from 'date-fns'
import Avatar from './Avatar'

interface MiniPostCardProps {
  post: AppBskyFeedDefs.PostView
  onClick?: () => void
}

export default function MiniPostCard({ post, onClick }: MiniPostCardProps) {
  const record = post.record as { text?: string; createdAt?: string }
  const text = record?.text || ''
  const truncated = text.length > 120 ? text.slice(0, 120) + '...' : text

  const createdAt = record?.createdAt
    ? new Date(record.createdAt)
    : new Date()
  const timeAgo = formatDistanceToNow(createdAt, { addSuffix: true })

  return (
    <div
      className="flex items-start gap-2 py-2 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/50 rounded transition-colors"
      onClick={onClick}
    >
      <Avatar
        src={post.author.avatar}
        alt={post.author.displayName || post.author.handle}
        size="sm"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="font-medium text-sm text-gray-900 dark:text-gray-100">
            {post.author.displayName || post.author.handle}
          </span>
          <span className="text-gray-500 dark:text-gray-400 text-xs">
            @{post.author.handle}
          </span>
          <span className="text-gray-400 dark:text-gray-500 text-xs">·</span>
          <span className="text-gray-500 dark:text-gray-400 text-xs">{timeAgo}</span>
        </div>
        <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2 mt-0.5">
          {truncated}
        </p>
      </div>
    </div>
  )
}
