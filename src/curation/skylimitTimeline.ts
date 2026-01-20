/**
 * Timeline integration for Skylimit curation
 */

import { BskyAgent } from '@atproto/api'
import { curateSinglePost } from './skylimitFilter'
import { getFilter, getAllFollows, savePostSummaries, saveEditionPost, getEditionPosts, clearEditionPosts, getPostSummary } from './skylimitCache'
import { createPostSummary } from './skylimitGeneral'
import { getSettings } from './skylimitStore'
import { scheduleCleanup } from './skylimitCleanup'
import { CurationFeedViewPost, PostSummary, FeedCacheEntryWithPost, CurationResult } from './types'

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
  const curationDisabled = !settings || settings.disabled

  const result: CurationFeedViewPost[] = []
  // Collect new summaries to save (not already in cache)
  const newSummaries: PostSummary[] = []

  // Pre-load existing summaries for all entries by uniqueId (for preserving curation decisions)
  const existingSummariesMap = new Map<string, PostSummary>()
  for (const entry of entries) {
    const existingSummary = await getPostSummary(entry.uniqueId)
    if (existingSummary) {
      existingSummariesMap.set(entry.uniqueId, existingSummary)
    }
  }

  for (const entry of entries) {
    const post = entry.originalPost
    // Use postTimestamp from entry (calculated by createFeedCacheEntries)
    const postTimestamp = new Date(entry.postTimestamp)

    // Check if this post already has a cached summary (preserves original curation decisions)
    const existingSummary = existingSummariesMap.get(entry.uniqueId)

    let curation: CurationResult
    let summary: PostSummary

    if (existingSummary) {
      // Use existing curation decision from cached summary
      curation = {
        curation_dropped: existingSummary.curation_dropped,
        curation_msg: existingSummary.curation_msg,
        curation_high_boost: existingSummary.curation_high_boost,
      }
      summary = existingSummary
    } else {
      // Curate the post (no existing summary)
      curation = await curateSinglePost(
        post,
        myUsername,
        myDid,
        followMap,
        currentStats,
        currentProbs,
        secretKey,
        editionCount,
        amplifyHighBoosts
      )

      // Create summary using postTimestamp from entry
      summary = createPostSummary(post, postTimestamp)

      // Store curation information in summary (this is the source of truth)
      summary.curation_dropped = curation.curation_dropped
      summary.curation_msg = curation.curation_msg
      summary.curation_high_boost = curation.curation_high_boost

      // Add to list of new summaries to save
      newSummaries.push(summary)

      // Save for edition if needed (only for newly curated posts)
      if (curation.curation_save) {
        await saveEditionPost(post.post.uri, post, curation.curation_save)
      }
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

  // Save all new summaries at once
  if (newSummaries.length > 0) {
    await savePostSummaries(newSummaries)
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

