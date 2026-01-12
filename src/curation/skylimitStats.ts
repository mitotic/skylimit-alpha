/**
 * Statistics computation for Skylimit curation
 */

import { PostSummary, UserEntry, UserFilter, GlobalStats, UserAccumulator, FollowInfo, PostStats } from './types'
import { 
  getSummaries, 
  getAllIntervals, 
  saveFilter, 
  newUserEntry, 
  newUserAccum,
  getAllFollows 
} from './skylimitCache'
import { nextInterval as nextIntervalGeneral, oldestInterval as oldestIntervalGeneral } from './skylimitGeneral'
import {
  INTERVALS_PER_DAY,
  UPDATE_INTERVAL_MINUTES,
  MOTD_MIN_SKYLIMIT_NUMBER,
  MAX_AMP_FACTOR,
  MIN_AMP_FACTOR,
  MOT_TAGS
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
 * Compute posting statistics from stored data
 */
export async function computePostStats(
  viewsPerDay: number,
  daysOfData: number,
  myUsername: string,
  myDid: string,
  secretKey: string
): Promise<[GlobalStats, UserFilter] | null> {
  const intervals = await getAllIntervals()
  if (intervals.length === 0) {
    return null
  }

  // Get the most recent interval
  const sortedIntervals = intervals.sort()
  const lastInterval = sortedIntervals[sortedIntervals.length - 1]
  
  const finalIntervalEndStr = nextIntervalGeneral(lastInterval)
  const oldestIntervalStr = oldestIntervalGeneral(lastInterval, daysOfData)
  
  // Convert interval string to Date for finalIntervalEnd
  // Interval format: "YYYY-MM-DD-HH"
  const [year, month, day, hour] = finalIntervalEndStr.split('-').map(Number)
  const finalIntervalEnd = new Date(Date.UTC(year, month - 1, day, hour))
  
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
  
  let intervalCount = 0
  let intervalStr = oldestIntervalStr
  
  // Process all intervals - build up summaryCache and postStats
  while (intervalStr < finalIntervalEndStr) {
    const nextIntervalStr = nextIntervalGeneral(intervalStr)
    const summaries = await getSummaries(intervalStr)
    
    if (summaries && summaries.length > 0) {
      computeIntervalStats(currentFollows, summaries, summaryCache, postStats)
      intervalCount++
    }
    
    intervalStr = nextIntervalStr
  }
  
  if (intervalCount === 0) {
    return null
  }
  
  // Accumulate status counts ONCE after all intervals are processed (like Mahoot)
  await accumulateStatusCounts(currentFollows, userAccum, summaryCache, postStats, secretKey, myUsername)
  
  // Compute probabilities
  const [globalStats, userFilter] = computeUserProbabilities(
    currentFollows,
    intervalCount,
    finalIntervalEnd,
    postStats,
    userAccum,
    viewsPerDay,
    myUsername
  )
  
  // Save computed filter
  await saveFilter(globalStats, userFilter)
  
  return [globalStats, userFilter]
}

/**
 * Compute statistics for an interval
 */
function computeIntervalStats(
  currentFollows: Record<string, FollowInfo>,
  summaries: PostSummary[],
  summaryCache: Record<string, any>,
  postStats: Record<string, PostStats>
): void {
  for (const summary of summaries) {
    summaryCache[summary.uri] = {
      username: summary.username,
      tags: summary.tags,
      repostUri: summary.repostUri,
      repostCount: summary.repostCount,
      inReplyToUri: summary.inReplyToUri,
      selfReply: summary.selfReply,
      engaged: summary.engaged ? 1 : 0,
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
      postStats[summary.uri] = { ...POST_STATS_PROTO }
    }
  }
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
): Promise<void> {
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
      continue
    }
    
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
  finalIntervalEnd: Date,
  _postStats: Record<string, PostStats>,
  userAccum: Record<string, UserAccumulator>,
  maxViewsPerDay: number,
  myUsername: string
): [GlobalStats, UserFilter] {
  let dayTotal = intervalCount / INTERVALS_PER_DAY
  const statPeriodMS = intervalCount * UPDATE_INTERVAL_MINUTES * 60 * 1000
  
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
  
  const globalStats: GlobalStats = {
    skylimit_number: skylimitNumber,
    status_daily: statusTotal / dayTotal,
    shown_daily: maxViewsPerDay, // Approximation
    status_total: statusTotal,
    day_total: dayTotal,
    status_lastday: 0, // Will be calculated separately
    shown_lastday: 0, // Will be calculated separately
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


