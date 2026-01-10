import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import { useParams, useSearchParams, useNavigate, useLocation, useNavigationType } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getPostThread, fetchParentChain } from '../api/feed'
import { likePost, unlikePost, repost, removeRepost, createPost, createQuotePost } from '../api/posts'
import PostCard from '../components/PostCard'
import ParentChainView from '../components/ParentChainView'
import Compose from '../components/Compose'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import EngagementList from '../components/EngagementList'

// Scroll state preservation constant for thread pages
const WEBSKY9_THREAD_SCROLL_POSITION = 'websky9_thread_scroll_position'

// Pagination constants for replies
const REPLIES_PAGE_LENGTH = 25
const REPLIES_INITIAL_PAGES = 2 // Show 2 pages initially (50 replies)

export default function ThreadPage() {
  const { uri } = useParams<{ uri: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const { agent } = useSession()
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

  const loadThread = useCallback(async () => {
    if (!agent || !uri) return

    try {
      const decodedUri = decodeURIComponent(uri)

      // Reset parent chain and pagination state
      setParentChain([])
      setIsLoadingParents(false)
      setRepliesDisplayCount(REPLIES_PAGE_LENGTH * REPLIES_INITIAL_PAGES)

      // Focused Thread View: Keep the clicked post as the anchor
      // Fetch with depth=1 to get direct replies only
      const threadData = await getPostThread(agent, decodedUri, 1)

      if (!threadData.thread || !('post' in threadData.thread)) {
        throw new Error('Thread data not found')
      }

      const threadPost = threadData.thread as AppBskyFeedDefs.ThreadViewPost
      setThread(threadPost)
      setClickedPostUri(null) // No highlighting needed - anchor post is prominent by default

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

      // Fetch parent chain in background if this is a reply
      if (record?.reply?.parent?.uri) {
        setIsLoadingParents(true)
        try {
          const chain = await fetchParentChain(agent, record.reply.parent.uri, 5)
          setParentChain(chain)
        } catch (parentError) {
          console.warn('Failed to fetch parent chain:', parentError)
          // Non-fatal - we still show the thread without parent context
        } finally {
          setIsLoadingParents(false)
        }
      }

      // Check if we should show compose (from query param)
      if (searchParams.get('reply') === 'true') {
        setReplyToUri(decodedUri)
        setShowCompose(true)
      }
    } catch (error) {
      console.error('Failed to load thread:', error)
      addToast(error instanceof Error ? error.message : 'Failed to load thread', 'error')
    } finally {
      setIsLoading(false)
    }
  }, [agent, uri, searchParams])

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
        sessionStorage.setItem(WEBSKY9_THREAD_SCROLL_POSITION, scrollY.toString())
        console.log('Saved thread scroll position before navigation:', scrollY)
      } catch (error) {
        console.warn('Failed to save thread scroll position:', error)
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
      const savedScrollPosition = sessionStorage.getItem(WEBSKY9_THREAD_SCROLL_POSITION)
      if (savedScrollPosition) {
        // Just prevent scroll to top, don't restore yet (content might not be loaded)
        scrollRestoredRef.current = false
        console.log('Detected return to thread page, will restore after content loads')
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
        const savedScrollPosition = sessionStorage.getItem(WEBSKY9_THREAD_SCROLL_POSITION)
        const isReturning = navigationType === 'POP' && savedScrollPosition
        
        // If this is a new thread (not returning), clear saved scroll position
        if (!isReturning && savedScrollPosition) {
          try {
            sessionStorage.removeItem(WEBSKY9_THREAD_SCROLL_POSITION)
            console.log('Cleared saved thread scroll position for new thread')
          } catch (error) {
            console.warn('Failed to clear thread scroll position:', error)
          }
        }
        
        if (isReturning && savedScrollPosition) {
          // Restore saved scroll position when returning via back navigation
          const scrollY = parseInt(savedScrollPosition, 10)
          if (!isNaN(scrollY) && scrollY > 0) {
            const currentScroll = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop
            
            // Only restore if we're near the top (meaning restoration hasn't happened yet)
            if (currentScroll < 100) {
              console.log('Restoring thread scroll position after load:', scrollY)
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
                      
                      console.log('Thread scroll position restored:', targetScroll)
                      
                      setTimeout(() => {
                        isProgrammaticScrollRef.current = false
                      }, 300)
                    } else if (attempt < maxAttempts) {
                      attemptRestore(attempt + 1)
                    } else {
                      isProgrammaticScrollRef.current = false
                      console.log('Max attempts reached for thread scroll restoration')
                    }
                  })
                }, delay)
              }
              
              attemptRestore()
            } else {
              scrollRestoredRef.current = true
              console.log('Thread scroll already positioned, skipping restoration')
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
        console.warn('Failed to restore thread scroll position:', error)
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
          sessionStorage.removeItem(WEBSKY9_THREAD_SCROLL_POSITION)
        } catch (error) {
          console.warn('Failed to clear thread scroll position:', error)
        }
        return
      }
      
      // Debounce scroll position save
      if (scrollSaveTimeoutRef.current) {
        clearTimeout(scrollSaveTimeoutRef.current)
      }
      scrollSaveTimeoutRef.current = setTimeout(() => {
        try {
          sessionStorage.setItem(WEBSKY9_THREAD_SCROLL_POSITION, scrollY.toString())
        } catch (error) {
          console.warn('Failed to save thread scroll position:', error)
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

  const handleLike = async (uri: string, cid: string) => {
    if (!agent || !thread) return

    // Capture original state BEFORE any updates
    const originalLikeUri = thread.post.viewer?.like
    const isLiked = !!originalLikeUri

    // Optimistic update - only update count, not the like URI
    setThread(prev => {
      if (!prev) return null
      return {
        ...prev,
        post: {
          ...prev.post,
          likeCount: (prev.post.likeCount || 0) + (isLiked ? -1 : 1),
        },
      }
    })

    try {
      if (isLiked && originalLikeUri) {
        await unlikePost(agent, originalLikeUri)
        // Update state to reflect unliked
        setThread(prev => {
          if (!prev) return null
          return {
            ...prev,
            post: {
              ...prev.post,
              viewer: { ...prev.post.viewer, like: undefined },
            },
          }
        })
      } else {
        const likeResponse = await likePost(agent, uri, cid)
        // Update state with real like URI so unlike works
        setThread(prev => {
          if (!prev) return null
          return {
            ...prev,
            post: {
              ...prev.post,
              viewer: { ...prev.post.viewer, like: likeResponse.uri },
            },
          }
        })
      }
    } catch (error) {
      loadThread()
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }

  const handleRepost = async (uri: string, cid: string) => {
    if (!agent || !thread) return

    // Capture original state BEFORE any updates
    const originalRepostUri = thread.post.viewer?.repost
    const isReposted = !!originalRepostUri

    // Optimistic update - only update count, not the repost URI
    setThread(prev => {
      if (!prev) return null
      return {
        ...prev,
        post: {
          ...prev.post,
          repostCount: (prev.post.repostCount || 0) + (isReposted ? -1 : 1),
        },
      }
    })

    try {
      if (isReposted && originalRepostUri) {
        await removeRepost(agent, originalRepostUri)
        // Update state to reflect unreposted
        setThread(prev => {
          if (!prev) return null
          return {
            ...prev,
            post: {
              ...prev.post,
              viewer: { ...prev.post.viewer, repost: undefined },
            },
          }
        })
      } else {
        const repostResponse = await repost(agent, uri, cid)
        // Update state with real repost URI so unrepost works
        setThread(prev => {
          if (!prev) return null
          return {
            ...prev,
            post: {
              ...prev.post,
              viewer: { ...prev.post.viewer, repost: repostResponse.uri },
            },
          }
        })
      }
    } catch (error) {
      loadThread()
      addToast(error instanceof Error ? error.message : 'Failed to update repost', 'error')
    }
  }

  const handleQuotePost = (post: AppBskyFeedDefs.PostView) => {
    setQuotePost(post)
    setReplyToUri(null)
    setShowCompose(true)
  }

  const handleReply = (uri: string) => {
    setReplyToUri(uri)
    setQuotePost(null)
    setShowCompose(true)
  }

  const handlePost = async (text: string, replyTo?: { uri: string; cid: string; rootUri?: string; rootCid?: string }, quotePost?: AppBskyFeedDefs.PostView) => {
    if (!agent || !thread) return

    try {
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
        await createPost(agent, {
          text,
          replyTo: replyTo || {
            uri: thread.post.uri,
            cid: thread.post.cid,
            rootUri: thread.post.uri,
            rootCid: thread.post.cid,
          },
        })
        addToast('Reply posted!', 'success')
      }
      loadThread()
    } catch (error) {
      throw error
    }
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

  const renderThread = (threadItem: AppBskyFeedDefs.ThreadViewPost, highlightedUri: string | null, isSecondaryView: boolean = false, isAnchor: boolean = false): React.ReactNode => {
    const replies = threadItem.replies || []
    const isHighlighted = urisMatch(highlightedUri, threadItem.post.uri)
    // Highlight anchor post in secondary view (when viewing a reply)
    const showAnchorHighlight = isSecondaryView

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
        <div className={`border-b border-gray-200 dark:border-gray-700 ${
          isHighlighted ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20 rounded-lg my-2' : ''
        } ${
          showAnchorHighlight ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20 rounded-lg mx-2 my-2' : ''
        }`}>
          <PostCard
            post={{
              post: threadItem.post,
            } as AppBskyFeedDefs.FeedViewPost}
            onReply={handleReply}
            onRepost={handleRepost}
            onQuotePost={handleQuotePost}
            onLike={handleLike}
            showRootPost={false}
            highlighted={isHighlighted || showAnchorHighlight}
            engagementStats={engagementStatsElement}
          />
        </div>
        {replies.length > 0 && (
          <div className="ml-4 md:ml-8 pl-4">
            {/* Only show up to repliesDisplayCount replies */}
            {replies.slice(0, repliesDisplayCount).map((reply) => {
              if ('post' in reply) {
                const replyThread = reply as AppBskyFeedDefs.ThreadViewPost
                const nestedCount = getNestedReplyCount(replyThread)
                const isReplyHighlighted = urisMatch(highlightedUri, replyThread.post.uri)
                // Check if the highlighted post is nested within this reply
                const hasHighlightedNested = highlightedUri !== null && findPostInThread(replyThread, highlightedUri) && !isReplyHighlighted

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
                      onClick={(e) => {
                        // Only navigate if not clicking on a button or link
                        const target = e.target as HTMLElement
                        if (
                          target.closest('button') === null &&
                          target.closest('a') === null &&
                          target.tagName !== 'BUTTON' &&
                          target.tagName !== 'A'
                        ) {
                          const encodedUri = encodeURIComponent(replyThread.post.uri)
                          navigate(`/post/${encodedUri}?from=post`)
                        }
                      }}
                    >
                      <PostCard
                        post={{
                          post: replyThread.post,
                        } as AppBskyFeedDefs.FeedViewPost}
                        onReply={handleReply}
                        onRepost={handleRepost}
                        onQuotePost={handleQuotePost}
                        onLike={handleLike}
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
                            navigate(`/post/${encodedUri}?from=post`)
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

  return (
    <div className="pb-20 md:pb-0">
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
        replyTo={replyToUri ? {
          uri: replyToUri,
          cid: thread.post.cid,
          rootUri: thread.post.uri,
          rootCid: thread.post.cid,
        } : undefined}
        quotePost={quotePost || undefined}
        onPost={handlePost}
      />

      {/* Scroll to top arrow - shown when scrolled down */}
      {isScrolledDown && (
        <button
          onClick={handleScrollToTop}
          className="fixed bottom-6 left-6 md:bottom-8 md:left-8 bg-gray-500 hover:bg-gray-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-12 h-12"
          aria-label="Scroll to top"
        >
          <span className="text-xl">↑</span>
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

