import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { getProfile } from '../api/profile'
import { getAuthorFeed, getActorLikes } from '../api/feed'
import { follow, unfollow } from '../api/social'
import { likePost, unlikePost, repost, removeRepost, createPost, createQuotePost } from '../api/posts'
import { getPostUniqueId } from '../curation/skylimitGeneral'
import Avatar from '../components/Avatar'
import Button from '../components/Button'
import PostCard from '../components/PostCard'
import Compose from '../components/Compose'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

type Tab = 'posts' | 'replies' | 'likes'

export default function ProfilePage() {
  const { actor } = useParams<{ actor: string }>()
  const { agent, session } = useSession()
  const [profile, setProfile] = useState<any>(null)
  const [feed, setFeed] = useState<AppBskyFeedDefs.FeedViewPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [activeTab, setActiveTab] = useState<Tab>('posts')
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  const [quotePost, setQuotePost] = useState<AppBskyFeedDefs.PostView | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const isMountedRef = useRef(true)
  const currentActorRef = useRef<string | undefined>(actor)

  // Update actor ref when actor changes
  useEffect(() => {
    currentActorRef.current = actor
  }, [actor])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  const loadProfile = useCallback(async () => {
    if (!agent || !actor) return

    const actorAtCallTime = actor // Capture actor at call time

    try {
      const data = await getProfile(agent, actorAtCallTime)
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        setProfile(data)
      }
    } catch (error) {
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        console.error('Failed to load profile:', error)
        addToast(error instanceof Error ? error.message : 'Failed to load profile', 'error')
      }
    } finally {
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        setIsLoading(false)
      }
    }
  }, [agent, actor])

  const loadFeed = useCallback(async (cursor?: string, tab: Tab = 'posts') => {
    if (!agent || !actor) return

    const actorAtCallTime = actor // Capture actor at call time

    try {
      let newFeed: AppBskyFeedDefs.FeedViewPost[] = []
      let newCursor: string | undefined

      if (tab === 'posts') {
        // Posts only - filter out replies
        const result = await getAuthorFeed(agent, actorAtCallTime, { 
          cursor, 
          limit: 25,
          filter: 'posts_no_replies'
        })
        newFeed = result.feed
        newCursor = result.cursor
      } else if (tab === 'replies') {
        // Replies only - get all posts and filter for replies
        const result = await getAuthorFeed(agent, actorAtCallTime, { cursor, limit: 50 })
        // Filter to only include posts that are replies (have a reply field in record)
        newFeed = result.feed.filter(post => {
          const record = post.post.record as any
          return record?.reply !== undefined
        })
        newCursor = result.cursor
      } else if (tab === 'likes') {
        // Liked posts
        const result = await getActorLikes(agent, actorAtCallTime, { cursor, limit: 25 })
        newFeed = result.feed
        newCursor = result.cursor
      }
      
      // Only update state if component is still mounted and actor hasn't changed
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        if (cursor) {
          setFeed(prev => [...prev, ...newFeed])
        } else {
          setFeed(newFeed)
        }
        
        setCursor(newCursor)
      }
    } catch (error) {
      // Only show error if component is still mounted and actor hasn't changed
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        // Suppress "Profiles not found" errors (common when navigating away)
        const errorMessage = error instanceof Error ? error.message : 'Failed to load feed'
        if (!errorMessage.includes('Profiles not found') && !errorMessage.includes('Profile not found')) {
          console.error('Failed to load feed:', error)
          addToast(errorMessage, 'error')
        }
      }
    } finally {
      if (isMountedRef.current && currentActorRef.current === actorAtCallTime) {
        setIsLoadingMore(false)
      }
    }
  }, [agent, actor])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  useEffect(() => {
    setFeed([])
    setCursor(undefined)
    setIsLoadingMore(true)
    loadFeed(undefined, activeTab)
  }, [activeTab, loadFeed])

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const handleFollow = async () => {
    if (!agent || !profile) return

    try {
      if (profile.viewer?.following) {
        await unfollow(agent, profile.viewer.following)
        addToast('Unfollowed', 'success')
      } else {
        await follow(agent, profile.did)
        addToast('Following', 'success')
      }
      loadProfile()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to update follow status', 'error')
    }
  }

  const handleLike = async (uri: string, cid: string) => {
    if (!agent) return

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalLikeUri = post.post.viewer?.like
    const isLiked = !!originalLikeUri

    // Optimistic update - only update count, not the like URI
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
        // Update state to reflect unliked
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
        // Update state with real like URI so unlike works
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
      loadFeed(undefined, activeTab)
      addToast(error instanceof Error ? error.message : 'Failed to update like', 'error')
    }
  }

  const handleRepost = async (uri: string, cid: string) => {
    if (!agent) return

    const post = feed.find(p => p.post.uri === uri)
    if (!post) return

    // Capture original state BEFORE any updates
    const originalRepostUri = post.post.viewer?.repost
    const isReposted = !!originalRepostUri

    // Optimistic update - only update count, not the repost URI
    setFeed(prev => prev.map(p => {
      if (p.post.uri === uri) {
        return {
          ...p,
          post: {
            ...p.post,
            repostCount: (p.post.repostCount || 0) + (isReposted ? -1 : 1),
          },
        }
      }
      return p
    }))

    try {
      if (isReposted && originalRepostUri) {
        await removeRepost(agent, originalRepostUri)
        // Update state to reflect unreposted
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, repost: undefined },
              },
            }
          }
          return p
        }))
      } else {
        const repostResponse = await repost(agent, uri, cid)
        // Update state with real repost URI so unrepost works
        setFeed(prev => prev.map(p => {
          if (p.post.uri === uri) {
            return {
              ...p,
              post: {
                ...p.post,
                viewer: { ...p.post.viewer, repost: repostResponse.uri },
              },
            }
          }
          return p
        }))
      }
    } catch (error) {
      loadFeed(undefined, activeTab)
      addToast(error instanceof Error ? error.message : 'Failed to update repost', 'error')
    }
  }

  const handleQuotePost = (post: AppBskyFeedDefs.PostView) => {
    setQuotePost(post)
    setShowCompose(true)
  }

  const handlePost = async (text: string) => {
    if (!agent) return

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
        await createPost(agent, { text })
        addToast('Post created!', 'success')
      }
      loadFeed(undefined, activeTab)
    } catch (error) {
      throw error
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p>Profile not found</p>
      </div>
    )
  }

  const isOwnProfile = session?.handle === profile.handle

  return (
    <div className="pb-20 md:pb-0">
      {/* Profile Header */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        {profile.banner && (
          <div
            className="h-48 bg-cover bg-center"
            style={{ backgroundImage: `url(${profile.banner})` }}
          />
        )}
        <div className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-end gap-4 -mt-16">
              <Avatar
                src={profile.avatar}
                alt={profile.displayName || profile.handle}
                size="lg"
                className="border-4 border-white dark:border-gray-900"
              />
            </div>
            {!isOwnProfile && (
              <Button
                variant={profile.viewer?.following ? "secondary" : "primary"}
                onClick={handleFollow}
              >
                {profile.viewer?.following ? 'Following' : 'Follow'}
              </Button>
            )}
          </div>
          <div className="mt-4">
            <h1 className="text-2xl font-bold">{profile.displayName || profile.handle}</h1>
            <p className="text-gray-500 dark:text-gray-400">@{profile.handle}</p>
            {profile.description && (
              <p className="mt-2 whitespace-pre-wrap">{profile.description}</p>
            )}
            <div className="flex gap-4 mt-4 text-sm text-gray-500 dark:text-gray-400">
              <span>{profile.followsCount || 0} Following</span>
              <span>{profile.followersCount || 0} Followers</span>
              <span>{profile.postsCount || 0} Posts</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        {(['posts', 'replies', 'likes'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
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

      {/* Feed */}
      <div>
        {isLoadingMore && feed.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : feed.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>
              {activeTab === 'posts' && 'No posts to show'}
              {activeTab === 'replies' && 'No replies to show'}
              {activeTab === 'likes' && 'No liked posts to show'}
            </p>
          </div>
        ) : (
          <>
            {feed.map((post) => (
              <PostCard
                key={getPostUniqueId(post)}
                post={post}
                onRepost={handleRepost}
                onQuotePost={handleQuotePost}
                onLike={handleLike}
                showRootPost={false}
              />
            ))}

            {cursor && (
              <div className="p-4 text-center">
                <button
                  onClick={() => {
                    setIsLoadingMore(true)
                    loadFeed(cursor, activeTab)
                  }}
                  disabled={isLoadingMore}
                  className="btn btn-secondary"
                >
                  {isLoadingMore ? (
                    <span className="flex items-center gap-2">
                      <Spinner size="sm" />
                      Loading...
                    </span>
                  ) : (
                    'Load More'
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <Compose
        isOpen={showCompose}
        onClose={() => {
          setShowCompose(false)
          setQuotePost(null)
        }}
        quotePost={quotePost || undefined}
        onPost={handlePost}
      />

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}

