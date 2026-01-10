import React, { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import { searchActors } from '../api/search'
import { follow, unfollow } from '../api/social'
import Avatar from '../components/Avatar'
import Button from '../components/Button'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

export default function SearchPage() {
  const { agent } = useSession()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  const debouncedSearch = useCallback(
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

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setQuery(value)
    debouncedSearch(value)
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
        debouncedSearch(query)
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to update follow status', 'error')
    }
  }

  return (
    <div className="pb-20 md:pb-0">
      <div className="sticky top-14 z-30 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <input
          type="text"
          value={query}
          onChange={handleSearchChange}
          placeholder="Search for people..."
          className="input w-full"
        />
      </div>

      <div className="p-4">
        {isSearching && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="lg" />
          </div>
        )}

        {!isSearching && query.trim() && results.length === 0 && (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>No results found</p>
          </div>
        )}

        {!isSearching && !query.trim() && (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>Search for people by username or display name</p>
          </div>
        )}

        {!isSearching && results.length > 0 && (
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
      </div>

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}

