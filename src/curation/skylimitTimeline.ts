/**
 * Timeline integration for Skylimit curation
 */

import { BskyAgent } from '@atproto/api'
import { curateSinglePost } from './skylimitFilter'
import { getFilter, getAllFollows, saveSummaries, saveEditionPost, getEditionPosts, clearEditionPosts } from './skylimitCache'
import { createPostSummary } from './skylimitGeneral'
import { getSettings } from './skylimitStore'
import { scheduleCleanup } from './skylimitCleanup'
import { CurationFeedViewPost, PostSummary, FeedCacheEntryWithPost } from './types'

/**
 * Curate a batch of posts from feed cache entries
 * Returns ALL posts (including dropped ones) - filtering happens during rendering
 * Saves summaries to summaries cache
 *
 * Uses postTimestamp from feed cache entries (calculated by createFeedCacheEntries)
 * instead of computing timestamps here.
 */
export async function curatePosts(
  entries: FeedCacheEntryWithPost[],
  _agent: BskyAgent,
  myUsername: string,
  myDid: string
): Promise<CurationFeedViewPost[]> {
  const settings = await getSettings()

  // Always compute statistics for display, even when curation is disabled
  const [currentStats, currentProbs] = await getFilter() || [null, null]
  const currentFollows = await getAllFollows()
  const followMap: Record<string, any> = {}
  for (const follow of currentFollows) {
    followMap[follow.username] = follow
  }

  const { getEditionTimeStrs } = await import('./skylimitGeneral')
  const editionTimeStrs = await getEditionTimeStrs()
  const editionCount = editionTimeStrs.length
  const secretKey = settings?.secretKey || 'default'
  const amplifyHighBoosts = settings?.amplifyHighBoosts || false
  const hideSelfReplies = settings?.hideSelfReplies || false
  const curationDisabled = !settings || settings.disabled

  const result: CurationFeedViewPost[] = []
  // Group summaries by interval since posts may span multiple intervals
  const summariesByInterval = new Map<string, PostSummary[]>()

  for (const entry of entries) {
    const post = entry.originalPost
    // Use postTimestamp from entry (calculated by createFeedCacheEntries)
    const postTimestamp = new Date(entry.postTimestamp)

    // Curate the post
    const curation = await curateSinglePost(
      post,
      myUsername,
      myDid,
      followMap,
      currentStats,
      currentProbs,
      secretKey,
      editionCount,
      amplifyHighBoosts,
      hideSelfReplies
    )

    // Create summary using postTimestamp from entry
    const summary = createPostSummary(post, postTimestamp)

    // Store curation information in summary (this is the source of truth)
    summary.curation_dropped = curation.curation_dropped
    summary.curation_msg = curation.curation_msg
    summary.curation_high_boost = curation.curation_high_boost

    // Use interval from entry (calculated by createFeedCacheEntries)
    const summaryInterval = entry.interval

    // Group summaries by their interval
    if (!summariesByInterval.has(summaryInterval)) {
      summariesByInterval.set(summaryInterval, [])
    }
    summariesByInterval.get(summaryInterval)!.push(summary)

    // Save for edition if needed
    if (curation.curation_save) {
      await saveEditionPost(post.post.uri, post, curation.curation_save)
    }

    // Create curated post (include ALL posts, even dropped ones)
    const curatedPost: CurationFeedViewPost = {
      ...post,
      curation: curationDisabled ? {
        // When disabled, only include statistics (curation_msg), not filtering info
        curation_msg: curation.curation_msg || undefined
      } : curation,
    }

    // Add ALL posts to result (filtering happens during rendering based on summaries cache)
    result.push(curatedPost)
  }

  // Save summaries grouped by interval
  for (const [interval, summaries] of summariesByInterval.entries()) {
    if (summaries.length > 0) {
      await saveSummaries(interval, summaries)
    }
  }

  if (summariesByInterval.size > 0) {
    // Schedule cleanup after saving new summaries
    scheduleCleanup()
  }

  // Return ALL posts (including dropped ones) for caching
  // Filtering will happen during rendering by looking up curation status from summaries cache
  return result
}

/**
 * Insert edition posts into timeline
 */
export async function insertEditionPosts(
  posts: CurationFeedViewPost[],
  editionTime?: Date
): Promise<CurationFeedViewPost[]> {
  const { getEditionTimeStrs } = await import('./skylimitGeneral')
  const editionTimeStrs = await getEditionTimeStrs()
  if (editionTimeStrs.length === 0) {
    return posts
  }
  
  // Check if it's time to show an edition
  const now = editionTime || new Date()
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  
  if (!editionTimeStrs.includes(nowTime)) {
    return posts
  }
  
  // Get edition posts
  const editionPosts = await getEditionPosts()
  if (editionPosts.length === 0) {
    return posts
  }
  
  // Create edition marker post
  const editionMarker: CurationFeedViewPost = {
    post: {
      uri: `edition-${nowTime}`,
      cid: '',
      author: {
        did: '',
        handle: 'edition',
        displayName: `Edition ${nowTime}`,
      },
      record: {
        text: `📰 Edition ${nowTime}`,
        createdAt: now.toISOString(),
      },
      likeCount: 0,
      replyCount: 0,
      repostCount: 0,
    },
    curation: {
      curation_edition: true,
    },
  } as any
  
  // Insert edition posts (convert to FeedViewPost format)
  const editionFeedPosts: CurationFeedViewPost[] = editionPosts.map((p: any) => ({
    post: p.post || p,
    reason: p.reason,
    curation: { curation_edition: true },
  }))
  
  const result = [editionMarker, ...editionFeedPosts, ...posts]
  
  // Clear edition posts after displaying
  await clearEditionPosts()
  
  return result
}

