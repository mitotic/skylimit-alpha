/**
 * General utility functions for Skylimit curation
 */

import { AppBskyFeedDefs, AppBskyActorDefs } from '@atproto/api'
import { CurationMetadata, FeedPlatform, PostSummary, ENGAGEMENT_NONE, ENGAGEMENT_LIKED, ENGAGEMENT_BOOKMARKED, ENGAGEMENT_REPOSTED, SL_REPOST_PREFIX } from './types'

// App account pinned post constants
const DEFAULT_APP_ACCOUNT_HANDLE = 'skylimit.dev'
const SKYSPEED_APP_ACCOUNT_HANDLE = 'followee1.skyspeed.social'
export let appAccountHandle = DEFAULT_APP_ACCOUNT_HANDLE
export const PINNED_POST_ID_KEY = 'websky_pinned_post_id'
export const PINNED_POST_TEXT_KEY = 'websky_pinned_post_text'

/**
 * Update appAccountHandle based on whether a non-standard server is configured.
 * Call this on app startup and when server changes.
 */
export function initAppAccountHandle(): void {
  const serverParam = localStorage.getItem('skylimit_server')
  appAccountHandle = serverParam ? SKYSPEED_APP_ACCOUNT_HANDLE : DEFAULT_APP_ACCOUNT_HANDLE
}
import { clientNow, clientDate } from '../utils/clientClock'
import log from '../utils/logger'

/**
 * Check if a post is a periodic edition (synthetic repost created by edition assembly)
 */
export function isPeriodicEdition(curation: CurationMetadata | undefined): boolean {
  return curation?.edition_status === 'synthetic'
}

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
 * Get edition time strings from settings.
 */
export async function getEditionTimeStrs(): Promise<string[]> {
  const { getSettings } = await import('./skylimitStore')
  const settings = await getSettings()

  if (settings.editionLayout) {
    const { getParsedEditions } = await import('./skylimitEditions')
    const parsed = await getParsedEditions()
    return parsed.editions
      .filter(e => e.editionNumber > 0)
      .map(e => e.time)
      .filter(t => t)
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
 * Safely extract text from a post record.
 * Handles the untyped record structure used in AT Protocol.
 */
export function extractPostText(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined
  }

  const rec = record as any

  // Direct text property (most common case)
  if (typeof rec.text === 'string' && rec.text.length > 0) {
    return rec.text
  }

  // Nested under value (sometimes seen in embedded records)
  if (rec.value && typeof rec.value.text === 'string' && rec.value.text.length > 0) {
    return rec.value.text
  }

  return undefined
}

/**
 * Extract text from a quoted/embedded post if present.
 * Handles different embed types: record#view and recordWithMedia#view.
 */
export function extractQuotedText(embed: unknown): string | undefined {
  if (!embed || typeof embed !== 'object') {
    return undefined
  }

  const emb = embed as any
  const embedType = emb.$type

  // Handle app.bsky.embed.record#view (simple quote)
  if (embedType === 'app.bsky.embed.record#view' || embedType === 'app.bsky.embed.record') {
    const quotedRecord = emb.record

    // Check if the quoted post is blocked or not found
    if (!quotedRecord || quotedRecord.blocked || quotedRecord.notFound) {
      return undefined
    }

    // The quoted post's record is in quotedRecord.value (for ViewRecord)
    // or quotedRecord.record (for some structures)
    const innerRecord = quotedRecord.value || quotedRecord.record || quotedRecord
    return extractPostText(innerRecord)
  }

  // Handle app.bsky.embed.recordWithMedia#view (quote with media)
  if (embedType === 'app.bsky.embed.recordWithMedia#view' || embedType === 'app.bsky.embed.recordWithMedia') {
    // The record portion is at emb.record, which itself contains the embedded record
    const recordEmbed = emb.record
    if (!recordEmbed) {
      return undefined
    }

    // Recursively extract from the record embed
    // recordWithMedia.record has the same structure as embed.record
    const quotedRecord = recordEmbed.record
    if (!quotedRecord || quotedRecord.blocked || quotedRecord.notFound) {
      return undefined
    }

    const innerRecord = quotedRecord.value || quotedRecord.record || quotedRecord
    return extractPostText(innerRecord)
  }

  return undefined
}

/**
 * Extract the handle of the quoted/embedded post's author from an embed object.
 * Mirrors extractQuotedText but returns the author handle instead of text.
 */
export function extractQuotedAuthorHandle(embed: unknown): string | undefined {
  if (!embed || typeof embed !== 'object') return undefined

  const emb = embed as any
  const embedType = emb.$type

  if (embedType === 'app.bsky.embed.record#view' || embedType === 'app.bsky.embed.record') {
    const quotedRecord = emb.record
    if (!quotedRecord || quotedRecord.blocked || quotedRecord.notFound) return undefined
    return quotedRecord.author?.handle
  }

  if (embedType === 'app.bsky.embed.recordWithMedia#view' || embedType === 'app.bsky.embed.recordWithMedia') {
    const recordEmbed = emb.record
    if (!recordEmbed) return undefined
    const quotedRecord = recordEmbed.record
    if (!quotedRecord || quotedRecord.blocked || quotedRecord.notFound) return undefined
    return quotedRecord.author?.handle
  }

  return undefined
}

/**
 * Create post summary from FeedViewPost
 */
export function createPostSummary(post: AppBskyFeedDefs.FeedViewPost, feedReceivedTime?: Date, myUsername?: string): PostSummary {
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
  let likeCount: number
  let replyCount: number
  let inReplyToUri: string | undefined
  let postEngagement: number
  let postText: string | undefined
  let quotedText: string | undefined
  let quoted_username: string | undefined

  if (isReposted) {
    // This is a repost
    const reposter = (post.reason as any)?.by
    if (!reposter) {
      // Fallback if reason.by is not available (shouldn't happen)
      log.warn('Repost', 'Repost detected but reposter info not available')
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
    likeCount = post.post.likeCount ?? 0
    replyCount = post.post.replyCount ?? 0
    inReplyToUri = getParentUri(post.post)
    postEngagement = ENGAGEMENT_NONE
      + (post.post.viewer?.like ? ENGAGEMENT_LIKED : 0)
      + (post.post.viewer?.bookmarked ? ENGAGEMENT_BOOKMARKED : 0)
      + (post.post.viewer?.repost ? ENGAGEMENT_REPOSTED : 0)
    // Extract text from the original post (the one being reposted)
    postText = extractPostText(post.post.record)
    quotedText = extractQuotedText(post.post.embed)
    quoted_username = extractQuotedAuthorHandle(post.post.embed)
  } else {
    // This is an original post
    username = post.post.author.handle
    accountDid = post.post.author.did
    orig_username = undefined
    tags = getHashtags(post.post)
    repostUri = undefined
    cid = post.post.cid
    repostCount = post.post.repostCount || 0
    likeCount = post.post.likeCount ?? 0
    replyCount = post.post.replyCount ?? 0
    inReplyToUri = getParentUri(post.post)
    postEngagement = ENGAGEMENT_NONE
      + (post.post.viewer?.like ? ENGAGEMENT_LIKED : 0)
      + (post.post.viewer?.bookmarked ? ENGAGEMENT_BOOKMARKED : 0)
      + (post.post.viewer?.repost ? ENGAGEMENT_REPOSTED : 0)
    // Extract text from this post
    postText = extractPostText(post.post.record)
    quotedText = extractQuotedText(post.post.embed)
    quoted_username = extractQuotedAuthorHandle(post.post.embed)
  }

  // Don't track engagement on self posts — it skews comparisons
  if (myUsername && username === myUsername) {
    postEngagement = ENGAGEMENT_NONE
  }

  // For reposts, use feedReceivedTime (when we received the feed = when reposted)
  // For original posts, use createdAt (when it was created)
  const timestamp = getFeedViewPostTimestamp(post, feedReceivedTime)
  
  log.trace('fetched', username, timestamp.getTime(), postText || '')
  return {
    uniqueId,
    cid,
    username,
    accountDid,
    orig_username,
    tags,
    repostUri,
    repostCount,
    likeCount,
    replyCount,
    inReplyToUri,
    timestamp,
    postTimestamp: timestamp.getTime(),
    postEngagement,
    postText,
    quotedText,
    quoted_username,
  }
}

/**
 * Extract priority patterns from profile description.
 * Parses "Skylimit: [m.n,] pattern1, pattern2, ..." format.
 * The optional leading number (skylimit number) is skipped.
 * Returns comma-separated patterns string, or empty string if none found.
 */
export function extractPriorityPatternsFromProfile(profile: AppBskyActorDefs.ProfileViewDetailed): string {
  const description = profile.description || ''
  const match = description.match(/\bskylimit(?:\.[a-z]+)?:\s*([^\n]+)/i)
  if (!match) return ''

  let rest = match[1].trim()
  // Skip optional leading skylimit number (e.g., "2.5, #tech, ai*" → skip "2.5,")
  const numMatch = rest.match(/^(\d+(?:\.\d+)?)\s*,\s*/)
  if (numMatch) {
    rest = rest.substring(numMatch[0].length)
  }

  // Return remaining comma-separated patterns (trimmed), with URL patterns normalized
  const patterns = rest.split(',').map(p => p.trim()).filter(p => p.length > 0).map(p => {
    // Support URL patterns: "[prefix words] https://domain/path" → "domain/path"
    const urlMatch = p.match(/https?:\/\/([^\s]+)/)
    if (urlMatch) {
      return urlMatch[1].replace(/\/+$/, '') // strip trailing slashes
    }
    return p
  })
  return patterns.join(', ')
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
 * Check if two dates are in the same calendar week (Sunday to Saturday)
 */
export function isSameWeek(
  date1: Date,
  date2: Date,
  timezone: string = 'UTC'
): boolean {
  const d1 = new Date(date1.toLocaleString('en-US', { timeZone: timezone }))
  const d2 = new Date(date2.toLocaleString('en-US', { timeZone: timezone }))

  // Get the Sunday that starts each date's week
  const sun1 = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate() - d1.getDay())
  const sun2 = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate() - d2.getDay())

  return sun1.getTime() === sun2.getTime()
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
  return new Date(record?.createdAt || clientNow())
}

/**
 * Get unique ID for a post (for looking up in summaries cache)
 * - Original posts: use post.post.uri
 * - Reposts: use reason.uri if available (AT Protocol repost URI),
 *   otherwise fallback to `sl-rp://repost/${reposterDid}:${post.post.uri}`
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
      return `${SL_REPOST_PREFIX}repost/${reposter.did}:${post.post.uri}`
    }
    return `${SL_REPOST_PREFIX}repost/${post.post.author.did}:${post.post.uri}`
  }
  return post.post.uri
}

/**
 * Get the web URL for a post, dispatching by platform.
 * For Bluesky: converts AT URI to https://bsky.app/profile/{handle}/post/{rkey}
 * Future platforms (e.g., Mastodon) can add branches here.
 *
 * @param uri - The post URI (AT Protocol URI for Bluesky)
 * @param handle - The author's handle
 * @param platform - The feed platform (defaults to 'bluesky')
 * @returns The web URL for the post
 */
export function getPostUrl(uri: string, handle: string, platform: FeedPlatform = 'bluesky'): string {
  switch (platform) {
    case 'bluesky':
    default: {
      // Extract rkey from AT URI: at://did:plc:xxx/app.bsky.feed.post/rkey
      const parts = uri.replace('at://', '').split('/')
      const rkey = parts[2] // The record key is the last segment
      return `https://bsky.app/profile/${handle}/post/${rkey}`
    }
  }
}

/**
 * Get the web URL for a user profile, dispatching by platform.
 * For Bluesky: https://bsky.app/profile/{handle}
 * Future platforms (e.g., Mastodon) can add branches here.
 *
 * @param handle - The user's handle
 * @param platform - The feed platform (defaults to 'bluesky')
 * @returns The web URL for the profile
 */
export function getProfileUrl(handle: string, platform: FeedPlatform = 'bluesky'): string {
  switch (platform) {
    case 'bluesky':
    default:
      return `https://bsky.app/profile/${handle}`
  }
}

/** @deprecated Use getPostUrl() instead */
export const getBlueSkyPostUrl = getPostUrl
/** @deprecated Use getProfileUrl() instead */
export const getBlueSkyProfileUrl = getProfileUrl

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

  // Helper: return a valid Date or null
  const validDate = (value: any): Date | null => {
    if (!value) return null
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }

  if (isReposted) {
    // For reposts, try multiple approaches to get the repost timestamp

    // 1. Check if reason object has timestamp (unlikely but possible)
    const reason = post.reason as any
    const fromIndexedAt = validDate(reason?.indexedAt)
    if (fromIndexedAt) return fromIndexedAt
    const fromCreatedAt = validDate(reason?.createdAt)
    if (fromCreatedAt) return fromCreatedAt

    // 2. Check if FeedViewPost itself has indexedAt (some API responses might)
    const fromPostIndexedAt = validDate((post as any).indexedAt)
    if (fromPostIndexedAt) return fromPostIndexedAt

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
    const now = clientDate()
    // Add a small offset based on post URI hash to ensure consistent ordering
    const uriHash = post.post.uri.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const offset = (uriHash % 1000) // 0-999ms offset
    return new Date(now.getTime() + offset)
  }

  // Original post: use createdAt, then indexedAt, then current time
  const record = post.post.record as any
  const fromCreatedAt = validDate(record?.createdAt)
  if (fromCreatedAt) return fromCreatedAt
  const fromIndexedAt = validDate(post.post.indexedAt)
  if (fromIndexedAt) return fromIndexedAt
  return new Date(clientNow())
}

/**
 * Check if a post is a pinned message from the app account (skylimit.dev).
 * If so, store it in localStorage for display as a banner.
 * Only updates if the post has a different uniqueId than the last stored one.
 */
export function checkAndStorePinnedPost(summary: PostSummary): void {
  if (summary.username !== appAccountHandle) return
  if (!summary.tags.includes('pin')) return

  const lastPinnedId = localStorage.getItem(PINNED_POST_ID_KEY)
  if (lastPinnedId === summary.uniqueId) return

  // Strip #pin hashtag from display text
  const displayText = (summary.postText || '')
    .replace(/#pin\b/gi, '')
    .trim()

  localStorage.setItem(PINNED_POST_ID_KEY, summary.uniqueId)
  localStorage.setItem(PINNED_POST_TEXT_KEY, displayText)
  window.dispatchEvent(new Event('pinnedPostUpdated'))
}

