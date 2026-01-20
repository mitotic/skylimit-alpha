import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyEmbedRecord, AppBskyFeedDefs } from '@atproto/api'
import { formatDistanceToNow } from 'date-fns'
import { useSession } from '../auth/SessionContext'
import { getPostThread } from '../api/feed'
import Avatar from './Avatar'
import PostMedia from './PostMedia'
import Spinner from './Spinner'
import { getBlueSkyPostUrl, getBlueSkyProfileUrl } from '../curation/skylimitGeneral'

// Request deduplication: track in-flight requests to avoid duplicate calls for the same post
const inFlightRequests = new Map<string, Promise<AppBskyFeedDefs.PostView | null>>()
const requestCache = new Map<string, AppBskyFeedDefs.PostView>()

interface QuotedPostProps {
  record: AppBskyEmbedRecord.View
  onClick?: (uri: string) => void
  maxDepth?: number
  depth?: number
}

export default function QuotedPost({ record, onClick, maxDepth = 1, depth = 0 }: QuotedPostProps) {
  const navigate = useNavigate()
  const { agent } = useSession()
  const [fullPost, setFullPost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [isLoadingFullPost, setIsLoadingFullPost] = useState(false)
  const [clickToBlueSky, setClickToBlueSky] = useState(() =>
    localStorage.getItem('websky_click_to_bluesky') === 'true'
  )

  // Parse the record safely - do this before any early returns
  const recordAny = record.record && typeof record.record === 'object' ? record.record as any : null
  const isValidPost = recordAny && !recordAny.blocked && !recordAny.notFound && recordAny.author && recordAny.uri
  const post = isValidPost && (AppBskyFeedDefs.isPostView(recordAny) || (recordAny.author && recordAny.uri && typeof recordAny === 'object'))
    ? recordAny as AppBskyFeedDefs.PostView
    : null

  // Fetch full post if needed
  const postUri = post?.uri
  const hasFetchedRef = useRef(false)
  
  useEffect(() => {
    if (!post || !postUri || !agent || hasFetchedRef.current) return
    
    const postRecord = post.record as any
    const embed = post.embed
    
    // Extract text from the record - try multiple ways to access it
    let postText = postRecord?.text
    if (!postText && postRecord && typeof postRecord === 'object') {
      if ('$type' in postRecord && postRecord.$type === 'app.bsky.feed.post') {
        postText = (postRecord as any).text
      }
      if (!postText && 'value' in postRecord) {
        postText = (postRecord as any).value?.text
      }
    }
    
    // Only fetch if we have NEITHER text NOR embed (meaning we have no content to display)
    // AND we have a URI (meaning we should have data but don't)
    // This avoids fetching for text-only posts (which don't need embed) or media-only posts (which might not have text)
    const hasContent = postText || embed
    const needsFetch = !hasContent && !fullPost && !isLoadingFullPost
    
    if (needsFetch) {
      hasFetchedRef.current = true
      setIsLoadingFullPost(true)
      
      const fetchFullPost = async () => {
        try {
          // Check cache first
          const cached = requestCache.get(postUri)
          if (cached) {
            setFullPost(cached)
            setIsLoadingFullPost(false)
            return
          }
          
          // Check if there's already an in-flight request for this URI
          let requestPromise = inFlightRequests.get(postUri)
          
          if (!requestPromise) {
            // Create new request
            requestPromise = (async () => {
              try {
                const threadData = await getPostThread(agent, postUri, 0) // depth 0: only fetch the single post, not a thread
                if (threadData.thread && 'post' in threadData.thread) {
                  const threadPost = threadData.thread as AppBskyFeedDefs.ThreadViewPost
                  const fetchedPost = threadPost.post
                  // Cache the result
                  requestCache.set(postUri, fetchedPost)
                  // Clean up cache after 5 minutes to prevent memory leaks
                  setTimeout(() => {
                    requestCache.delete(postUri)
                  }, 5 * 60 * 1000)
                  return fetchedPost
                }
                return null
              } catch (error) {
                console.error('Failed to fetch full quoted post:', error)
                return null
              } finally {
                // Remove from in-flight requests
                inFlightRequests.delete(postUri)
              }
            })()
            
            inFlightRequests.set(postUri, requestPromise)
          }
          
          // Wait for the request (either new or existing)
          const fetchedPost = await requestPromise
          if (fetchedPost) {
            setFullPost(fetchedPost)
          }
        } catch (error) {
          console.error('Failed to fetch full quoted post:', error)
        } finally {
          setIsLoadingFullPost(false)
        }
      }
      
      fetchFullPost()
    }
  }, [postUri, agent, fullPost, isLoadingFullPost, post])

  // Reload click to Bluesky setting when component mounts (in case it changed)
  useEffect(() => {
    setClickToBlueSky(localStorage.getItem('websky_click_to_bluesky') === 'true')
  }, [])

  if (!record.record || typeof record.record !== 'object') {
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800">
        <p className="text-sm text-gray-500 dark:text-gray-400">Quoted post unavailable</p>
      </div>
    )
  }

  if (recordAny?.blocked || recordAny?.notFound) {
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {recordAny?.blocked ? 'Blocked post' : 'Post not found'}
        </p>
      </div>
    )
  }

  if (!post) {
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800">
        <p className="text-sm text-gray-500 dark:text-gray-400">Invalid post data</p>
      </div>
    )
  }

  // Use fullPost if available, otherwise use the original post
  const displayPost = fullPost || post
  const displayRecord = fullPost?.record || post.record as any
  const author = displayPost.author
  const embed = displayPost.embed

  // Extract text from the record - try multiple ways to access it
  let postText = displayRecord?.text
  if (!postText && displayRecord && typeof displayRecord === 'object') {
    if ('$type' in displayRecord && displayRecord.$type === 'app.bsky.feed.post') {
      postText = (displayRecord as any).text
    }
    if (!postText && 'value' in displayRecord) {
      postText = (displayRecord as any).value?.text
    }
  }

  const createdAtValue = displayRecord?.createdAt
  const createdAt = createdAtValue ? new Date(createdAtValue) : new Date()
  const timeAgo = formatDistanceToNow(createdAt, { addSuffix: true })

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (displayPost.uri) {
      if (clickToBlueSky) {
        // Open in Bluesky client (same tab)
        window.location.href = getBlueSkyPostUrl(displayPost.uri, author.handle)
      } else {
        const encodedUri = encodeURIComponent(displayPost.uri)
        if (onClick) {
          onClick(displayPost.uri)
        } else {
          navigate(`/post/${encodedUri}`)
        }
      }
    }
  }

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (clickToBlueSky) {
      window.location.href = getBlueSkyProfileUrl(author.handle)
    } else {
      navigate(`/profile/${author.handle}`)
    }
  }

  return (
    <div
      className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      onClick={handleClick}
    >
      <div className="flex items-center gap-2 mb-2">
        <div onClick={handleAuthorClick} className="flex-shrink-0 cursor-pointer">
          <Avatar
            src={author.avatar}
            alt={author.displayName || author.handle}
            size="sm"
          />
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-1 min-w-0 overflow-hidden">
          <span
            onClick={handleAuthorClick}
            className="font-semibold text-sm hover:underline cursor-pointer truncate max-w-[35%] sm:max-w-none"
          >
            {author.displayName || author.handle}
          </span>
          <span
            onClick={handleAuthorClick}
            className="text-gray-500 dark:text-gray-400 text-sm hover:underline cursor-pointer truncate max-w-[25%] sm:max-w-none hidden sm:inline"
          >
            @{author.handle}
          </span>
          <span className="text-gray-500 dark:text-gray-400 text-sm flex-shrink-0">·</span>
          <span className="text-gray-500 dark:text-gray-400 text-xs flex-shrink-0">{timeAgo}</span>
        </div>
      </div>

      {isLoadingFullPost ? (
        <div className="flex items-center justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : (
        <>
          {postText ? (
            <div className="text-sm mb-2 whitespace-pre-wrap break-words">
              {postText}
            </div>
          ) : (
            // Only show placeholder if we have neither text nor media
            !embed && !isLoadingFullPost && (
              <div className="text-sm mb-2 text-gray-500 dark:text-gray-400 italic">
                Quoted post content unavailable
              </div>
            )
          )}

          {embed && (
            <div className="mb-2">
              <PostMedia embed={embed as any} maxDepth={maxDepth} depth={depth + 1} />
            </div>
          )}

          {(displayPost.replyCount || displayPost.repostCount || displayPost.likeCount) && (
            <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400 mt-2">
              {displayPost.replyCount ? (
                <span>{displayPost.replyCount} {displayPost.replyCount === 1 ? 'reply' : 'replies'}</span>
              ) : null}
              {displayPost.repostCount ? (
                <span>{displayPost.repostCount} {displayPost.repostCount === 1 ? 'repost' : 'reposts'}</span>
              ) : null}
              {displayPost.likeCount ? (
                <span>{displayPost.likeCount} {displayPost.likeCount === 1 ? 'like' : 'likes'}</span>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  )
}

