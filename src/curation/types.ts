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

// Analysis period settings
export const UPDATE_INTERVAL_MINUTES = 120 // 2 hours
export const INTERVALS_PER_DAY = 24 * 60 / UPDATE_INTERVAL_MINUTES // 12 intervals per day
export const MOTD_MIN_SKYLIMIT_NUMBER = 1.0

export interface GlobalStats {
  skylimit_number: number
  status_daily: number
  shown_daily: number
  status_total: number
  day_total: number
  status_lastday: number
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
  summaries_skipped?: number            // Posts skipped (from non-followees)

  // Summaries cache timestamps
  summaries_oldest_time?: string        // ISO string of oldest post in summaries
  summaries_newest_time?: string        // ISO string of newest post in summaries

  // Complete intervals algorithm
  intervals_complete?: number           // Intervals with non-zero neighbors (not at boundary)
  intervals_incomplete?: number         // Non-zero intervals that are incomplete
  complete_intervals_days?: number      // completeCount / INTERVALS_PER_DAY
  interval_length_hours?: number        // UPDATE_INTERVAL_MINUTES / 60 (for UI display)
  days_of_data?: number                 // daysOfData setting (summaries cache retention period)
}

export interface UserEntry {
  altname: string
  acct_id: string
  topics: string
  amp_factor: number
  motx_daily: number
  priority_daily: number
  post_daily: number
  boost_daily: number
  reblog2_daily: number
  engaged_daily: number
  total_daily: number
  net_prob: number
  priority_prob: number
  post_prob: number
  reblog2_avg: number
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
  curation_high_boost?: boolean
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

export interface CurationResult {
  curation_dropped?: string
  curation_msg?: string
  curation_high_boost?: boolean
  curation_edition?: boolean
  curation_save?: string
  curation_id?: string
  curation_tag?: string
}

export interface UserAccumulator {
  userEntry: UserEntry
  boost_total: number
  reblog2_total: number
  motx_total: number
  priority_total: number
  post_total: number
  engaged_total: number
  weight: number
  follow_weight: number
  normalized_daily: number
  followed_at?: string
}

export interface PostStats {
  boost_count: number
  fboost_count: number
  repostCount: number
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
  amplifyHighBoosts: boolean
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
}

// Extended FeedViewPost with curation metadata
export interface CurationMetadata {
  curation_dropped?: string
  curation_msg?: string
  curation_high_boost?: boolean
  curation_edition?: boolean
  curation_save?: string
  curation_id?: string
  curation_tag?: string
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

