import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistanceToNow } from 'date-fns'
import Avatar from './Avatar'
import Spinner from './Spinner'

interface ParentChainViewProps {
  parents: AppBskyFeedDefs.PostView[]
  rootUri: string | null
  isLoading: boolean
}

// Single parent post with avatar and connecting line
function ParentPost({
  post,
  onClick,
  showLine = true
}: {
  post: AppBskyFeedDefs.PostView
  onClick: () => void
  showLine?: boolean
}) {
  const navigate = useNavigate()
  const record = post.record as any
  const author = post.author

  const createdAt = record?.createdAt
    ? new Date(record.createdAt)
    : new Date()
  const timeAgo = formatDistanceToNow(createdAt, { addSuffix: true })

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(`/profile/${author.handle}`)
  }

  return (
    <div
      className="px-4 pt-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors"
      onClick={onClick}
    >
      <div className="flex gap-3">
        {/* Left column: avatar with vertical line below */}
        <div className="flex-shrink-0 flex flex-col items-center">
          <div onClick={handleAuthorClick} className="cursor-pointer">
            <Avatar
              src={author.avatar}
              alt={author.displayName || author.handle}
              size="md"
            />
          </div>
          {/* Vertical line connecting to next post */}
          {showLine && (
            <div className="w-0.5 flex-1 mt-1 min-h-[8px] bg-gray-300 dark:bg-gray-600"></div>
          )}
        </div>

        {/* Right column: author info and text */}
        <div className="flex-1 min-w-0 pb-3">
          <div className="flex items-center gap-2 mb-1">
            <span
              onClick={handleAuthorClick}
              className="font-semibold hover:underline cursor-pointer"
            >
              {author.displayName || author.handle}
            </span>
            <span
              onClick={handleAuthorClick}
              className="text-gray-500 dark:text-gray-400 hover:underline cursor-pointer"
            >
              @{author.handle}
            </span>
            <span className="text-gray-500 dark:text-gray-400">·</span>
            <span className="text-gray-500 dark:text-gray-400 text-sm">{timeAgo}</span>
          </div>

          {record?.text && (
            <div className="whitespace-pre-wrap break-words">
              {record.text}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Zigzag break symbol component
function ZigzagBreak({ onClick, count }: { onClick: () => void; count: number }) {
  return (
    <div className="px-4 py-2">
      <div className="flex gap-3">
        {/* Line column - zigzag in the middle */}
        <div className="flex-shrink-0 w-10 flex flex-col items-center">
          <div className="w-0.5 h-2 bg-gray-300 dark:bg-gray-600"></div>
          <button
            onClick={onClick}
            className="my-1 text-gray-400 hover:text-blue-500 dark:text-gray-500 dark:hover:text-blue-400 transition-colors"
            title={`Show ${count} more posts`}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 3 L6 7 L10 11 L14 7 Z M10 9 L6 13 L10 17 L14 13 Z" />
            </svg>
          </button>
          <div className="w-0.5 h-2 bg-gray-300 dark:bg-gray-600"></div>
        </div>
        {/* Text label */}
        <div className="flex-1 flex items-center">
          <button
            onClick={onClick}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:underline transition-colors"
          >
            {count} more {count === 1 ? 'post' : 'posts'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ParentChainView({ parents, rootUri: _rootUri, isLoading }: ParentChainViewProps) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)

  if (isLoading) {
    return (
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm">
          <Spinner size="sm" />
          <span>Loading context...</span>
        </div>
      </div>
    )
  }

  if (parents.length === 0) return null

  const handlePostClick = (uri: string) => {
    const encodedUri = encodeURIComponent(uri)
    navigate(`/post/${encodedUri}`)
  }

  // Parents array is ordered from root to immediate parent
  // parents[0] = root (or closest to root we have)
  // parents[parents.length - 1] = immediate parent

  const rootPost = parents[0]
  const immediateParent = parents[parents.length - 1]
  const middlePosts = parents.slice(1, -1)
  const hasMiddlePosts = middlePosts.length > 0

  // Collapsed view: root → zigzag → immediate parent (when > 2 parents)
  if (!expanded && parents.length > 2) {
    return (
      <div className="border-b border-gray-200 dark:border-gray-700">
        {/* Root post */}
        <ParentPost
          post={rootPost}
          onClick={() => handlePostClick(rootPost.uri)}
          showLine={true}
        />

        {/* Zigzag break */}
        <ZigzagBreak
          onClick={() => setExpanded(true)}
          count={middlePosts.length}
        />

        {/* Immediate parent */}
        <ParentPost
          post={immediateParent}
          onClick={() => handlePostClick(immediateParent.uri)}
          showLine={true}
        />
      </div>
    )
  }

  // Expanded view or <= 2 parents: show all
  return (
    <div className="border-b border-gray-200 dark:border-gray-700">
      {parents.map((parent, _index) => (
        <ParentPost
          key={parent.uri}
          post={parent}
          onClick={() => handlePostClick(parent.uri)}
          showLine={true} // Always show line as it connects to anchor post below
        />
      ))}

      {/* Collapse button if we expanded */}
      {expanded && hasMiddlePosts && (
        <div className="px-4 pb-2">
          <button
            onClick={() => setExpanded(false)}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-blue-500 hover:underline"
          >
            ↑ Collapse
          </button>
        </div>
      )}
    </div>
  )
}
