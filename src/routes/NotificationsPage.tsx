import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyNotificationListNotifications, AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { useRateLimit } from '../contexts/RateLimitContext'
import { getNotifications, updateSeenNotifications } from '../api/notifications'
import { getPostThread } from '../api/feed'
import { aggregateNotifications, AggregatedNotification } from '../utils/notificationAggregation'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import RateLimitIndicator from '../components/RateLimitIndicator'
import AggregatedNotificationComponent from '../components/AggregatedNotification'

type Notification = AppBskyNotificationListNotifications.Notification

interface NotificationWithPost extends Notification {
  post?: AppBskyFeedDefs.PostView
}

export default function NotificationsPage() {
  const navigate = useNavigate()
  const { agent, session } = useSession()
  const { rateLimitStatus, setRateLimitStatus } = useRateLimit()
  const [notifications, setNotifications] = useState<NotificationWithPost[]>([])
  const [aggregatedNotifications, setAggregatedNotifications] = useState<AggregatedNotification[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  const loadNotifications = useCallback(async (cursor?: string) => {
    if (!agent || !session) return

    try {
      setRateLimitStatus(null)
      
      const { notifications: newNotifications, cursor: newCursor } = await getNotifications(agent, {
        cursor,
        limit: 25,
        onRateLimit: (info) => {
          setRateLimitStatus({
            isActive: true,
            retryAfter: info.retryAfter,
            message: info.message || 'Rate limit exceeded. Please wait before trying again.'
          })
        }
      })

      setRateLimitStatus(null)

      // Helper to normalize reason strings
      const normalizeReason = (reason: string): string => {
        const r = reason.toLowerCase()
        if (r.includes('like')) return 'like'
        if (r.includes('repost')) return 'repost'
        return r
      }

      // Shared caches for both fetch phases
      const postCache = new Map<string, AppBskyFeedDefs.PostView>()
      const threadCache = new Map<string, any>()
      const uriResolutionMap = new Map<string, string>()

      // Step 1: Separate direct URIs (can fetch immediately) from repost URIs (need resolution)
      const directPostUris = new Set<string>()
      const directReplyMentionUris = new Set<string>()
      const repostUrisToResolve: Array<{ reasonSubject: string; repo: string; rkey: string }> = []

      for (const notification of newNotifications) {
        const reason = String(notification.reason || '').toLowerCase()
        const normalizedReason = normalizeReason(reason)

        if (!notification.reasonSubject || reason === 'follow') continue
        if (uriResolutionMap.has(notification.reasonSubject)) continue

        const postUri = notification.reasonSubject

        if (postUri.includes('/app.bsky.feed.repost/')) {
          // Repost URI - need to resolve first
          const uriParts = postUri.replace('at://', '').split('/')
          repostUrisToResolve.push({
            reasonSubject: postUri,
            repo: uriParts[0],
            rkey: uriParts[2]
          })
        } else {
          // Direct post URI - can fetch immediately
          uriResolutionMap.set(postUri, postUri)
          if (normalizedReason === 'reply' || normalizedReason === 'mention') {
            directReplyMentionUris.add(postUri)
          } else if (normalizedReason === 'like' || normalizedReason === 'repost' || normalizedReason === 'quote') {
            directPostUris.add(postUri)
          }
        }
      }

      // Step 2: Fetch direct URIs AND resolve repost URIs IN PARALLEL
      const fetchDirectPosts = async () => {
        // Batch fetch all direct post URIs (likes/reposts/quotes) in ONE request
        if (directPostUris.size > 0) {
          try {
            const response = await agent.getPosts({ uris: Array.from(directPostUris) })
            for (const post of response.data.posts) {
              postCache.set(post.uri, post)
            }
          } catch (error) {
            console.warn('Batch fetch failed:', error)
          }
        }

        // Reply/mention threads still need individual getPostThread with depth=1
        const threadFetches = Array.from(directReplyMentionUris).map(async (uri) => {
          try {
            const thread = await getPostThread(agent, uri, 1)
            if (thread.thread) {
              threadCache.set(uri, thread.thread)
              if (thread.thread.post) {
                postCache.set(uri, thread.thread.post as AppBskyFeedDefs.PostView)
              }
            }
          } catch (error) {
            console.warn('Failed to fetch thread:', uri, error)
          }
        })

        await Promise.all(threadFetches)
      }

      const resolveRepostUris = async () => {
        if (repostUrisToResolve.length === 0) return []

        return Promise.all(
          repostUrisToResolve.map(async ({ reasonSubject, repo, rkey }) => {
            try {
              const repostRecord = await agent.com.atproto.repo.getRecord({
                repo,
                collection: 'app.bsky.feed.repost',
                rkey
              })
              const subject = (repostRecord.data.value as any)?.subject
              return { reasonSubject, resolvedUri: subject?.uri || reasonSubject }
            } catch {
              return { reasonSubject, resolvedUri: reasonSubject }
            }
          })
        )
      }

      // Run both in parallel - direct fetches don't wait for repost resolution
      const [, resolvedReposts] = await Promise.all([
        fetchDirectPosts(),
        resolveRepostUris()
      ])

      // Step 3: Update resolution map and fetch posts for resolved repost URIs
      const repostPostUris = new Set<string>()
      for (const { reasonSubject, resolvedUri } of resolvedReposts) {
        uriResolutionMap.set(reasonSubject, resolvedUri)
        if (!postCache.has(resolvedUri)) {
          repostPostUris.add(resolvedUri)
        }
      }

      // Batch fetch posts for resolved repost URIs (only what we don't have)
      if (repostPostUris.size > 0) {
        try {
          const response = await agent.getPosts({ uris: Array.from(repostPostUris) })
          for (const post of response.data.posts) {
            postCache.set(post.uri, post)
          }
        } catch (error) {
          console.warn('Batch fetch resolved reposts failed:', error)
        }
      }

      // Step 5: Attach posts to notifications using the cache
      const notificationsWithPosts: NotificationWithPost[] = newNotifications.map((notification) => {
        const reason = String(notification.reason || '').toLowerCase()
        const normalizedReason = normalizeReason(reason)

        if (!notification.reasonSubject || reason === 'follow') {
          return notification
        }

        const resolvedUri = uriResolutionMap.get(notification.reasonSubject)
        if (!resolvedUri) {
          return notification
        }

        if (normalizedReason === 'reply' || normalizedReason === 'mention') {
          // For replies, try to find the actual reply in the thread
          const thread = threadCache.get(resolvedUri)
          if (thread?.replies && Array.isArray(thread.replies)) {
            const reply = thread.replies.find(
              (r: any) => r.post?.author.did === notification.author.did
            )
            if (reply?.post) {
              return { ...notification, post: reply.post as AppBskyFeedDefs.PostView }
            }
          }
          // Fallback to parent post
          const post = postCache.get(resolvedUri)
          if (post) {
            return { ...notification, post }
          }
        } else {
          // For like/repost/quote, use the cached post
          const post = postCache.get(resolvedUri)
          if (post) {
            return { ...notification, post }
          }
        }

        return notification
      })

      if (cursor) {
        setNotifications(prev => [...prev, ...notificationsWithPosts])
      } else {
        setNotifications(notificationsWithPosts)
        // Mark notifications as seen when first loading
        try {
          await updateSeenNotifications(agent, new Date().toISOString())
        } catch (error) {
          console.warn('Failed to mark notifications as seen:', error)
        }
      }

      setCursor(newCursor)
    } catch (error) {
      console.error('Failed to load notifications:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to load notifications'
      addToast(errorMessage, 'error')
      
      if (errorMessage.toLowerCase().includes('rate limit')) {
        const retryAfterMatch = errorMessage.match(/(\d+)\s*seconds?/i)
        const retryAfter = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : undefined
        setRateLimitStatus({
          isActive: true,
          retryAfter,
          message: errorMessage
        })
      }
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [agent, session, setRateLimitStatus])

  // Aggregate notifications whenever notifications change
  useEffect(() => {
    if (notifications.length > 0) {
      // Group notifications and attach posts to aggregated groups
      const aggregated = aggregateNotifications(notifications)

      // Attach posts to aggregated notifications
      const aggregatedWithPosts = aggregated.map(agg => {
        const normalizedReason = String(agg.reason || '').toLowerCase().trim()

        if (agg.reasonSubject && (normalizedReason === 'like' || normalizedReason === 'repost')) {
          // Find the post from any notification in the group
          const notificationWithPost = notifications.find(
            n => n.reasonSubject === agg.reasonSubject && n.post
          )
          if (notificationWithPost?.post) {
            // Check if this is a like on a repost
            // The AT Protocol uses "like-via-repost" as the reason when someone likes a repost
            // We should already have this set in agg.isRepost from aggregation, but double-check
            let isRepost = agg.isRepost || false

            // Also check the reasonSubject URI as a fallback
            // When someone likes a repost, the reasonSubject URI points to the repost record
            // Format: at://did:plc:.../app.bsky.feed.repost/...
            if (!isRepost && agg.reasonSubject) {
              const reasonSubjectLower = agg.reasonSubject.toLowerCase()
              if (reasonSubjectLower.includes('/app.bsky.feed.repost/') ||
                  reasonSubjectLower.includes('app.bsky.feed.repost')) {
                isRepost = true
              }
            }

            return { ...agg, post: notificationWithPost.post, isRepost: !!isRepost }
          }
        } else if (normalizedReason === 'reply' || normalizedReason === 'mention' || normalizedReason === 'quote') {
          // For replies/mentions/quotes, get post from the most recent notification
          const notificationWithPost = notifications.find(
            n => n.uri === agg.mostRecent.uri && n.post
          )
          if (notificationWithPost?.post) {
            return { ...agg, post: notificationWithPost.post }
          }
        }
        return agg
      })
      
      setAggregatedNotifications(aggregatedWithPosts)
    } else {
      setAggregatedNotifications([])
    }
  }, [notifications])

  useEffect(() => {
    loadNotifications()
  }, [loadNotifications])

  const handleLoadMore = () => {
    if (cursor && !isLoadingMore) {
      setIsLoadingMore(true)
      loadNotifications(cursor)
    }
  }

  const handlePostClick = (uri: string) => {
    const encodedUri = encodeURIComponent(uri)
    navigate(`/post/${encodedUri}`)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="pb-20 md:pb-0">
      <RateLimitIndicator status={rateLimitStatus} />

      {aggregatedNotifications.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <p>No notifications yet.</p>
        </div>
      ) : (
        <div>
          {aggregatedNotifications.map((aggNotification, index) => (
            <AggregatedNotificationComponent
              key={`${aggNotification.reasonSubject || aggNotification.mostRecent.uri}:${aggNotification.reason}:${index}:${aggNotification.mostRecent.indexedAt}`}
              notification={aggNotification}
              onPostClick={handlePostClick}
            />
          ))}

          {cursor && (
            <div className="p-4 text-center">
              <button
                onClick={handleLoadMore}
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
        </div>
      )}

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}
