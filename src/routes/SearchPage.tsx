import React, { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { searchActors, searchPosts } from '../api/search'
import { follow, unfollow } from '../api/social'
import Avatar from '../components/Avatar'
import Button from '../components/Button'
import Spinner from '../components/Spinner'
import PostCard from '../components/PostCard'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

type SearchTab = 'people' | 'posts'

export default function SearchPage() {
  const { agent } = useSession()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SearchTab>('people')
  const [results, setResults] = useState<any[]>([])
  const [postResults, setPostResults] = useState<AppBskyFeedDefs.PostView[]>([])
  const [postCursor, setPostCursor] = useState<string | undefined>()
  const [isSearching, setIsSearching] = useState(false)
  const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [isScrolledDown, setIsScrolledDown] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop
      setIsScrolledDown(scrollY > 300)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
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
          className="fixed bottom-6 left-6 md:bottom-8 md:left-8 bg-gray-500 hover:bg-gray-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-12 h-12"
          aria-label="Scroll to top"
        >
          <span className="text-xl">↑</span>
        </button>
      )}

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}
