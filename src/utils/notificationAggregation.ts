/**
 * Notification Aggregation Utilities
 * 
 * Groups notifications by reasonSubject and reason type
 */

import { AppBskyNotificationListNotifications, AppBskyFeedDefs } from '@atproto/api'

type Notification = AppBskyNotificationListNotifications.Notification

export interface AggregatedNotification {
  // Grouping key
  reasonSubject?: string  // Post URI for likes/reposts
  reason: string          // like, repost, reply, follow, mention, quote
  
  // Aggregated data
  authors: AppBskyNotificationListNotifications.Notification['author'][]
  count: number                             // Total count
  mostRecent: Notification                  // Most recent notification in group
  isRead: boolean                           // True if all are read
  
  // Post data (for likes/reposts/quotes)
  post?: AppBskyFeedDefs.PostView
  isRepost?: boolean                        // True if the post being liked/reposted is itself a repost
  
  // Individual notifications (for replies/mentions that shouldn't be aggregated)
  notifications?: Notification[]
}

/**
 * Groups notifications by reasonSubject + reason
 * Likes and reposts are aggregated, replies/mentions/quotes are kept separate
 */
export function aggregateNotifications(
  notifications: Notification[]
): AggregatedNotification[] {
  // Group notifications by key: reasonSubject + reason
  const groups = new Map<string, Notification[]>()
  
  notifications.forEach(notification => {
    // Get original reason - handle both string and object types
    let originalReason: string = ''
    if (typeof notification.reason === 'string') {
      originalReason = notification.reason
    } else if (notification.reason && typeof notification.reason === 'object') {
      // If reason is an object, try to extract a string value
      // It might have a $type field or be a complex object
      originalReason = (notification.reason as any).$type || String(notification.reason)
    }
    
    let reason = String(originalReason).toLowerCase().trim()

    // Handle compound reasons like "like-via-repost" - this indicates a like on a repost
    if (reason === 'like-via-repost' || reason.includes('like-via-repost')) {
      reason = 'like'  // Normalize to 'like' for aggregation
    } else if (reason.includes('repost') && !reason.includes('via')) {
      reason = 'repost'
    } else if (reason.includes('like') && !reason.includes('via')) {
      reason = 'like'
    }
    
    // Fallback: Check record type if reason is still not clear
    // Repost notifications might have record.$type === 'app.bsky.feed.repost'
    if (!reason || reason === '' || reason === '[object object]') {
      const record = notification.record as any
      if (record?.$type) {
        const recordType = String(record.$type).toLowerCase()
        if (recordType.includes('repost')) {
          reason = 'repost'
        } else if (recordType.includes('like')) {
          reason = 'like'
        }
      }
    }
    
    
    // Only aggregate likes and reposts
    // Keep replies, mentions, quotes, and follows separate
    // Note: "like-via-repost" is normalized to "like" for aggregation purposes
    // so likes on reposts are aggregated with other likes on the same repost
    if (reason === 'like' || reason === 'repost') {
      // For reposts, we need reasonSubject to aggregate properly
      // If no reasonSubject, we can't aggregate, so keep it separate
      if (notification.reasonSubject) {
        const key = `${notification.reasonSubject}:${reason}`
        if (!groups.has(key)) {
          groups.set(key, [])
        }
        groups.get(key)!.push(notification)
      } else {
        // No reasonSubject - keep separate but still handle as repost
        const key = `single:${notification.uri}`
        groups.set(key, [notification])
      }
    } else {
      // Keep other types separate - use URI as unique key
      const key = `single:${notification.uri}`
      groups.set(key, [notification])
    }
  })
  
  // Convert groups to aggregated notifications
  const aggregated: AggregatedNotification[] = []
  
  groups.forEach((groupNotifications) => {
    if (groupNotifications.length === 0) return
    
    const first = groupNotifications[0]
    // Get and normalize reason - handle both string and object types
    let originalReason: string = ''
    if (typeof first.reason === 'string') {
      originalReason = first.reason
    } else if (first.reason && typeof first.reason === 'object') {
      originalReason = (first.reason as any).$type || String(first.reason)
    }
    
    let reason = String(originalReason).toLowerCase().trim()
    
    // Normalize compound reasons like "like-via-repost" to "like" for storage
    // but we'll check for "via-repost" separately to set isRepost flag
    if (reason === 'like-via-repost' || reason.includes('like-via-repost')) {
      reason = 'like'
    } else if (reason === 'repost-via-repost' || reason.includes('repost-via-repost')) {
      reason = 'repost'
    } else if (reason.includes('repost') && !reason.includes('via')) {
      reason = 'repost'
    } else if (reason.includes('like') && !reason.includes('via')) {
      reason = 'like'
    }
    
    // Fallback: Check record type if reason is still not clear
    if (!reason || reason === '' || reason === '[object object]') {
      const record = first.record as any
      if (record?.$type) {
        const recordType = String(record.$type).toLowerCase()
        if (recordType.includes('repost')) {
          reason = 'repost'
        } else if (recordType.includes('like')) {
          reason = 'like'
        }
      }
    }
    
    // Sort by indexedAt (most recent first)
    groupNotifications.sort((a, b) => {
      const timeA = new Date(a.indexedAt).getTime()
      const timeB = new Date(b.indexedAt).getTime()
      return timeB - timeA
    })
    
    const mostRecent = groupNotifications[0]
    const authors = groupNotifications.map(n => n.author)
    
    // Remove duplicates by DID
    const uniqueAuthors = authors.filter((author, index, self) =>
      index === self.findIndex(a => a.did === author.did)
    )
    
    // All must be read for the group to be considered read
    const isRead = groupNotifications.every(n => n.isRead !== false)
    
    // Check if this is a like or repost for aggregation purposes
    const isAggregatable = reason === 'like' || reason === 'repost'
    
    // Check if any notification in the group is a like-via-repost or repost-via-repost
    // This indicates the like/repost is on a repost record
    const hasViaRepost = groupNotifications.some(n => {
      const nReason = typeof n.reason === 'string' ? n.reason.toLowerCase() : String(n.reason || '').toLowerCase()
      return nReason === 'like-via-repost' || 
             nReason === 'repost-via-repost' ||
             nReason.includes('via-repost')
    })
    
    const aggregatedNotification: AggregatedNotification = {
      reasonSubject: first.reasonSubject,
      reason, // Store normalized reason value for consistency (normalized to 'like' or 'repost')
      authors: uniqueAuthors,
      count: groupNotifications.length,
      mostRecent,
      isRead,
      isRepost: hasViaRepost, // Set isRepost if any notification is like-via-repost or repost-via-repost
      notifications: isAggregatable ? groupNotifications : undefined,
    }
    
    aggregated.push(aggregatedNotification)
  })
  
  // Sort aggregated notifications by most recent first
  aggregated.sort((a, b) => {
    const timeA = new Date(a.mostRecent.indexedAt).getTime()
    const timeB = new Date(b.mostRecent.indexedAt).getTime()
    return timeB - timeA
  })
  
  return aggregated
}

/**
 * Formats aggregated notification text
 * Examples:
 * - "John liked your post"
 * - "John and Jane liked your post"
 * - "John, Jane, and 2 others liked your post"
 * - "John liked your repost" (when liking a repost)
 */
export function formatAggregatedText(
  authors: AppBskyNotificationListNotifications.Notification['author'][],
  reason: string,
  count: number,
  isRepost?: boolean
): string {
  const getActionText = (reasonInput: string, isRepostPost?: boolean) => {
    // Handle both string and object types
    let reasonStr: string = ''
    if (typeof reasonInput === 'string') {
      reasonStr = reasonInput
    } else if (reasonInput && typeof reasonInput === 'object') {
      reasonStr = (reasonInput as any).$type || String(reasonInput)
    } else {
      reasonStr = String(reasonInput || '')
    }
    
    const normalizedReason = reasonStr.toLowerCase().trim()
    
    switch (normalizedReason) {
      case 'like':
      case 'like-via-repost': {
        // If the post being liked is a repost, say "liked your repost"
        // "like-via-repost" explicitly indicates a like on a repost
        // Use isRepostPost flag OR check if reason is "like-via-repost"
        const isLikeOnRepost = isRepostPost || normalizedReason === 'like-via-repost'
        return isLikeOnRepost ? 'liked your repost' : 'liked your post'
      }
      case 'repost':
      case 'repost-via-repost':
        return 'reposted your post'
      case 'reply':
        return 'replied to you'
      case 'quote':
        return 'quoted your post'
      case 'mention':
        return 'mentioned you'
      case 'follow':
        return 'started following you'
      default:
        return 'notified you'
    }
  }
  
  const actionText = getActionText(reason, isRepost)
  
  if (count === 1) {
    const name = authors[0]?.displayName || authors[0]?.handle || 'Someone'
    return `${name} ${actionText}`
  } else if (count === 2) {
    const name1 = authors[0]?.displayName || authors[0]?.handle || 'Someone'
    const name2 = authors[1]?.displayName || authors[1]?.handle || 'Someone'
    return `${name1} and ${name2} ${actionText}`
  } else {
    const name1 = authors[0]?.displayName || authors[0]?.handle || 'Someone'
    const othersCount = count - 1
    return `${name1} and ${othersCount} other${othersCount === 1 ? '' : 's'} ${actionText}`
  }
}

