import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistanceToNow } from 'date-fns'
import { useSession } from '../auth/SessionContext'
import { getPostThread } from '../api/feed'
import { getCachedRootPost, saveCachedRootPost } from '../curation/parentPostCache'
import Avatar from './Avatar'
import Spinner from './Spinner'

interface RootPostProps {
  rootUri: string
  isDirectReply: boolean // true if reply is direct child of root, false if nested
  onClick?: (uri: string) => void
}

export default function RootPost({ rootUri, isDirectReply, onClick }: RootPostProps) {
  const navigate = useNavigate()
  const { agent } = useSession()
  const [rootPost, setRootPost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!agent || !rootUri) return

    const fetchRoot = async () => {
      try {
        // Check cache first using rootUri as key
        const cachedRoot = await getCachedRootPost(rootUri)
        if (cachedRoot) {
          setRootPost(cachedRoot)
          setIsLoading(false)
          return
        }

        // Not in cache, fetch from API
        // Use depth=0 to fetch only the single post (not a thread)
        const threadData = await getPostThread(agent, rootUri, 0)
        if (threadData.thread && 'post' in threadData.thread) {
          const threadPost = threadData.thread as AppBskyFeedDefs.ThreadViewPost
          const fetchedRoot = threadPost.post

          // Save to cache for future use
          await saveCachedRootPost(rootUri, fetchedRoot)
          setRootPost(fetchedRoot)
        }
      } catch (error) {
        // Silently handle "Post not found" errors (deleted posts are expected)
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (!errorMessage.includes('Post not found')) {
          console.warn('Failed to fetch root post:', error)
        }
      } finally {
        setIsLoading(false)
      }
    }

    fetchRoot()
  }, [agent, rootUri])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-2">
        <Spinner size="sm" />
      </div>
    )
  }

  if (!rootPost) {
    return null
  }

  const record = rootPost.record as any
  const author = rootPost.author

  const createdAt = record?.createdAt
    ? new Date(record.createdAt)
    : new Date()
  const timeAgo = formatDistanceToNow(createdAt, { addSuffix: true })

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (rootPost.uri) {
      const encodedUri = encodeURIComponent(rootPost.uri)
      if (onClick) {
        onClick(rootPost.uri)
      } else {
        navigate(`/post/${encodedUri}`)
      }
    }
  }

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(`/profile/${author.handle}`)
  }

  // Line style: solid for direct reply, dashed for nested reply
  const lineStyle = isDirectReply
    ? 'bg-gray-300 dark:bg-gray-600' // solid
    : 'border-l-2 border-dashed border-gray-300 dark:border-gray-600' // dashed

  return (
    <div
      className="px-4 pt-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors opacity-50"
      onClick={handleClick}
    >
      {/* Flex container matching PostCard's gap-3 structure */}
      <div className="flex gap-3">
        {/* Left column: avatar with vertical line extending below */}
        <div className="flex-shrink-0 flex flex-col items-center">
          <div onClick={handleAuthorClick} className="cursor-pointer">
            <Avatar
              src={author.avatar}
              alt={author.displayName || author.handle}
              size="md"
            />
          </div>
          {/* Vertical line extending from avatar to bottom - no gap */}
          <div className={`w-0.5 flex-1 min-h-[8px] ${lineStyle}`}></div>
        </div>

        {/* Right column: author info and text */}
        <div className="flex-1 min-w-0 pb-6">
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
