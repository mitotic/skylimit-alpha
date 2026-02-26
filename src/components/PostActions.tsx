import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import RepostMenu from './RepostMenu'
import { getBlueSkyPostUrl } from '../curation/skylimitGeneral'
import { isReadOnlyMode } from '../utils/readOnlyMode'

interface PostActionsProps {
  post: AppBskyFeedDefs.PostView
  author?: { handle: string }
  onReply?: (uri: string) => void
  onRepost?: (uri: string, cid: string) => void
  onQuotePost?: (post: AppBskyFeedDefs.PostView) => void
  onLike?: (uri: string, cid: string) => void
  onBookmark?: (uri: string, cid: string) => void
}

export default function PostActions({
  post,
  author,
  onReply,
  onRepost,
  onQuotePost,
  onLike,
  onBookmark,
}: PostActionsProps) {
  const navigate = useNavigate()
  const [showRepostMenu, setShowRepostMenu] = useState(false)
  const [showCopied, setShowCopied] = useState(false)
  const repostButtonRef = useRef<HTMLButtonElement>(null)


  const replyCount = post.replyCount ?? 0
  const repostCount = post.repostCount ?? 0
  const likeCount = post.likeCount ?? 0
  const isLiked = !!post.viewer?.like
  const isReposted = !!post.viewer?.repost
  const isBookmarked = !!post.viewer?.bookmarked

  const handleReplyClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isReadOnlyMode()) { onReply?.(post.uri); return }
    onReply?.(post.uri)
    if (post.uri) {
      const encodedUri = encodeURIComponent(post.uri)
      navigate(`/post/${encodedUri}?reply=true`)
    }
  }

  const handleRepostClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isReadOnlyMode()) { onRepost?.(post.uri, post.cid); return }
    if (repostButtonRef.current) {
      setShowRepostMenu(true)
    }
  }

  const handleSimpleRepost = () => {
    onRepost?.(post.uri, post.cid)
    setShowRepostMenu(false)
  }

  const handleQuotePost = () => {
    if (onQuotePost) {
      onQuotePost(post)
    }
    setShowRepostMenu(false)
  }

  const handleLikeClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onLike?.(post.uri, post.cid)
  }

  const handleBookmarkClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onBookmark?.(post.uri, post.cid)
  }

  const handleShareClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const handle = author?.handle ?? post.author?.handle
    if (handle) {
      const url = getBlueSkyPostUrl(post.uri, handle)
      navigator.clipboard.writeText(url).then(() => {
        setShowCopied(true)
      })
    }
  }

  useEffect(() => {
    if (!showCopied) return
    const timer = setTimeout(() => setShowCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [showCopied])

  return (
    <div className="flex items-center gap-6 mt-2">
      <button
        className="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
        onClick={handleReplyClick}
        aria-label={`Reply to post. ${replyCount} replies`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {replyCount > 0 && <span className="text-sm">{replyCount}</span>}
      </button>

      <div className="relative">
        <button
          ref={repostButtonRef}
          className={`flex items-center gap-1 transition-colors ${
            isReposted
              ? 'text-green-500 dark:text-green-400'
              : 'text-gray-500 dark:text-gray-400 hover:text-green-500 dark:hover:text-green-400'
          }`}
          onClick={handleRepostClick}
          aria-label={`Repost. ${repostCount} reposts`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={isReposted ? 3 : 2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 1l4 4-4 4" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <path d="M7 23l-4-4 4-4" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {repostCount > 0 && <span className="text-sm">{repostCount}</span>}
        </button>
        {showRepostMenu && repostButtonRef.current && (
          <RepostMenu
            onRepost={handleSimpleRepost}
            onQuotePost={handleQuotePost}
            onClose={() => setShowRepostMenu(false)}
            position={{
              x: repostButtonRef.current.getBoundingClientRect().left,
              y: repostButtonRef.current.getBoundingClientRect().bottom + 8,
            }}
          />
        )}
      </div>

      <button
        className={`flex items-center gap-1 transition-colors ${
          isLiked
            ? 'text-red-500 dark:text-red-400'
            : 'text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400'
        }`}
        onClick={handleLikeClick}
        aria-label={`Like. ${likeCount} likes`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill={isLiked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
        {likeCount > 0 && <span className="text-sm">{likeCount}</span>}
      </button>

      <button
        className={`flex items-center gap-1 transition-colors ${
          isBookmarked
            ? 'text-yellow-500 dark:text-yellow-400'
            : 'text-gray-500 dark:text-gray-400 hover:text-yellow-500 dark:hover:text-yellow-400'
        }`}
        onClick={handleBookmarkClick}
        aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark post'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill={isBookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      <div className="relative">
        <button
          className="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
          onClick={handleShareClick}
          aria-label="Copy link to post"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        </button>
        {showCopied && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs text-white bg-gray-800 dark:bg-gray-700 rounded shadow whitespace-nowrap">
            Link copied!
          </div>
        )}
      </div>
    </div>
  )
}




