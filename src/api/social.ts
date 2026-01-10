/**
 * Social operations (follow/unfollow)
 */

import { BskyAgent } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

export interface SocialOptions {
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
}

/**
 * Follows a user with rate limit handling
 */
export async function follow(
  agent: BskyAgent,
  did: string,
  options?: SocialOptions
): Promise<{ uri: string; cid: string }> {
  return retryWithBackoff(
    async () => {
      const response = await agent.follow(did)
      return {
        uri: response.uri,
        cid: response.cid,
      }
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
      throw new Error(`Failed to follow user: ${error.message}`)
    }
    throw new Error('Failed to follow user: Unknown error')
  })
}

/**
 * Unfollows a user with rate limit handling
 */
export async function unfollow(
  agent: BskyAgent,
  followUri: string,
  options?: SocialOptions
): Promise<void> {
  return retryWithBackoff(
    async () => {
      await agent.deleteFollow(followUri)
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
      throw new Error(`Failed to unfollow user: ${error.message}`)
    }
    throw new Error('Failed to unfollow user: Unknown error')
  })
}

/**
 * Checks if the current user follows another user with rate limit handling
 * Returns the follow URI if following, undefined otherwise
 */
export async function checkFollowStatus(
  agent: BskyAgent,
  targetDid: string,
  options?: SocialOptions
): Promise<string | undefined> {
  return retryWithBackoff(
    async () => {
      const profile = await agent.getProfile({ actor: targetDid })
      return profile.data.viewer?.following || undefined
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
      throw new Error(`Failed to check follow status: ${error.message}`)
    }
    throw new Error('Failed to check follow status: Unknown error')
  })
}




