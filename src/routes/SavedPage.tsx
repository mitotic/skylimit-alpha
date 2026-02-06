import { useState, useEffect, useCallback } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getBookmarks } from '../api/feed'
import { likePost, unlikePost, bookmarkPost, unbookmarkPost } from '../api/posts'
import PostCard from '../components/PostCard'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

export default function SavedPage() {
  const { agent } = useSession()
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = (message: string, type: 'error' | 'success' = 'error') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
  }

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  const loadBookmarks = useCallback(async (loadCursor?: string) => {
    if (!agent) return

    try {
      const response = await getBookmarks(agent, {
        limit: 25,
        cursor: loadCursor,
      })

      const posts = response.bookmarks
        .filter(bv => AppBskyFeedDefs.isPostView(bv.item))
        .map(bv => ({
          post: bv.item as AppBskyFeedDefs.PostView,
        } as AppBskyFeedDefs.FeedViewPost))

      if (loadCursor) {
        setFeed(prev => [...prev, ...posts])
      } else {
        setFeed(posts)
      }
      // Clear cursor if no posts returned (end of list)
      setCursor(posts.length > 0 ? response.cursor : undefined)
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to load bookmarks', 'error')
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [agent])

  useEffect(() => {
    loadBookmarks()
  }, [loadBookmarks])

  const handleBookmark = async (uri: string, cid: string) => {
    if (!agent) return

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    const wasBookmarked = !!post.post.viewer?.bookmarked

    // Optimistic update
    if (wasBookmarked) {
      // Remove from list when unbookmarking
      setFeed(prev => prev.filter(p => p.post.uri !== uri))
    } else {
      setFeed(prev => prev.map(p => {
        if (p.post.uri === uri) {
          return {
            ...p,
            post: {
              ...p.post,
              viewer: { ...p.post.viewer, bookmarked: true },
            },
          }
        }
        return p
      }))
    }

    try {
      if (wasBookmarked) {
        await unbookmarkPost(agent, uri)
      } else {
        await bookmarkPost(agent, uri, cid)
      }
    } catch (error) {
      // Revert - reload bookmarks
      loadBookmarks()
      addToast(error instanceof Error ? error.message : 'Failed to update bookmark', 'error')
    }
  }

  const handleLike = async (uri: string, cid: string) => {
    if (!agent) return

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    const originalLikeUri = post.post.viewer?.like
    const isLiked = !!originalLikeUri

    // Optimistic update
    setFeed(prev => prev.map(p => {
      if (p.post.uri === uri) {
        return {
          ...p,
          post: {
            ...p.post,
            likeCount: (p.post.likeCount || 0) + (isLiked ? -1 : 1),
          },
        }
      }
      return p
    }))

    try {
      if (isLiked && originalLikeUri) {
        await unlikePost(agent, originalLikeUri)
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, like: undefined },
              },
            }
          }
          return p
        }))
      } else {
        const likeResponse = await likePost(agent, uri, cid)
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, like: likeResponse.uri },
              },
            }
          }
          return p
        }))
      }
    } catch (error) {
      loadBookmarks()
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-20">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Saved Posts</h1>
      </div>

      {feed.length === 0 ? (
        <div className="p-8 text-center text-gray-500 dark:text-gray-400">
          <p className="text-lg mb-2">No saved posts yet</p>
          <p className="text-sm">Posts you bookmark will appear here.</p>
        </div>
      ) : (
        <>
          {feed.map((post) => (
            <PostCard
              key={post.post.uri}
              post={post}
              onLike={handleLike}
              onBookmark={handleBookmark}
              showRootPost={false}
            />
          ))}

          <div className="p-4 text-center">
            {cursor ? (
              <button
                onClick={() => {
                  setIsLoadingMore(true)
                  loadBookmarks(cursor)
                }}
                disabled={isLoadingMore}
                className="btn btn-secondary"
              >
                {isLoadingMore ? 'Loading...' : 'Load More'}
              </button>
            ) : (
              <span className="text-sm text-gray-400 dark:text-gray-500">No more saved posts</span>
            )}
          </div>
        </>
      )}

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}
