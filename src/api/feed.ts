/**
 * Feed API operations
 * 
 * Handles fetching timelines, home feeds, and post threads
 */

import { BskyAgent, AppBskyFeedGetTimeline, AppBskyFeedGetAuthorFeed, AppBskyFeedGetPostThread, AppBskyFeedGetLikes, AppBskyFeedGetRepostedBy, AppBskyFeedDefs } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

export interface FeedOptions {
  limit?: number
  cursor?: string
  filter?: 'posts_with_media' | 'posts_no_replies' | 'posts_and_author_threads' | 'posts'
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
}

/**
 * Fetches the home timeline feed with rate limit handling
 */
export async function getHomeFeed(
  agent: BskyAgent,
  options: FeedOptions = {}
): Promise<{
  feed: AppBskyFeedGetTimeline.OutputSchema['feed']
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await agent.getTimeline({
        limit: options.limit || 50,
        cursor: options.cursor,
      })

      return {
        feed: response.data.feed,
        cursor: response.data.cursor,
      }
    },
    3, // max retries
    1000, // base delay 1 second
    (rateLimitInfo) => {
      if (options.onRateLimit) {
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
      throw new Error(`Failed to fetch home feed: ${error.message}`)
    }
    throw new Error('Failed to fetch home feed: Unknown error')
  })
}

/**
 * Fetches posts from a specific author's feed with rate limit handling
 */
export async function getAuthorFeed(
  agent: BskyAgent,
  actor: string,
  options: FeedOptions = {}
): Promise<{
  feed: AppBskyFeedGetAuthorFeed.OutputSchema['feed']
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const params: any = {
        actor,
        limit: options.limit || 50,
        cursor: options.cursor,
      }
      
      if (options.filter) {
        params.filter = options.filter
      }

      const response = await agent.getAuthorFeed(params)

      return {
        feed: response.data.feed,
        cursor: response.data.cursor,
      }
    },
    3,
    1000,
    (rateLimitInfo) => {
      if (options.onRateLimit) {
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
      throw new Error(`Failed to fetch author feed: ${error.message}`)
    }
    throw new Error('Failed to fetch author feed: Unknown error')
  })
}

/**
 * Fetches posts liked by a specific actor with rate limit handling
 */
export async function getActorLikes(
  agent: BskyAgent,
  actor: string,
  options: FeedOptions = {}
): Promise<{
  feed: AppBskyFeedGetAuthorFeed.OutputSchema['feed']
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await agent.getActorLikes({
        actor,
        limit: options.limit || 50,
        cursor: options.cursor,
      })

      const feed = (response.data.feed || []).map((item: any) => ({
        post: item.post,
        reason: item.reason,
      }))

      return {
        feed,
        cursor: response.data.cursor,
      }
    },
    3,
    1000,
    (rateLimitInfo) => {
      if (options.onRateLimit) {
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
      throw new Error(`Failed to fetch actor likes: ${error.message}`)
    }
    throw new Error('Failed to fetch actor likes: Unknown error')
  })
}

/**
 * Fetches a post thread (post with replies) with rate limit handling
 */
export async function getPostThread(
  agent: BskyAgent,
  uri: string,
  depth: number = 6,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<AppBskyFeedGetPostThread.OutputSchema> {
  return retryWithBackoff(
    async () => {
      const response = await agent.getPostThread({
        uri,
        depth,
      })
      return response.data
    },
    3,
    1000,
    (rateLimitInfo) => {
      if (onRateLimit) {
        onRateLimit({
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
      throw new Error(`Failed to fetch post thread: ${error.message}`)
    }
    throw new Error('Failed to fetch post thread: Unknown error')
  })
}

/**
 * Fetches the parent chain for a post (for focused thread view)
 * Returns an array of parent posts from oldest (root) to most recent (immediate parent)
 */
export async function fetchParentChain(
  agent: BskyAgent,
  parentUri: string,
  maxDepth: number = 5,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<AppBskyFeedDefs.PostView[]> {
  const chain: AppBskyFeedDefs.PostView[] = []
  let currentUri: string | undefined = parentUri

  for (let i = 0; i < maxDepth && currentUri; i++) {
    try {
      const response = await getPostThread(agent, currentUri, 0, onRateLimit)
      const threadPost = response.thread

      if (!AppBskyFeedDefs.isThreadViewPost(threadPost)) break

      chain.unshift(threadPost.post) // Add to front (oldest first)

      // Get next parent URI from the record
      const record = threadPost.post.record as { reply?: { parent?: { uri: string } } }
      currentUri = record?.reply?.parent?.uri
    } catch (error) {
      console.warn('Failed to fetch parent post:', error)
      break
    }
  }

  return chain
}

/**
 * Fetches users who liked a specific post with rate limit handling
 */
export async function getLikes(
  agent: BskyAgent,
  uri: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{
  likes: AppBskyFeedGetLikes.OutputSchema['likes']
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await agent.getLikes({
        uri,
        limit: options.limit || 50,
        cursor: options.cursor,
      })

      return {
        likes: response.data.likes,
        cursor: response.data.cursor,
      }
    },
    3,
    1000
  ).catch(error => {
    if (isRateLimitError(error)) {
      const info = getRateLimitInfo(error)
      throw new Error(
        info.message ||
        `Rate limit exceeded. Please wait ${info.retryAfter || 60} seconds before trying again.`
      )
    }
    if (error instanceof Error) {
      throw new Error(`Failed to fetch likes: ${error.message}`)
    }
    throw new Error('Failed to fetch likes: Unknown error')
  })
}

/**
 * Fetches users who reposted a specific post with rate limit handling
 */
export async function getRepostedBy(
  agent: BskyAgent,
  uri: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{
  repostedBy: AppBskyFeedGetRepostedBy.OutputSchema['repostedBy']
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await agent.getRepostedBy({
        uri,
        limit: options.limit || 50,
        cursor: options.cursor,
      })

      return {
        repostedBy: response.data.repostedBy,
        cursor: response.data.cursor,
      }
    },
    3,
    1000
  ).catch(error => {
    if (isRateLimitError(error)) {
      const info = getRateLimitInfo(error)
      throw new Error(
        info.message ||
        `Rate limit exceeded. Please wait ${info.retryAfter || 60} seconds before trying again.`
      )
    }
    if (error instanceof Error) {
      throw new Error(`Failed to fetch reposted by: ${error.message}`)
    }
    throw new Error('Failed to fetch reposted by: Unknown error')
  })
}

