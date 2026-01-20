/**
 * Statistics computation for Skylimit curation
 */

import { PostSummary, UserEntry, UserFilter, GlobalStats, UserAccumulator, FollowInfo, PostStats } from './types'
import {
  getAllPostSummaries,
  saveFilter,
  newUserEntry,
  newUserAccum,
  getAllFollows
} from './skylimitCache'
import { nextInterval as nextIntervalGeneral, oldestInterval as oldestIntervalGeneral, getIntervalString } from './skylimitGeneral'
import {
  INTERVALS_PER_DAY,
  MOTD_MIN_SKYLIMIT_NUMBER,
  MAX_AMP_FACTOR,
  MIN_AMP_FACTOR,
  MOT_TAGS,
  UPDATE_INTERVAL_MINUTES
} from './types'
// countTotalPosts is defined in this file
import { hmacHex } from '../utils/hmac'

const POST_STATS_PROTO: PostStats = { boost_count: 0, fboost_count: 0, repostCount: 0 }

/**
 * Count total posts for a user entry
 */
export function countTotalPostsForUser(userEntry: UserEntry): number {
  return userEntry.motx_daily + userEntry.priority_daily + userEntry.post_daily + userEntry.boost_daily
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
  summariesTotalCached: number
  summariesDroppedCached: number
  summariesTotal: number
  summariesAccumulated: number
  summariesSkipped: number
  // Timestamp range
  summariesOldestTime: Date | null
  summariesNewestTime: Date | null
  // Complete intervals algorithm
  completeCount: number
  incompleteCount: number
  completeIntervalsDays: number
  intervalLengthHours: number
  daysOfData: number
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
  // Get all post summaries from the new cache
  const allSummaries = await getAllPostSummaries()
  if (allSummaries.length === 0) {
    return null
  }

  // Group summaries by computed interval for the complete intervals algorithm
  const summariesByInterval = new Map<string, PostSummary[]>()
  for (const summary of allSummaries) {
    // Compute interval from postTimestamp
    const intervalStr = getIntervalString(new Date(summary.postTimestamp))
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
  const finalIntervalEndStr = nextIntervalGeneral(lastInterval)
  const oldestIntervalStr = oldestIntervalGeneral(lastInterval, daysOfData)

  // Convert interval string to Date for finalIntervalEnd
  // Interval format: "YYYY-MM-DD-HH"
  const [year, month, day, hour] = finalIntervalEndStr.split('-').map(Number)
  const finalIntervalEnd = new Date(Date.UTC(year, month - 1, day, hour))

  // Convert oldest interval to Date for analysis start time
  const [startYear, startMonth, startDay, startHour] = oldestIntervalStr.split('-').map(Number)
  const analysisStartTime = new Date(Date.UTC(startYear, startMonth - 1, startDay, startHour))

  const currentFollows = await getCurrentFollows()
  const summaryCache: Record<string, any> = {}
  const postStats: Record<string, PostStats> = {}

  const userAccum: Record<string, UserAccumulator> = {}

  // Track stats for self-user
  const selfUserEntry = newUserEntry({
    altname: 'user_0000',
    acct_id: myDid,
    topics: '',
    amp_factor: 1,
  })
  userAccum[myUsername] = newUserAccum({ userEntry: selfUserEntry })

  // ============================================================
  // TWO-PASS APPROACH: Only use complete intervals for statistics
  // ============================================================

  // PASS 1: Collect all interval post counts (without processing)
  let expectedIntervals = 0
  let intervalStr = oldestIntervalStr
  // Track post counts by interval key (interval key = start time of interval)
  const intervalPostCounts: Record<string, number> = {}
  // Count dropped summaries across all intervals
  let droppedCount = 0

  while (intervalStr < finalIntervalEndStr) {
    expectedIntervals++
    const summaries = summariesByInterval.get(intervalStr)
    intervalPostCounts[intervalStr] = summaries?.length || 0
    // Count dropped summaries (curation_dropped is a non-empty string when dropped)
    if (summaries) {
      droppedCount += summaries.filter(s => s.curation_dropped).length
    }
    intervalStr = nextIntervalGeneral(intervalStr)
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
  const completeIntervalsDays = completeCount / INTERVALS_PER_DAY
  const intervalLengthHours = UPDATE_INTERVAL_MINUTES / 60

  // Count total non-empty intervals (for reporting)
  const intervalCount = Object.values(intervalPostCounts).filter(c => c > 0).length

  if (intervalCount === 0) {
    return null
  }

  // Track oldest/newest timestamps across all summaries (from complete intervals only)
  const timestampRange: TimestampRange = { oldest: null, newest: null }

  // PASS 2: Only process complete intervals into summaryCache and postStats
  for (const intervalKey of completeIntervalSet) {
    const summaries = summariesByInterval.get(intervalKey)
    if (summaries && summaries.length > 0) {
      computeIntervalStats(currentFollows, summaries, summaryCache, postStats, timestampRange)
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

  // Accumulate status counts ONCE after all intervals are processed (like Mahoot)
  const { accumulated, skipped } = await accumulateStatusCounts(currentFollows, userAccum, summaryCache, postStats, secretKey, myUsername)

  const summariesTotal = Object.keys(summaryCache).length
  // Total cached summaries across ALL intervals (complete + incomplete)
  const summariesTotalCached = Object.values(intervalPostCounts).reduce((sum, c) => sum + c, 0)

  const intervalDiagnostics: IntervalDiagnostics = {
    expected: expectedIntervals,
    processed: intervalCount,
    sparse: sparseIntervals,
    avgPostsPerInterval,
    maxPostsPerInterval,
    startTime: analysisStartTime,
    endTime: finalIntervalEnd,
    // Cache diagnostics
    summariesTotalCached,
    summariesDroppedCached: droppedCount,
    summariesTotal,
    summariesAccumulated: accumulated,
    summariesSkipped: skipped,
    // Timestamp range
    summariesOldestTime: timestampRange.oldest,
    summariesNewestTime: timestampRange.newest,
    // Complete intervals algorithm
    completeCount,
    incompleteCount,
    completeIntervalsDays,
    intervalLengthHours,
    daysOfData,
  }

  // Compute probabilities
  const [globalStats, userFilter] = computeUserProbabilities(
    currentFollows,
    intervalCount,
    finalIntervalEnd,
    postStats,
    userAccum,
    viewsPerDay,
    myUsername,
    intervalDiagnostics
  )

  // Save computed filter
  await saveFilter(globalStats, userFilter)

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
  currentFollows: Record<string, FollowInfo>,
  summaries: PostSummary[],
  summaryCache: Record<string, any>,
  postStats: Record<string, PostStats>,
  timestampRange: TimestampRange
): void {
  for (const summary of summaries) {
    summaryCache[summary.uniqueId] = {
      username: summary.username,
      tags: summary.tags,
      repostUri: summary.repostUri,
      repostCount: summary.repostCount,
      inReplyToUri: summary.inReplyToUri,
      engaged: summary.engaged ? 1 : 0,
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

    if (summary.repostUri) {
      // This is a repost
      const repostedUri = summary.repostUri
      if (!(repostedUri in postStats)) {
        postStats[repostedUri] = { ...POST_STATS_PROTO }
      }
      postStats[repostedUri].boost_count += 1
      postStats[repostedUri].repostCount = summary.repostCount

      if (summary.username in currentFollows) {
        // Repost by followee
        postStats[repostedUri].fboost_count += 1
      }
    } else {
      // Original post
      postStats[summary.uniqueId] = { ...POST_STATS_PROTO }
    }
  }
}

/**
 * Result of accumulating status counts
 */
interface AccumulateResult {
  accumulated: number  // Posts that were accumulated (from current followees)
  skipped: number      // Posts skipped (from non-followees)
}

/**
 * Accumulate status counts per user
 */
async function accumulateStatusCounts(
  currentFollows: Record<string, FollowInfo>,
  userAccum: Record<string, UserAccumulator>,
  summaryCache: Record<string, any>,
  postStats: Record<string, PostStats>,
  secretKey: string,
  _myUsername: string
): Promise<AccumulateResult> {
  let accumulated = 0
  let skipped = 0

  // Process all summaries in the cache for this interval
  for (const uri of Object.keys(summaryCache)) {
    const summaryInfo = summaryCache[uri]
    const username = summaryInfo.username

    const follow = currentFollows[username] || null

    const trackingNames: string[] = []

    if (username in userAccum) {
      // Tracking user (self)
      trackingNames.push(username)
    } else if (follow) {
      // Post/repost from followee
      const altname = 'user_' + (await hmacHex(secretKey, 'anonymize_' + username)).slice(-4)

      const userEntry = newUserEntry({
        altname,
        acct_id: follow.accountDid,
        topics: follow.topics || '',
        amp_factor: Math.min(MAX_AMP_FACTOR, Math.max(MIN_AMP_FACTOR, follow.amp_factor)),
      })
      userAccum[username] = newUserAccum({
        userEntry,
        followed_at: follow.followed_at
      })
      trackingNames.push(username)
    } else {
      // Post from non-followed user; check if following tags in post
      for (const tag of summaryInfo.tags) {
        const trackName = '#' + tag
        const tagFollow = currentFollows[trackName] || null
        if (tagFollow) {
          if (!(trackName in userAccum)) {
            const userEntry = newUserEntry({
              altname: trackName,
              acct_id: '',
              topics: '',
              amp_factor: Math.min(MAX_AMP_FACTOR, Math.max(MIN_AMP_FACTOR, tagFollow.amp_factor)),
            })
            userAccum[trackName] = newUserAccum({
              userEntry,
              followed_at: tagFollow.followed_at
            })
          }
          trackingNames.push(trackName)
        }
      }
    }

    if (trackingNames.length === 0) {
      // Ignore non-followed non-tagged post
      skipped++
      continue
    }

    accumulated++
    
    const motx = summaryInfo.tags.some((tag: string) => MOT_TAGS.includes(tag))
    const accumFac = 1 / trackingNames.length // Split post among different followed tags
    
    for (const trackName of trackingNames) {
      const accum = userAccum[trackName]
      if (!accum) continue
      
      if (summaryInfo.repostUri) {
        // Repost
        accum.boost_total += accumFac
        const repostedStats = postStats[summaryInfo.repostUri]
        if (repostedStats) {
          accum.reblog2_total += accumFac * Math.log2(Math.max(1, repostedStats.repostCount))
        }
      } else {
        // Original post
        if (motx) {
          accum.motx_total += accumFac
        } else if (isPriorityPost(summaryInfo, accum.userEntry.topics)) {
          accum.priority_total += accumFac
        } else {
          accum.post_total += accumFac
        }
      }
      
      if (summaryInfo.engaged) {
        accum.engaged_total += accumFac
      }
    }
  }

  return { accumulated, skipped }
}

/**
 * Check if post is priority
 */
function isPriorityPost(summaryInfo: any, topics: string): boolean {
  if (summaryInfo.repostUri) return false
  if (summaryInfo.tags.includes('priority')) return true
  
  const topicsList = (topics || '').toLowerCase().split(' ').filter((s: string) => s)
  if (topicsList.length) {
    for (const topic of topicsList) {
      if (summaryInfo.tags.includes(topic)) {
        return true
      }
    }
  }
  // Note: Hashtagged posts without configured topics are NOT auto-promoted to priority
  // They will be filtered as regular posts

  return false
}

/**
 * Compute user probabilities
 */
function computeUserProbabilities(
  _currentFollows: Record<string, FollowInfo>,
  intervalCount: number,
  _finalIntervalEnd: Date,
  _postStats: Record<string, PostStats>,
  userAccum: Record<string, UserAccumulator>,
  maxViewsPerDay: number,
  myUsername: string,
  intervalDiagnostics: IntervalDiagnostics
): [GlobalStats, UserFilter] {
  // Use complete intervals for dayTotal if available, fallback to all processed intervals
  let dayTotal = intervalDiagnostics.completeIntervalsDays > 0
    ? intervalDiagnostics.completeIntervalsDays
    : (intervalCount / INTERVALS_PER_DAY)
  
  const accumEntries = Object.entries(userAccum)
  
  let totalUserWeight = 0
  let totalWeightedDaily = 0
  
  // Calculate daily rates and weights
  for (const [trackName, accum] of accumEntries) {
    const userEntry = accum.userEntry
    
    if (accum.followed_at) {
      accum.weight = userEntry.amp_factor

      // Note: follow_weight extrapolation is disabled because followed_at reflects
      // when the follow was saved to IndexedDB, not the actual follow date from Bluesky.
      // This caused a bug where all follows got follow_weight=0.1 after cache reset,
      // inflating posting rates by 10x. Using follow_weight=1 means we use actual
      // posting counts from the lookback period without extrapolation.
      accum.follow_weight = 1
    } else {
      // Don't count unfollowed user (or self) posts/reposts
      accum.weight = 0
      accum.follow_weight = 1
    }
    
    // Extrapolate post count for recent follows
    // Avoid division by zero and NaN
    if (!isFinite(accum.follow_weight) || isNaN(accum.follow_weight)) {
      console.warn(`computeUserProbabilities: Invalid follow_weight for ${trackName}, using 1`)
      accum.follow_weight = 1
    }
    if (!isFinite(dayTotal) || isNaN(dayTotal) || dayTotal <= 0) {
      console.warn(`computeUserProbabilities: Invalid dayTotal=${dayTotal}, using 0.167 (2 intervals)`)
      dayTotal = 0.167 // Fallback to 2 intervals worth
    }
    
    const denominator = Math.max(0.1, accum.follow_weight * dayTotal)
    userEntry.motx_daily = accum.motx_total / denominator
    userEntry.priority_daily = accum.priority_total / denominator
    userEntry.post_daily = accum.post_total / denominator
    userEntry.boost_daily = accum.boost_total / denominator
    userEntry.reblog2_daily = accum.reblog2_total / denominator
    userEntry.engaged_daily = accum.engaged_total / denominator
    
    // Ensure all daily values are valid numbers
    if (!isFinite(userEntry.motx_daily) || isNaN(userEntry.motx_daily)) userEntry.motx_daily = 0
    if (!isFinite(userEntry.priority_daily) || isNaN(userEntry.priority_daily)) userEntry.priority_daily = 0
    if (!isFinite(userEntry.post_daily) || isNaN(userEntry.post_daily)) userEntry.post_daily = 0
    if (!isFinite(userEntry.boost_daily) || isNaN(userEntry.boost_daily)) userEntry.boost_daily = 0
    if (!isFinite(userEntry.reblog2_daily) || isNaN(userEntry.reblog2_daily)) userEntry.reblog2_daily = 0
    if (!isFinite(userEntry.engaged_daily) || isNaN(userEntry.engaged_daily)) userEntry.engaged_daily = 0
    
    userEntry.total_daily = countTotalPostsForUser(userEntry)
    
    // Ensure total_daily is a valid number
    if (!isFinite(userEntry.total_daily) || isNaN(userEntry.total_daily)) {
      userEntry.total_daily = 0
    }
    
    // Normalize by amp factor
    accum.normalized_daily = accum.weight ? userEntry.total_daily / accum.weight : 0
    
    totalUserWeight += accum.weight
    totalWeightedDaily += accum.weight * accum.normalized_daily
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
    userEntry.net_prob = Math.min(1, skylimitNumber / Math.max(1, netCount))
    
    // Ensure net_prob is a valid number
    if (!isFinite(userEntry.net_prob) || isNaN(userEntry.net_prob)) {
      userEntry.net_prob = 0
    }
    
    const regularPostsPlusBoosts = Math.max(1, userEntry.post_daily + userEntry.boost_daily)
    const userSkylimitNumber = skylimitNumber * (accum.weight || 1)
    let availableViews = userSkylimitNumber - userEntry.motx_daily
    
    if (userSkylimitNumber < MOTD_MIN_SKYLIMIT_NUMBER) {
      availableViews = userSkylimitNumber - Math.min(1 / 7 + 1 / 30, userEntry.motx_daily)
    }
    
    if (availableViews <= 0) {
      userEntry.priority_prob = 0
      userEntry.post_prob = 0
    } else if (userEntry.priority_daily >= availableViews) {
      userEntry.priority_prob = Math.min(1, availableViews / userEntry.priority_daily)
      userEntry.post_prob = 0
    } else {
      userEntry.priority_prob = 1.0
      userEntry.post_prob = Math.min(1, (availableViews - userEntry.priority_daily) / regularPostsPlusBoosts)
    }
    
    userEntry.reblog2_avg = userEntry.reblog2_daily / Math.max(1, userEntry.boost_daily)
  }
  
  // Calculate global stats
  const statusTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.post_total + accum.boost_total + accum.motx_total + accum.priority_total, 0
  )

  // Calculate original posts vs reposts breakdown
  const originalPostsTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.post_total + accum.motx_total + accum.priority_total, 0
  )
  const repostsTotal = Object.values(userAccum).reduce((sum, accum) =>
    sum + accum.boost_total, 0
  )

  const globalStats: GlobalStats = {
    skylimit_number: skylimitNumber,
    status_daily: statusTotal / dayTotal,
    shown_daily: maxViewsPerDay, // Approximation
    status_total: statusTotal,
    day_total: dayTotal,
    status_lastday: 0, // Will be calculated separately
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
    original_posts_daily: originalPostsTotal / dayTotal,
    reposts_daily: repostsTotal / dayTotal,

    // Cache diagnostics
    summaries_total_cached: intervalDiagnostics.summariesTotalCached,
    summaries_dropped_cached: intervalDiagnostics.summariesDroppedCached,
    summaries_total: intervalDiagnostics.summariesTotal,
    summaries_accumulated: intervalDiagnostics.summariesAccumulated,
    summaries_skipped: intervalDiagnostics.summariesSkipped,

    // Summaries timestamps
    summaries_oldest_time: intervalDiagnostics.summariesOldestTime?.toISOString(),
    summaries_newest_time: intervalDiagnostics.summariesNewestTime?.toISOString(),

    // Complete intervals algorithm
    intervals_complete: intervalDiagnostics.completeCount,
    intervals_incomplete: intervalDiagnostics.incompleteCount,
    complete_intervals_days: intervalDiagnostics.completeIntervalsDays,
    interval_length_hours: intervalDiagnostics.intervalLengthHours,
    days_of_data: intervalDiagnostics.daysOfData,
  }
  
  const userFilter: UserFilter = Object.entries(userAccum).reduce(
    (obj, [key, val]) => ({ ...obj, [key]: val.userEntry }),
    {}
  )
  
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
 * Calculated as weighted average of post_prob across all users,
 * weighted by their posting frequency (total_daily).
 *
 * @param userFilter - The UserFilter containing user entries with probabilities
 * @returns FilterFrac value between 0 and 1, defaults to 0.5 if no data
 */
export function computeFilterFrac(userFilter: UserFilter): number {
  let totalWeight = 0
  let weightedProbSum = 0

  for (const [trackName, entry] of Object.entries(userFilter)) {
    // Skip hashtag entries (they start with #)
    if (trackName.startsWith('#')) continue

    const weight = entry.total_daily
    if (weight > 0 && isFinite(weight)) {
      totalWeight += weight
      // Use post_prob as the base probability for regular posts
      // This is the probability that a regular post survives filtering
      const prob = entry.post_prob
      if (isFinite(prob)) {
        weightedProbSum += prob * weight
      }
    }
  }

  // Default to 0.5 if no data available
  if (totalWeight === 0 || !isFinite(totalWeight)) {
    return 0.5
  }

  const filterFrac = weightedProbSum / totalWeight

  // Ensure result is valid and within bounds
  if (!isFinite(filterFrac) || isNaN(filterFrac)) {
    return 0.5
  }

  return Math.max(0.01, Math.min(1.0, filterFrac))
}


