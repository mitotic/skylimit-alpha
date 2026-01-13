/**
 * Core filtering logic for Skylimit curation
 */

import { AppBskyFeedDefs } from '@atproto/api'
import { 
  PostSummary, 
  CurationResult, 
  UserFilter, 
  GlobalStats, 
  FollowInfo,
  MOTD_TAG,
  MOT_TAGS,
  MOTX_TAG,
  DIGEST_TAG,
  NODIGEST_TAG,
  PRIORITY_TAG,
  MOTD_MIN_SKYLIMIT_NUMBER,
  USER_TOPICS_KEY,
  USER_TIMEZONE_KEY
} from './types'
import { hmacRandom } from '../utils/hmac'
import {
  createPostSummary,
  isSamePeriod,
  getFeedViewPostTimestamp,
  getFollowedHashtagsInPost
} from './skylimitGeneral'
import { saveFollow } from './skylimitCache'

const BOOST_AMPLIFY_FAC = 2
const BOOST_AMPLIFY_MIN = 4
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000  // 7 days - posts within this window are digestible

/**
 * Count total posts for a user entry
 */
export function countTotalPosts(userEntry: { motx_daily: number; priority_daily: number; post_daily: number; boost_daily: number }): number {
  return userEntry.motx_daily + userEntry.priority_daily + userEntry.post_daily + userEntry.boost_daily
}

/**
 * Check if a post should be prioritized
 */
export function isPriorityPost(post: PostSummary, topics: string): boolean {
  if (post.repostUri) return false
  if (post.tags.includes(PRIORITY_TAG)) return true
  
  const topicsList = (topics || '').toLowerCase().split(' ').filter(s => s)
  if (topicsList.length) {
    for (const topic of topicsList) {
      if (post.tags.includes(topic)) {
        return true
      }
    }
  }
  // Note: Hashtagged posts without configured topics are NOT auto-promoted to priority
  // They will be filtered as regular posts

  return false
}

/**
 * Check if post is a periodic post
 */
export function isPeriodicPost(post: PostSummary): {
  isPeriodic: boolean
  periodType: 'MOTD' | 'MOTW' | 'MOTM' | null
} {
  for (const tag of MOT_TAGS) {
    if (post.tags.includes(tag)) {
      return {
        isPeriodic: true,
        periodType: tag.toUpperCase() as 'MOTD' | 'MOTW' | 'MOTM',
      }
    }
  }
  return { isPeriodic: false, periodType: null }
}

/**
 * Curate a single post
 */
export async function curateSinglePost(
  post: AppBskyFeedDefs.FeedViewPost,
  myUsername: string,
  _myDid: string,
  currentFollows: Record<string, FollowInfo>,
  currentStats: GlobalStats | null,
  currentProbs: UserFilter | null,
  secretKey: string,
  editionCount: number,
  amplifyHighBoosts: boolean,
  hideSelfReplies: boolean
): Promise<CurationResult> {
  const summary = createPostSummary(post)
  const modStatus: CurationResult = { curation_msg: '' }
  
  // Always show own posts
  if (summary.username === myUsername || summary.username === summary.orig_username) {
    return modStatus
  }
  
  // Hide self replies if enabled
  if (hideSelfReplies && summary.selfReply) {
    modStatus.curation_dropped = 'self reply'
    return modStatus
  }
  
  // If no stats/probs available, still try to show basic info if user is followed
  // This allows statistics to show even when stats haven't been computed yet
  if (!currentProbs || !currentStats) {
    // Check if user is followed (even without stats)
    const follow = currentFollows[summary.username] || null
    if (follow) {
      modStatus.curation_msg = `User followed\nAmp factor: ${follow.amp_factor}`
    }
    return modStatus
  }
  
  const { getEditionLayout } = await import('./skylimitGeneral')
  const editionLayout = await getEditionLayout()
  // Use FeedViewPost timestamp (repost time for reposts, creation time for originals)
  const statusTime = getFeedViewPostTimestamp(post)
  
  // Check if post is digestible (not a repost, not a reply, not too old)
  const digestible = editionCount > 0 && 
    !summary.repostUri && 
    !summary.inReplyToUri && 
    !summary.tags.includes(NODIGEST_TAG) &&
    (statusTime.getTime() >= (Date.now() - DIGEST_WINDOW_MS))
  
  let handledStatus = ''
  let userSave = ''
  let tagSave = ''
  
  if (summary.username in currentProbs) {
    // Currently tracking user
    const userEntry = currentProbs[summary.username]
    const randomNum = await hmacRandom(secretKey, 'filter_' + myUsername + '_' + summary.uri)
    
    const follow = currentFollows[summary.username] || null
    let priority = isPriorityPost(summary, follow?.[USER_TOPICS_KEY] || '')
    let motxAccept = ''
    
    // Format statistics on separate lines
    const postingCount = Math.round(countTotalPosts(userEntry))
    const repostingCount = Math.round(userEntry.boost_daily)
    const showProb = (userEntry.post_prob * 100).toFixed(1) // Convert to percent
    const ampFactor = follow ? follow.amp_factor : null
    
    handledStatus = `Posting ${postingCount}/day (reposting ${repostingCount}/day)\nShow probability: ${showProb}%`
    if (ampFactor !== null) {
      handledStatus += `\nAmp factor: ${ampFactor}`
    }
    
    if (follow) {
      const userTimezone = follow[USER_TIMEZONE_KEY] || 'UTC'
      
      const motxFound = !summary.repostUri && summary.tags.some(tag => MOT_TAGS.includes(tag))
      
      if (motxFound) {
        const userSkylimitNumber = follow.amp_factor * currentStats.skylimit_number
        
        for (const tag of MOT_TAGS) {
          if (!summary.tags.includes(tag)) continue
          
          if (tag === MOTD_TAG && userSkylimitNumber < MOTD_MIN_SKYLIMIT_NUMBER) {
            continue
          }
          
          const lastMotxId = follow[tag as keyof FollowInfo] as string | undefined
          
          if (lastMotxId && lastMotxId !== summary.uri) {
            const lastMotxTime = new Date(lastMotxId) // Simplified - would need proper parsing
            if (isSamePeriod(statusTime, lastMotxTime, tag.toUpperCase() as 'MOTD' | 'MOTW' | 'MOTM', userTimezone)) {
              continue
            }
          }
          
          motxAccept = tag
          
          if (!lastMotxId || lastMotxId !== summary.uri) {
            // Record MOTx post
            const updatedFollow = { ...follow, [tag]: summary.uri }
            await saveFollow(updatedFollow)
          }
          break
        }
        
        if (!motxAccept) {
          priority = true
        }
      }
    }
    
    const priorityDrop = randomNum >= userEntry.priority_prob
    let regularDrop = randomNum >= userEntry.post_prob
    
    // Amplify high boosts
    if (regularDrop && amplifyHighBoosts && summary.repostCount > Math.max(2 ** userEntry.reblog2_avg - 1, BOOST_AMPLIFY_MIN)) {
      regularDrop = randomNum >= BOOST_AMPLIFY_FAC * userEntry.post_prob
      if (!regularDrop) {
        modStatus.curation_high_boost = true
      }
    }
    
    if (motxAccept) {
      // Periodic post accepted
      modStatus.curation_dropped = ''
    } else if (priority) {
      modStatus.curation_dropped = priorityDrop ? 'random (priority)' : ''
    } else {
      modStatus.curation_dropped = regularDrop ? 'random (regular)' : ''
    }
    
    // Check if should save for edition
    if (!modStatus.curation_dropped && digestible) {
      const editionUser = editionLayout[summary.username] || null
      if (editionUser && (!editionUser.tag || summary.tags.includes(editionUser.tag) || (motxAccept && editionUser.tag === MOTX_TAG))) {
        userSave = editionUser.section
      } else if (motxAccept && summary.tags.includes(DIGEST_TAG)) {
        userSave = '#' + MOTX_TAG
      }
    }
  }
  
  // Check for followed hashtags
  const followedHashtags = Object.keys(currentFollows).filter(k => k.startsWith('#'))
  const tagFollows = getFollowedHashtagsInPost(summary, followedHashtags)
  
  if (tagFollows.length > 0) {
    let count = 0
    let totalPostProb = 0
    
    for (const tag of tagFollows) {
      const trackName = '#' + tag
      const editionUser = editionLayout[trackName] || null
      if (digestible && editionUser && !tagSave) {
        tagSave = editionUser.section
      }
      
      if (trackName in currentProbs) {
        const tagEntry = currentProbs[trackName]
        totalPostProb += tagEntry.post_prob
        count += 1
      }
    }
    
    if (!handledStatus) {
      const tagStr = '#' + tagFollows.join('/')
      const randomNum = await hmacRandom(secretKey, 'filter_' + tagStr + '_' + summary.uri)
      const regularDrop = randomNum >= (totalPostProb / count)
      handledStatus = 'Tags: ' + tagStr
      modStatus.curation_tag = '#' + tagFollows[0]
      modStatus.curation_dropped = regularDrop ? 'random (tag) ' + tagStr : ''
    }
  }
  
  // Set curation_msg - use handledStatus if available, otherwise show basic info
  if (handledStatus) {
    modStatus.curation_msg = handledStatus
    if (modStatus.curation_dropped) {
      // Add newline before dropped message so it appears on next line
      modStatus.curation_msg += '\n[Dropped ' + modStatus.curation_dropped + ']'
    } else if (userSave || tagSave) {
      modStatus.curation_save = userSave || tagSave
      modStatus.curation_dropped = 'saved for edition ' + (userSave || tagSave)
      modStatus.curation_msg += '\n[Dropped ' + modStatus.curation_dropped + ']'
    }
  } else {
    // No statistics available - user not tracked and no followed hashtags
    // Still show if user is followed (basic info)
    const follow = currentFollows[summary.username] || null
    if (follow) {
      modStatus.curation_msg = `User followed\nAmp factor: ${follow.amp_factor}`
    } else {
      modStatus.curation_msg = 'User not tracked'
    }
  }
  
  return modStatus
}

