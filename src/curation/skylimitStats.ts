/**
 * Statistics computation for Skylimit curation
 */

import {
  PostSummary, UserEntry, UserFilter, GlobalStats, UserAccumulator, FollowInfo,
  WEEKLY_TAG,
  MAX_AMP_FACTOR,
  MIN_AMP_FACTOR,
  ENGAGEMENT_NONE,
  POP_LOG_MAX,
  POP_LOG_INTERVALS,
  POP_MAX_BIN_INDEX,
  POP_BIN_COUNT,
  POP_MIN_POST_COUNT,
  getPopIndex,
  getIntervalHoursSync,
  getIntervalsPerDaySync,
  isStatusShow,
  extractDidFromUri,
  CURATION_STATUSES,
  POST_TYPES,
  SL_REPOST_PREFIX
} from './types'
import {
  getAllPostSummaries,
  saveFilter,
  saveTextSuggestions,
  newUserEntry,
  newUserAccum,
  getAllFollows
} from './skylimitCache'
import type { TextSuggestions } from './types'
import { nextInterval as nextIntervalGeneral, oldestInterval as oldestIntervalGeneral, getIntervalString } from './skylimitGeneral'
import { getSettings } from './skylimitStore'
import { isInitialLookbackCompleted } from './skylimitFeedCache'
import { getLocalMidnight, getPrevLocalMidnight } from './feedCacheCore'
import { isPriorityPost } from './skylimitFilter'
// countTotalPosts is defined in this file
import { hmacHex } from '../utils/hmac'
import { clientDate } from '../utils/clientClock'
import { setUnviewedPostsTodayMap, setUnviewedPostsYesterdayMap } from './skylimitUnviewedTracker'

/**
 * Count total posts per day for a user entry.
 * Includes: periodic posts + priority posts + original posts + followed replies + unfollowed replies + reposts.
 * Unfollowed replies are already filtered during accumulation (only non-dropped ones counted).
 */
export function countTotalPostsForUser(userEntry: UserEntry): number {
  return userEntry.periodic_daily + userEntry.priority_daily +
         userEntry.original_daily + userEntry.followed_reply_daily +
         userEntry.unfollowed_reply_daily + userEntry.reposts_daily
}

/**
 * Interval diagnostics for tracking data quality
 */
interface IntervalDiagnostics {
  expected: number
  processed: number
  sparse: number
  avgPostsPerInterval: number
  maxPostsPerInterval: number
  startTime: Date
  endTime: Date
  // Cache diagnostics
  summariesTotalAll: number
  summariesTotalProcessed: number
  summariesTotalFollowees: number
  // Timestamp range
  summariesOldestTime: Date | null
  summariesNewestTime: Date | null
  // Complete intervals algorithm
  completeCount: number
  incompleteCount: number
  completeIntervalsDays: number
  intervalLengthHours: number
  daysOfData: number
  curationStatusCounts: Record<string, number>
  postTypeCounts: Record<string, number>
}

// --- Text Pattern Suggestions ---

const SUGGESTION_DOMAIN_REGEX = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+(?:\.[a-zA-Z]{2,})+)/g
const SUGGESTION_SKIP_DOMAINS = new Set(['bsky.social', 'bsky.app', 'cdn.bsky.app', 'media.tenor.com'])

/**
 * Extract top-5 hashtags and domains per user from post summaries.
 * Only processes original posts (no reposts, replies, quote posts).
 */
function extractTextSuggestions(
  summariesByUsername: Map<string, PostSummary[]>
): Record<string, TextSuggestions> {
  const result: Record<string, TextSuggestions> = {}

  for (const [username, summaries] of summariesByUsername) {
    const hashtagCounts = new Map<string, number>()
    const domainCounts = new Map<string, number>()

    for (const s of summaries) {
      if (s.repostUri || s.inReplyToUri || s.quotedText) continue

      for (const tag of s.tags) {
        const t = tag.toLowerCase()
        const normalized = t.startsWith('#') ? t : `#${t}`
        hashtagCounts.set(normalized, (hashtagCounts.get(normalized) || 0) + 1)
      }

      if (s.postText) {
        for (const match of s.postText.matchAll(SUGGESTION_DOMAIN_REGEX)) {
          const domain = match[1].toLowerCase()
          if (!SUGGESTION_SKIP_DOMAINS.has(domain)) {
            domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1)
          }
        }
      }
    }

    if (hashtagCounts.size === 0 && domainCounts.size === 0) continue

    const topHashtags = [...hashtagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([tag]) => tag)

    const topDomains = [...domainCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([domain]) => domain)

    result[username] = { hashtags: topHashtags, domains: topDomains }
  }

  return result
}

/**
 * Compute posting statistics from stored data
 */
export async function computePostStats(
  viewsPerDay: number,
  daysOfData: number,
  myUsername: string,
  myDid: string,
  secretKey: string
): Promise<[GlobalStats, UserFilter] | null> {
  // Get settings for interval configuration
  const settings = await getSettings()
  const intervalHours = getIntervalHoursSync(settings)
  const intervalsPerDay = getIntervalsPerDaySync(settings)

  // Get all post summaries from the new cache
  const allSummaries = await getAllPostSummaries()
  if (allSummaries.length === 0) {
    return null
  }

  // Build unviewed posts map for today (since midnight of current calendar day)
  const todayMidnightDate = getLocalMidnight(clientDate(), settings.timezone)
  const todayMidnight = todayMidnightDate.getTime()
  const unviewedMap = new Map<string, number>()
  for (const summary of allSummaries) {
    if (!summary.viewedAt && isStatusShow(summary.curation_status) && summary.postTimestamp > todayMidnight) {
      unviewedMap.set(summary.uniqueId, summary.postTimestamp)
    }
  }
  setUnviewedPostsTodayMap(unviewedMap, todayMidnight)

  // Build unviewed posts map for yesterday (only if cache covers yesterday)
  const yesterdayMidnight = getPrevLocalMidnight(todayMidnightDate, settings.timezone).getTime()
  const oldestPostTimestamp = Math.min(...allSummaries.map(s => s.postTimestamp))
  const ONE_HOUR = 60 * 60 * 1000
  if (oldestPostTimestamp <= yesterdayMidnight + ONE_HOUR) {
    const unviewedYesterdayMap = new Map<string, number>()
    for (const summary of allSummaries) {
      if (!summary.viewedAt && isStatusShow(summary.curation_status) &&
          summary.postTimestamp > yesterdayMidnight && summary.postTimestamp <= todayMidnight) {
        unviewedYesterdayMap.set(summary.uniqueId, summary.postTimestamp)
      }
    }
    setUnviewedPostsYesterdayMap(unviewedYesterdayMap, yesterdayMidnight)
  }

  // Group summaries by computed interval for the complete intervals algorithm
  const summariesByInterval = new Map<string, PostSummary[]>()
  for (const summary of allSummaries) {
    // Compute interval from postTimestamp
    const intervalStr = getIntervalString(new Date(summary.postTimestamp), intervalHours)
    if (!summariesByInterval.has(intervalStr)) {
      summariesByInterval.set(intervalStr, [])
    }
    summariesByInterval.get(intervalStr)!.push(summary)
  }

  // Get the interval range from the data
  const intervals = Array.from(summariesByInterval.keys()).sort()
  if (intervals.length === 0) {
    return null
  }

  const lastInterval = intervals[intervals.length - 1]
  const finalIntervalEndStr = nextIntervalGeneral(lastInterval, intervalHours)
  const oldestIntervalStr = oldestIntervalGeneral(lastInterval, daysOfData, intervalHours)

  // Convert interval string to Date for finalIntervalEnd
  // Interval format: "YYYY-MM-DD-HH"
  const [year, month, day, hour] = finalIntervalEndStr.split('-').map(Number)
  const finalIntervalEnd = new Date(Date.UTC(year, month - 1, day, hour))

  // Convert oldest interval to Date for analysis start time
  const [startYear, startMonth, startDay, startHour] = oldestIntervalStr.split('-').map(Number)
  const analysisStartTime = new Date(Date.UTC(startYear, startMonth - 1, startDay, startHour))

  const currentFollows = await getCurrentFollows()
  const summaryCache: Record<string, any> = {}

  // Build DID to username map for efficient reply parent lookup
  const didToUsername: Record<string, string> = {}
  for (const [username, follow] of Object.entries(currentFollows)) {
    if (follow.accountDid) {
      didToUsername[follow.accountDid] = username
    }
  }

  // Check if initial lookback (first curation round) has completed
  const initialLookbackActive = !(await isInitialLookbackCompleted())

  const userAccum: Record<string, UserAccumulator> = {}

  // Track stats for self-user
  const selfUserEntry = newUserEntry({
    altname: 'user_0000',
    acct_id: myDid,
    priorityPatterns: '',
    amp_factor: 1,
  })
  userAccum[myUsername] = newUserAccum({ userEntry: selfUserEntry })

  // Accumulate counts per CurationStatus across all summaries
  const curationStatusCounts: Record<string, number> = {}
  for (const status of CURATION_STATUSES) {
    curationStatusCounts[status] = 0
  }
  curationStatusCounts['null'] = 0

  const curationStatusSet = new Set<string>(CURATION_STATUSES)

  for (const summary of allSummaries) {
    const raw = summary.curation_status ?? 'null'
    const key = curationStatusSet.has(raw) ? raw : 'null'
    curationStatusCounts[key]++
  }

  // Accumulate counts per PostType across all summaries
  const postTypeCounts: Record<string, number> = {}
  for (const pt of POST_TYPES) {
    postTypeCounts[pt] = 0
  }
  postTypeCounts['null'] = 0
  const postTypeSet = new Set<string>(POST_TYPES)
  for (const summary of allSummaries) {
    const raw = summary.post_type ?? 'null'
    const key = postTypeSet.has(raw) ? raw : 'null'
    postTypeCounts[key]++
  }

  // ============================================================
  // TWO-PASS APPROACH: Only use complete intervals for statistics
  // ============================================================

  // PASS 1: Collect all interval post counts (without processing)
  let expectedIntervals = 0
  let intervalStr = oldestIntervalStr
  // Track post counts by interval key (interval key = start time of interval)
  const intervalPostCounts: Record<string, number> = {}

  while (intervalStr < finalIntervalEndStr) {
    expectedIntervals++
    const summaries = summariesByInterval.get(intervalStr)
    intervalPostCounts[intervalStr] = summaries?.length || 0
    intervalStr = nextIntervalGeneral(intervalStr, intervalHours)
  }

  // Sort intervals chronologically by start time
  // Interval format: "YYYY-MM-DD-HH" (start time of each 2-hour interval)
  // This format sorts correctly in lexicographic order
  const sortedIntervalKeys = Object.keys(intervalPostCounts).sort()

  // Determine which intervals are complete
  // An interval is complete if: non-zero posts, non-zero neighbors, not at boundary
  const completeIntervalSet = new Set<string>()
  let incompleteCount = 0

  for (let i = 0; i < sortedIntervalKeys.length; i++) {
    const intervalKey = sortedIntervalKeys[i]
    const count = intervalPostCounts[intervalKey]

    // Skip if zero posts (not a "processed" interval)
    if (count === 0) continue

    // Boundary intervals are incomplete (oldest and newest)
    if (i === 0 || i === sortedIntervalKeys.length - 1) {
      incompleteCount++
      continue
    }

    // Check chronologically adjacent neighbors
    const prevCount = intervalPostCounts[sortedIntervalKeys[i - 1]] || 0
    const nextCount = intervalPostCounts[sortedIntervalKeys[i + 1]] || 0

    if (prevCount > 0 && nextCount > 0) {
      completeIntervalSet.add(intervalKey)
    } else {
      incompleteCount++
    }
  }

  const completeCount = completeIntervalSet.size
  const completeIntervalsDays = completeCount / intervalsPerDay

  // PASS 2: Build isCompleteInterval map for all intervals
  const isCompleteInterval: Record<string, boolean> = {}
  for (let i = 0; i < sortedIntervalKeys.length; i++) {
    const intervalKey = sortedIntervalKeys[i]
    const count = intervalPostCounts[intervalKey]

    // First or last interval is always incomplete
    if (i === 0 || i === sortedIntervalKeys.length - 1) {
      isCompleteInterval[intervalKey] = false
    } else if (count === 0) {
      // Zero-count intervals are incomplete
      isCompleteInterval[intervalKey] = false
    } else {
      // Check neighbors
      const prevCount = intervalPostCounts[sortedIntervalKeys[i - 1]] || 0
      const nextCount = intervalPostCounts[sortedIntervalKeys[i + 1]] || 0
      isCompleteInterval[intervalKey] = prevCount > 0 && nextCount > 0
    }
  }

  // PASS 3: Compute effectiveDayCount for each interval (newest to oldest)
  const effectiveDayCount: Record<string, number> = {}
  let allSummariesCount = 0
  let completeIntervalSummariesCount = 0
  let countOfCompleteIntervals = 0

  // Count total complete intervals first
  for (const intervalKey of sortedIntervalKeys) {
    if (isCompleteInterval[intervalKey]) {
      countOfCompleteIntervals++
    }
  }

  // Iterate from newest to oldest
  const reversedIntervalKeys = [...sortedIntervalKeys].reverse()
  for (const intervalKey of reversedIntervalKeys) {
    allSummariesCount += intervalPostCounts[intervalKey] || 0
    if (isCompleteInterval[intervalKey]) {
      completeIntervalSummariesCount += intervalPostCounts[intervalKey] || 0
    }

    if (completeIntervalSummariesCount === 0) {
      effectiveDayCount[intervalKey] = 0
    } else {
      const partialIntervalAmpFactor = allSummariesCount / completeIntervalSummariesCount
      effectiveDayCount[intervalKey] = partialIntervalAmpFactor * (countOfCompleteIntervals / intervalsPerDay)
    }
  }

  const oldestDataIntervalStr = sortedIntervalKeys[0]
  const effectiveDayTotal = effectiveDayCount[oldestDataIntervalStr] || 0

  // PASS 4: Compute followeeDayCount for each followee username
  // Get minFolloweeDayCount from settings (prevents inflated posting rates)
  const minFolloweeDayCount = settings.minFolloweeDayCount ?? 1

  const followeeDayCount: Record<string, number> = {}

  // Group summaries by username for efficient lookup
  const summariesByUsername = new Map<string, PostSummary[]>()
  for (const summary of allSummaries) {
    if (!summariesByUsername.has(summary.username)) {
      summariesByUsername.set(summary.username, [])
    }
    summariesByUsername.get(summary.username)!.push(summary)
  }

  for (const [username, follow] of Object.entries(currentFollows)) {
    const userSummaries = summariesByUsername.get(username) || []

    if (userSummaries.length === 0) {
      // No posts from this followee in the cached data - use minimum
      followeeDayCount[username] = minFolloweeDayCount
      continue
    }

    // Check if this is an "old follower" (followed before oldest interval)
    const followedAtTime = new Date(follow.followed_at).getTime()
    const [y, m, d, h] = oldestIntervalStr.split('-').map(Number)
    const oldestIntervalTime = new Date(Date.UTC(y, m - 1, d, h)).getTime()

    if (followedAtTime < oldestIntervalTime) {
      // Old follower - use oldest effective day count (with minimum floor)
      followeeDayCount[username] = Math.max(minFolloweeDayCount, effectiveDayTotal)
    } else {
      // Recent follower - find their oldest post interval
      const oldestPostTimestamp = Math.min(...userSummaries.map(s => s.postTimestamp))
      const followeeOldestIntervalStr = getIntervalString(new Date(oldestPostTimestamp), intervalHours)

      // Apply minimum floor to prevent inflated rates
      followeeDayCount[username] = Math.max(
        minFolloweeDayCount,
        effectiveDayCount[followeeOldestIntervalStr] || 0
      )
    }
  }

  // Count total non-empty intervals (for reporting)
  const intervalCount = Object.values(intervalPostCounts).filter(c => c > 0).length

  if (intervalCount === 0) {
    return null
  }

  // Track oldest/newest timestamps across all summaries
  const timestampRange: TimestampRange = { oldest: null, newest: null }
  const editionPostCounts: Record<string, number> = {}
  const editionHoldCounts: Record<string, number> = {}

  // Process all intervals into summaryCache
  for (const [, summaries] of summariesByInterval.entries()) {
    if (summaries && summaries.length > 0) {
      computeIntervalStats(summaries, summaryCache, timestampRange, editionPostCounts, editionHoldCounts)
    }
  }

  // Calculate interval diagnostics using ONLY complete intervals
  const completeIntervalCounts = [...completeIntervalSet].map(k => intervalPostCounts[k])
  const avgPostsPerInterval = completeIntervalCounts.length > 0
    ? completeIntervalCounts.reduce((sum, c) => sum + c, 0) / completeIntervalCounts.length
    : 0
  const maxPostsPerInterval = completeIntervalCounts.length > 0
    ? Math.max(...completeIntervalCounts)
    : 0
  const sparseThreshold = avgPostsPerInterval * 0.1
  const sparseIntervals = completeIntervalCounts.filter(c => c < sparseThreshold).length

  // Accumulate status counts ONCE after all intervals are processed
  const popAmp = settings?.popAmp ?? 1
  const summariesTotalFollowees = await accumulateStatusCounts(currentFollows, userAccum, summaryCache, secretKey, myUsername, didToUsername, initialLookbackActive, popAmp)

  const summariesTotalAll = Object.keys(summaryCache).length
  // Total posts from processed intervals
  const summariesTotalProcessed = Object.values(intervalPostCounts).reduce((sum, c) => sum + c, 0)

  const intervalDiagnostics: IntervalDiagnostics = {
    expected: expectedIntervals,
    processed: intervalCount,
    sparse: sparseIntervals,
    avgPostsPerInterval,
    maxPostsPerInterval,
    startTime: analysisStartTime,
    endTime: finalIntervalEnd,
    // Cache diagnostics
    summariesTotalAll,
    summariesTotalProcessed,
    summariesTotalFollowees,
    // Timestamp range
    summariesOldestTime: timestampRange.oldest,
    summariesNewestTime: timestampRange.newest,
    // Complete intervals algorithm
    completeCount,
    incompleteCount,
    completeIntervalsDays,
    intervalLengthHours: intervalHours,
    daysOfData,
    curationStatusCounts,
    postTypeCounts,
  }

  // Compute probabilities
  const [globalStats, userFilter] = computeUserProbabilities(
    currentFollows,
    intervalCount,
    finalIntervalEnd,
    userAccum,
    viewsPerDay,
    myUsername,
    intervalDiagnostics,
    intervalsPerDay,
    followeeDayCount,
    minFolloweeDayCount,
    editionPostCounts,
    editionHoldCounts,
    popAmp,
    effectiveDayTotal
  )

  // Save computed filter and text pattern suggestions
  await saveFilter(globalStats, userFilter)
  await saveTextSuggestions(extractTextSuggestions(summariesByUsername))

  return [globalStats, userFilter]
}

/**
 * Timestamp range for summaries
 */
interface TimestampRange {
  oldest: Date | null
  newest: Date | null
}

/**
 * Compute statistics for an interval
 * Returns the oldest and newest timestamps found in the summaries
 */
function computeIntervalStats(
  summaries: PostSummary[],
  summaryCache: Record<string, any>,
  timestampRange: TimestampRange,
  editionPostCounts: Record<string, number>,
  editionHoldCounts: Record<string, number>
): void {
  for (const summary of summaries) {
    // Skip all edition posts from probability statistics
    if (summary.curation_status?.startsWith('edition_')) {
      if (summary.curation_status.startsWith('edition_post_')) {
        editionPostCounts[summary.username] = (editionPostCounts[summary.username] || 0) + 1
        if (summary.edition_status === 'hold') {
          editionHoldCounts[summary.username] = (editionHoldCounts[summary.username] || 0) + 1
        }
      }
      continue
    }

    summaryCache[summary.uniqueId] = {
      username: summary.username,
      tags: summary.tags,
      repostUri: summary.repostUri,
      repostCount: summary.repostCount,
      inReplyToUri: summary.inReplyToUri,
      engaged: Math.floor(Math.log10(summary.postEngagement || ENGAGEMENT_NONE)),
      curation_status: summary.curation_status,  // Needed for repost_drop check
    }

    // Track oldest and newest timestamps
    if (summary.timestamp) {
      const ts = new Date(summary.timestamp)
      if (!timestampRange.oldest || ts < timestampRange.oldest) {
        timestampRange.oldest = ts
      }
      if (!timestampRange.newest || ts > timestampRange.newest) {
        timestampRange.newest = ts
      }
    }
  }
}

/**
 * Accumulate status counts per user.
 * Returns the number of posts accumulated.
 */
async function accumulateStatusCounts(
  currentFollows: Record<string, FollowInfo>,
  userAccum: Record<string, UserAccumulator>,
  summaryCache: Record<string, any>,
  secretKey: string,
  _myUsername: string,
  didToUsername: Record<string, string>,
  initialLookbackActive: boolean,
  popAmp: number
): Promise<number> {
  let accumulated = 0

  // Process all summaries in the cache
  for (const uri of Object.keys(summaryCache)) {
    const summaryInfo = summaryCache[uri]
    const username = summaryInfo.username

    // Safety guard: summaryCache should not contain synthetic reposts or edition posts,
    // but skip them here in case they slip through
    if (uri.startsWith(SL_REPOST_PREFIX) || summaryInfo.curation_status?.startsWith('edition_')) {
      continue
    }

    // Get or create user accumulator
    let accum = userAccum[username]
    if (!accum) {
      const follow = currentFollows[username] || null
      if (follow) {
        // Post/repost from followee - create new accumulator
        const altname = 'user_' + (await hmacHex(secretKey, 'anonymize_' + username)).slice(-4)

        const userEntry = newUserEntry({
          altname,
          acct_id: follow.accountDid,
          priorityPatterns: follow.priorityPatterns || '',
          amp_factor: Math.min(MAX_AMP_FACTOR, Math.max(MIN_AMP_FACTOR, follow.amp_factor)),
        })
        userAccum[username] = newUserAccum({
          userEntry,
          followed_at: follow.followed_at
        })
        accum = userAccum[username]
      } else {
        // Post from non-followed user (shouldn't happen in Following feed)
        continue
      }
    }

    accumulated++

    const periodic = summaryInfo.tags.some((tag: string) => tag.toLowerCase() === WEEKLY_TAG)

    // Helper: check if this post has an explicit _show curation status
    // Exclude temp_show: these are pre-curation placeholders, not real curation decisions
    const isExplicitlyShown = summaryInfo.curation_status?.endsWith('_show') === true
      && summaryInfo.curation_status !== 'temp_show'

    let isRegularPost = false

    if (summaryInfo.repostUri) {
      // Repost - skip if dropped by repost interval
      if (summaryInfo.curation_status === 'repost_drop') {
        // Don't count repost_drop in statistics - skip entirely
        continue
      }
      // Repost - accumulate repost statistics
      accum.repost_total += 1
      if (isExplicitlyShown) accum.shown_total += 1
    } else {
      // Original post
      if (periodic) {
        accum.periodic_total += 1
        if (isExplicitlyShown) accum.shown_total += 1
      } else if (isPriorityPost(summaryInfo, accum.userEntry.priorityPatterns)) {
        accum.priority_total += 1
        if (isExplicitlyShown) accum.shown_total += 1
      } else {
        // Regular post - categorize by reply status
        isRegularPost = true
        if (summaryInfo.inReplyToUri) {
          const parentDid = extractDidFromUri(summaryInfo.inReplyToUri)
          const isParentFollowed = parentDid ? (parentDid in didToUsername) : false

          if (isParentFollowed) {
            accum.followed_reply_total += 1
            if (isExplicitlyShown) accum.shown_total += 1
          } else {
            // Unfollowed reply - only count if NOT during initial lookback
            // AND the post was NOT dropped (curation_status != 'reply_drop')
            if (initialLookbackActive) {
              // During initial lookback: don't count unfollowed replies at all
              // (unfollowed_reply_total stays 0 for this post)
            } else if (summaryInfo.curation_status !== 'reply_drop') {
              // After initial curation: only count if not dropped
              accum.unfollowed_reply_total += 1
              if (isExplicitlyShown) accum.shown_total += 1
            }
            // Note: If reply_drop, we don't count it (already handled by curation)
          }
        } else {
          accum.original_total += 1
          if (isExplicitlyShown) accum.shown_total += 1
        }
      }
    }

    // Popularity binning for regular posts
    if (popAmp > 1 && isRegularPost && summaryInfo.likeCount !== undefined) {
      if (!accum.popBins) accum.popBins = new Array(POP_BIN_COUNT).fill(0)
      const popIndex = getPopIndex(summaryInfo.likeCount)
      const cappedPop = Math.min(popIndex, Math.pow(10, POP_LOG_MAX) - 1)
      const logPop = Math.log10(cappedPop + 1)
      const binIndex = Math.min(Math.round(logPop * POP_LOG_INTERVALS), POP_MAX_BIN_INDEX)
      accum.popBins[binIndex] += 1
    }

    if (summaryInfo.engaged > 0) {
      accum.engaged_total += summaryInfo.engaged
    }
  }

  return accumulated
}

/**
 * Compute user probabilities
 */
function computeUserProbabilities(
  _currentFollows: Record<string, FollowInfo>,
  intervalCount: number,
  _finalIntervalEnd: Date,
  userAccum: Record<string, UserAccumulator>,
  maxViewsPerDay: number,
  myUsername: string,
  intervalDiagnostics: IntervalDiagnostics,
  intervalsPerDay: number,
  followeeDayCount: Record<string, number>,
  minFolloweeDayCount: number,
  editionPostCounts: Record<string, number>,
  editionHoldCounts: Record<string, number>,
  popAmp: number,
  effectiveDayTotal: number
): [GlobalStats, UserFilter] {
  // Use complete intervals for day total if available, fallback to all processed intervals
  const completeIntervalsDayTotal = intervalDiagnostics.completeIntervalsDays > 0
    ? intervalDiagnostics.completeIntervalsDays
    : (intervalCount / intervalsPerDay)
  
  const accumEntries = Object.entries(userAccum)
  
  let totalUserWeight = 0

  // Calculate daily rates and weights
  for (const [username, accum] of accumEntries) {
    const userEntry = accum.userEntry

    if (accum.followed_at) {
      accum.weight = userEntry.amp_factor
    } else {
      // Don't count unfollowed user (or self) posts/reposts
      accum.weight = 0
    }

    // Use followee-specific day count for denominator
    const userDayCount = followeeDayCount[username] || completeIntervalsDayTotal
    const denominator = Math.max(minFolloweeDayCount, userDayCount)
    userEntry.periodic_daily = accum.periodic_total / denominator
    userEntry.priority_daily = accum.priority_total / denominator
    userEntry.original_daily = accum.original_total / denominator
    userEntry.followed_reply_daily = accum.followed_reply_total / denominator
    userEntry.unfollowed_reply_daily = accum.unfollowed_reply_total / denominator
    userEntry.reposts_daily = accum.repost_total / denominator
    userEntry.edited_daily = (editionPostCounts[username] || 0) / denominator
    userEntry.edited_hold_daily = (editionHoldCounts[username] || 0) / denominator
    userEntry.engaged_daily = accum.engaged_total / denominator

    userEntry.total_daily = countTotalPostsForUser(userEntry)
    userEntry.shown_daily = accum.shown_total / denominator

    // Normalize by amp factor
    accum.normalized_daily = accum.weight ? userEntry.total_daily / accum.weight : 0

    totalUserWeight += accum.weight
  }
  
  // Sort by normalized view count
  const sortedEntries = [...accumEntries].sort((a, b) => {
    const normA = a[1].normalized_daily
    const normB = b[1].normalized_daily
    return normA - normB
  })
  
  // Calculate Skylimit number
  let skylimitNumber = 0
  let remainingViews = maxViewsPerDay
  let remainingWeight = totalUserWeight
  
  for (const [, accum] of sortedEntries) {
    if (accum.weight === 0) continue
    
    const normalizedDaily = accum.normalized_daily
    if (normalizedDaily <= 0) continue
    
    const viewsForThis = Math.min(normalizedDaily, remainingViews / remainingWeight)
    skylimitNumber = Math.max(skylimitNumber, viewsForThis)
    
    remainingViews -= viewsForThis * accum.weight
    remainingWeight -= accum.weight
  }
  
  // Calculate probabilities for each user
  for (const [trackName, accum] of accumEntries) {
    const userEntry = accum.userEntry
    
    const netCount = trackName === myUsername
      ? userEntry.total_daily
      : accum.normalized_daily
    // Math.max(1, netCount) prevents division by zero, Math.min(1, ...) bounds result
    userEntry.net_prob = Math.min(1, skylimitNumber / Math.max(1, netCount))

    // Regular posts = original + followed replies + unfollowed replies + reposts
    // Note: unfollowed_reply_daily is already filtered during accumulation:
    // - During initial lookback: always 0
    // - After initial curation: only non-dropped replies counted
    const regularPostsPlusReposts = Math.max(1,
      userEntry.original_daily + userEntry.followed_reply_daily +
      userEntry.unfollowed_reply_daily + userEntry.reposts_daily)
    const userSkylimitNumber = skylimitNumber * (accum.weight || 1)
    let availableViews = userSkylimitNumber - userEntry.periodic_daily

    if (availableViews <= 0) {
      userEntry.priority_prob = 0
      userEntry.regular_prob = 0
    } else if (userEntry.priority_daily >= availableViews) {
      userEntry.priority_prob = Math.min(1, availableViews / userEntry.priority_daily)
      userEntry.regular_prob = 0
    } else {
      userEntry.priority_prob = 1.0
      userEntry.regular_prob = Math.min(1, (availableViews - userEntry.priority_daily) / regularPostsPlusReposts)
    }

    // Compute medianPop for popularity weighting
    // Use popTotal (sum of bin counts) — only posts with likeCount defined are binned
    if (popAmp <= 1 || !accum.popBins) {
      userEntry.medianPop = 0
    } else {
      const popTotal = accum.popBins.reduce((sum, c) => sum + c, 0)
      if (popTotal < POP_MIN_POST_COUNT) {
        userEntry.medianPop = 0
      } else if ((accum.popBins[0] || 0) >= popTotal / 2) {
        userEntry.medianPop = 0
      } else {
        let cumulative = accum.popBins[0] || 0
        userEntry.medianPop = 0
        for (let i = 1; i <= POP_MAX_BIN_INDEX; i++) {
          cumulative += accum.popBins[i] || 0
          if (cumulative >= popTotal / 2) {
            userEntry.medianPop = Math.round(Math.pow(10, i / POP_LOG_INTERVALS))
            break
          }
        }
      }
    }
  }

  // Calculate global stats - total posts across all users
  // postTotal now simply sums all counts - unfollowed replies are already filtered during accumulation
  const postTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.original_total + accum.followed_reply_total + accum.unfollowed_reply_total +
          accum.repost_total + accum.periodic_total + accum.priority_total, 0
  )

  // Calculate posts breakdown
  const originalTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.original_total, 0)
  const followedReplyTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.followed_reply_total, 0)
  const unfollowedReplyTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.unfollowed_reply_total, 0)
  const repostsTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.repost_total, 0
  )
  const editionPostTotal = Object.values(editionPostCounts).reduce((sum, c) => sum + c, 0)
  const editionHoldTotal = Object.values(editionHoldCounts).reduce((sum, c) => sum + c, 0)

  const globalStats: GlobalStats = {
    skylimit_number: skylimitNumber,
    post_daily: postTotal / effectiveDayTotal,
    shown_daily: maxViewsPerDay, // Approximation
    post_total: postTotal,
    complete_intervals_day_total: completeIntervalsDayTotal,
    effective_day_total: effectiveDayTotal,
    post_lastday: 0, // Will be calculated separately
    shown_lastday: 0, // Will be calculated separately

    // Interval diagnostics
    intervals_expected: intervalDiagnostics.expected,
    intervals_processed: intervalDiagnostics.processed,
    intervals_sparse: intervalDiagnostics.sparse,
    posts_per_interval_avg: intervalDiagnostics.avgPostsPerInterval,
    posts_per_interval_max: intervalDiagnostics.maxPostsPerInterval,

    // Time range
    analysis_start_time: intervalDiagnostics.startTime.toISOString(),
    analysis_end_time: intervalDiagnostics.endTime.toISOString(),

    // Posts breakdown
    original_daily: originalTotal / effectiveDayTotal,
    followed_reply_daily: followedReplyTotal / effectiveDayTotal,
    unfollowed_reply_daily: unfollowedReplyTotal / effectiveDayTotal,
    reposts_daily: repostsTotal / effectiveDayTotal,
    edited_daily: editionPostTotal / effectiveDayTotal,
    edited_hold_daily: editionHoldTotal / effectiveDayTotal,

    // Cache diagnostics
    summaries_total_all: intervalDiagnostics.summariesTotalAll,
    summaries_total_processed: intervalDiagnostics.summariesTotalProcessed,
    summaries_total_followees: intervalDiagnostics.summariesTotalFollowees,

    // Summaries timestamps
    summaries_oldest_time: intervalDiagnostics.summariesOldestTime?.toISOString(),
    summaries_newest_time: intervalDiagnostics.summariesNewestTime?.toISOString(),

    // Complete intervals algorithm
    intervals_complete: intervalDiagnostics.completeCount,
    intervals_incomplete: intervalDiagnostics.incompleteCount,
    complete_intervals_days: intervalDiagnostics.completeIntervalsDays,
    interval_length_hours: intervalDiagnostics.intervalLengthHours,
    days_of_data: intervalDiagnostics.daysOfData,
    curation_status_counts: intervalDiagnostics.curationStatusCounts,
    post_type_counts: intervalDiagnostics.postTypeCounts,
  }
  
  const userFilter: UserFilter = Object.entries(userAccum).reduce(
    (obj, [key, val]) => ({ ...obj, [key]: val.userEntry }),
    {}
  )
  
  return [globalStats, userFilter]
}

/**
 * Recompute probabilities from an existing UserFilter after an amp factor change.
 * This is a lightweight alternative to computePostStats() that reuses the daily rates
 * already stored in the UserFilter, only recalculating weights, skylimit number,
 * and probabilities.
 */
export async function recomputeProbabilities(
  userFilter: UserFilter,
  globalStats: GlobalStats,
  viewsPerDay: number,
  myUsername: string
): Promise<[GlobalStats, UserFilter]> {
  // Read current amp factors from follows
  const follows = await getAllFollows()
  const followMap: Record<string, FollowInfo> = {}
  for (const follow of follows) {
    followMap[follow.username] = follow
  }

  // Build per-user weight and normalized_daily
  const entries: Array<{ username: string, entry: UserEntry, weight: number, normalized_daily: number }> = []
  let totalUserWeight = 0

  for (const [username, entry] of Object.entries(userFilter)) {
    if (username === myUsername) continue  // Skip self-user

    const follow = followMap[username]
    const ampFactor = follow
      ? Math.min(MAX_AMP_FACTOR, Math.max(MIN_AMP_FACTOR, follow.amp_factor))
      : entry.amp_factor
    entry.amp_factor = ampFactor

    const weight = ampFactor
    const normalized_daily = weight ? entry.total_daily / weight : 0

    entries.push({ username, entry, weight, normalized_daily })
    totalUserWeight += weight
  }

  // Sort by normalized daily count (ascending)
  entries.sort((a, b) => a.normalized_daily - b.normalized_daily)

  // Calculate skylimit number
  let skylimitNumber = 0
  let remainingViews = viewsPerDay
  let remainingWeight = totalUserWeight

  for (const item of entries) {
    if (item.weight === 0) continue
    if (item.normalized_daily <= 0) continue

    const viewsForThis = Math.min(item.normalized_daily, remainingViews / remainingWeight)
    skylimitNumber = Math.max(skylimitNumber, viewsForThis)

    remainingViews -= viewsForThis * item.weight
    remainingWeight -= item.weight
  }

  // Calculate probabilities for each followed user
  for (const item of entries) {
    const entry = item.entry

    entry.net_prob = Math.min(1, skylimitNumber / Math.max(1, item.normalized_daily))

    const regularPostsPlusReposts = Math.max(1,
      entry.original_daily + entry.followed_reply_daily +
      entry.unfollowed_reply_daily + entry.reposts_daily)
    const userSkylimitNumber = skylimitNumber * (item.weight || 1)
    let availableViews = userSkylimitNumber - entry.periodic_daily

    if (availableViews <= 0) {
      entry.priority_prob = 0
      entry.regular_prob = 0
    } else if (entry.priority_daily >= availableViews) {
      entry.priority_prob = Math.min(1, availableViews / entry.priority_daily)
      entry.regular_prob = 0
    } else {
      entry.priority_prob = 1.0
      entry.regular_prob = Math.min(1, (availableViews - entry.priority_daily) / regularPostsPlusReposts)
    }
  }

  // Update self-user probability (diagnostic only — self-posts always bypass curation)
  const selfEntry = userFilter[myUsername]
  if (selfEntry) {
    selfEntry.net_prob = Math.min(1, skylimitNumber / Math.max(1, selfEntry.total_daily))
    selfEntry.priority_prob = 0
    selfEntry.regular_prob = 0
  }

  // Update global stats with new skylimit number
  globalStats.skylimit_number = skylimitNumber

  // Save and return
  await saveFilter(globalStats, userFilter)
  return [globalStats, userFilter]
}

/**
 * Get current follows as a map
 */
async function getCurrentFollows(): Promise<Record<string, FollowInfo>> {
  const follows = await getAllFollows()
  const followMap: Record<string, FollowInfo> = {}
  for (const follow of follows) {
    followMap[follow.username] = follow
  }
  return followMap
}

/**
 * Compute the average filter fraction (FilterFrac) from UserFilter.
 * This represents the fraction of posts that survive curation filtering on average.
 *
 * Calculated as weighted average of regular_prob across all users,
 * weighted by their posting frequency (total_daily).
 *
 * @param userFilter - The UserFilter containing user entries with probabilities
 * @returns FilterFrac value between 0 and 1, defaults to 0.5 if no data
 */
export function computeFilterFrac(userFilter: UserFilter): number {
  let totalWeight = 0
  let weightedProbSum = 0

  for (const [, entry] of Object.entries(userFilter)) {
    const weight = entry.total_daily
    if (weight > 0) {
      totalWeight += weight
      // Use regular_prob as the base probability for regular posts
      // This is the probability that a regular post survives filtering
      weightedProbSum += entry.regular_prob * weight
    }
  }

  // Default to 0.5 if no data available
  if (totalWeight === 0) {
    return 0.5
  }

  const filterFrac = weightedProbSum / totalWeight
  return Math.max(0.01, Math.min(1.0, filterFrac))
}


