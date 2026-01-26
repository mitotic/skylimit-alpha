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
  getFeedViewPostTimestamp
} from './skylimitGeneral'
import { saveFollow } from './skylimitCache'

const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000  // 7 days - posts within this window are digestible

/**
 * Count total posts for a user entry
 */
/**
 * Count total posts per day for a user entry.
 * Includes: MOTx posts + priority posts + regular posts + reposts.
 */
export function countTotalPosts(userEntry: { motx_daily: number; priority_daily: number; post_daily: number; repost_daily: number }): number {
  return userEntry.motx_daily + userEntry.priority_daily + userEntry.post_daily + userEntry.repost_daily
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
  editionCount: number
): Promise<CurationResult> {
  const summary = createPostSummary(post)
  const modStatus: CurationResult = { curation_msg: '' }

  // Always show own posts
  if (summary.username === myUsername || summary.username === summary.orig_username) {
    return modStatus
  }

  // If no stats/probs available, still try to show basic info if user is followed
  // This allows statistics to show even when stats haven't been computed yet
  if (!currentProbs || !currentStats) {
    modStatus.curation_status = 'untracked_show'
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
  
  if (summary.username in currentProbs) {
    // Currently tracking user
    const userEntry = currentProbs[summary.username]
    const randomNum = await hmacRandom(secretKey, 'filter_' + myUsername + '_' + summary.uniqueId)
    
    const follow = currentFollows[summary.username] || null
    let priority = isPriorityPost(summary, follow?.[USER_TOPICS_KEY] || '')
    let motxAccept = ''
    
    // Format statistics on separate lines
    const postingCount = Math.round(countTotalPosts(userEntry))
    const repostingCount = Math.round(userEntry.repost_daily)
    const showProb = (userEntry.regular_prob * 100).toFixed(1) // Convert to percent
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
          
          if (lastMotxId && lastMotxId !== summary.uniqueId) {
            const lastMotxTime = new Date(lastMotxId) // Simplified - would need proper parsing
            if (isSamePeriod(statusTime, lastMotxTime, tag.toUpperCase() as 'MOTD' | 'MOTW' | 'MOTM', userTimezone)) {
              continue
            }
          }
          
          motxAccept = tag
          
          if (!lastMotxId || lastMotxId !== summary.uniqueId) {
            // Record MOTx post
            const updatedFollow = { ...follow, [tag]: summary.uniqueId }
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
    const regularDrop = randomNum >= userEntry.regular_prob

    // Set curation_status based on decision
    let dropReason = ''
    if (motxAccept) {
      // Periodic post accepted
      modStatus.curation_status = 'motx_show'
    } else if (priority) {
      modStatus.curation_status = priorityDrop ? 'priority_drop' : 'priority_show'
      if (priorityDrop) dropReason = 'random (priority)'
    } else {
      modStatus.curation_status = regularDrop ? 'regular_drop' : 'regular_show'
      if (regularDrop) dropReason = 'random (regular)'
    }

    // Check if should save for edition (only for shown posts)
    if (modStatus.curation_status?.endsWith('_show') && digestible) {
      const editionUser = editionLayout[summary.username] || null
      if (editionUser && (!editionUser.tag || summary.tags.includes(editionUser.tag) || (motxAccept && editionUser.tag === MOTX_TAG))) {
        userSave = editionUser.section
      } else if (motxAccept && summary.tags.includes(DIGEST_TAG)) {
        userSave = '#' + MOTX_TAG
      }
      if (userSave) {
        modStatus.curation_status = 'edition_drop'
        modStatus.curation_save = userSave
        dropReason = 'saved for edition ' + userSave
      }
    }

    // Build curation_msg with drop reason if applicable
    modStatus.curation_msg = handledStatus
    if (dropReason) {
      modStatus.curation_msg += '\n[Dropped ' + dropReason + ']'
    }
  } else {
    // No statistics available - user not tracked yet
    modStatus.curation_status = 'untracked_show'
    const follow = currentFollows[summary.username] || null
    if (follow) {
      modStatus.curation_msg = `User followed\nAmp factor: ${follow.amp_factor}`
    } else {
      modStatus.curation_msg = 'User not tracked'
    }
  }
  
  return modStatus
}

