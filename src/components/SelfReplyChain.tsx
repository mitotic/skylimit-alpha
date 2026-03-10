import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import Avatar from './Avatar'
import RichText from './RichText'
import PostMedia from './PostMedia'
import PostActions from './PostActions'
import Spinner from './Spinner'

const CHAIN_PAGE_SIZE = 10

interface SelfReplyChainProps {
  firstPost: AppBskyFeedDefs.PostView   // the first same-author reply
  chainPosts: AppBskyFeedDefs.PostView[] // continuation posts (after first reply)
  isLoading: boolean
  mayHaveMore?: boolean                  // true if more posts might be fetchable from the server
  onLoadMore?: () => void                // callback to fetch more chain posts from the server
  onLike?: (uri: string, cid: string) => void
  onRepost?: (uri: string, cid: string) => void
  onQuotePost?: (post: AppBskyFeedDefs.PostView) => void
  onReply?: (uri: string) => void
  onBookmark?: (uri: string, cid: string) => void
  onDeletePost?: (uri: string) => void
  onPinPost?: (uri: string, cid: string) => void
  isOwnPost?: boolean
}

// Compact post without avatar/username — used for all posts in the chain
function CompactChainPost({
  post,
  onClick,
  showLine = true,
  isOwnPost,
  onLike,
  onRepost,
  onQuotePost,
  onReply,
  onBookmark,
  onDeletePost,
  onPinPost,
}: {
  post: AppBskyFeedDefs.PostView
  onClick: () => void
  showLine?: boolean
  isOwnPost?: boolean
  onLike?: (uri: string, cid: string) => void
  onRepost?: (uri: string, cid: string) => void
  onQuotePost?: (post: AppBskyFeedDefs.PostView) => void
  onReply?: (uri: string) => void
  onBookmark?: (uri: string, cid: string) => void
  onDeletePost?: (uri: string) => void
  onPinPost?: (uri: string, cid: string) => void
}) {
  const record = post.record as any

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

          <PostActions
            post={post}
            author={post.author}
            isOwnPost={isOwnPost}
            onReply={onReply}
            onRepost={onRepost}
            onQuotePost={onQuotePost}
            onLike={onLike}
            onBookmark={onBookmark}
            onDeletePost={onDeletePost}
            onPinPost={onPinPost}
          />
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

export default function SelfReplyChain({ firstPost, chainPosts, isLoading, mayHaveMore, onLoadMore, onLike, onRepost, onQuotePost, onReply, onBookmark, onDeletePost, onPinPost, isOwnPost }: SelfReplyChainProps) {
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
          onLike={onLike}
          onRepost={onRepost}
          onQuotePost={onQuotePost}
          onReply={onReply}
          onBookmark={onBookmark}
          onDeletePost={onDeletePost}
          onPinPost={onPinPost}
          isOwnPost={isOwnPost}
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
