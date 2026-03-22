import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import { useParams, useSearchParams, useNavigate, useLocation, useNavigationType } from 'react-router-dom'
import { AppBskyFeedDefs, AppBskyRichtextFacet } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getPostThread, MAX_PARENT_CHAIN_DEPTH } from '../api/feed'
import { likePost, unlikePost, repost, removeRepost, createPost, createQuotePost, bookmarkPost, unbookmarkPost, deletePost } from '../api/posts'
import { pinPost } from '../api/profile'
import { getPostUrl } from '../curation/skylimitGeneral'
import { updatePostSummaryEngagement } from '../curation/skylimitCache'
import { ENGAGEMENT_REPLIED } from '../curation/types'
import PostCard from '../components/PostCard'
import ParentChainView from '../components/ParentChainView'
import Compose from '../components/Compose'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import EngagementList from '../components/EngagementList'
import SelfReplyChain from '../components/SelfReplyChain'
import { PencilIcon } from '../components/NavIcons'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import log from '../utils/logger'

// Scroll state preservation constant for thread pages
const WEBSKY_THREAD_SCROLL_POSITION = 'websky_thread_scroll_position'

// Pagination constants for replies
const REPLIES_PAGE_LENGTH = 25
const REPLIES_INITIAL_PAGES = 2 // Show 2 pages initially (50 replies)

export default function ThreadPage() {
  const { uri } = useParams<{ uri: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const { agent, session } = useSession()
  const [thread, setThread] = useState<AppBskyFeedDefs.ThreadViewPost | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showCompose, setShowCompose] = useState(false)
  const [replyToUri, setReplyToUri] = useState<string | null>(null)
  const [quotePost, setQuotePost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [clickedPostUri, setClickedPostUri] = useState<string | null>(null)
  const [rootUri, setRootUri] = useState<string | null>(null)
  const [parentChain, setParentChain] = useState<AppBskyFeedDefs.PostView[]>([])
  const [isLoadingParents, setIsLoadingParents] = useState(false)
  const [repliesDisplayCount, setRepliesDisplayCount] = useState(REPLIES_PAGE_LENGTH * REPLIES_INITIAL_PAGES)
  const [isScrolledDown, setIsScrolledDown] = useState(false)
  const [selfReplyChain, setSelfReplyChain] = useState<AppBskyFeedDefs.PostView[]>([])
  const [isLoadingChain, setIsLoadingChain] = useState(false)
  const [chainMayHaveMore, setChainMayHaveMore] = useState(false)
  const chainLastUriRef = useRef<string | null>(null)
  const chainFetchCountRef = useRef(0)
  const chainAnchorDidRef = useRef<string | null>(null)
  const threadRef = useRef<AppBskyFeedDefs.ThreadViewPost | null>(null)
  threadRef.current = thread
  const [engagementModal, setEngagementModal] = useState<{
    isOpen: boolean
    type: 'likes' | 'reposts'
    postUri: string
    count: number
  }>({ isOpen: false, type: 'likes', postUri: '', count: 0 })
  const highlightedPostRef = useRef<HTMLDivElement | null>(null)
  
  // Scroll state preservation refs
  const scrollRestoredRef = useRef(false)
  const isProgrammaticScrollRef = useRef(false)
  const previousPathnameRef = useRef<string>(location.pathname)
  const scrollSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  // Fetch one page of the self-reply chain starting from fetchUri.
  // Walks the reply tree from a single getPostThread call, collecting same-author replies.
  // Returns { posts, mayHaveMore, lastUri } where mayHaveMore indicates the API depth limit
  // may have cut off the chain (last post had empty replies array).
  const fetchChainPage = useCallback(async (
    fetchUri: string,
    authorDid: string,
  ): Promise<{ posts: AppBskyFeedDefs.PostView[]; mayHaveMore: boolean; lastUri: string | null }> => {
    if (!agent) return { posts: [], mayHaveMore: false, lastUri: null }

    const chainData = await getPostThread(agent, fetchUri, 10)
    if (!chainData.thread || !('post' in chainData.thread)) {
      return { posts: [], mayHaveMore: false, lastUri: null }
    }

    const posts: AppBskyFeedDefs.PostView[] = []
    let current = chainData.thread as AppBskyFeedDefs.ThreadViewPost

    while (true) {
      const replies = (current.replies || [])
        .filter(r => 'post' in r) as AppBskyFeedDefs.ThreadViewPost[]
      const sameAuthorReply = replies
        .filter(r => r.post.author.did === authorDid)
        .sort((a, b) => new Date(a.post.indexedAt).getTime() - new Date(b.post.indexedAt).getTime())[0]

      if (!sameAuthorReply) break
      posts.push(sameAuthorReply.post)
      current = sameAuthorReply
    }

    // If we found posts and the last post has an empty replies array, the API depth limit
    // likely cut off the tree — there may be more posts if we fetch from that URI.
    const mayHaveMore = posts.length >= 10 && (current.replies || []).length === 0
    const lastUri = posts.length > 0 ? posts[posts.length - 1].uri : null

    return { posts, mayHaveMore, lastUri }
  }, [agent])

  const loadThread = useCallback(async () => {
    if (!agent || !uri) return

    try {
      const decodedUri = decodeURIComponent(uri)

      // Reset parent chain, self-reply chain, and pagination state
      setParentChain([])
      setIsLoadingParents(false)
      setSelfReplyChain([])
      setIsLoadingChain(false)
      setChainMayHaveMore(false)
      chainLastUriRef.current = null
      chainFetchCountRef.current = 0
      chainAnchorDidRef.current = null
      setRepliesDisplayCount(REPLIES_PAGE_LENGTH * REPLIES_INITIAL_PAGES)

      // Focused Thread View: Keep the clicked post as the anchor
      // Fetch with depth=1 to get direct replies, and parentHeight to get parent chain in one call
      const threadData = await getPostThread(agent, decodedUri, 1, undefined, MAX_PARENT_CHAIN_DEPTH)

      if (!threadData.thread || !('post' in threadData.thread)) {
        throw new Error('Thread data not found')
      }

      const threadPost = threadData.thread as AppBskyFeedDefs.ThreadViewPost
      setThread(threadPost)
      setClickedPostUri(null) // No highlighting needed - anchor post is prominent by default

      // Detect if the current user has replied to this post
      if (session?.did && threadPost.replies) {
        const directReplies = (threadPost.replies as AppBskyFeedDefs.ThreadViewPost[])
          .filter(r => 'post' in r)
        const userReplied = directReplies.some(r => r.post.author.did === session.did)
        if (userReplied) {
          updatePostSummaryEngagement(decodedUri, ENGAGEMENT_REPLIED, session?.handle)
        }
      }

      // Extract parent/root info from the post record
      const record = threadPost.post.record as {
        reply?: { parent?: { uri: string }, root?: { uri: string } }
      }

      // Set root URI for "View full thread" link
      if (record?.reply?.root?.uri && record.reply.root.uri !== decodedUri) {
        setRootUri(record.reply.root.uri)
      } else {
        setRootUri(null) // This is the root, no need for root link
      }

      // Extract parent chain from the nested parent field (returned by parentHeight)
      if (threadPost.parent && AppBskyFeedDefs.isThreadViewPost(threadPost.parent)) {
        setIsLoadingParents(true)
        try {
          const chain: AppBskyFeedDefs.PostView[] = []
          let current: AppBskyFeedDefs.ThreadViewPost['parent'] = threadPost.parent
          while (current && AppBskyFeedDefs.isThreadViewPost(current)) {
            const parentThread = current as AppBskyFeedDefs.ThreadViewPost
            chain.unshift(parentThread.post) // oldest first
            current = parentThread.parent
          }
          setParentChain(chain)
        } finally {
          setIsLoadingParents(false)
        }
      }

      // Initiate self-reply chain fetch immediately (no useEffect delay)
      const anchorDid = threadPost.post.author.did
      const directReplies = (threadPost.replies || [])
        .filter(r => 'post' in r) as AppBskyFeedDefs.ThreadViewPost[]
      const opReplies = directReplies
        .filter(r => r.post.author.did === anchorDid)
        .sort((a, b) => new Date(a.post.indexedAt).getTime() - new Date(b.post.indexedAt).getTime())

      if (opReplies.length > 0) {
        const firstOpReply = opReplies[0]
        chainAnchorDidRef.current = anchorDid
        chainFetchCountRef.current = 0
        setIsLoadingChain(true)
        // Fire and forget — don't await, let it update state when done
        fetchChainPage(firstOpReply.post.uri, anchorDid).then(({ posts, mayHaveMore, lastUri }) => {
          chainFetchCountRef.current = 1
          chainLastUriRef.current = lastUri
          setSelfReplyChain(posts)
          setChainMayHaveMore(mayHaveMore)
        }).catch(error => {
          log.warn('Thread', 'Failed to fetch self-reply chain:', error)
          setSelfReplyChain([])
          setChainMayHaveMore(false)
        }).finally(() => {
          setIsLoadingChain(false)
        })
      }

      // Check if we should show compose (from query param)
      if (searchParams.get('reply') === 'true') {
        if (isReadOnlyMode()) {
          addToast('Disable Read-only mode in Settings to do this', 'error')
        } else {
          setReplyToUri(decodedUri)
          setShowCompose(true)
        }
      }
    } catch (error) {
      log.error('Thread', 'Failed to load thread:', error)
      addToast(error instanceof Error ? error.message : 'Failed to load thread', 'error')
    } finally {
      setIsLoading(false)
    }
  }, [agent, uri, searchParams, fetchChainPage])

  // Step 1: Disable browser scroll restoration for thread pages
  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual'
    }
  }, [])

  // Step 2: Save scroll position when navigating away from thread page
  useEffect(() => {
    const wasOnThread = previousPathnameRef.current.startsWith('/post/')
    const isOnThread = location.pathname.startsWith('/post/')
    
    // If we were on thread page and are now navigating away, save scroll position
    if (wasOnThread && !isOnThread) {
      const scrollY = window.scrollY || document.documentElement.scrollTop
      try {
        sessionStorage.setItem(WEBSKY_THREAD_SCROLL_POSITION, scrollY.toString())
        log.debug('Thread', 'Saved thread scroll position before navigation:', scrollY)
      } catch (error) {
        log.warn('Thread', 'Failed to save thread scroll position:', error)
      }
    }
    
    previousPathnameRef.current = location.pathname
  }, [location.pathname])

  // Step 3: Prevent scroll to top on return (synchronous, before paint)
  useLayoutEffect(() => {
    const wasOnThread = previousPathnameRef.current.startsWith('/post/')
    const isOnThread = location.pathname.startsWith('/post/')
    
    // Check if we're returning to thread page via back navigation
    if (!wasOnThread && isOnThread && navigationType === 'POP') {
      const savedScrollPosition = sessionStorage.getItem(WEBSKY_THREAD_SCROLL_POSITION)
      if (savedScrollPosition) {
        // Just prevent scroll to top, don't restore yet (content might not be loaded)
        scrollRestoredRef.current = false
        log.debug('Thread', 'Detected return to thread page, will restore after content loads')
      }
    }
    
    // Update previous pathname AFTER checking (for next navigation)
    if (previousPathnameRef.current !== location.pathname) {
      previousPathnameRef.current = location.pathname
    }
  }, [location.pathname, navigationType])

  useEffect(() => {
    loadThread()
  }, [loadThread])

  // Load more chain posts (called by SelfReplyChain when user clicks "Show more")
  const handleLoadMoreChain = useCallback(async () => {
    if (!agent || !chainLastUriRef.current || !chainAnchorDidRef.current) return
    if (chainFetchCountRef.current >= 3) return // Max 3 fetches (~31 levels)

    setIsLoadingChain(true)
    try {
      const { posts, mayHaveMore, lastUri } = await fetchChainPage(
        chainLastUriRef.current,
        chainAnchorDidRef.current,
      )
      chainFetchCountRef.current += 1
      chainLastUriRef.current = lastUri
      setChainMayHaveMore(mayHaveMore && chainFetchCountRef.current < 3)

      if (posts.length > 0) {
        setSelfReplyChain(prev => [...prev, ...posts])
      }
    } catch (error) {
      log.warn('Thread', 'Failed to fetch more chain posts:', error)
      setChainMayHaveMore(false)
    } finally {
      setIsLoadingChain(false)
    }
  }, [agent, fetchChainPage])


  // Step 4: Restore scroll position after thread loads OR scroll to highlighted post
  useEffect(() => {
    // Only restore if we're on a thread page
    if (!location.pathname.startsWith('/post/')) {
      scrollRestoredRef.current = false
      return
    }
    
    // Only restore once when thread is loaded
    if (!isLoading && !scrollRestoredRef.current && thread) {
      try {
        const savedScrollPosition = sessionStorage.getItem(WEBSKY_THREAD_SCROLL_POSITION)
        const isReturning = navigationType === 'POP' && savedScrollPosition
        
        // If this is a new thread (not returning), clear saved scroll position
        if (!isReturning && savedScrollPosition) {
          try {
            sessionStorage.removeItem(WEBSKY_THREAD_SCROLL_POSITION)
            log.debug('Thread', 'Cleared saved thread scroll position for new thread')
          } catch (error) {
            log.warn('Thread', 'Failed to clear thread scroll position:', error)
          }
        }
        
        if (isReturning && savedScrollPosition) {
          // Restore saved scroll position when returning via back navigation
          const scrollY = parseInt(savedScrollPosition, 10)
          if (!isNaN(scrollY) && scrollY > 0) {
            const currentScroll = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
            
            // Only restore if we're near the top (meaning restoration hasn't happened yet)
            if (currentScroll < 100) {
              log.debug('Thread', 'Restoring thread scroll position after load:', scrollY)
              scrollRestoredRef.current = true
              
              // Use retry mechanism to ensure DOM is ready
              const attemptRestore = (attempt: number = 1) => {
                const maxAttempts = 10
                const baseDelay = 100
                const delay = attempt * baseDelay
                
                setTimeout(() => {
                  requestAnimationFrame(() => {
                    const scrollHeight = document.documentElement.scrollHeight
                    const clientHeight = window.innerHeight
                    const maxScroll = Math.max(scrollHeight - clientHeight, 0)
                    const targetScroll = Math.min(scrollY, maxScroll)
                    
                    if (targetScroll > 0 && scrollHeight > clientHeight && scrollHeight >= targetScroll) {
                      isProgrammaticScrollRef.current = true
                      window.scrollTo(0, targetScroll)
                      document.documentElement.scrollTop = targetScroll
                      document.body.scrollTop = targetScroll
                      
                      log.debug('Thread', 'Thread scroll position restored:', targetScroll)
                      
                      setTimeout(() => {
                        isProgrammaticScrollRef.current = false
                      }, 300)
                    } else if (attempt < maxAttempts) {
                      attemptRestore(attempt + 1)
                    } else {
                      isProgrammaticScrollRef.current = false
                      log.debug('Thread', 'Max attempts reached for thread scroll restoration')
                    }
                  })
                }, delay)
              }
              
              attemptRestore()
            } else {
              scrollRestoredRef.current = true
              log.debug('Thread', 'Thread scroll already positioned, skipping restoration')
            }
          } else {
            scrollRestoredRef.current = true
          }
        } else {
          // New navigation: scroll to top
          scrollRestoredRef.current = true
          window.scrollTo(0, 0)
        }
      } catch (error) {
        log.warn('Thread', 'Failed to restore thread scroll position:', error)
        scrollRestoredRef.current = true
      }
    }
  }, [location.pathname, isLoading, thread, clickedPostUri, navigationType])

  // Step 5: Save scroll position during scrolling (debounced)
  useEffect(() => {
    if (!location.pathname.startsWith('/post/')) return
    
    const handleScroll = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop
      
      // Don't save during programmatic scrolls
      if (isProgrammaticScrollRef.current) {
        return
      }
      
      // Clear saved position if scrolled to top
      if (scrollY < 50) {
        try {
          sessionStorage.removeItem(WEBSKY_THREAD_SCROLL_POSITION)
        } catch (error) {
          log.warn('Thread', 'Failed to clear thread scroll position:', error)
        }
        return
      }
      
      // Debounce scroll position save
      if (scrollSaveTimeoutRef.current) {
        clearTimeout(scrollSaveTimeoutRef.current)
      }
      scrollSaveTimeoutRef.current = setTimeout(() => {
        try {
          sessionStorage.setItem(WEBSKY_THREAD_SCROLL_POSITION, scrollY.toString())
        } catch (error) {
          log.warn('Thread', 'Failed to save thread scroll position:', error)
        }
      }, 200)
    }
    
    window.addEventListener('scroll', handleScroll, { passive: true })
    
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (scrollSaveTimeoutRef.current) {
        clearTimeout(scrollSaveTimeoutRef.current)
      }
    }
  }, [location.pathname])

  // Track scroll position for scroll-to-top button
  useEffect(() => {
    const handleScrollForButton = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop
      setIsScrolledDown(scrollY > 300)
    }

    window.addEventListener('scroll', handleScrollForButton, { passive: true })
    return () => window.removeEventListener('scroll', handleScrollForButton)
  }, [])

  const handleScrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Helper: determine where a post lives and get its viewer state.
  // Returns 'anchor' | 'chain' | 'reply' so each handler updates only the correct state.
  const classifyPost = (uri: string): { location: 'anchor' | 'chain' | 'reply', viewer: AppBskyFeedDefs.ViewerState | undefined } => {
    if (!thread) return { location: 'reply', viewer: undefined }
    if (thread.post.uri === uri) return { location: 'anchor', viewer: thread.post.viewer }
    const chainPost = selfReplyChain.find(p => p.uri === uri)
    if (chainPost) return { location: 'chain', viewer: chainPost.viewer }
    const reply = ((thread.replies || []) as AppBskyFeedDefs.ThreadViewPost[])
      .find(r => 'post' in r && r.post.uri === uri)
    return { location: 'reply', viewer: reply?.post.viewer }
  }

  // Helpers to update a single post in thread state or chain state
  const updateAnchorPost = (updater: (post: AppBskyFeedDefs.PostView) => AppBskyFeedDefs.PostView) => {
    setThread(prev => prev ? { ...prev, post: updater(prev.post) } : null)
  }
  const updateReplyPost = (uri: string, updater: (post: AppBskyFeedDefs.PostView) => AppBskyFeedDefs.PostView) => {
    setThread(prev => {
      if (!prev) return null
      return {
        ...prev,
        replies: (prev.replies || []).map((r: any) =>
          'post' in r && r.post.uri === uri ? { ...r, post: updater(r.post) } : r
        ),
      }
    })
  }
  const updateChainPost = (uri: string, updater: (post: AppBskyFeedDefs.PostView) => AppBskyFeedDefs.PostView) => {
    setSelfReplyChain(prev => prev.map(p => p.uri === uri ? updater(p) : p))
  }

  // Dispatch an update to the correct state based on post location
  const updatePost = (uri: string, location: 'anchor' | 'chain' | 'reply', updater: (post: AppBskyFeedDefs.PostView) => AppBskyFeedDefs.PostView) => {
    if (location === 'anchor') updateAnchorPost(updater)
    else if (location === 'chain') updateChainPost(uri, updater)
    else updateReplyPost(uri, updater)
  }

  const handleLike = async (uri: string, cid: string) => {
    if (!agent || !thread) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const { location, viewer } = classifyPost(uri)
    const originalLikeUri = viewer?.like
    const isLiked = !!originalLikeUri

    // Optimistic update - only update count, not the like URI
    updatePost(uri, location, p => ({ ...p, likeCount: (p.likeCount || 0) + (isLiked ? -1 : 1) }))

    try {
      if (isLiked && originalLikeUri) {
        await unlikePost(agent, originalLikeUri)
        updatePost(uri, location, p => ({ ...p, viewer: { ...p.viewer, like: undefined } }))
      } else {
        const likeResponse = await likePost(agent, uri, cid)
        updatePost(uri, location, p => ({ ...p, viewer: { ...p.viewer, like: likeResponse.uri } }))
      }
    } catch (error) {
      loadThread()
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }

  const handleBookmark = async (uri: string, cid: string) => {
    if (!agent || !thread) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const { location, viewer } = classifyPost(uri)
    const wasBookmarked = !!viewer?.bookmarked

    // Optimistic update
    updatePost(uri, location, p => ({ ...p, viewer: { ...p.viewer, bookmarked: !wasBookmarked } }))

    try {
      if (wasBookmarked) {
        await unbookmarkPost(agent, uri)
      } else {
        await bookmarkPost(agent, uri, cid)
      }
    } catch (error) {
      // Revert
      updatePost(uri, location, p => ({ ...p, viewer: { ...p.viewer, bookmarked: wasBookmarked } }))
      addToast(error instanceof Error ? error.message : 'Failed to update bookmark', 'error')
    }
  }

  const handleRepost = async (uri: string, cid: string) => {
    if (!agent || !thread) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    const { location, viewer } = classifyPost(uri)
    const originalRepostUri = viewer?.repost
    const isReposted = !!originalRepostUri

    // Optimistic update - only update count, not the repost URI
    updatePost(uri, location, p => ({ ...p, repostCount: (p.repostCount || 0) + (isReposted ? -1 : 1) }))

    try {
      if (isReposted && originalRepostUri) {
        await removeRepost(agent, originalRepostUri)
        updatePost(uri, location, p => ({ ...p, viewer: { ...p.viewer, repost: undefined } }))
      } else {
        const repostResponse = await repost(agent, uri, cid)
        updatePost(uri, location, p => ({ ...p, viewer: { ...p.viewer, repost: repostResponse.uri } }))
      }
    } catch (error) {
      loadThread()
      addToast(error instanceof Error ? error.message : 'Failed to update repost', 'error')
    }
  }

  const handleQuotePost = (post: AppBskyFeedDefs.PostView) => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    setQuotePost(post)
    setReplyToUri(null)
    setShowCompose(true)
  }

  const handleReply = (uri: string) => {
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }
    setReplyToUri(uri)
    setQuotePost(null)
    setShowCompose(true)
  }

  const handlePost = async (text: string, replyTo?: { uri: string; cid: string; rootUri?: string; rootCid?: string }, quotePost?: AppBskyFeedDefs.PostView, images?: Array<{ image: Blob; alt: string }>, ogImage?: { url: string; title: string; description: string }) => {
    if (!agent || !thread) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    if (quotePost) {
      await createQuotePost(agent, {
        text,
        quotedPost: {
          uri: quotePost.uri,
          cid: quotePost.cid,
        },
      })
      addToast('Quote post created!', 'success')
    } else {
      const buildEmbed = () => {
        if (images && images.length > 0) return { images }
        if (ogImage) return { external: { uri: ogImage.url, title: ogImage.title, description: ogImage.description, thumbUrl: ogImage.url } }
        return undefined
      }
      await createPost(agent, {
        text,
        replyTo: replyTo || {
          uri: thread.post.uri,
          cid: thread.post.cid,
          rootUri: thread.post.uri,
          rootCid: thread.post.cid,
        },
        embed: buildEmbed(),
      })
      addToast('Reply posted!', 'success')
    }
    await loadThread()
  }

  const handleDeletePost = async (uri: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    try {
      await deletePost(agent, uri)
      // If deleting the anchor post, navigate back
      if (thread && uri === thread.post.uri) {
        addToast('Post deleted', 'success')
        navigate(-1)
      } else {
        addToast('Post deleted', 'success')
        await loadThread()
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to delete post', 'error')
    }
  }

  const handlePinPost = async (uri: string, cid: string) => {
    if (!agent) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    try {
      await pinPost(agent, uri, cid)
      addToast('Post pinned to your profile', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to pin post', 'error')
    }
  }

  const handlePostThread = async (
    segments: Array<{ text: string; images: Array<{ image: Blob; alt: string }>; ogImage?: { url: string; title: string; description: string } }>,
    replyTo?: { uri: string; cid: string; rootUri?: string; rootCid?: string }
  ) => {
    if (!agent || !thread) return
    if (isReadOnlyMode()) { addToast('Disable Read-only mode in Settings to do this', 'error'); return }

    // Default replyTo is the current thread post
    const effectiveReplyTo = replyTo || {
      uri: thread.post.uri,
      cid: thread.post.cid,
      rootUri: thread.post.uri,
      rootCid: thread.post.cid,
    }

    let previousUri = effectiveReplyTo.uri
    let previousCid = effectiveReplyTo.cid
    const rootUri = effectiveReplyTo.rootUri || effectiveReplyTo.uri
    const rootCid = effectiveReplyTo.rootCid || effectiveReplyTo.cid

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const buildSegEmbed = () => {
        if (seg.images.length > 0) return { images: seg.images }
        if (seg.ogImage) return { external: { uri: seg.ogImage.url, title: seg.ogImage.title, description: seg.ogImage.description, thumbUrl: seg.ogImage.url } }
        return undefined
      }
      const result = await createPost(agent, {
        text: seg.text,
        replyTo: { uri: previousUri, cid: previousCid, rootUri, rootCid },
        embed: buildSegEmbed(),
      })
      previousUri = result.uri
      previousCid = result.cid
    }

    addToast(`Thread posted! (${segments.length} posts)`, 'success')
    await loadThread()
  }

  // Helper function to count nested replies recursively
  const getNestedReplyCount = (replyThread: AppBskyFeedDefs.ThreadViewPost): number => {
    if (!replyThread.replies || replyThread.replies.length === 0) return 0
    let count = replyThread.replies.length
    replyThread.replies.forEach(r => {
      if ('post' in r) {
        count += getNestedReplyCount(r as AppBskyFeedDefs.ThreadViewPost)
      }
    })
    return count
  }

  // Helper function to normalize URIs for comparison (handles encoding differences)
  const normalizeUri = (uri: string): string => {
    try {
      // Decode and re-encode to normalize
      return decodeURIComponent(uri)
    } catch {
      return uri
    }
  }

  // Helper function to check if URIs match (with normalization)
  const urisMatch = (uri1: string | null, uri2: string | null): boolean => {
    if (!uri1 || !uri2) return false
    return normalizeUri(uri1) === normalizeUri(uri2)
  }

  // Helper function to check if a post or any of its nested replies matches the highlighted URI
  const findPostInThread = (threadItem: AppBskyFeedDefs.ThreadViewPost, targetUri: string): boolean => {
    if (urisMatch(threadItem.post.uri, targetUri)) {
      return true
    }
    if (threadItem.replies) {
      for (const reply of threadItem.replies) {
        if ('post' in reply) {
          if (findPostInThread(reply as AppBskyFeedDefs.ThreadViewPost, targetUri)) {
            return true
          }
        }
      }
    }
    return false
  }

  const renderThread = (threadItem: AppBskyFeedDefs.ThreadViewPost, highlightedUri: string | null, _isSecondaryView: boolean = false, isAnchor: boolean = false): React.ReactNode => {
    const unsortedReplies = threadItem.replies || []
    const opDid = threadItem.post.author.did
    const postReplies = unsortedReplies
      .filter(r => 'post' in r) as AppBskyFeedDefs.ThreadViewPost[]
    const nonPostReplies = unsortedReplies.filter(r => !('post' in r))
    const opReplies = postReplies
      .filter(r => r.post.author.did === opDid)
      .sort((a, b) => new Date(a.post.indexedAt).getTime() - new Date(b.post.indexedAt).getTime())
    const otherReplies = postReplies
      .filter(r => r.post.author.did !== opDid)
      .sort((a, b) => {
        const likeDiff = (b.post.likeCount || 0) - (a.post.likeCount || 0)
        if (likeDiff !== 0) return likeDiff
        return new Date(a.post.indexedAt).getTime() - new Date(b.post.indexedAt).getTime()
      })
    const replies = [...opReplies, ...otherReplies, ...nonPostReplies]
    const firstOpReplyUri = opReplies.length > 0 ? opReplies[0].post.uri : null
    const isHighlighted = urisMatch(highlightedUri, threadItem.post.uri)

    // Engagement counts for anchor post
    const repostCount = threadItem.post.repostCount || 0
    const likeCount = threadItem.post.likeCount || 0
    const hasEngagement = isAnchor && (repostCount > 0 || likeCount > 0)

    // Engagement stats element to pass to PostCard
    const engagementStatsElement = hasEngagement ? (
      <div className="py-2 flex items-center gap-6 text-sm text-gray-600 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700/50 mt-2">
        {repostCount > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setEngagementModal({
                isOpen: true,
                type: 'reposts',
                postUri: threadItem.post.uri,
                count: repostCount
              })
            }}
            className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors"
          >
            <span className="font-semibold text-gray-900 dark:text-gray-100">{repostCount.toLocaleString()}</span>{' '}
            {repostCount === 1 ? 'Repost' : 'Reposts'}
          </button>
        )}
        {likeCount > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setEngagementModal({
                isOpen: true,
                type: 'likes',
                postUri: threadItem.post.uri,
                count: likeCount
              })
            }}
            className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors"
          >
            <span className="font-semibold text-gray-900 dark:text-gray-100">{likeCount.toLocaleString()}</span>{' '}
            {likeCount === 1 ? 'Like' : 'Likes'}
          </button>
        )}
      </div>
    ) : undefined

    return (
      <div
        key={threadItem.post.uri}
        ref={(el) => {
          if (isHighlighted) {
            highlightedPostRef.current = el
          }
        }}
      >
        <div className="border-b border-gray-200 dark:border-gray-700">
          <PostCard
            post={{
              post: threadItem.post,
            } as AppBskyFeedDefs.FeedViewPost}
            onReply={handleReply}
            onRepost={handleRepost}
            onQuotePost={handleQuotePost}
            onLike={handleLike}
            onBookmark={handleBookmark}
            onDeletePost={handleDeletePost}
            onPinPost={handlePinPost}
            showRootPost={false}
            engagementStats={engagementStatsElement}
            stackedLayout={true}
          />
        </div>
        {replies.length > 0 && (
          <div>
            {/* Only show up to repliesDisplayCount replies */}
            {replies.slice(0, repliesDisplayCount).map((reply) => {
              if ('post' in reply) {
                const replyThread = reply as AppBskyFeedDefs.ThreadViewPost
                const nestedCount = getNestedReplyCount(replyThread)
                const isReplyHighlighted = urisMatch(highlightedUri, replyThread.post.uri)
                const hasHighlightedNested = highlightedUri !== null && findPostInThread(replyThread, highlightedUri) && !isReplyHighlighted
                const isFirstChainReply = isAnchor && firstOpReplyUri && urisMatch(firstOpReplyUri, replyThread.post.uri) && (selfReplyChain.length > 0 || isLoadingChain)

                // First same-author reply with a chain: render entirely via SelfReplyChain
                if (isFirstChainReply) {
                  return (
                    <div key={replyThread.post.uri} className="relative">
                      <SelfReplyChain
                        firstPost={replyThread.post}
                        chainPosts={selfReplyChain}
                        isLoading={isLoadingChain}
                        mayHaveMore={chainMayHaveMore}
                        onLoadMore={handleLoadMoreChain}
                        onLike={handleLike}
                        onRepost={handleRepost}
                        onQuotePost={handleQuotePost}
                        onReply={handleReply}
                        onBookmark={handleBookmark}
                        onDeletePost={handleDeletePost}
                        onPinPost={handlePinPost}
                        isOwnPost={replyThread.post.author?.did === session?.did}
                      />
                    </div>
                  )
                }

                return (
                  <div
                    key={replyThread.post.uri}
                    className="relative mb-2"
                    ref={(el) => {
                      if (isReplyHighlighted) {
                        highlightedPostRef.current = el
                      }
                    }}
                  >
                    {/* Clickable reply card */}
                    <div
                      className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-lg transition-colors ${
                        isReplyHighlighted ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20 rounded-lg' : ''
                      } ${
                        hasHighlightedNested ? 'ring-2 ring-blue-400 bg-blue-50/50 dark:bg-blue-900/10' : ''
                      }`}
                    >
                      <PostCard
                        post={{
                          post: replyThread.post,
                        } as AppBskyFeedDefs.FeedViewPost}
                        onReply={handleReply}
                        onRepost={handleRepost}
                        onQuotePost={handleQuotePost}
                        onLike={handleLike}
                        onBookmark={handleBookmark}
                        onDeletePost={handleDeletePost}
                        onPinPost={handlePinPost}
                        showRootPost={false}
                        highlighted={isReplyHighlighted}
                      />
                    </div>

                    {/* Nested reply count indicator */}
                    {nestedCount > 0 && (
                      <div className="ml-4 mt-1 mb-3 text-sm text-gray-500 dark:text-gray-400">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const encodedUri = encodeURIComponent(replyThread.post.uri)
                            navigate(`/post/${encodedUri}`)
                          }}
                          className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors"
                        >
                          {nestedCount} {nestedCount === 1 ? 'reply' : 'replies'}
                          {hasHighlightedNested && ' (clicked post inside)'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              }
              return null
            })}

            {/* Load More button when there are more replies */}
            {replies.length > repliesDisplayCount && (
              <div className="py-4 text-center">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setRepliesDisplayCount(prev => prev + REPLIES_PAGE_LENGTH)
                  }}
                  className="px-6 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                >
                  Load More ({replies.length - repliesDisplayCount} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!thread) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p>Thread not found</p>
      </div>
    )
  }

  // Compute replyTo data for Compose (includes parent post text for preview)
  const composeReplyTo = (() => {
    if (!replyToUri) return undefined
    // Search the thread tree for the post being replied to
    const searchThread = (node: AppBskyFeedDefs.ThreadViewPost, uri: string): AppBskyFeedDefs.PostView | undefined => {
      if (node.post.uri === uri) return node.post
      for (const reply of node.replies || []) {
        if (AppBskyFeedDefs.isThreadViewPost(reply)) {
          const result = searchThread(reply, uri)
          if (result) return result
        }
      }
      return undefined
    }
    const found = searchThread(thread, replyToUri)
    const fromParents = !found ? parentChain.find(p => p.uri === replyToUri) : undefined
    const post = (found || fromParents || thread.post) as AppBskyFeedDefs.PostView
    const record = post.record as Record<string, unknown> | undefined
    return {
      uri: replyToUri,
      cid: post.cid,
      rootUri: thread.post.uri,
      rootCid: thread.post.cid,
      text: record?.text as string | undefined,
      facets: record?.facets as AppBskyRichtextFacet.Main[] | undefined,
      authorName: post.author.displayName,
      authorHandle: post.author.handle,
    }
  })()

  return (
    <div className="pb-20 md:pb-0">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Thread</h1>
          {thread && (
            <a
              href={getPostUrl(thread.post.uri, thread.post.author.handle)}
              className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
            >
              View on Bluesky ↗
            </a>
          )}
        </div>
      </div>
      {/* Parent chain view - shows context above the clicked post */}
      {(parentChain.length > 0 || isLoadingParents) && (
        <ParentChainView
          parents={parentChain}
          rootUri={rootUri}
          isLoading={isLoadingParents}
        />
      )}

      {/* Anchor post and replies */}
      {renderThread(thread, clickedPostUri, parentChain.length > 0 || isLoadingParents, true)}

      <Compose
        isOpen={showCompose}
        onClose={() => {
          setShowCompose(false)
          setReplyToUri(null)
          setQuotePost(null)
        }}
        replyTo={composeReplyTo}
        quotePost={quotePost || undefined}
        onPost={handlePost}
        onPostThread={handlePostThread}
      />

      {/* Floating compose button to reply to thread post */}
      {thread && (
        <button
          onClick={() => {
            if (isReadOnlyMode()) {
              addToast('Disable Read-only mode in Settings to do this', 'error')
              return
            }
            setReplyToUri(thread.post.uri)
            setQuotePost(null)
            setShowCompose(true)
          }}
          className="fixed bottom-20 right-6 md:bottom-8 md:right-8 bg-blue-500 hover:bg-blue-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-14 h-14"
          aria-label="Reply to post"
        >
          <PencilIcon className="w-7 h-7" />
          {isReadOnlyMode() && (
            <span className="absolute inset-0 flex items-center justify-center text-red-500 text-6xl font-thin pointer-events-none -mt-1">&times;</span>
          )}
        </button>
      )}

      {/* Scroll to top arrow - shown when scrolled down */}
      {isScrolledDown && (
        <button
          onClick={handleScrollToTop}
          className="fixed bottom-6 left-6 md:bottom-8 md:left-8 bg-blue-100 hover:bg-blue-200 text-blue-600 dark:bg-blue-900/40 dark:hover:bg-blue-900/60 dark:text-blue-400 p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-12 h-12"
          aria-label="Scroll to top"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
        </button>
      )}

      {/* Engagement list modal */}
      <EngagementList
        isOpen={engagementModal.isOpen}
        onClose={() => setEngagementModal(prev => ({ ...prev, isOpen: false }))}
        postUri={engagementModal.postUri}
        type={engagementModal.type}
        count={engagementModal.count}
      />

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}

