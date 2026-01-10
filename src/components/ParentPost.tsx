import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistanceToNow } from 'date-fns'
import { useSession } from '../auth/SessionContext'
import { getPostThread } from '../api/feed'
import { getCachedParentPost, saveCachedParentPost } from '../curation/parentPostCache'
import { getPostUniqueId } from '../curation/skylimitGeneral'
import Avatar from './Avatar'
import PostMedia from './PostMedia'
import Spinner from './Spinner'

interface ParentPostProps {
  parentUri: string
  childPost: AppBskyFeedDefs.FeedViewPost // Child post to use for cache key
  onClick?: (uri: string) => void
}

export default function ParentPost({ parentUri, childPost, onClick }: ParentPostProps) {
  const navigate = useNavigate()
  const { agent } = useSession()
  const [parentPost, setParentPost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!agent || !parentUri || !childPost) return

    const fetchParent = async () => {
      try {
        // Get child post unique ID for cache key
        const childPostId = getPostUniqueId(childPost)
        
        // Check cache first
        const cachedParent = await getCachedParentPost(childPostId)
        if (cachedParent) {
          setParentPost(cachedParent)
          setIsLoading(false)
          return
        }
        
        // Not in cache, fetch from API
        // Use depth=0 to fetch only the single post (not a thread)
        // This is more efficient than depth=1 which fetches replies we don't need
        const threadData = await getPostThread(agent, parentUri, 0)
        if (threadData.thread && 'post' in threadData.thread) {
          const threadPost = threadData.thread as AppBskyFeedDefs.ThreadViewPost
          const fetchedParent = threadPost.post
          
          // Save to cache for future use
          await saveCachedParentPost(childPostId, fetchedParent)
          setParentPost(fetchedParent)
        }
      } catch (error) {
        console.error('Failed to fetch parent post:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchParent()
  }, [agent, parentUri, childPost])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-2">
        <Spinner size="sm" />
      </div>
    )
  }

  if (!parentPost) {
    return null
  }

  const record = parentPost.record as any
  const author = parentPost.author
  const embed = parentPost.embed

  const createdAt = record?.createdAt
    ? new Date(record.createdAt)
    : new Date()
  const timeAgo = formatDistanceToNow(createdAt, { addSuffix: true })

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (parentPost.uri) {
      const encodedUri = encodeURIComponent(parentPost.uri)
      if (onClick) {
        onClick(parentPost.uri)
      } else {
        navigate(`/post/${encodedUri}`)
      }
    }
  }

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(`/profile/${author.handle}`)
  }

  return (
    <div
      className="pb-3 border-b border-gray-200 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors rounded-t-lg px-2 pt-2"
      onClick={handleClick}
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

          {record?.text && (
            <div className="text-sm mb-1 whitespace-pre-wrap break-words line-clamp-3">
              {record.text}
            </div>
          )}

          {embed && (
            <div className="mb-1">
              <PostMedia embed={embed as any} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

