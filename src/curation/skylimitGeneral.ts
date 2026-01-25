/**
 * General utility functions for Skylimit curation
 */

import { AppBskyFeedDefs, AppBskyActorDefs } from '@atproto/api'
import { PostSummary, EditionLayout } from './types'

/**
 * Extract hashtags from Bluesky post text and facets
 */
export function extractHashtags(text: string, facets?: any[]): string[] {
  const tags: string[] = []
  
  // Extract from text (simple regex for #hashtag)
  const textMatches = text.match(/#[\w]+/g)
  if (textMatches) {
    tags.push(...textMatches.map(t => t.substring(1).toLowerCase()))
  }
  
  // Extract from facets (structured hashtag data)
  if (facets) {
    for (const facet of facets) {
      if (facet.features) {
        for (const feature of facet.features) {
          if (feature.$type === 'app.bsky.richtext.facet#tag') {
            const tag = feature.tag?.toLowerCase()
            if (tag && !tags.includes(tag)) {
              tags.push(tag)
            }
          }
        }
      }
    }
  }
  
  return tags
}

/**
 * Get hashtags from a post
 */
export function getHashtags(post: AppBskyFeedDefs.PostView, lowerCase: boolean = true): string[] {
  const record = post.record as any
  const text = record?.text || ''
  const facets = record?.facets || []
  
  const tags = extractHashtags(text, facets)
  return lowerCase ? tags.map(t => t.toLowerCase()) : tags
}

/**
 * Parse edition layout from text configuration
 */
export function parseEditionLayout(layoutText: string): EditionLayout {
  const layout: EditionLayout = {}
  const lines = layoutText.split('\n').map(l => l.trim()).filter(l => l)
  
  let currentSection = ''
  let sectionIndex = 0
  let userIndex = 0
  
  for (const line of lines) {
    // Check if this is a section name (not starting with @ or #)
    if (!line.startsWith('@') && !line.startsWith('#')) {
      currentSection = line
      sectionIndex++
      userIndex = 0
      continue
    }
    
    // Parse account entries
    const entries = line.split(/\s+/).filter(e => e)
    for (const entry of entries) {
      if (entry.startsWith('@')) {
        // Account entry: @user.bsky.social or @user.bsky.social#hashtag
        const [account, tag] = entry.split('#')
        const username = account.substring(1)

        layout[username] = {
          section: currentSection || '*default',
          tag: tag || undefined,
          index: userIndex++,
        }
      }
    }
  }
  
  return layout
}

/**
 * Get edition layout from settings
 */
export async function getEditionLayout(): Promise<EditionLayout> {
  // Load from settings
  const { getSettings } = await import('./skylimitStore')
  const settings = await getSettings()
  if (settings.editionLayout) {
    return parseEditionLayout(settings.editionLayout)
  }
  return {}
}

/**
 * Get edition time strings from settings
 */
export async function getEditionTimeStrs(): Promise<string[]> {
  // Load from settings
  const { getSettings } = await import('./skylimitStore')
  const settings = await getSettings()
  if (settings.editionTimes) {
    return settings.editionTimes.split(',').map(t => t.trim()).filter(t => t)
  }
  return []
}

/**
 * Check if a post is a repost
 */
export function isRepost(post: AppBskyFeedDefs.FeedViewPost): boolean {
  return post.reason?.$type === 'app.bsky.feed.defs#reasonRepost'
}

/**
 * Get reposted post URI
 */
export function getRepostedUri(post: AppBskyFeedDefs.FeedViewPost): string | undefined {
  if (isRepost(post)) {
    return post.post.uri
  }
  return undefined
}

/**
 * Check if post is a reply
 */
export function isReply(post: AppBskyFeedDefs.PostView): boolean {
  const record = post.record as any
  return !!record?.reply
}

/**
 * Get parent post URI from reply
 */
export function getParentUri(post: AppBskyFeedDefs.PostView): string | undefined {
  const record = post.record as any
  return record?.reply?.parent?.uri
}

/**
 * Create post summary from FeedViewPost
 */
export function createPostSummary(post: AppBskyFeedDefs.FeedViewPost, feedReceivedTime?: Date): PostSummary {
  const isReposted = isRepost(post)

  // Use single source of truth for unique ID generation
  const uniqueId = getPostUniqueId(post)

  // For reposts: username is the reposter, orig_username is the original author
  // For original posts: username is the author, orig_username is undefined
  let username: string
  let accountDid: string
  let orig_username: string | undefined
  let tags: string[]
  let repostUri: string | undefined
  let cid: string
  let repostCount: number
  let inReplyToUri: string | undefined
  let engaged: boolean

  if (isReposted) {
    // This is a repost
    const reposter = (post.reason as any)?.by
    if (!reposter) {
      // Fallback if reason.by is not available (shouldn't happen)
      console.warn('Repost detected but reposter info not available')
      username = post.post.author.handle
      accountDid = post.post.author.did
      orig_username = undefined
    } else {
      // Reposter is the person who reposted
      username = reposter.handle
      accountDid = reposter.did
      // Original author is in post.post.author
      orig_username = post.post.author.handle
    }
    // For reposts, tags come from the original post
    tags = getHashtags(post.post)
    // repostUri is the original post URI (the post being reposted)
    repostUri = post.post.uri
    cid = post.post.cid
    repostCount = post.post.repostCount || 0
    inReplyToUri = getParentUri(post.post)
    engaged = !!(post.post.viewer?.like || post.post.viewer?.repost)
  } else {
    // This is an original post
    username = post.post.author.handle
    accountDid = post.post.author.did
    orig_username = undefined
    tags = getHashtags(post.post)
    repostUri = undefined
    cid = post.post.cid
    repostCount = post.post.repostCount || 0
    inReplyToUri = getParentUri(post.post)
    engaged = !!(post.post.viewer?.like || post.post.viewer?.repost)
  }
  
  // For reposts, use feedReceivedTime (when we received the feed = when reposted)
  // For original posts, use createdAt (when it was created)
  const timestamp = getFeedViewPostTimestamp(post, feedReceivedTime)
  
  return {
    uniqueId,
    cid,
    username,
    accountDid,
    orig_username,
    tags,
    repostUri,
    repostCount,
    inReplyToUri,
    timestamp,
    postTimestamp: timestamp.getTime(),
    engaged,
  }
}

/**
 * Extract topics from profile description
 */
export function extractTopicsFromProfile(profile: AppBskyActorDefs.ProfileViewDetailed): string[] {
  const description = profile.description || ''
  const match = description.match(/Topics:\s*([^\n]+)/i)
  if (match) {
    return match[1].split(/\s+/).map(t => t.toLowerCase().replace('#', ''))
  }
  return []
}

/**
 * Extract timezone from profile description
 */
export function extractTimezone(profile: AppBskyActorDefs.ProfileViewDetailed): string {
  const description = profile.description || ''
  const match = description.match(/TZ:\s*([A-Za-z_]+\/[A-Za-z_]+)/i)
  return match ? match[1] : 'UTC'
}

/**
 * Get interval string from date
 * @param date - The date to convert to interval string
 * @param intervalHours - The interval length in hours (must be factor of 24)
 */
export function getIntervalString(date: Date, intervalHours: number): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  // Round hour down to nearest interval block
  const hour = date.getUTCHours()
  const intervalHour = Math.floor(hour / intervalHours) * intervalHours
  const intervalHourStr = String(intervalHour).padStart(2, '0')

  return `${year}-${month}-${day}-${intervalHourStr}`
}

/**
 * Get next interval string
 * @param intervalStr - The current interval string
 * @param intervalHours - The interval length in hours (must be factor of 24)
 */
export function nextInterval(intervalStr: string, intervalHours: number): string {
  const [year, month, day, hour] = intervalStr.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour))
  date.setUTCHours(date.getUTCHours() + intervalHours)
  return getIntervalString(date, intervalHours)
}

/**
 * Get oldest interval to analyze
 * @param lastInterval - The most recent interval string
 * @param daysOfData - Number of days to look back
 * @param intervalHours - The interval length in hours (must be factor of 24)
 */
export function oldestInterval(lastInterval: string, daysOfData: number, intervalHours: number): string {
  const [year, month, day, hour] = lastInterval.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour))
  date.setUTCDate(date.getUTCDate() - daysOfData)
  return getIntervalString(date, intervalHours)
}

/**
 * Check if two dates are in the same period (day/week/month)
 */
export function isSamePeriod(
  date1: Date,
  date2: Date,
  periodType: 'MOTD' | 'MOTW' | 'MOTM',
  timezone: string = 'UTC'
): boolean {
  // Convert dates to specified timezone
  const d1 = new Date(date1.toLocaleString('en-US', { timeZone: timezone }))
  const d2 = new Date(date2.toLocaleString('en-US', { timeZone: timezone }))
  
  if (periodType === 'MOTD') {
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate()
  } else if (periodType === 'MOTW') {
    // Same week (Monday to Sunday)
    const week1 = getWeekNumber(d1)
    const week2 = getWeekNumber(d2)
    return d1.getFullYear() === d2.getFullYear() && week1 === week2
  } else if (periodType === 'MOTM') {
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth()
  }
  
  return false
}

/**
 * Get week number (ISO week)
 */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

/**
 * Get timestamp from Bluesky post
 * For reposts, use indexedAt (when it was reposted/appeared in timeline)
 * For original posts, use createdAt (when it was created)
 */
export function getPostTimestamp(post: AppBskyFeedDefs.PostView): Date {
  const record = post.record as any
  // Use indexedAt if available (represents when post appeared in timeline)
  // For reposts, this is when they were reposted
  // For original posts, this is close to creation time
  if (post.indexedAt) {
    return new Date(post.indexedAt)
  }
  // Fallback to createdAt if indexedAt not available
  return new Date(record?.createdAt || Date.now())
}

/**
 * Get unique ID for a post (for looking up in summaries cache)
 * - Original posts: use post.post.uri
 * - Reposts: use reason.uri if available (AT Protocol repost URI),
 *   otherwise fallback to `sl://repost/${reposterDid}:${post.post.uri}`
 *
 * IMPORTANT: Must match how createPostSummary generates uniqueId
 */
export function getPostUniqueId(post: AppBskyFeedDefs.FeedViewPost): string {
  if (isRepost(post)) {
    // Use reason.uri if available (newer AT Protocol API)
    const reasonUri = (post.reason as any)?.uri
    if (reasonUri && typeof reasonUri === 'string') {
      return reasonUri
    }
    // Fallback: construct synthetic repost ID
    const reposter = (post.reason as any)?.by
    if (reposter?.did) {
      return `sl://repost/${reposter.did}:${post.post.uri}`
    }
    return `sl://repost/${post.post.author.did}:${post.post.uri}`
  }
  return post.post.uri
}

/**
 * Convert an AT Protocol URI to a Bluesky web URL
 * AT URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
 * Bluesky URL format: https://bsky.app/profile/{handle}/post/{rkey}
 *
 * @param atUri - The AT Protocol URI
 * @param handle - The author's handle
 * @returns The Bluesky web URL
 */
export function getBlueSkyPostUrl(atUri: string, handle: string): string {
  // Extract rkey from AT URI: at://did:plc:xxx/app.bsky.feed.post/rkey
  const parts = atUri.replace('at://', '').split('/')
  const rkey = parts[2] // The record key is the last segment
  return `https://bsky.app/profile/${handle}/post/${rkey}`
}

/**
 * Get the Bluesky profile URL for a handle
 * @param handle - The user's handle
 * @returns The Bluesky profile URL
 */
export function getBlueSkyProfileUrl(handle: string): string {
  return `https://bsky.app/profile/${handle}`
}

/**
 * Get timestamp for a FeedViewPost
 * For reposts, we need to use when it was reposted (not when original was created)
 * For original posts, use createdAt (when it was created)
 * 
 * IMPORTANT: In Bluesky's FeedViewPost structure:
 * - post.post.indexedAt = original post's indexedAt (NOT repost time)
 * - post.post.record.createdAt = original post's creation time
 * - For reposts, we need to find when the repost actually happened
 * 
 * The challenge: FeedViewPost doesn't directly expose the repost record's timestamp.
 * However, reposts appear in the timeline at the time they were reposted,
 * and the timeline is sorted chronologically. So we can use the position/order
 * or track when we receive them.
 * 
 * For now, we'll use a workaround: check if the post.post.indexedAt is very recent
 * (which might indicate it's actually the repost time in some cases), otherwise
 * we'll need to track repost timestamps separately when we receive the feed.
 */
export function getFeedViewPostTimestamp(post: AppBskyFeedDefs.FeedViewPost, feedReceivedTime?: Date): Date {
  const isReposted = isRepost(post)
  
  if (isReposted) {
    // For reposts, try multiple approaches to get the repost timestamp
    
    // 1. Check if reason object has timestamp (unlikely but possible)
    const reason = post.reason as any
    if (reason?.indexedAt) {
      return new Date(reason.indexedAt)
    }
    if (reason?.createdAt) {
      return new Date(reason.createdAt)
    }
    
    // 2. Check if FeedViewPost itself has indexedAt (some API responses might)
    if ((post as any).indexedAt) {
      return new Date((post as any).indexedAt)
    }
    
    // 3. Use feedReceivedTime if provided (when we received this batch from API)
    // This is a good proxy since reposts appear in timeline at repost time
    if (feedReceivedTime) {
      return feedReceivedTime
    }
    
    // 4. Fallback: Use current time as proxy
    // This is not ideal but reposts appear in timeline at repost time,
    // so if we process them immediately, current time is close to repost time
    // However, this means all reposts processed at once get same timestamp
    // So we add a small random offset to ensure unique ordering
    const now = new Date()
    // Add a small offset based on post URI hash to ensure consistent ordering
    const uriHash = post.post.uri.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const offset = (uriHash % 1000) // 0-999ms offset
    return new Date(now.getTime() + offset)
  }
  
  // Original post: use createdAt
  const record = post.post.record as any
  return new Date(record?.createdAt || post.post.indexedAt || Date.now())
}

