import { AppBskyFeedDefs } from '@atproto/api'

// Periodic post tags
export const MOTD_TAG = 'motd'
export const MOTW_TAG = 'motw'
export const MOTM_TAG = 'motm'
export const MOT_TAGS = [MOTD_TAG, MOTW_TAG, MOTM_TAG]
export const MOTX_TAG = 'motx'
export const DIGEST_TAG = 'digest'
export const NODIGEST_TAG = 'nodigest'
export const PRIORITY_TAG = 'priority'

// Curation status type - always ends in '_show' or '_drop'
export type CurationStatus =
  | 'motx_show'        // MOTx tag post accepted
  | 'priority_show'    // Priority post passes probability filter
  | 'priority_drop'    // Priority post fails probability filter
  | 'regular_show'     // Regular post passes probability filter
  | 'regular_drop'     // Regular post fails probability filter
  | 'reply_drop'       // Unfollowed reply dropped
  | 'repost_drop'      // Repost/original shown within interval
  | 'edition_drop'     // Post saved for edition digest
  | 'untracked_show'   // User not tracked - shown by default
  | 'temp_show'        // Temporary show during initial lookback (before stats computed)
  | 'self_show'        // User's own post - always shown

/**
 * Check if a curation status indicates the post should be shown
 */
export function isStatusShow(status: CurationStatus | undefined): boolean {
  return status === undefined || status.endsWith('_show')
}

/**
 * Check if a curation status indicates the post should be dropped
 */
export function isStatusDrop(status: CurationStatus | undefined): boolean {
  return status !== undefined && status.endsWith('_drop')
}

// Keys for user profile metadata
export const USER_TOPICS_KEY = 'topics'
export const USER_TIMEZONE_KEY = 'timezone'

// Amplification factor limits
export const MAX_AMP_FACTOR = 8.0
export const MIN_AMP_FACTOR = 0.125

// Analysis period settings - default interval (used as fallback)
const DEFAULT_INTERVAL_HOURS = 2

// Valid interval values (factors of 24 between 1-12)
export const VALID_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const

export const MOTD_MIN_SKYLIMIT_NUMBER = 1.0

// Forward declaration for settings type (full interface defined below)
type SkylimitSettingsForInterval = { curationIntervalHours?: number }

/**
 * Get the curation interval in hours from settings.
 * Validates that the value is a factor of 24 and between 1-12.
 */
export function getIntervalHoursSync(settings: SkylimitSettingsForInterval): number {
  const hours = settings.curationIntervalHours ?? DEFAULT_INTERVAL_HOURS
  return VALID_INTERVAL_HOURS.includes(hours as typeof VALID_INTERVAL_HOURS[number])
    ? hours
    : DEFAULT_INTERVAL_HOURS
}

/**
 * Get the curation interval in minutes from settings.
 */
export function getIntervalMinutesSync(settings: SkylimitSettingsForInterval): number {
  return getIntervalHoursSync(settings) * 60
}

/**
 * Get the number of intervals per day from settings.
 */
export function getIntervalsPerDaySync(settings: SkylimitSettingsForInterval): number {
  return 24 / getIntervalHoursSync(settings)
}

/**
 * Extract DID from an AT Protocol URI.
 * AT URIs follow the format: at://did:plc:xxx/app.bsky.feed.post/rkey
 * @param uri - The AT Protocol URI
 * @returns The DID portion, or null if the URI is invalid
 */
export function extractDidFromUri(uri: string): string | null {
  if (!uri || !uri.startsWith('at://')) return null
  const parts = uri.replace('at://', '').split('/')
  if (parts.length >= 1 && parts[0].startsWith('did:')) {
    return parts[0]
  }
  return null
}

/**
 * Global statistics for curation across all followed users.
 *
 * Skylimit Number: The core metric determining guaranteed views per day.
 * Computed to balance viewing capacity across all followed accounts based
 * on their posting frequency and amplification factors.
 */
export interface GlobalStats {
  skylimit_number: number
  post_daily: number           // Daily post count across all users (renamed from status_daily)
  shown_daily: number
  post_total: number           // Total posts in analysis period (renamed from status_total)
  day_total: number
  post_lastday: number         // Posts from the last day (renamed from status_lastday)
  shown_lastday: number

  // Interval diagnostics
  intervals_expected?: number           // Total intervals in daysOfData range
  intervals_processed?: number          // Intervals with data (non-empty)
  intervals_sparse?: number             // Intervals with < 10% of average posts
  posts_per_interval_avg?: number       // Average posts per processed interval
  posts_per_interval_max?: number       // Maximum posts in any single interval

  // Time range display
  analysis_start_time?: string          // ISO string of analysis start (UTC)
  analysis_end_time?: string            // ISO string of analysis end (UTC)

  // Posts breakdown
  original_daily?: number               // Original posts (not replies)
  followed_reply_daily?: number         // Replies to followees
  unfollowed_reply_daily?: number       // Replies to non-followees
  reposts_daily?: number                // boost_total / dayTotal

  // Cache vs accumulated diagnostics
  summaries_total_cached?: number       // Total summaries across all intervals (complete + incomplete)
  summaries_dropped_cached?: number     // Total dropped summaries across all intervals
  summaries_total?: number              // Total posts in summaries cache (complete intervals only)
  summaries_accumulated?: number        // Posts accumulated (from current followees)

  // Summaries cache timestamps
  summaries_oldest_time?: string        // ISO string of oldest post in summaries
  summaries_newest_time?: string        // ISO string of newest post in summaries

  // Complete intervals algorithm
  intervals_complete?: number           // Intervals with non-zero neighbors (not at boundary)
  intervals_incomplete?: number         // Non-zero intervals that are incomplete
  complete_intervals_days?: number      // completeCount / intervalsPerDay
  interval_length_hours?: number        // Curation interval length in hours (from settings)
  days_of_data?: number                 // daysOfData setting (summaries cache retention period)
}

/**
 * Per-user curation statistics and probabilities.
 *
 * Amplification Factor (amp_factor): A per-user multiplier (0.125 to 8.0)
 * that increases or decreases visibility of posts from specific accounts.
 * Higher values = more posts shown from that user.
 */
export interface UserEntry {
  altname: string
  acct_id: string
  topics: string
  amp_factor: number
  motx_daily: number
  priority_daily: number
  original_daily: number       // Original posts (not replies)
  followed_reply_daily: number // Replies to followees
  unfollowed_reply_daily: number // Replies to non-followees
  repost_daily: number         // Daily repost count for this user
  engaged_daily: number
  total_daily: number
  net_prob: number
  priority_prob: number
  regular_prob: number
}

export interface UserFilter {
  [username: string]: UserEntry
}

/**
 * Summary of a post for curation purposes.
 *
 * IMPORTANT: uniqueId vs URI distinction:
 * - uniqueId: For original posts, same as the post's URI. For reposts, it's
 *   reason.uri (the AT Protocol repost URI) if available, otherwise a synthetic
 *   ID in the format `sl://repost/${reposterDid}:${postUri}`.
 * - repostUri: The actual AT Protocol URI of the original post (for reposts only).
 * - inReplyToUri: The actual AT Protocol URI of the parent post (for replies only).
 */
export interface PostSummary {
  uniqueId: string              // Unique identifier (see above for format)
  cid: string
  username: string
  accountDid: string
  tags: string[]
  repostUri?: string            // Actual URI of the reposted post
  repostCount: number
  inReplyToUri?: string         // Actual URI of the parent post
  timestamp: Date
  postTimestamp: number         // Numeric timestamp for IndexedDB indexing (timestamp.getTime())
  engaged: boolean
  orig_username?: string
  curation_status?: CurationStatus
  curation_msg?: string
  // Invariant counter numbering (added for counter revamp)
  postNumber?: number | null    // Sequential count in follow feed (resets daily, 1-indexed). null if unassigned
  curationNumber?: number | null // Count among shown posts: 0 for dropped, positive for shown, null if unassigned
  // Text fields for search capability
  postText?: string             // Main post text content
  quotedText?: string           // Text from quoted/embedded post (if any)
  // Edition save section (from CurationResult, for deferred edition saving)
  curation_save?: string
  // View tracking
  viewedAt?: number             // Client time timestamp (ms via clientNow()) when the post was first viewed in the viewport
}

export interface FollowInfo {
  accountDid: string
  username: string
  followed_at: string
  amp_factor: number
  topics?: string
  timezone?: string
  displayName?: string
  last_posted_at?: number  // postTimestamp of most recent post (ms)
  amp_factor_changed_at?: number  // Timestamp (ms) of last amp factor change
  [MOTD_TAG]?: string
  [MOTW_TAG]?: string
  [MOTM_TAG]?: string
}

/**
 * Result of curating a single post - metadata attached to posts after curation.
 */
export interface CurationResult {
  curation_status?: CurationStatus
  curation_msg?: string
  curation_edition?: boolean
  curation_save?: string
  curation_id?: string
}

/**
 * Accumulator for computing per-user statistics during interval processing.
 * Used in the two-pass statistics algorithm to gather data before probability computation.
 */
export interface UserAccumulator {
  userEntry: UserEntry
  repost_total: number         // Total reposts accumulated
  motx_total: number
  priority_total: number
  original_total: number       // Original posts (not replies)
  followed_reply_total: number // Replies to followees
  unfollowed_reply_total: number // Replies to non-followees
  engaged_total: number
  weight: number
  normalized_daily: number
  followed_at?: string
}

/**
 * Statistics for tracking repost counts during interval processing.
 */
export interface PostStats {
  repost_count: number           // Number of times post was reposted (renamed from boost_count)
  followed_repost_count: number  // Reposts by followed users (renamed from fboost_count)
  repostCount: number            // Original repost count from post metadata
}

export interface EditionLayout {
  [key: string]: {
    section: string
    tag?: string
    index: number
  }
}

export interface SkylimitSettings {
  viewsPerDay: number
  showTime: boolean
  showAllPosts: boolean
  curationSuspended: boolean
  daysOfData: number
  secretKey: string
  editionTimes: string
  editionLayout: string
  anonymizeUsernames: boolean
  debugMode: boolean
  feedRedisplayIdleInterval?: number // in milliseconds, default 240 minutes
  feedPageLength?: number // number of posts per page, default 25, values: 10, 20, 25, 50
  infiniteScrollingOption?: boolean // enable infinite scrolling, default false
  // Paged fresh updates settings
  pagedUpdatesVarFactor?: number // variability factor for PageRaw calculation, default 2
  pagedUpdatesFullPageWaitMinutes?: number // time to wait for full page before showing partial page, default 30
  // Repost display interval settings
  repostDisplayIntervalHours?: number // hide reposts if original/repost shown within this interval (hours), default 0 (disabled)
  // Lookback caching settings
  lookbackDays?: number // number of days to cache back from today, default 1
  // Feed display settings
  maxDisplayedFeedSize?: number // max posts in displayed feed, default 300
  // Curation interval settings
  curationIntervalHours?: number // curation interval in hours, default 2, must be 1-12 and factor of 24 (1, 2, 3, 4, 6, 8, 12)
  // Debug settings for effective day count
  minFolloweeDayCount?: number // minimum followee day count to prevent inflated posting rates, default 1
  // Reply handling settings
  hideUnfollowedReplies?: boolean // Hide all replies to non-followees, default false
  showViewedStatus?: boolean // Show viewed-post visual indicators (checkmark, gradient, unviewed count), default true
  timezone?: string // Stored timezone for consistent day boundaries (e.g., "America/New_York")
  lastBrowserTimezone?: string // Browser timezone when user last saved/confirmed timezone setting
}

/**
 * Curation metadata attached to FeedViewPost for display purposes.
 */
export interface CurationMetadata {
  curation_status?: CurationStatus
  curation_msg?: string
  curation_edition?: boolean
  curation_save?: string
  curation_id?: string
  // Number fields to avoid IndexedDB lookups in PostCard
  postNumber?: number | null
  curationNumber?: number | null
  // View tracking
  viewedAt?: number
}

export type CurationFeedViewPost = AppBskyFeedDefs.FeedViewPost & {
  curation?: CurationMetadata
}

/**
 * Cache entry for a feed post.
 *
 * IMPORTANT: uniqueId is NOT the same as the post's URI for reposts.
 * - For original posts: uniqueId equals post.post.uri
 * - For reposts: uniqueId is reason.uri (the AT Protocol repost URI) if available,
 *   otherwise a synthetic ID in the format `sl://repost/${reposterDid}:${post.post.uri}`
 */
export interface FeedCacheEntry {
  uniqueId: string               // Unique identifier (see above for format)
  post: AppBskyFeedDefs.FeedViewPost
  timestamp: number              // feedReceivedTime (when batch was received)
  postTimestamp: number          // actual post creation/repost time
  interval: string
  cachedAt: number
  reposterDid?: string           // For reposts, store reposter DID for unique ID construction
}

/**
 * Feed cache entry with original post preserved
 * Used for creating entries before saving, and passing to curation
 */
export interface FeedCacheEntryWithPost extends FeedCacheEntry {
  originalPost: AppBskyFeedDefs.FeedViewPost  // Keep original for curation
}

/**
 * Fetch mode for unified fetchToSecondaryFeedCache
 */
export type FetchMode = 'initial' | 'idle_return' | 'next_page' | 'all_new'

/**
 * Stop reason for unified fetch
 */
export type FetchStopReason = 'overlap' | 'boundary' | 'exhausted' | 'max_iterations'

/**
 * In-memory secondary cache entry — holds a feed cache entry with its inline curation summary
 */
export interface SecondaryEntry {
  entry: FeedCacheEntryWithPost
  summary: PostSummary
}

/**
 * Index entry for efficient repost lookups in the secondary cache.
 * Maps original post URIs to summaries that reference them.
 */
export interface SecondaryRepostIndexEntry {
  uniqueId: string
  postTimestamp: number
  curation_status?: CurationStatus
}

/**
 * Map from original post URI → entries that reference it.
 * Covers both originals (keyed by uniqueId) and reposts (keyed by repostUri),
 * since both map to the same key space (original post URIs).
 */
export type SecondaryRepostIndex = Map<string, SecondaryRepostIndexEntry[]>

/**
 * Add a summary to the secondary repost index.
 * Call this after pushing to secondaryEntries.
 */
export function addToRepostIndex(index: SecondaryRepostIndex, summary: PostSummary): void {
  const entry: SecondaryRepostIndexEntry = {
    uniqueId: summary.uniqueId,
    postTimestamp: summary.postTimestamp,
    curation_status: summary.curation_status,
  }
  // Index by uniqueId (covers Check 3a: original post lookup)
  const byId = index.get(summary.uniqueId)
  if (byId) byId.push(entry)
  else index.set(summary.uniqueId, [entry])
  // Index by repostUri if present (covers Check 3b: repost lookup)
  if (summary.repostUri) {
    const byRepost = index.get(summary.repostUri)
    if (byRepost) byRepost.push(entry)
    else index.set(summary.repostUri, [entry])
  }
}

/**
 * Result of unified fetchToSecondaryFeedCache
 */
export interface SecondaryFetchResult {
  stopReason: FetchStopReason
  entries: SecondaryEntry[]
  postsFetched: number
  oldestTimestamp: number | null
  newestTimestamp: number | null
}

