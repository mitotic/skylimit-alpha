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
  WEEKLY_TAG,
  DEFAULT_PRIORITY_PATTERNS,
  USER_PRIORITY_PATTERNS_KEY,
  USER_TIMEZONE_KEY,
  extractDidFromUri,
  isStatusShow,
  isStatusDrop,
  SecondaryRepostIndex,
  getPopIndex
} from './types'
import { hmacRandom } from '../utils/hmac'
import {
  createPostSummary,
  isSameWeek,
  getFeedViewPostTimestamp
} from './skylimitGeneral'
import { matchTextPattern } from './skylimitEditionMatcher'
import { TextPattern } from './skylimitEditions'
import { saveFollow, wasRepostOrOriginalDisplayedWithinInterval } from './skylimitCache'
import { clientNow } from '../utils/clientClock'
import { isInitialLookbackCompleted } from './skylimitFeedCache'
import log from '../utils/logger'

/**
 * Count total posts per day for a user entry.
 * Unfollowed replies are always included - filtering is done during accumulation.
 */
export function countTotalPosts(
  userEntry: { periodic_daily: number; priority_daily: number; original_daily: number; followed_reply_daily: number; unfollowed_reply_daily: number; repost_daily: number }
): number {
  return userEntry.periodic_daily + userEntry.priority_daily +
         userEntry.original_daily + userEntry.followed_reply_daily +
         userEntry.unfollowed_reply_daily + userEntry.repost_daily
}

/**
 * Parse a priorityPatterns string into TextPattern objects.
 * Format: comma-separated patterns in Edition Layout text pattern syntax.
 */
export function parsePriorityPatterns(patternsStr: string): TextPattern[] {
  if (!patternsStr) return []
  return patternsStr.split(',').map(p => p.trim()).filter(p => p).map(p => ({
    pattern: p,
    letterCode: '',
    isDomain: p.includes('.') && !p.startsWith('#'),
    isHashtag: p.startsWith('#'),
  }))
}

/**
 * Check if a post matches priority patterns.
 * Reposts are never priority. Uses DEFAULT_PRIORITY_PATTERNS if none configured.
 */
export function isPriorityPost(post: PostSummary, priorityPatterns: string): string | null {
  if (post.repostUri) return null

  const patternsStr = priorityPatterns || DEFAULT_PRIORITY_PATTERNS
  const patterns = parsePriorityPatterns(patternsStr)

  for (const pattern of patterns) {
    if (matchTextPattern(post.postText || '', post.quotedText, post.tags, pattern)) {
      return pattern.pattern
    }
  }
  return null
}

/**
 * Check if post tags contain the #Weekly hashtag (case-insensitive)
 */
export function isPeriodicTag(post: PostSummary): boolean {
  if (post.repostUri) return false
  return post.tags.some(tag => tag.toLowerCase() === WEEKLY_TAG)
}

/**
 * Compound check: is this a periodic post that should be shown?
 * Returns true if #Weekly found AND no other weekly post was shown this week.
 */
export function isPeriodicShow(
  post: PostSummary,
  follow: FollowInfo,
  statusTime: Date,
  timezone: string
): boolean {
  if (!isPeriodicTag(post)) return false

  const lastId = follow.lastWeeklyPostId
  if (lastId && lastId !== post.uniqueId) {
    const lastTime = new Date(lastId)
    if (isSameWeek(statusTime, lastTime, timezone)) {
      return false  // Already shown a weekly post this week
    }
  }
  return true
}

/**
 * Test whether an unfollowed reply is eligible to be shown (or held for editions).
 * Returns true if the poster is a "quiet poster" (regular_prob >= 1)
 * AND hideUnfollowedReplies setting is off.
 */
function isUnfollowedReplyEligible(
  regularProb: number,
  hideUnfollowedReplies: boolean
): boolean {
  return regularProb >= 1 && !hideUnfollowedReplies
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
  secondaryRepostIndex?: SecondaryRepostIndex
): Promise<CurationResult> {
  const summary = createPostSummary(post, undefined, myUsername)
  const modStatus: CurationResult = { curation_msg: '' }
  let dropReason = ''

  const traceReturn = () => {
    log.trace('curated', summary.username, summary.postTimestamp, summary.postText || '',
      `status=${modStatus.curation_status}` +
      (modStatus.edition_tag ? ` edition_tag=${modStatus.edition_tag} pattern="${modStatus.matching_pattern}"` : '') +
      (dropReason ? ` drop="${dropReason}"` : ''))
  }

  // Always show own posts
  if (summary.username === myUsername || summary.username === summary.orig_username) {
    modStatus.curation_status = 'self_show'
    traceReturn()
    return modStatus
  }

  // Edition matching runs before stats check — posts must be held during initial lookback
  // so they're available when transferSecondaryToPrimary assembles editions
  let editionEligible = editionCount > 0 && !summary.repostUri

  // Replies require additional checks for edition eligibility
  if (editionEligible && summary.inReplyToUri) {
    const parentDid = extractDidFromUri(summary.inReplyToUri)
    if (!parentDid || parentDid === summary.accountDid) {
      // Self-reply — not eligible
      editionEligible = false
    } else {
      // Check if parent author is followed
      const parentFollowed = Object.values(currentFollows).some(f => f.accountDid === parentDid)
      if (!parentFollowed) {
        // Unfollowed reply — use shared eligibility check
        const userEntry = currentProbs?.[summary.username]
        if (!userEntry) {
          editionEligible = false
        } else {
          const { getSettings } = await import('./skylimitStore')
          const settings = await getSettings()
          editionEligible = isUnfollowedReplyEligible(
            userEntry.regular_prob,
            settings?.hideUnfollowedReplies ?? false
          )
        }
      }
      // else: followed non-self reply — stays eligible
    }
  }

  if (editionEligible) {
    const { getParsedEditions } = await import('./skylimitEditions')
    const { matchPost } = await import('./skylimitEditionMatcher')
    const parsedEditions = await getParsedEditions()
    const { getSettings: getSettingsForTz } = await import('./skylimitStore')
    const settingsForTz = await getSettingsForTz()

    const editionMatch = matchPost(summary, parsedEditions, settingsForTz?.timezone)
    if (editionMatch) {
      modStatus.curation_status = 'edition_post_drop'
      modStatus.edition_tag = editionMatch.editionTag
      modStatus.matching_pattern = editionMatch.editionPattern
      modStatus.edition_status = 'hold'
      modStatus.curation_msg = `[Dropped edition hold [${editionMatch.editionTag}] ${editionMatch.editionPattern}]`
      log.verbose('Edition', `Hold: @${summary.username} post=${new Date(summary.postTimestamp).toLocaleString()} tag=${editionMatch.editionTag} pattern="${editionMatch.editionPattern}"`)
      traceReturn()
      return modStatus
    }
  }

  // If no stats/probs available, use temp_show during initial lookback
  // Posts will be re-curated once stats are computed
  if (!currentProbs || !currentStats) {
    modStatus.curation_status = 'temp_show'
    // Check if user is followed (even without stats)
    const follow = currentFollows[summary.username] || null
    if (follow) {
      modStatus.curation_msg = `User followed\nAmp factor: ${follow.amp_factor}\n(Pending curation)`
    } else {
      modStatus.curation_msg = '(Pending curation)'
    }
    traceReturn()
    return modStatus
  }
  
  // Use FeedViewPost timestamp (repost time for reposts, creation time for originals)
  const statusTime = getFeedViewPostTimestamp(post)

  let handledStatus = ''
  
  if (summary.username in currentProbs) {
    // Currently tracking user
    const userEntry = currentProbs[summary.username]
    const randomNum = await hmacRandom(secretKey, 'filter_' + myUsername + '_' + summary.uniqueId)
    
    const follow = currentFollows[summary.username] || null
    let periodicAccepted = false

    // Format statistics on separate lines
    const postingCount = Math.round(countTotalPosts(userEntry))
    const repostingCount = Math.round(userEntry.repost_daily)
    const showProb = (userEntry.regular_prob * 100).toFixed(1) // Convert to percent
    const ampFactor = follow ? follow.amp_factor : null

    handledStatus = `Posting ${postingCount}/day (reposting ${repostingCount}/day)\nShow probability: ${showProb}%`
    if (ampFactor !== null) {
      handledStatus += `\nAmp factor: ${ampFactor}`
    }

    // Check periodic (#Weekly) post
    if (follow) {
      const userTimezone = follow[USER_TIMEZONE_KEY] || 'UTC'

      if (isPeriodicShow(summary, follow, statusTime, userTimezone)) {
        periodicAccepted = true
        // Record weekly post
        if (!follow.lastWeeklyPostId || follow.lastWeeklyPostId !== summary.uniqueId) {
          const updatedFollow = { ...follow, lastWeeklyPostId: summary.uniqueId }
          await saveFollow(updatedFollow)
        }
      }
    }

    // Priority matching (periodic posts that weren't accepted fall through here)
    const priorityMatch = isPriorityPost(summary, follow?.[USER_PRIORITY_PATTERNS_KEY] || '')
    const priority = !periodicAccepted && priorityMatch !== null

    // Check repost display interval (before probability filtering)
    // This handles both forward (new posts) and backward (lookback) time navigation
    if (summary.repostUri) {
      const { getSettings, REPOST_DISPLAY_INTERVAL_DEFAULT } = await import('./skylimitStore')
      const settings = await getSettings()
      const intervalHours = settings?.repostDisplayIntervalHours ?? REPOST_DISPLAY_INTERVAL_DEFAULT

      if (intervalHours > 0) {
        const intervalMs = intervalHours * 60 * 60 * 1000

        const wasDisplayedWithinInterval = await wasRepostOrOriginalDisplayedWithinInterval(
          summary.repostUri,
          summary.postTimestamp,
          summary.uniqueId,
          intervalMs,
          secondaryRepostIndex
        )

        if (wasDisplayedWithinInterval) {
          modStatus.curation_status = 'repost_drop'
          modStatus.curation_msg = handledStatus + `\n[Dropped: repost/original shown within ${intervalHours}h]`
          traceReturn()
          return modStatus
        }
      }
    }

    const priorityDrop = randomNum >= userEntry.priority_prob

    // Compute effective regular probability with popularity weighting
    let effectiveRegularProb = userEntry.regular_prob
    if (userEntry.medianPop > 0) {
      const { getSettings } = await import('./skylimitStore')
      const popSettings = await getSettings()
      const popAmp = popSettings?.popAmp ?? 1
      const popIndex = getPopIndex(summary.likeCount)
      if (popIndex >= userEntry.medianPop) {
        effectiveRegularProb = userEntry.regular_prob * popAmp / (1 + popAmp)
      } else {
        effectiveRegularProb = userEntry.regular_prob * 1 / (1 + popAmp)
      }
    }
    const regularDrop = randomNum >= effectiveRegularProb

    // Set curation_status based on decision
    if (periodicAccepted) {
      modStatus.curation_status = 'periodic_show'
    } else if (priority) {
      modStatus.curation_status = priorityDrop ? 'priority_drop' : 'priority_show'
      modStatus.matching_pattern = priorityMatch
      if (priorityDrop) dropReason = 'random (priority)'
    } else {
      // Check if this is an unfollowed reply
      const isUnfollowedReply = summary.inReplyToUri && (() => {
        const parentDid = extractDidFromUri(summary.inReplyToUri!)
        if (!parentDid) return false
        // Check if parent author is NOT in currentFollows
        return !Object.values(currentFollows).some(f => f.accountDid === parentDid)
      })()

      if (isUnfollowedReply) {
        // Check if this is the first curation round (initial lookback active)
        const initialLookbackActive = !(await isInitialLookbackCompleted())

        if (initialLookbackActive) {
          // First round: ALWAYS drop unfollowed replies
          modStatus.curation_status = 'reply_drop'
          dropReason = 'unfollowed reply (initial)'
        } else {
          // Subsequent rounds: apply normal logic
          const { getSettings } = await import('./skylimitStore')
          const settings = await getSettings()
          const hideUnfollowedReplies = settings?.hideUnfollowedReplies ?? false

          if (!isUnfollowedReplyEligible(userEntry.regular_prob, hideUnfollowedReplies)) {
            // Drop: setting is on OR poster is not a quiet poster
            modStatus.curation_status = 'reply_drop'
            dropReason = 'unfollowed reply'
          } else {
            // Show: quiet poster (regular_prob>=1) AND setting is off
            modStatus.curation_status = 'regular_show'
          }
        }
      } else {
        // Check if this is a same-user reply (reply to own post)
        const isSameUserReply = summary.inReplyToUri && (() => {
          const parentDid = extractDidFromUri(summary.inReplyToUri!)
          return parentDid === summary.accountDid
        })()

        if (isSameUserReply) {
          // Look up parent in post summaries cache
          const { getPostSummary } = await import('./skylimitCache')
          const parentSummary = await getPostSummary(summary.inReplyToUri!)

          const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000

          if (parentSummary
              && isStatusShow(parentSummary.curation_status)
              && (clientNow() - parentSummary.postTimestamp) >= TWENTY_FOUR_HOURS) {
            // Parent shown and old (>24h) — keep the reply, apply normal probability
            modStatus.curation_status = regularDrop ? 'regular_drop' : 'regular_show'
            if (regularDrop) dropReason = 'random (regular)'
          } else {
            // Drop: parent not in summaries, parent dropped, or parent shown recently
            modStatus.curation_status = 'reply_drop'
            dropReason = parentSummary
              ? (isStatusDrop(parentSummary.curation_status)
                  ? 'same-user reply (parent dropped)'
                  : 'same-user reply (parent shown recently)')
              : 'same-user reply'
          }
        } else {
          // Original post or non-same-user followed reply - standard logic
          modStatus.curation_status = regularDrop ? 'regular_drop' : 'regular_show'
          if (regularDrop) dropReason = 'random (regular)'
        }
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

  // Update last_posted_at if this post is newer
  const follow = currentFollows[summary.username]
  if (follow && (!follow.last_posted_at || summary.postTimestamp > follow.last_posted_at)) {
    const updatedFollow = { ...follow, last_posted_at: summary.postTimestamp }
    await saveFollow(updatedFollow)
    currentFollows[summary.username] = updatedFollow  // Update in-memory for batch efficiency
  }

  traceReturn()
  return modStatus
}

