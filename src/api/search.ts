/**
 * Search API operations
 */

import { BskyAgent, AppBskyActorSearchActors, AppBskyFeedSearchPosts } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

export interface SearchOptions {
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
}

/**
 * Searches for actors (users) with rate limit handling
 */
export async function searchActors(
  agent: BskyAgent,
  query: string,
  limit: number = 25,
  options?: SearchOptions
): Promise<AppBskyActorSearchActors.OutputSchema> {
  return retryWithBackoff(
    async () => {
      const response = await agent.searchActors({
        term: query,
        limit,
      })
      return response.data
    },
    3,
    1000,
    (rateLimitInfo) => {
      if (options?.onRateLimit) {
        options.onRateLimit({
          retryAfter: rateLimitInfo.retryAfter,
          message: rateLimitInfo.message
        })
      }
    }
  ).catch(error => {
    if (isRateLimitError(error)) {
      const info = getRateLimitInfo(error)
      throw new Error(
        info.message || 
        `Rate limit exceeded. Please wait ${info.retryAfter || 60} seconds before trying again.`
      )
    }
    if (error instanceof Error) {
      throw new Error(`Failed to search actors: ${error.message}`)
    }
    throw new Error('Failed to search actors: Unknown error')
  })
}

/**
 * Searches for posts with rate limit handling
 */
export async function searchPosts(
  agent: BskyAgent,
  query: string,
  limit: number = 25,
  cursor?: string,
  sort: 'top' | 'latest' = 'top',
  options?: SearchOptions
): Promise<AppBskyFeedSearchPosts.OutputSchema> {
  return retryWithBackoff(
    async () => {
      const response = await agent.app.bsky.feed.searchPosts({
        q: query,
        sort,
        limit,
        cursor,
      })
      return response.data
    },
    3,
    1000,
    (rateLimitInfo) => {
      if (options?.onRateLimit) {
        options.onRateLimit({
          retryAfter: rateLimitInfo.retryAfter,
          message: rateLimitInfo.message
        })
      }
    }
  ).catch(error => {
    if (isRateLimitError(error)) {
      const info = getRateLimitInfo(error)
      throw new Error(
        info.message ||
        `Rate limit exceeded. Please wait ${info.retryAfter || 60} seconds before trying again.`
      )
    }
    if (error instanceof Error) {
      throw new Error(`Failed to search posts: ${error.message}`)
    }
    throw new Error('Failed to search posts: Unknown error')
  })
}

