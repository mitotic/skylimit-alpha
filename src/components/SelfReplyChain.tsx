import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistance } from 'date-fns'
import { clientDate } from '../utils/clientClock'
import Avatar from './Avatar'
import RichText from './RichText'
import PostMedia from './PostMedia'
import Spinner from './Spinner'

const CHAIN_PAGE_SIZE = 10

interface SelfReplyChainProps {
  firstPost: AppBskyFeedDefs.PostView   // the first same-author reply
  chainPosts: AppBskyFeedDefs.PostView[] // continuation posts (after first reply)
  isLoading: boolean
  mayHaveMore?: boolean                  // true if more posts might be fetchable from the server
  onLoadMore?: () => void                // callback to fetch more chain posts from the server
}

// Compact post without avatar/username — used for all posts in the chain
function CompactChainPost({
  post,
  onClick,
  showLine = true,
}: {
  post: AppBskyFeedDefs.PostView
  onClick: () => void
  showLine?: boolean
}) {
  const record = post.record as any

  const createdAt = record?.createdAt
    ? new Date(record.createdAt)
    : clientDate()
  const timeAgo = formatDistance(createdAt, clientDate(), { addSuffix: true })

  return (
    <div
      className="cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-colors"
      onClick={onClick}
    >
      <div className="flex">
        {/* Left column: vertical connecting line */}
        <div className="flex-shrink-0 w-[52px] flex justify-center">
          {showLine && (
            <div className="w-0.5 h-full bg-gray-300 dark:bg-gray-600"></div>
          )}
        </div>

        {/* Right column: content */}
        <div className="flex-1 min-w-0 py-2 pr-4">
          {record?.text && (
            <div className="whitespace-pre-wrap break-words">
              <RichText text={record.text} facets={record.facets} />
            </div>
          )}

          {post.embed && (
            <div className="mt-2">
              <PostMedia embed={post.embed as any} />
            </div>
          )}

          {/* Stats row: reply, repost, like, bookmark, share + timestamp */}
          <div className="mt-1 flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {(post.replyCount || 0) > 0 && <span>{post.replyCount}</span>}
            </span>
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 1l4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="M7 23l-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              {(post.repostCount || 0) > 0 && <span>{post.repostCount}</span>}
            </span>
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
              {(post.likeCount || 0) > 0 && <span>{post.likeCount}</span>}
            </span>
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <span className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </span>
            <span>· {timeAgo}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// Plus-in-circle icon
function PlusCircleIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v8M6 10h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Minus-in-circle icon
function MinusCircleIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 10h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export default function SelfReplyChain({ firstPost, chainPosts, isLoading, mayHaveMore, onLoadMore }: SelfReplyChainProps) {
  const navigate = useNavigate()
  const [displayCount, setDisplayCount] = useState(0) // 0 = collapsed (only first post shown)

  const author = firstPost.author

  const handlePostClick = (uri: string) => {
    const encodedUri = encodeURIComponent(uri)
    navigate(`/post/${encodedUri}`)
  }

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(`/profile/${author.handle}`)
  }

  if (isLoading) {
    return (
      <div className="px-4 pt-3">
        {/* Avatar header */}
        <div className="flex gap-3 items-center mb-2">
          <div className="flex-shrink-0" onClick={handleAuthorClick} style={{ cursor: 'pointer' }}>
            <Avatar src={author.avatar} alt={author.displayName || author.handle} size="md" />
          </div>
          <div className="flex items-center gap-2">
            <span onClick={handleAuthorClick} className="font-semibold hover:underline cursor-pointer">
              {author.displayName || author.handle}
            </span>
            <span onClick={handleAuthorClick} className="text-gray-500 dark:text-gray-400 hover:underline cursor-pointer">
              @{author.handle}
            </span>
          </div>
        </div>
        {/* Loading indicator with line */}
        <div className="flex items-center gap-2 pb-3">
          <div className="flex-shrink-0 w-[52px] flex justify-center">
            <Spinner size="sm" />
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading thread...</span>
        </div>
      </div>
    )
  }

  const visibleContinuation = chainPosts.slice(0, displayCount)
  const remainingCount = chainPosts.length - Math.min(displayCount, chainPosts.length)
  // All posts shown when: we've displayed everything AND there are no more to fetch
  const allPostsShown = remainingCount <= 0 && displayCount > 0 && !mayHaveMore

  // All posts that are currently visible (first + continuation)
  const allVisible = [firstPost, ...visibleContinuation]

  const handleShowMore = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (remainingCount > 0) {
      // Still have locally fetched posts to reveal
      setDisplayCount(prev => prev + CHAIN_PAGE_SIZE)
    } else if (mayHaveMore && onLoadMore) {
      // Need to fetch more from the server, then reveal them
      setDisplayCount(prev => prev + CHAIN_PAGE_SIZE)
      onLoadMore()
    }
  }

  return (
    <div className="px-4 pt-3">
      {/* Avatar header row */}
      <div className="flex gap-3 items-center">
        <div className="flex-shrink-0 flex flex-col items-center">
          <div onClick={handleAuthorClick} className="cursor-pointer">
            <Avatar src={author.avatar} alt={author.displayName || author.handle} size="md" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span onClick={handleAuthorClick} className="font-semibold hover:underline cursor-pointer">
            {author.displayName || author.handle}
          </span>
          <span onClick={handleAuthorClick} className="text-gray-500 dark:text-gray-400 hover:underline cursor-pointer">
            @{author.handle}
          </span>
        </div>
      </div>

      {/* All visible posts rendered uniformly */}
      {allVisible.map((post) => (
        <CompactChainPost
          key={post.uri}
          post={post}
          onClick={() => handlePostClick(post.uri)}
          showLine={true}
        />
      ))}

      {/* Bottom indicator: line ending at ⊕/⊖ icon */}
      <div className="flex items-center pb-3">
        {/* Line column ending at the icon */}
        <div className="flex-shrink-0 w-[52px] flex flex-col items-center">
          <div className="w-0.5 h-2 bg-gray-300 dark:bg-gray-600"></div>
        </div>
      </div>
      <div className="flex items-center pb-3 -mt-3">
        <div className="flex-shrink-0 w-[52px] flex justify-center">
          {allPostsShown ? (
            <button
              onClick={(e) => { e.stopPropagation(); setDisplayCount(0) }}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
            >
              <MinusCircleIcon />
            </button>
          ) : (
            <button
              onClick={handleShowMore}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
            >
              <PlusCircleIcon />
            </button>
          )}
        </div>
        {allPostsShown ? (
          <button
            onClick={(e) => { e.stopPropagation(); setDisplayCount(0) }}
            className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors ml-1.5"
          >
            Collapse
          </button>
        ) : (
          <button
            onClick={handleShowMore}
            className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors ml-1.5"
          >
            {(() => {
              const raw = remainingCount > 0 ? remainingCount : chainPosts.length
              const count = Math.min(raw, CHAIN_PAGE_SIZE)
              if (count === 0 && mayHaveMore) return 'Show more replies'
              return `Show ${count} more ${count === 1 ? 'reply' : 'replies'}`
            })()}
          </button>
        )}
      </div>
    </div>
  )
}
