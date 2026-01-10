import React, { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import RepostMenu from './RepostMenu'

interface PostActionsProps {
  post: AppBskyFeedDefs.PostView
  onReply?: (uri: string) => void
  onRepost?: (uri: string, cid: string) => void
  onQuotePost?: (post: AppBskyFeedDefs.PostView) => void
  onLike?: (uri: string, cid: string) => void
}

export default function PostActions({
  post,
  onReply,
  onRepost,
  onQuotePost,
  onLike,
}: PostActionsProps) {
  const navigate = useNavigate()
  const [showRepostMenu, setShowRepostMenu] = useState(false)
  const repostButtonRef = useRef<HTMLButtonElement>(null)

  const replyCount = post.replyCount ?? 0
  const repostCount = post.repostCount ?? 0
  const likeCount = post.likeCount ?? 0
  const isLiked = !!post.viewer?.like
  const isReposted = !!post.viewer?.repost

  const handleReplyClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onReply?.(post.uri)
    if (post.uri) {
      const encodedUri = encodeURIComponent(post.uri)
      navigate(`/post/${encodedUri}?reply=true`)
    }
  }

  const handleRepostClick = (e: React.MouseEvent) => {
    e.stopPropagation()
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

  return (
    <div className="flex items-center gap-6 mt-2">
      <button
        className="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
        onClick={handleReplyClick}
        aria-label={`Reply to post. ${replyCount} replies`}
      >
        <span>💬</span>
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
          <span>🔄</span>
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
        <span>❤️</span>
        {likeCount > 0 && <span className="text-sm">{likeCount}</span>}
      </button>
    </div>
  )
}




