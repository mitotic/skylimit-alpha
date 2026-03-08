import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigationType } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getCustomFeed } from '../api/feed'
import { likePost, unlikePost, repost, removeRepost, createPost, createQuotePost, bookmarkPost, unbookmarkPost } from '../api/posts'
import { getSettings } from '../curation/skylimitStore'
import PostCard from '../components/PostCard'
import Compose from '../components/Compose'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import log from '../utils/logger'

const FEED_STATE_KEY = 'websky_feed_page_state'

interface SavedFeedState {
  feedUri: string
  posts: AppBskyFeedDefs.FeedViewPost[]
  cursor?: string
  feedName: string
  feedCreator: string
  scrollY: number
}

function saveFeedState(state: SavedFeedState) {
  try {
    sessionStorage.setItem(FEED_STATE_KEY, JSON.stringify(state))
  } catch { /* ignore quota errors */ }
}

function loadFeedState(feedUri: string): SavedFeedState | null {
  try {
    const raw = sessionStorage.getItem(FEED_STATE_KEY)
    if (!raw) return null
    const state = JSON.parse(raw) as SavedFeedState
    // Only restore if it's the same feed
    if (state.feedUri !== feedUri) return null
    return state
  } catch {
    return null
  }
}

function clearFeedState() {
  sessionStorage.removeItem(FEED_STATE_KEY)
}

export default function FeedPage() {
  const { feedUri: encodedFeedUri } = useParams<{ feedUri: string }>()
  const feedUri = encodedFeedUri ? decodeURIComponent(encodedFeedUri) : ''
  const navigationType = useNavigationType()
  const { agent } = useSession()

  const [posts, setPosts] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [feedName, setFeedName] = useState<string>('')
  const [feedCreator, setFeedCreator] = useState<string>('')
  const [hasMore, setHasMore] = useState(false)
  const [pageLength, setPageLength] = useState(25)
  const [infiniteScrollEnabled, setInfiniteScrollEnabled] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [showCompose, setShowCompose] = useState(false)
  const [replyToUri, setReplyToUri] = useState<string | null>(null)
  const [quotePost, setQuotePost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [isScrolledDown, setIsScrolledDown] = useState(false)

  // Scroll restoration refs
  const pendingScrollRestoreRef = useRef<number | null>(null)
  const postsRef = useRef(posts)
  postsRef.current = posts

  // Infinite scroll ref
  const sentinelRef = useRef<HTMLDivElement>(null)

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  // Load settings
  useEffect(() => {
    getSettings().then(settings => {
      const pl = settings?.feedPageLength || 25
      setPageLength(pl)
      setInfiniteScrollEnabled(settings?.infiniteScrollingOption || false)
    })
  }, [])

  // Save feed state continuously (debounced) so it's available on back navigation
  useEffect(() => {
    if (posts.length === 0 || !feedUri) return

    let saveTimeout: ReturnType<typeof setTimeout>
    const handleScroll = () => {
      clearTimeout(saveTimeout)
      saveTimeout = setTimeout(() => {
        const scrollY = window.scrollY || document.documentElement.scrollTop
        saveFeedState({
          feedUri,
          posts: postsRef.current,
          cursor,
          feedName,
          feedCreator,
          scrollY,
        })
      }, 300)
    }

    // Save immediately when posts change (e.g., after loading more)
    handleScroll()

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      clearTimeout(saveTimeout)
      window.removeEventListener('scroll', handleScroll)
    }
  }, [posts.length, cursor, feedUri, feedName, feedCreator])

  // Initial feed load — try restoring from saved state on back navigation
  const loadFeed = useCallback(async () => {
    if (!agent || !feedUri || pageLength === 0) return

    // On back navigation, try to restore saved state
    if (navigationType === 'POP') {
      const saved = loadFeedState(feedUri)
      if (saved && saved.posts.length > 0) {
        setPosts(saved.posts)
        setCursor(saved.cursor)
        setHasMore(!!saved.cursor)
        setFeedName(saved.feedName)
        setFeedCreator(saved.feedCreator)
        setIsLoading(false)
        pendingScrollRestoreRef.current = saved.scrollY
        return
      }
    }

    // Fresh load
    clearFeedState()
    setIsLoading(true)
    try {
      // Fetch feed generator info
      const genResponse = await agent.app.bsky.feed.getFeedGenerators({ feeds: [feedUri] })
      if (genResponse.data.feeds.length > 0) {
        const gen = genResponse.data.feeds[0]
        setFeedName(gen.displayName)
        setFeedCreator(gen.creator.handle)
      }

      // Determine initial fetch size: 2 pages if 2*pageLength <= 50, else 1 page
      const initialLimit = (pageLength * 2 <= 50) ? pageLength * 2 : pageLength

      const result = await getCustomFeed(agent, feedUri, { limit: initialLimit })
      setPosts(result.feed)
      setCursor(result.cursor)
      setHasMore(!!result.cursor)
    } catch (error) {
      log.error('Feed', 'Failed to load feed:', error)
      addToast(error instanceof Error ? error.message : 'Failed to load feed', 'error')
    } finally {
      setIsLoading(false)
    }
  }, [agent, feedUri, pageLength, navigationType])

  useEffect(() => {
    if (pageLength > 0) {
      loadFeed()
    }
  }, [loadFeed])

  // Restore scroll position after content renders
  useEffect(() => {
    if (!isLoading && posts.length > 0 && pendingScrollRestoreRef.current !== null) {
      const scrollY = pendingScrollRestoreRef.current
      pendingScrollRestoreRef.current = null
      // Use multiple rAF to ensure DOM has fully rendered
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.scrollTo(0, scrollY)
        })
      })
    }
  }, [isLoading, posts.length])

  // Load more posts
  const loadMore = useCallback(async () => {
    if (!agent || !feedUri || !cursor || isLoadingMore) return

    setIsLoadingMore(true)
    try {
      const result = await getCustomFeed(agent, feedUri, {
        limit: pageLength,
        cursor,
      })
      setPosts(prev => [...prev, ...result.feed])
      setCursor(result.cursor)
      setHasMore(!!result.cursor)
    } catch (error) {
      log.error('Feed', 'Failed to load more posts:', error)
      addToast(error instanceof Error ? error.message : 'Failed to load more posts', 'error')
    } finally {
      setIsLoadingMore(false)
    }
  }, [agent, feedUri, cursor, isLoadingMore, pageLength])

  // Infinite scroll with IntersectionObserver
  useEffect(() => {
    if (!infiniteScrollEnabled || !hasMore) return

    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingMore && hasMore) {
          loadMore()
        }
      },
      { rootMargin: '200px' }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [infiniteScrollEnabled, hasMore, isLoadingMore, loadMore])

  // Disable browser's native scroll restoration
  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual'
    }
  }, [])

  // Post interaction handlers
  const handleLike = async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const postIndex = posts.findIndex(p => p.post.uri === uri)
    if (postIndex === -1) return

    const post = posts[postIndex]
    const isLiked = !!post.post.viewer?.like
    const originalLikeUri = post.post.viewer?.like

    // Optimistic update
    setPosts(prev => prev.map((p, i) => {
      if (i !== postIndex) return p
      return {
        ...p,
        post: {
          ...p.post,
          likeCount: (p.post.likeCount || 0) + (isLiked ? -1 : 1),
        },
      }
    }))

    try {
      if (isLiked && originalLikeUri) {
        await unlikePost(agent, originalLikeUri)
        setPosts(prev => prev.map((p, i) => {
          if (i !== postIndex) return p
          return { ...p, post: { ...p.post, viewer: { ...p.post.viewer, like: undefined } } }
        }))
      } else {
        const likeResponse = await likePost(agent, uri, cid)
        setPosts(prev => prev.map((p, i) => {
          if (i !== postIndex) return p
          return { ...p, post: { ...p.post, viewer: { ...p.post.viewer, like: likeResponse.uri } } }
        }))
      }
    } catch (error) {
      loadFeed()
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }

  const handleRepost = async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const postIndex = posts.findIndex(p => p.post.uri === uri)
    if (postIndex === -1) return

    const post = posts[postIndex]
    const isReposted = !!post.post.viewer?.repost
    const originalRepostUri = post.post.viewer?.repost

    setPosts(prev => prev.map((p, i) => {
      if (i !== postIndex) return p
      return {
        ...p,
        post: {
          ...p.post,
          repostCount: (p.post.repostCount || 0) + (isReposted ? -1 : 1),
        },
      }
    }))

    try {
      if (isReposted && originalRepostUri) {
        await removeRepost(agent, originalRepostUri)
        setPosts(prev => prev.map((p, i) => {
          if (i !== postIndex) return p
          return { ...p, post: { ...p.post, viewer: { ...p.post.viewer, repost: undefined } } }
        }))
      } else {
        const repostResponse = await repost(agent, uri, cid)
        setPosts(prev => prev.map((p, i) => {
          if (i !== postIndex) return p
          return { ...p, post: { ...p.post, viewer: { ...p.post.viewer, repost: repostResponse.uri } } }
        }))
      }
    } catch (error) {
      loadFeed()
      addToast(error instanceof Error ? error.message : 'Failed to update repost', 'error')
    }
  }

  const handleBookmark = async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const postIndex = posts.findIndex(p => p.post.uri === uri)
    if (postIndex === -1) return

    const wasBookmarked = !!posts[postIndex].post.viewer?.bookmarked

    setPosts(prev => prev.map((p, i) => {
      if (i !== postIndex) return p
      return { ...p, post: { ...p.post, viewer: { ...p.post.viewer, bookmarked: !wasBookmarked } } }
    }))

    try {
      if (wasBookmarked) {
        await unbookmarkPost(agent, uri)
      } else {
        await bookmarkPost(agent, uri, cid)
      }
    } catch (error) {
      setPosts(prev => prev.map((p, i) => {
        if (i !== postIndex) return p
        return { ...p, post: { ...p.post, viewer: { ...p.post.viewer, bookmarked: wasBookmarked } } }
      }))
      addToast(error instanceof Error ? error.message : 'Failed to update bookmark', 'error')
    }
  }

  const handleReply = (uri: string) => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    setReplyToUri(uri)
    setQuotePost(null)
    setShowCompose(true)
  }

  const handleQuotePost = (post: AppBskyFeedDefs.PostView) => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    setQuotePost(post)
    setReplyToUri(null)
    setShowCompose(true)
  }

  const handlePost = async (text: string, replyTo?: { uri: string; cid: string; rootUri?: string; rootCid?: string }, quotedPost?: AppBskyFeedDefs.PostView, _images?: Array<{ image: Blob; alt: string }>, _ogImage?: { url: string; title: string; description: string }) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    if (quotedPost) {
      await createQuotePost(agent, {
        text,
        quotedPost: { uri: quotedPost.uri, cid: quotedPost.cid },
      })
      addToast('Quote post created!', 'success')
    } else if (replyTo) {
      await createPost(agent, {
        text,
        replyTo: {
          uri: replyTo.uri,
          cid: replyTo.cid,
          rootUri: replyTo.rootUri,
          rootCid: replyTo.rootCid,
        },
      })
      addToast('Reply posted!', 'success')
    }
    setShowCompose(false)
    setReplyToUri(null)
    setQuotePost(null)
  }

  // Build the "View on Bluesky" URL for this feed
  const getFeedBskyUrl = () => {
    // Feed URIs look like: at://did:plc:xxx/app.bsky.feed.generator/feed-name
    // Bluesky URL: https://bsky.app/profile/did:plc:xxx/feed/feed-name
    const match = feedUri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.generator\/(.+)$/)
    if (match) {
      return `https://bsky.app/profile/${match[1]}/feed/${match[2]}`
    }
    return null
  }

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Track scroll position for scroll-to-top button
  useEffect(() => {
    const handleScrollForButton = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop
      setIsScrolledDown(scrollY > 300)
    }

    window.addEventListener('scroll', handleScrollForButton, { passive: true })
    return () => window.removeEventListener('scroll', handleScrollForButton)
  }, [])

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-8">
        <Spinner size="lg" />
      </div>
    )
  }

  const bskyUrl = getFeedBskyUrl()

  return (
    <div className="pb-20">
      {/* Feed header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{feedName || 'Feed'}</h1>
            {feedCreator && (
              <p className="text-sm text-gray-500 dark:text-gray-400">by @{feedCreator}</p>
            )}
          </div>
          {bskyUrl && (
            <a
              href={bskyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
            >
              View on Bluesky ↗
            </a>
          )}
        </div>
      </div>

      {/* Posts */}
      {posts.length === 0 && !isLoading && (
        <div className="p-8 text-center text-gray-500 dark:text-gray-400">
          No posts in this feed
        </div>
      )}

      {posts.map((feedPost, index) => (
        <PostCard
          key={feedPost.post.uri + '-' + index}
          post={feedPost}
          onReply={handleReply}
          onRepost={handleRepost}
          onQuotePost={handleQuotePost}
          onLike={handleLike}
          onBookmark={handleBookmark}
        />
      ))}

      {/* Infinite scroll sentinel */}
      {infiniteScrollEnabled && hasMore && (
        <div ref={sentinelRef} className="h-10" />
      )}

      {/* Loading more indicator */}
      {isLoadingMore && (
        <div className="flex justify-center py-4">
          <Spinner size="md" />
        </div>
      )}

      {/* Prev Page button (when infinite scroll is disabled) */}
      {!infiniteScrollEnabled && hasMore && !isLoadingMore && (
        <div className="flex justify-center py-4">
          <button
            onClick={loadMore}
            className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            Prev Page
          </button>
        </div>
      )}

      {/* Scroll to top arrow - shown when scrolled down */}
      {isScrolledDown && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-6 left-6 md:bottom-8 md:left-8 bg-blue-100 hover:bg-blue-200 text-blue-600 dark:bg-blue-900/40 dark:hover:bg-blue-900/60 dark:text-blue-400 p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-12 h-12"
          aria-label="Scroll to top"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
        </button>
      )}

      {/* Compose modal */}
      <Compose
        isOpen={showCompose}
        onPost={handlePost}
        onClose={() => { setShowCompose(false); setReplyToUri(null); setQuotePost(null) }}
        replyTo={replyToUri ? (() => {
          const p = posts.find(fp => fp.post.uri === replyToUri)?.post
          if (!p) return undefined
          const record = p.record as { text?: string; facets?: any[]; reply?: { root?: { uri: string; cid: string } } }
          return {
            uri: p.uri,
            cid: p.cid,
            rootUri: record?.reply?.root?.uri,
            rootCid: record?.reply?.root?.cid,
            text: record?.text,
            authorName: p.author.displayName,
            authorHandle: p.author.handle,
          }
        })() : undefined}
        quotePost={quotePost || undefined}
      />

      <ToastContainer toasts={toasts} onRemove={(id: string) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}
