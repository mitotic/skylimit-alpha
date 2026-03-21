import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useNavigationType } from 'react-router-dom'
import { AppBskyNotificationListNotifications, AppBskyFeedDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { useRateLimit } from '../contexts/RateLimitContext'
import { getNotifications, updateSeenNotifications } from '../api/notifications'
import { getProfiles } from '../api/profile'
// getPostThread removed - batch getPosts() is used instead for performance
import { aggregateNotifications, AggregatedNotification } from '../utils/notificationAggregation'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import RateLimitIndicator from '../components/RateLimitIndicator'
import AggregatedNotificationComponent from '../components/AggregatedNotification'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import log from '../utils/logger'

type Notification = AppBskyNotificationListNotifications.Notification

interface NotificationWithPost extends Notification {
  post?: AppBskyFeedDefs.PostView
  parentPost?: AppBskyFeedDefs.PostView
  replyParentAuthor?: { displayName?: string; handle: string }
}

const NOTIF_FEED_KEY = 'websky_notif_feed_state'
const NOTIF_SCROLL_KEY = 'websky_notif_scroll_pos'

export default function NotificationsPage() {
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const { agent, session } = useSession()
  const { rateLimitStatus, setRateLimitStatus } = useRateLimit()
  const [notifications, setNotifications] = useState<NotificationWithPost[]>([])
  const [aggregatedNotifications, setAggregatedNotifications] = useState<AggregatedNotification[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [followStatusMap, setFollowStatusMap] = useState<Record<string, boolean | null>>({})
  const restoredFromCacheRef = useRef(false)
  const isProgrammaticScrollRef = useRef(false)
  const scrollSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

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
      const uriResolutionMap = new Map<string, string>()

      // Step 1: Separate direct URIs (can fetch immediately) from repost URIs (need resolution)
      const directPostUris = new Set<string>()
      const directReplyMentionUris = new Set<string>()
      const replyPostUris = new Set<string>()  // URIs of actual reply posts (notification.uri)
      const repostUrisToResolve: Array<{ reasonSubject: string; repo: string; rkey: string }> = []

      for (const notification of newNotifications) {
        const reason = String(notification.reason || '').toLowerCase()
        const normalizedReason = normalizeReason(reason)

        if (!notification.reasonSubject || reason === 'follow') continue

        // Collect reply post URIs for ALL reply/mention notifications (not just first per reasonSubject)
        if (normalizedReason === 'reply' || normalizedReason === 'mention') {
          replyPostUris.add(notification.uri)
        }

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
        // Run all three batch fetches in parallel - they are independent
        const fetchLikeRepostPosts = async () => {
          if (directPostUris.size > 0) {
            try {
              const response = await agent.getPosts({ uris: Array.from(directPostUris) })
              for (const post of response.data.posts) {
                postCache.set(post.uri, post)
              }
            } catch (error) {
              log.warn('Notifications', 'Batch fetch failed:', error)
            }
          }
        }

        // Batch fetch parent/root posts for reply/mention notifications (reasonSubject URIs)
        const fetchReplyParentPosts = async () => {
          if (directReplyMentionUris.size > 0) {
            try {
              const response = await agent.getPosts({ uris: Array.from(directReplyMentionUris) })
              for (const post of response.data.posts) {
                postCache.set(post.uri, post)
              }
            } catch (error) {
              log.warn('Notifications', 'Batch fetch reply parent posts failed:', error)
            }
          }
        }

        // Batch fetch actual reply posts by their URIs (notification.uri)
        const fetchReplyPosts = async () => {
          if (replyPostUris.size > 0) {
            try {
              const response = await agent.getPosts({ uris: Array.from(replyPostUris) })
              for (const post of response.data.posts) {
                postCache.set(post.uri, post)
              }
            } catch (error) {
              log.warn('Notifications', 'Batch fetch reply posts failed:', error)
            }
          }
        }

        await Promise.all([fetchLikeRepostPosts(), fetchReplyParentPosts(), fetchReplyPosts()])
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
          log.warn('Notifications', 'Batch fetch resolved reposts failed:', error)
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
          // Get the root/original post (the user's post that was replied to)
          const rootPost = postCache.get(resolvedUri)

          // Try to get the actual reply post directly (fetched by notification.uri)
          const replyPost = postCache.get(notification.uri)
          if (replyPost) {
            // Determine reply-to author for indirect replies
            // An indirect reply is when the replier responded to someone other than the user
            // Compare parent URI with reasonSubject (the user's post) to detect this
            const record = notification.record as any
            const parentUri = record?.reply?.parent?.uri
            let replyParentAuthor: { displayName?: string; handle: string } | undefined
            if (parentUri && parentUri !== resolvedUri) {
              // Indirect reply: the reply is to a different post than the user's
              // Try to get parent post author from cache
              const parentPost = postCache.get(parentUri)
              if (parentPost?.author) {
                replyParentAuthor = {
                  displayName: parentPost.author.displayName,
                  handle: parentPost.author.handle
                }
              }
            }
            return {
              ...notification,
              post: replyPost,
              parentPost: rootPost,
              replyParentAuthor
            }
          }

          // Fallback to root post
          if (rootPost) {
            return { ...notification, post: rootPost }
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
      }

      // Batch fetch follow statuses and mark as seen in parallel (non-blocking)
      const parallelTasks: Promise<void>[] = []

      // Batch follow status check: collect all follow notification author DIDs
      const followAuthorDids = new Set<string>()
      for (const notification of newNotifications) {
        if (String(notification.reason || '').toLowerCase() === 'follow') {
          followAuthorDids.add(notification.author.did)
        }
      }
      if (followAuthorDids.size > 0) {
        parallelTasks.push(
          (async () => {
            try {
              const dids = Array.from(followAuthorDids)
              // getProfiles supports up to 25 per call
              const statusMap: Record<string, boolean | null> = {}
              for (let i = 0; i < dids.length; i += 25) {
                const batch = dids.slice(i, i + 25)
                const { profiles } = await getProfiles(agent, batch)
                for (const profile of profiles) {
                  statusMap[profile.did] = !!profile.viewer?.following
                }
              }
              setFollowStatusMap(prev => ({ ...prev, ...statusMap }))
            } catch (error) {
              log.warn('Notifications', 'Batch follow status check failed:', error)
            }
          })()
        )
      }

      // Mark notifications as seen (skip in read-only mode)
      if (!cursor) {
        if (isReadOnlyMode()) {
          log.warn('Notifications', 'Read-only mode: skipping updateSeenNotifications')
        } else {
          parallelTasks.push(
            updateSeenNotifications(agent, new Date().toISOString()).catch(error => {
              log.warn('Notifications', 'Failed to mark notifications as seen:', error)
            })
          )
        }
      }

      await Promise.all(parallelTasks)

      setCursor(newCursor)
    } catch (error) {
      log.error('Notifications', 'Failed to load notifications:', error)
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
            return {
              ...agg,
              post: notificationWithPost.post,
              parentPost: notificationWithPost.parentPost,
              replyParentAuthor: notificationWithPost.replyParentAuthor
            }
          }
        }
        return agg
      })
      
      setAggregatedNotifications(aggregatedWithPosts)
    } else {
      setAggregatedNotifications([])
    }
  }, [notifications])

  // Save notification state to sessionStorage whenever it changes
  useEffect(() => {
    if (notifications.length === 0) return
    try {
      sessionStorage.setItem(NOTIF_FEED_KEY, JSON.stringify({
        notifications,
        cursor,
        followStatusMap,
      }))
    } catch { /* ignore quota errors */ }
  }, [notifications, cursor, followStatusMap])

  // On mount: restore from cache on back navigation, otherwise fetch fresh
  useEffect(() => {
    if (navigationType === 'POP') {
      try {
        const saved = sessionStorage.getItem(NOTIF_FEED_KEY)
        if (saved) {
          const parsed = JSON.parse(saved)
          if (parsed.notifications && parsed.notifications.length > 0) {
            setNotifications(parsed.notifications)
            setCursor(parsed.cursor)
            setFollowStatusMap(parsed.followStatusMap || {})
            setIsLoading(false)
            restoredFromCacheRef.current = true
            return
          }
        }
      } catch { /* parse error, fall through to fresh load */ }
    } else {
      // Fresh navigation — clear stale state
      sessionStorage.removeItem(NOTIF_FEED_KEY)
      sessionStorage.removeItem(NOTIF_SCROLL_KEY)
    }
    loadNotifications()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore scroll position after cache restore renders
  useEffect(() => {
    if (!restoredFromCacheRef.current) return
    restoredFromCacheRef.current = false

    const savedScrollY = sessionStorage.getItem(NOTIF_SCROLL_KEY)
    if (!savedScrollY) return
    const targetY = parseInt(savedScrollY, 10)
    if (isNaN(targetY) || targetY <= 0) return

    isProgrammaticScrollRef.current = true
    let attempt = 0
    const maxAttempts = 8

    const tryRestore = () => {
      attempt++
      window.scrollTo(0, targetY)
      const actual = window.scrollY
      if (Math.abs(actual - targetY) < 100 || attempt >= maxAttempts) {
        setTimeout(() => { isProgrammaticScrollRef.current = false }, 200)
      } else {
        setTimeout(tryRestore, attempt * 100)
      }
    }
    setTimeout(tryRestore, 50)
  }, [aggregatedNotifications.length]) // triggers when aggregated list is populated from cache

  // Debounced scroll position saving
  useEffect(() => {
    const handleScroll = () => {
      if (scrollSaveTimeoutRef.current) clearTimeout(scrollSaveTimeoutRef.current)
      scrollSaveTimeoutRef.current = setTimeout(() => {
        if (isProgrammaticScrollRef.current) return
        const scrollY = window.scrollY
        try {
          if (scrollY < 50) {
            sessionStorage.removeItem(NOTIF_SCROLL_KEY)
          } else {
            sessionStorage.setItem(NOTIF_SCROLL_KEY, scrollY.toString())
          }
        } catch { /* ignore */ }
      }, 150)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (scrollSaveTimeoutRef.current) clearTimeout(scrollSaveTimeoutRef.current)
    }
  }, [])

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
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Notifications</h1>
          <a
            href="https://bsky.app/notifications"
            className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
          >
            View on Bluesky ↗
          </a>
        </div>
      </div>
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
              followStatusMap={followStatusMap}
              onFollowStatusChange={(did, status) => setFollowStatusMap(prev => ({ ...prev, [did]: status }))}
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
