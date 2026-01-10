import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyActorDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getLikes, getRepostedBy } from '../api/feed'
import Modal from './Modal'
import Avatar from './Avatar'
import Spinner from './Spinner'

interface EngagementListProps {
  isOpen: boolean
  onClose: () => void
  postUri: string
  type: 'likes' | 'reposts'
  count: number
}

const PAGE_SIZE = 25

export default function EngagementList({
  isOpen,
  onClose,
  postUri,
  type,
  count
}: EngagementListProps) {
  const navigate = useNavigate()
  const { agent } = useSession()
  const [users, setUsers] = useState<AppBskyActorDefs.ProfileView[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Reset state when modal opens or type changes
  useEffect(() => {
    if (isOpen) {
      setUsers([])
      setCursor(undefined)
      setHasMore(true)
      setError(null)
      loadUsers()
    }
  }, [isOpen, postUri, type])

  const loadUsers = async (loadCursor?: string) => {
    if (!agent || isLoading) return

    setIsLoading(true)
    setError(null)

    try {
      if (type === 'likes') {
        const result = await getLikes(agent, postUri, {
          limit: PAGE_SIZE,
          cursor: loadCursor
        })
        const newUsers = result.likes.map(like => like.actor)
        setUsers(prev => loadCursor ? [...prev, ...newUsers] : newUsers)
        setCursor(result.cursor)
        setHasMore(!!result.cursor)
      } else {
        const result = await getRepostedBy(agent, postUri, {
          limit: PAGE_SIZE,
          cursor: loadCursor
        })
        setUsers(prev => loadCursor ? [...prev, ...result.repostedBy] : result.repostedBy)
        setCursor(result.cursor)
        setHasMore(!!result.cursor)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setIsLoading(false)
    }
  }

  const handleLoadMore = () => {
    if (cursor && !isLoading) {
      loadUsers(cursor)
    }
  }

  const handleUserClick = (handle: string) => {
    onClose()
    navigate(`/profile/${handle}`)
  }

  const title = type === 'likes'
    ? `Liked by ${count.toLocaleString()}`
    : `Reposted by ${count.toLocaleString()}`

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      <div className="space-y-2">
        {users.map(user => (
          <div
            key={user.did}
            onClick={() => handleUserClick(user.handle)}
            className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer transition-colors"
          >
            <Avatar
              src={user.avatar}
              alt={user.displayName || user.handle}
              size="md"
            />
            <div className="flex-1 min-w-0">
              <div className="font-semibold truncate">
                {user.displayName || user.handle}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 truncate">
                @{user.handle}
              </div>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-center py-4">
            <Spinner size="md" />
          </div>
        )}

        {error && (
          <div className="text-center py-4 text-red-500">
            {error}
          </div>
        )}

        {!isLoading && hasMore && users.length > 0 && (
          <button
            onClick={handleLoadMore}
            className="w-full py-2 text-blue-500 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            Load more
          </button>
        )}

        {!isLoading && users.length === 0 && !error && (
          <div className="text-center py-4 text-gray-500">
            No {type === 'likes' ? 'likes' : 'reposts'} yet
          </div>
        )}
      </div>
    </Modal>
  )
}
