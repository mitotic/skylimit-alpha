import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate, useLocation, useNavigationType } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { searchActors, searchPosts } from '../api/search'
import { follow, unfollow } from '../api/social'
import Avatar from '../components/Avatar'
import Button from '../components/Button'
import Spinner from '../components/Spinner'
import PostCard from '../components/PostCard'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import { clientNow } from '../utils/clientClock'

type SearchTab = 'people' | 'posts'

// sessionStorage keys
const SEARCH_STATE_KEY = 'websky_search_state'
const SEARCH_SCROLL_KEY = 'websky_search_scroll_position'

// Discard saved state if older than 5 minutes
const SEARCH_IDLE_INTERVAL = 5 * 60 * 1000

interface SavedSearchState {
  query: string
  activeTab: SearchTab
  results: any[]
  postResults: AppBskyFeedDefs.PostView[]
  postCursor: string | undefined
  savedAt: number
}

export default function SearchPage() {
  const { agent } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SearchTab>('people')
  const [results, setResults] = useState<any[]>([])
  const [postResults, setPostResults] = useState<AppBskyFeedDefs.PostView[]>([])
  const [postCursor, setPostCursor] = useState<string | undefined>()
  const [isSearching, setIsSearching] = useState(false)
  const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [isScrolledDown, setIsScrolledDown] = useState(false)

  // Refs for state preservation
  const scrollRestoredRef = useRef(false)
  const isProgrammaticScrollRef = useRef(false)
  const scrollSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isRestoringRef = useRef(false)

  // Ref to capture latest state for saving on unmount
  const stateRef = useRef({ query, activeTab, results, postResults, postCursor })

  // Disable browser scroll restoration
  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual'
    }
  }, [])

  // Restore search state on mount if returning via back navigation
  useEffect(() => {
    if (navigationType !== 'POP') {
      // Fresh navigation — clear any stale saved state
      try {
        sessionStorage.removeItem(SEARCH_STATE_KEY)
        sessionStorage.removeItem(SEARCH_SCROLL_KEY)
      } catch {
        // Ignore
      }
      return
    }

    try {
      const savedStateJson = sessionStorage.getItem(SEARCH_STATE_KEY)
      if (!savedStateJson) return

      const savedState: SavedSearchState = JSON.parse(savedStateJson)

      // Check idle interval
      const timeSinceSave = clientNow() - savedState.savedAt
      if (timeSinceSave > SEARCH_IDLE_INTERVAL) {
        sessionStorage.removeItem(SEARCH_STATE_KEY)
        sessionStorage.removeItem(SEARCH_SCROLL_KEY)
        return
      }

      // Restore state
      isRestoringRef.current = true
      setQuery(savedState.query)
      setActiveTab(savedState.activeTab)
      setResults(savedState.results)
      setPostResults(savedState.postResults)
      setPostCursor(savedState.postCursor)

      // Allow a tick for state to settle
      setTimeout(() => {
        isRestoringRef.current = false
      }, 100)
    } catch (error) {
      console.warn('Failed to restore search state:', error)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Restore scroll position after search state is restored
  useEffect(() => {
    if (location.pathname !== '/search') return
    if (scrollRestoredRef.current) return
    if (navigationType !== 'POP') {
      scrollRestoredRef.current = true
      return
    }

    // Wait for results to be populated before restoring scroll
    const hasResults = results.length > 0 || postResults.length > 0
    if (!hasResults) return

    const savedScrollY = sessionStorage.getItem(SEARCH_SCROLL_KEY)
    if (!savedScrollY) {
      scrollRestoredRef.current = true
      return
    }

    const scrollY = parseInt(savedScrollY, 10)
    if (isNaN(scrollY) || scrollY <= 0) {
      scrollRestoredRef.current = true
      return
    }

    scrollRestoredRef.current = true

    // Retry loop: 3 attempts at increasing delays
    const attemptRestore = (attempt: number = 1) => {
      const maxAttempts = 3
      const delay = attempt * 100

      setTimeout(() => {
        requestAnimationFrame(() => {
          const scrollHeight = document.documentElement.scrollHeight
          const clientHeight = window.innerHeight
          const maxScroll = Math.max(scrollHeight - clientHeight, 0)
          const targetScroll = Math.min(scrollY, maxScroll)

          if (targetScroll > 0 && scrollHeight > clientHeight) {
            isProgrammaticScrollRef.current = true
            window.scrollTo(0, targetScroll)

            setTimeout(() => {
              isProgrammaticScrollRef.current = false
            }, 300)
          } else if (attempt < maxAttempts) {
            attemptRestore(attempt + 1)
          }
        })
      }, delay)
    }

    attemptRestore()
  }, [location.pathname, navigationType, results, postResults])

  // Keep stateRef in sync with current state values
  useEffect(() => {
    stateRef.current = { query, activeTab, results, postResults, postCursor }
  }, [query, activeTab, results, postResults, postCursor])

  // Save search state on unmount (when navigating away from search page)
  // Note: scroll position is saved continuously by the scroll listener effect,
  // so we don't save it here (window.scrollY may already be 0 during unmount)
  useEffect(() => {
    return () => {
      const { query: q, activeTab: tab, results: r, postResults: pr, postCursor: pc } = stateRef.current

      // Only save if there's a query with results
      if (q.trim() && (r.length > 0 || pr.length > 0)) {
        const searchState: SavedSearchState = {
          query: q,
          activeTab: tab,
          results: r,
          postResults: pr,
          postCursor: pc,
          savedAt: clientNow()
        }

        try {
          sessionStorage.setItem(SEARCH_STATE_KEY, JSON.stringify(searchState))
        } catch (error) {
          console.warn('Failed to save search state:', error)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track scroll position for scroll-to-top button AND state preservation
  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop
      setIsScrolledDown(scrollY > 300)

      // Don't save during programmatic scrolls
      if (isProgrammaticScrollRef.current) return

      // Debounce scroll position save
      if (scrollSaveTimeoutRef.current) {
        clearTimeout(scrollSaveTimeoutRef.current)
      }
      scrollSaveTimeoutRef.current = setTimeout(() => {
        try {
          if (scrollY < 50) {
            sessionStorage.removeItem(SEARCH_SCROLL_KEY)
          } else {
            sessionStorage.setItem(SEARCH_SCROLL_KEY, scrollY.toString())
          }
        } catch {
          // Ignore
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
  }, [])

  const handleScrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  const debouncedSearchActors = useCallback(
    (() => {
      let timeout: ReturnType<typeof setTimeout>
      return (searchQuery: string) => {
        clearTimeout(timeout)
        timeout = setTimeout(async () => {
          if (!searchQuery.trim() || !agent) {
            setResults([])
            return
          }

          setIsSearching(true)
          try {
            const data = await searchActors(agent, searchQuery, 25)
            setResults(data.actors || [])
          } catch (error) {
            console.error('Search failed:', error)
            addToast(error instanceof Error ? error.message : 'Search failed', 'error')
            setResults([])
          } finally {
            setIsSearching(false)
          }
        }, 500)
      }
    })(),
    [agent]
  )

  const debouncedSearchPosts = useCallback(
    (() => {
      let timeout: ReturnType<typeof setTimeout>
      return (searchQuery: string) => {
        clearTimeout(timeout)
        timeout = setTimeout(async () => {
          if (!searchQuery.trim() || !agent) {
            setPostResults([])
            setPostCursor(undefined)
            return
          }

          setIsSearching(true)
          try {
            const data = await searchPosts(agent, searchQuery, 25)
            setPostResults(data.posts || [])
            setPostCursor(data.cursor)
          } catch (error) {
            console.error('Post search failed:', error)
            addToast(error instanceof Error ? error.message : 'Post search failed', 'error')
            setPostResults([])
            setPostCursor(undefined)
          } finally {
            setIsSearching(false)
          }
        }, 500)
      }
    })(),
    [agent]
  )

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setQuery(value)
    if (activeTab === 'people') {
      debouncedSearchActors(value)
    } else {
      debouncedSearchPosts(value)
    }
  }

  const handleTabChange = (tab: SearchTab) => {
    if (tab === activeTab) return
    setActiveTab(tab)
    if (query.trim()) {
      if (tab === 'people') {
        debouncedSearchActors(query)
      } else {
        debouncedSearchPosts(query)
      }
    }
  }

  const handleLoadMorePosts = async () => {
    if (!agent || !postCursor || !query.trim()) return
    setIsLoadingMorePosts(true)
    try {
      const data = await searchPosts(agent, query, 25, postCursor)
      setPostResults(prev => [...prev, ...(data.posts || [])])
      setPostCursor(data.cursor)
    } catch (error) {
      console.error('Failed to load more posts:', error)
      addToast(error instanceof Error ? error.message : 'Failed to load more posts', 'error')
    } finally {
      setIsLoadingMorePosts(false)
    }
  }

  const handleFollow = async (did: string, currentFollowing?: string) => {
    if (!agent) return

    try {
      if (currentFollowing) {
        await unfollow(agent, currentFollowing)
        addToast('Unfollowed', 'success')
      } else {
        await follow(agent, did)
        addToast('Following', 'success')
      }
      // Refresh results
      if (query.trim()) {
        debouncedSearchActors(query)
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to update follow status', 'error')
    }
  }

  return (
    <div className="pb-20 md:pb-0">
      <div className="sticky top-0 z-30 bg-white dark:bg-gray-900">
        {/* Header */}
        <div className="p-4 pb-0">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Search</h1>
            <a
              href="https://bsky.app/search"
              className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
            >
              View on Bluesky ↗
            </a>
          </div>
        </div>
        <div className="px-4 py-3">
          <input
            type="text"
            value={query}
            onChange={handleSearchChange}
            placeholder={activeTab === 'people' ? "Search for people..." : "Search for posts..."}
            className="input w-full"
          />
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          {(['people', 'posts'] as SearchTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => handleTabChange(tab)}
              className={`flex-1 px-4 py-3 text-center font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'border-b-2 border-blue-500 text-blue-500'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Results area */}
      <div className={activeTab === 'people' ? 'p-4' : 'pt-2'}>
        {isSearching && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="lg" />
          </div>
        )}

        {!isSearching && query.trim() && activeTab === 'people' && results.length === 0 && (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>No people found</p>
          </div>
        )}

        {!isSearching && query.trim() && activeTab === 'posts' && postResults.length === 0 && (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>No posts found</p>
          </div>
        )}

        {!isSearching && !query.trim() && (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>{activeTab === 'people'
              ? 'Search for people by username or display name'
              : 'Search for posts by keyword or phrase'
            }</p>
          </div>
        )}

        {/* People results */}
        {!isSearching && activeTab === 'people' && results.length > 0 && (
          <div className="space-y-4">
            {results.map((actor) => (
              <div
                key={actor.did}
                className="flex items-center gap-4 p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer"
                onClick={() => navigate(`/profile/${actor.handle}`)}
              >
                <Avatar
                  src={actor.avatar}
                  alt={actor.displayName || actor.handle}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{actor.displayName || actor.handle}</div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">@{actor.handle}</div>
                  {actor.description && (
                    <div className="text-sm text-gray-600 dark:text-gray-300 mt-1 line-clamp-2">
                      {actor.description}
                    </div>
                  )}
                </div>
                <Button
                  variant={actor.viewer?.following ? "secondary" : "primary"}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleFollow(actor.did, actor.viewer?.following)
                  }}
                >
                  {actor.viewer?.following ? 'Following' : 'Follow'}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Post results */}
        {!isSearching && activeTab === 'posts' && postResults.length > 0 && (
          <div>
            {postResults.map((post) => (
              <PostCard
                key={post.uri}
                post={{ post } as AppBskyFeedDefs.FeedViewPost}
                showRootPost={false}
              />
            ))}

            {postCursor && (
              <div className="p-4 text-center">
                <Button
                  variant="secondary"
                  onClick={handleLoadMorePosts}
                  disabled={isLoadingMorePosts}
                >
                  {isLoadingMorePosts ? (
                    <span className="flex items-center gap-2">
                      <Spinner size="sm" />
                      Loading...
                    </span>
                  ) : (
                    'Load More'
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

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

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}
