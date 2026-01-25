/**
 * Search API operations
 */

import { BskyAgent, AppBskyActorSearchActors } from '@atproto/api'
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
 * Searches for posts
 * Note: AT Protocol doesn't have a direct post search endpoint
 * This is a placeholder for future implementation
 */
export async function searchPosts(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _agent: BskyAgent,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _query: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _limit?: number
): Promise<any> {
  // TODO: Implement post search if/when AT Protocol adds this endpoint
  // For now, this is a placeholder
  throw new Error('Post search is not yet available in the AT Protocol API')
}

