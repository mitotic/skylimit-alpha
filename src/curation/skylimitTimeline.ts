/**
 * Timeline integration for Skylimit curation
 */

import { BskyAgent } from '@atproto/api'
import { curateSinglePost } from './skylimitFilter'
import { getFilter, getAllFollows, savePostSummaries, getPostSummary } from './skylimitCache'
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

  // Always compute statistics for display, even when curation is suspended
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
        curation_status: existingSummary.curation_status,
        curation_msg: existingSummary.curation_msg,
        matching_pattern: existingSummary.matching_pattern,
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
        editionCount
      )

      // Create summary using postTimestamp from entry
      summary = createPostSummary(post, postTimestamp, myUsername)

      // Store curation information in summary (this is the source of truth)
      summary.curation_status = curation.curation_status
      summary.curation_msg = curation.curation_msg

      // Store edition fields if present
      if (curation.edition_tag) {
        summary.edition_tag = curation.edition_tag
      }
      if (curation.matching_pattern) {
        summary.matching_pattern = curation.matching_pattern
      }
      if (curation.edition_status) {
        summary.edition_status = curation.edition_status
      }

      // Add to list of new summaries to save
      newSummaries.push(summary)
    }

    // Create curated post (include ALL posts, even dropped ones)
    const curatedPost: CurationFeedViewPost = {
      ...post,
      curation: curation,
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


