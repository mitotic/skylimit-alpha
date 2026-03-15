import { useState, useEffect } from 'react'
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom'
import { AppBskyActorDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getProfile } from '../api/profile'
import { follow, unfollow, getFollowers, getFollowing } from '../api/social'
import { extractPriorityPatternsFromProfile, extractTimezone } from '../curation/skylimitGeneral'
import { saveFollow, deleteFollow } from '../curation/skylimitCache'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import Avatar from '../components/Avatar'
import Button from '../components/Button'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

const PAGE_SIZE = 25

export default function FollowListPage() {
  const { actor } = useParams<{ actor: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { agent, session } = useSession()

  const type = location.pathname.endsWith('/followers') ? 'followers' : 'following'

  const [profile, setProfile] = useState<AppBskyActorDefs.ProfileViewDetailed | null>(null)
  const [users, setUsers] = useState<AppBskyActorDefs.ProfileView[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = (message: string, toastType: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type: toastType }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  useEffect(() => {
    if (!agent || !actor) return
    setUsers([])
    setCursor(undefined)
    setHasMore(true)
    setError(null)

    getProfile(agent, actor)
      .then(p => setProfile(p))
      .catch(() => setError('Failed to load profile'))

    loadUsers()
  }, [agent, actor, type])

  const loadUsers = async (loadCursor?: string) => {
    if (!agent || !actor || isLoading) return

    setIsLoading(true)
    setError(null)

    try {
      if (type === 'followers') {
        const result = await getFollowers(agent, actor, {
          limit: PAGE_SIZE,
          cursor: loadCursor,
        })
        setUsers(prev => loadCursor ? [...prev, ...result.followers] : result.followers)
        setCursor(result.cursor)
        setHasMore(!!result.cursor)
      } else {
        const result = await getFollowing(agent, actor, {
          limit: PAGE_SIZE,
          cursor: loadCursor,
        })
        setUsers(prev => loadCursor ? [...prev, ...result.follows] : result.follows)
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

  const handleFollow = async (user: AppBskyActorDefs.ProfileView) => {
    if (!agent) return
    if (isReadOnlyMode()) {
      addToast('Disable Read-only mode in Settings to do this', 'error')
      return
    }

    try {
      if (user.viewer?.following) {
        await unfollow(agent, user.viewer.following)
        await deleteFollow(user.handle)
        setUsers(prev => prev.map(u =>
          u.did === user.did
            ? { ...u, viewer: { ...u.viewer, following: undefined } }
            : u
        ))
        addToast('Unfollowed', 'success')
      } else {
        const result = await follow(agent, user.did)
        const priorityPatterns = extractPriorityPatternsFromProfile(user as AppBskyActorDefs.ProfileViewDetailed)
        const timezone = extractTimezone(user as AppBskyActorDefs.ProfileViewDetailed)
        await saveFollow({
          username: user.handle,
          accountDid: user.did,
          displayName: user.displayName || undefined,
          followed_at: new Date().toISOString(),
          amp_factor: 1,
          priorityPatterns: priorityPatterns || undefined,
          timezone,
        })
        setUsers(prev => prev.map(u =>
          u.did === user.did
            ? { ...u, viewer: { ...u.viewer, following: result.uri } }
            : u
        ))
        addToast('Following', 'success')
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to update follow status', 'error')
    }
  }

  const count = type === 'followers'
    ? (profile?.followersCount || 0)
    : (profile?.followsCount || 0)

  return (
    <div className="pb-20 md:pb-0">
      <div className="p-4">
        <Link
          to={`/profile/${actor}`}
          className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
        >
          &larr; Back to profile
        </Link>
      </div>

      {profile && (
        <div className="px-4 pb-2 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3 mb-2">
            <Avatar
              src={profile.avatar}
              alt={profile.displayName || profile.handle}
              size="md"
            />
            <div className="min-w-0">
              <div className="font-bold truncate">{profile.displayName || profile.handle}</div>
              <div className="text-sm text-gray-500 dark:text-gray-400 truncate">@{profile.handle}</div>
            </div>
          </div>
          <h1 className="text-xl font-bold mb-2">
            {type === 'followers' ? 'Followers' : 'Following'}
            <span className="text-gray-500 dark:text-gray-400 font-normal ml-2">
              {count.toLocaleString()}
            </span>
          </h1>
        </div>
      )}

      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {users.map(user => (
          <div
            key={user.did}
            onClick={() => navigate(`/profile/${user.handle}`)}
            className="flex items-center gap-4 p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer"
          >
            <Avatar
              src={user.avatar}
              alt={user.displayName || user.handle}
              size="md"
            />
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{user.displayName || user.handle}</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">@{user.handle}</div>
              {user.description && (
                <div className="text-sm text-gray-600 dark:text-gray-300 mt-1 line-clamp-2">
                  {user.description}
                </div>
              )}
            </div>
            {user.did !== session?.did && (
              <Button
                variant={user.viewer?.following ? 'secondary' : 'primary'}
                onClick={(e) => {
                  e.stopPropagation()
                  handleFollow(user)
                }}
              >
                {user.viewer?.following ? 'Following' : 'Follow'}
              </Button>
            )}
          </div>
        ))}
      </div>

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
        <div className="flex justify-center py-4">
          <button
            onClick={handleLoadMore}
            className="px-4 py-2 text-blue-500 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            Load more
          </button>
        </div>
      )}

      {!isLoading && users.length === 0 && !error && profile && (
        <div className="text-center py-8 text-gray-500">
          {type === 'followers' ? 'No followers yet' : 'Not following anyone yet'}
        </div>
      )}

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}
