import { AppBskyFeedDefs } from '@atproto/api'

// Feed platform discriminator (for future multi-protocol support)
export type FeedPlatform = 'bluesky' | 'mastodon'

// Periodic post tag
export const WEEKLY_TAG = 'weekly'

// Default priority patterns (match any hashtagged post)
export const DEFAULT_PRIORITY_PATTERNS = '#*'

// Curation status type - always ends in '_show' or '_drop'
export const CURATION_STATUSES = [
  'periodic_show',        // Periodic tag post accepted (#Weekly)
  'priority_always_show', // Priority post shown (probability = 1)
  'priority_show',        // Priority post passes probability filter
  'priority_drop',        // Priority post fails probability filter
  'regular_always_show',  // Regular post shown (probability = 1)
  'regular_show',         // Regular post passes probability filter (no popularity data)
  'regular_drop',         // Regular post fails probability filter (no popularity data)
  'regular_lo_show',      // Low popularity regular post passes probability filter
  'regular_lo_drop',      // Low popularity regular post fails probability filter
  'regular_hi_show',      // High popularity regular post passes probability filter
  'regular_hi_drop',      // High popularity regular post fails probability filter
  'reply_drop',           // Unfollowed reply dropped
  'repost_drop',          // Repost/original shown within interval
  'edition_post_drop',    // Post matched edition pattern, held for edition
  'edition_post_show',    // Edition held post released (orphaned by layout change)
  'edition_publish_drop', // Edition repost dropped (shouldn't normally occur)
  'edition_publish_show', // Edition repost shown
  'untracked_show',       // User not tracked - shown by default
  'temp_show',            // Temporary show during initial lookback (before stats computed)
  'self_show',            // User's own post - always shown
] as const

export type CurationStatus = typeof CURATION_STATUSES[number]

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

/**
 * Check if a post is truly dropped (excludes edition statuses which are assembled, not dropped)
 */
export function isPostDropped(status: CurationStatus | undefined): boolean {
  return status !== undefined && status.endsWith('_drop') && !status.startsWith('edition_')
}

/**
 * Check if a post is part of an edition (curation status starts with 'edition_post_')
 */
export function isPostEdited(status: CurationStatus | undefined): boolean {
  return status !== undefined && status.startsWith('edition_post_')
}

/**
 * Check if a curation status is an edition publish status (skip in numbering)
 */
export function isEditionPublishStatus(status: CurationStatus | undefined): boolean {
  return status !== undefined && status.startsWith('edition_publish_')
}

/**
 * Check if a curation status is an edition post status (held or released)
 */
export function isEditionPostStatus(status: CurationStatus | undefined): boolean {
  return status !== undefined && status.startsWith('edition_post_')
}

// Keys for user profile metadata
export const USER_PRIORITY_PATTERNS_KEY = 'priorityPatterns'
export const USER_TIMEZONE_KEY = 'timezone'

// Amplification factor limits
export const MAX_AMP_FACTOR = 32.0
export const MIN_AMP_FACTOR = 1/32  // 0.03125

// Analysis period settings - default interval (used as fallback)
const DEFAULT_INTERVAL_HOURS = 2

// Valid interval values (factors of 24 between 1-12)
export const VALID_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const


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
  complete_intervals_day_total: number
  effective_day_total: number
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
  reposts_daily?: number                // repostsTotal / effectiveDayTotal
  edited_daily?: number                 // editionPostTotal / effectiveDayTotal
  edited_hold_daily?: number            // editionHoldTotal / effectiveDayTotal

  // Cache vs accumulated diagnostics
  summaries_total_all?: number          // Total summaries in cache (all intervals)
  summaries_total_processed?: number    // Summaries from processed intervals only
  summaries_total_followees?: number    // Posts accumulated (from current followees)

  // Summaries cache timestamps
  summaries_oldest_time?: string        // ISO string of oldest post in summaries
  summaries_newest_time?: string        // ISO string of newest post in summaries

  // Complete intervals algorithm
  intervals_complete?: number           // Intervals with non-zero neighbors (not at boundary)
  intervals_incomplete?: number         // Non-zero intervals that are incomplete
  complete_intervals_days?: number      // completeCount / intervalsPerDay
  interval_length_hours?: number        // Curation interval length in hours (from settings)
  days_of_data?: number                 // daysOfData setting (summaries cache retention period)

  // Per-status accumulator counts (keys are CurationStatus values + 'null' for undefined)
  curation_status_counts?: Record<string, number>

  // Per-post-type accumulator counts (keys are PostType values + 'null' for undefined)
  post_type_counts?: Record<string, number>
}

/**
 * Per-user curation statistics and probabilities.
 *
 * Amplification Factor (amp_factor): A per-user multiplier (1/32 to 32.0)
 * that increases or decreases visibility of posts from specific accounts.
 * Higher values = more posts shown from that user.
 */
export interface UserEntry {
  altname: string
  acct_id: string
  priorityPatterns: string
  amp_factor: number
  periodic_daily: number
  priority_daily: number
  original_daily: number       // Original posts (not replies)
  followed_reply_daily: number // Replies to followees
  unfollowed_reply_daily: number // Replies to non-followees
  reposts_daily: number         // Daily repost count for this user
  edited_daily: number         // Edition-matched posts per day (diagnostics only)
  edited_hold_daily: number    // Edition hold posts per day
  engaged_daily: number
  total_daily: number
  shown_daily: number           // Actual shown posts per day (from curation status tracking)
  net_prob: number
  priority_prob: number
  regular_prob: number
  medianPop: number             // Median popularity for this user (0 = disabled)
}

export interface UserFilter {
  [username: string]: UserEntry
}

/** Per-user text pattern suggestions for edition layout autocomplete */
export type TextSuggestions = { hashtags: string[]; domains: string[] }
export type SuggestionsMap = Map<string, TextSuggestions>

/**
 * Summary of a post for curation purposes.
 *
 * IMPORTANT: uniqueId vs URI distinction:
 * - uniqueId: For original posts, same as the post's URI. For reposts, it's
 *   reason.uri (the AT Protocol repost URI) if available, otherwise a synthetic
 *   ID in the format `sl-rp://repost/${reposterDid}:${postUri}`.
 *   Synthetic edition posts use `sl-ed://repost/${editorDid}:${postUri}`.
 * - repostUri: The actual AT Protocol URI of the original post (for reposts only).
 * - inReplyToUri: The actual AT Protocol URI of the parent post (for replies only).
 */
// Synthetic URI protocol prefixes for repost and edition unique IDs
export const SL_REPOST_PREFIX = 'sl-rp://'   // Regular reposts without reason.uri
export const SL_EDITION_PREFIX = 'sl-ed://'  // Synthetic edition posts

// Popularity weighting constants
export const POP_LOG_MAX = 3           // Max log10 value (popIndex capped at 10^logMax - 1 = 999)
export const POP_LOG_INTERVALS = 20    // Number of log intervals per unit
export const POP_MAX_BIN_INDEX = POP_LOG_MAX * POP_LOG_INTERVALS  // 60
export const POP_BIN_COUNT = POP_MAX_BIN_INDEX + 1                // 61
export const POP_MIN_POST_COUNT = 50   // Minimum regular posts needed for popularity weighting

/** Compute popularity index from like count. Currently uses likeCount directly. */
export function getPopIndex(likeCount: number | undefined): number {
  return likeCount ?? 0
}

// Post engagement level constants (powers of 10, additive).
// Multiple levels can be combined: e.g., 111 = none + clicked + liked.
// Use Math.floor(Math.log10(postEngagement)) to get highest level index (0–5).
export const ENGAGEMENT_NONE       = 1       // No engagement (default)
export const ENGAGEMENT_CLICKED    = 10      // Opened Thread view
export const ENGAGEMENT_LIKED      = 100     // Liked
export const ENGAGEMENT_BOOKMARKED = 1000    // Bookmarked
export const ENGAGEMENT_REPOSTED   = 10000   // Reposted
export const ENGAGEMENT_REPLIED    = 100000  // Replied

/** Check whether a specific engagement level is already set in a postEngagement value. */
export function hasEngagementLevel(postEngagement: number, level: number): boolean {
  const digitIndex = Math.round(Math.log10(level))
  return Math.floor(postEngagement / Math.pow(10, digitIndex)) % 10 >= 1
}

export const POST_TYPES = [
  'original',
  'quotepost',
  'repost_followed',
  'repost_unfollowed',
  'repost_synthetic',
  'reply_followed',
  'reply_unfollowed',
  'reply_self',
] as const

export type PostType = typeof POST_TYPES[number]

export interface PostSummary {
  uniqueId: string              // Unique identifier (see above for format)
  cid: string
  username: string
  accountDid: string
  tags: string[]
  repostUri?: string            // Actual URI of the reposted post
  repostCount: number
  likeCount?: number            // Like count at time of summarization (for popularity weighting)
  replyCount?: number           // Reply count at time of summarization (for future use)
  inReplyToUri?: string         // Actual URI of the parent post
  timestamp: Date
  postTimestamp: number         // Numeric timestamp for IndexedDB indexing (timestamp.getTime())
  postEngagement?: number       // Additive engagement levels (powers of 10), see ENGAGEMENT_* constants
  orig_username?: string
  post_type?: PostType
  curation_status?: CurationStatus
  curation_msg?: string
  // Invariant counter numbering (added for counter revamp)
  postNumber?: number | null    // Sequential count in follow feed (resets daily, 1-indexed). null if unassigned
  curationNumber?: number | null // Count among shown posts: 0 for dropped, positive for shown, null if unassigned
  // Text fields for search capability
  postText?: string             // Main post text content
  quotedText?: string           // Text from quoted/embedded post (if any)
  quoted_username?: string      // Handle of quoted/embedded post's author (if any)
  // Edition fields
  edition_tag?: string          // Edition pattern tag (e.g., "1.a.00b")
  matching_pattern?: string     // Matched pattern string (e.g., "@user*: #tech") for debugging
  edition_status?: string       // "hold" | "orphaned" | "synthetic" | "published:<editionKey>"
  // View tracking
  viewedAt?: number             // Client time timestamp (ms via clientNow()) when the post was first viewed in the viewport
}

/** Returns the edition key if the post was published to an edition, else undefined. */
export function getEditionKey(editionStatus?: string): string | undefined {
  if (!editionStatus || !editionStatus.startsWith('published:')) return undefined
  return editionStatus.substring('published:'.length)
}

export interface FollowInfo {
  accountDid: string
  username: string
  followed_at: string
  amp_factor: number
  priorityPatterns?: string  // comma-separated TextPattern format (e.g., "#tech, ai*, #*")
  timezone?: string
  displayName?: string
  last_posted_at?: number  // postTimestamp of most recent post (ms)
  amp_factor_changed_at?: number  // Timestamp (ms) of last amp factor change
  lastWeeklyPostId?: string  // uniqueId of last shown #Weekly post
  followedBy?: boolean  // true if this followee also follows you back
  lastUpdatedAt?: number  // Timestamp (ms) of when this cache entry was last updated from API
}

/**
 * Result of curating a single post - metadata attached to posts after curation.
 */
export interface CurationResult {
  curation_status?: CurationStatus
  curation_msg?: string
  curation_id?: string
  edition_tag?: string
  matching_pattern?: string
  edition_status?: string
}

/**
 * Accumulator for computing per-user statistics during interval processing.
 * Used in the two-pass statistics algorithm to gather data before probability computation.
 */
export interface UserAccumulator {
  userEntry: UserEntry
  repost_total: number         // Total reposts accumulated
  periodic_total: number
  priority_total: number
  original_total: number       // Original posts (not replies)
  followed_reply_total: number // Replies to followees
  unfollowed_reply_total: number // Replies to non-followees
  edited_total: number            // Posts with edition_post_ status (diagnostics only)
  engaged_total: number
  shown_total: number            // Total shown posts accumulated
  weight: number
  normalized_daily: number
  followed_at?: string
  popBins?: number[]            // Log-binned popularity counts (POP_BIN_COUNT elements, indices 0 to POP_MAX_BIN_INDEX)
}


export const WEEKS_OF_DATA_OPTIONS = [1, 2, 3, 4, 5, 6] as const
export const WEEKS_OF_DATA_DEFAULT = 4
export const DAYS_OF_DATA_DEFAULT = WEEKS_OF_DATA_DEFAULT * 7

export interface SkylimitSettings {
  viewsPerDay: number
  showTime: boolean
  showAllPosts: boolean
  curationSuspended: boolean
  daysOfData: number
  secretKey: string
  editionLayout: string
  anonymizeUsernames: boolean
  debugMode: boolean
  feedRedisplayIdleInterval?: number // in milliseconds, default 240 minutes
  feedPageLength?: number // number of posts per page, default 25, values: 10, 20, 25, 50
  infiniteScrollingOption?: boolean // enable infinite scrolling, default false
  // Paged fresh updates settings
  newPostBatchFetches?: number // number of API fetches per probe (1-3), default 1
  pagedUpdatesFullPageWaitMinutes?: number // time to wait for full page before showing partial page, default 10
  // Repost display interval settings
  repostDisplayIntervalHours?: number // hide reposts if original/repost shown within this interval (hours), default 0 (disabled)
  // Lookback settings
  initialLookbackDays?: number // days to look back on initial load for curation stats, default 1
  refillLookbackDays?: number // days to look back for refill fetches (idle return, new posts), default 1
  // Feed display settings
  maxDisplayedFeedSize?: number // max posts in displayed feed, default 300
  // Curation interval settings
  curationIntervalHours?: number // curation interval in hours, default 2, must be 1-12 and factor of 24 (1, 2, 3, 4, 6, 8, 12)
  // Debug settings for effective day count
  minFolloweeDayCount?: number // minimum followee day count to prevent inflated posting rates, default 1
  // Reply handling settings
  hideUnfollowedReplies?: boolean // Hide all replies to non-followees, default false
  showViewedStatus?: boolean // Show viewed-post visual indicators (checkmark, gradient, unviewed count), default true
  consoleLogLevel?: number // Console log verbosity: 0=errors, 1=warnings, 2=milestones, 3=debug, 4=verbose. Default 2
  traceUsers?: string // Comma-separated list of handles to trace through the processing pipeline
  highlightStatusPrefix?: string // Highlight posts whose curation_status starts with this prefix (red outline)
  timezone?: string // Stored timezone for consistent day boundaries (e.g., "America/New_York")
  lastBrowserTimezone?: string // Browser timezone when user last saved/confirmed timezone setting
  showEditionsInFeed?: boolean // Show periodic editions in home feed, default false
  newspaperView?: boolean // Use newspaper view for periodic editions, default false
  editionFont?: 'serif' | 'sans-serif' // Font family for edition layout display, default 'serif'
  popAmp?: number // Popularity amplifier: 1-5, default 1 (disabled)
}

/**
 * Curation metadata attached to FeedViewPost for display purposes.
 */
export interface CurationMetadata {
  curation_status?: CurationStatus
  curation_msg?: string
  curation_id?: string
  matching_pattern?: string     // Matched priority/edition pattern string (for debug popup)
  edition_status?: string
  edition_summary_id?: string  // Original post summary uniqueId (for view tracking in EditionView)
  // Number fields to avoid IndexedDB lookups in PostCard
  postNumber?: number | null
  curationNumber?: number | null
  // View tracking
  viewedAt?: number
  // Platform discriminator (for future multi-protocol support)
  platform?: FeedPlatform
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
 *   otherwise a synthetic ID in the format `sl-rp://repost/${reposterDid}:${post.post.uri}`
 *   Synthetic edition posts use `sl-ed://repost/${editorDid}:${post.post.uri}`
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

export interface EditionRegistryEntry {
  editionKey: string              // "YYYY-MM-DD_HH:MM" (primary key)
  editionName: string             // e.g., "Morning Edition"
  createdAt: number               // timestamp when edition was created (clientNow())
  startPostTimestamp: number      // earliest synthetic postTimestamp in this edition
  endPostTimestamp: number        // latest synthetic postTimestamp in this edition
  oldestOriginalTimestamp: number // oldest original post's postTimestamp (for expiry)
  viewedAt?: number               // clock time when edition was first rendered in editions tab
}

