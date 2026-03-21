import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigationType } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getBookmarks } from '../api/feed'
import { likePost, unlikePost, bookmarkPost, unbookmarkPost } from '../api/posts'
import PostCard from '../components/PostCard'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

const SAVED_FEED_KEY = 'websky_saved_feed_state'
const SAVED_SCROLL_KEY = 'websky_saved_scroll_pos'

export default function SavedPage() {
  const { agent } = useSession()
  const navigationType = useNavigationType()
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const restoredFromCacheRef = useRef(false)
  const isProgrammaticScrollRef = useRef(false)
  const scrollSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const addToast = (message: string, type: 'error' | 'success' = 'error') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
  }

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  // Save feed state to sessionStorage
  const saveFeedState = useCallback((currentFeed: AppBskyFeedDefs.FeedViewPost[], currentCursor?: string) => {
    try {
      sessionStorage.setItem(SAVED_FEED_KEY, JSON.stringify({ feed: currentFeed, cursor: currentCursor }))
    } catch { /* ignore quota errors */ }
  }, [])

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
        setFeed(prev => {
          const updated = [...prev, ...posts]
          const newCursor = posts.length > 0 ? response.cursor : undefined
          saveFeedState(updated, newCursor)
          return updated
        })
      } else {
        setFeed(posts)
        saveFeedState(posts, posts.length > 0 ? response.cursor : undefined)
      }
      // Clear cursor if no posts returned (end of list)
      setCursor(posts.length > 0 ? response.cursor : undefined)
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to load bookmarks', 'error')
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [agent, saveFeedState])

  // On mount: restore from cache on back navigation, otherwise fetch fresh
  useEffect(() => {
    if (navigationType === 'POP') {
      try {
        const saved = sessionStorage.getItem(SAVED_FEED_KEY)
        if (saved) {
          const { feed: savedFeed, cursor: savedCursor } = JSON.parse(saved)
          if (savedFeed && savedFeed.length > 0) {
            setFeed(savedFeed)
            setCursor(savedCursor)
            setIsLoading(false)
            restoredFromCacheRef.current = true
            return
          }
        }
      } catch { /* parse error, fall through to fresh load */ }
    } else {
      // Fresh navigation — clear stale state
      sessionStorage.removeItem(SAVED_FEED_KEY)
      sessionStorage.removeItem(SAVED_SCROLL_KEY)
    }
    loadBookmarks()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore scroll position after cache restore renders
  useEffect(() => {
    if (!restoredFromCacheRef.current) return
    restoredFromCacheRef.current = false

    const savedScrollY = sessionStorage.getItem(SAVED_SCROLL_KEY)
    if (!savedScrollY) return
    const targetY = parseInt(savedScrollY, 10)
    if (isNaN(targetY) || targetY <= 0) return

    isProgrammaticScrollRef.current = true
    let attempt = 0
    const maxAttempts = 8

    const tryRestore = () => {
      attempt++
      window.scrollTo(0, targetY)
      const actual = window.scrollY
      if (Math.abs(actual - targetY) < 100 || attempt >= maxAttempts) {
        setTimeout(() => { isProgrammaticScrollRef.current = false }, 200)
      } else {
        setTimeout(tryRestore, attempt * 100)
      }
    }
    // Small delay for DOM to render restored feed
    setTimeout(tryRestore, 50)
  }, [feed.length]) // triggers when feed is populated from cache

  // Debounced scroll position saving
  useEffect(() => {
    const handleScroll = () => {
      if (scrollSaveTimeoutRef.current) clearTimeout(scrollSaveTimeoutRef.current)
      scrollSaveTimeoutRef.current = setTimeout(() => {
        if (isProgrammaticScrollRef.current) return
        const scrollY = window.scrollY
        try {
          if (scrollY < 50) {
            sessionStorage.removeItem(SAVED_SCROLL_KEY)
          } else {
            sessionStorage.setItem(SAVED_SCROLL_KEY, scrollY.toString())
          }
        } catch { /* ignore */ }
      }, 150)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (scrollSaveTimeoutRef.current) clearTimeout(scrollSaveTimeoutRef.current)
    }
  }, [])

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
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Saved Posts</h1>
          <a
            href="https://bsky.app/saved"
            className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
          >
            View on Bluesky ↗
          </a>
        </div>
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
