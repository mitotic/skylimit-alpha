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
  original_posts_daily?: number         // motx + priority + post (excluding boosts)
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
  post_daily: number
  repost_daily: number         // Daily repost count for this user
  engaged_daily: number
  total_daily: number
  net_prob: number
  priority_prob: number
  post_prob: number
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
  curation_dropped?: string
  curation_msg?: string
}

export interface FollowInfo {
  accountDid: string
  username: string
  followed_at: string
  amp_factor: number
  topics?: string
  timezone?: string
  displayName?: string
  [MOTD_TAG]?: string
  [MOTW_TAG]?: string
  [MOTM_TAG]?: string
}

/**
 * Result of curating a single post - metadata attached to posts after curation.
 */
export interface CurationResult {
  curation_dropped?: string
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
  post_total: number
  engaged_total: number
  weight: number
  follow_weight: number
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
  showAllStatus: boolean
  disabled: boolean
  daysOfData: number
  secretKey: string
  editionTimes: string
  editionLayout: string
  anonymizeUsernames: boolean
  debugMode: boolean
  feedRedisplayIdleInterval?: number // in milliseconds, default 5 minutes
  feedPageLength?: number // number of posts per page, default 25, range 10-100
  infiniteScrollingOption?: boolean // enable infinite scrolling, default false
  // Paged fresh updates settings
  pagedUpdatesEnabled?: boolean // enable paged fresh updates, default true (enabled by default)
  pagedUpdatesVarFactor?: number // variability factor for PageRaw calculation, default 1.5
  pagedUpdatesFullPageWaitMinutes?: number // time to wait for full page before showing partial page, default 30
  // Lookback caching settings
  lookbackDays?: number // number of days to cache back from today, default 1
  // Feed display settings
  maxDisplayedFeedSize?: number // max posts in displayed feed, default 300
  // Curation interval settings
  curationIntervalHours?: number // curation interval in hours, default 2, must be 1-12 and factor of 24 (1, 2, 3, 4, 6, 8, 12)
}

/**
 * Curation metadata attached to FeedViewPost for display purposes.
 */
export interface CurationMetadata {
  curation_dropped?: string
  curation_msg?: string
  curation_edition?: boolean
  curation_save?: string
  curation_id?: string
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

