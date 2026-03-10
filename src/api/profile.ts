/**
 * Profile API operations
 */

import { BskyAgent, AppBskyActorGetProfile, AppBskyActorGetProfiles } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

export interface ProfileOptions {
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
}

/**
 * Fetches a user profile with rate limit handling
 */
export async function getProfile(
  agent: BskyAgent,
  actor: string,
  options?: ProfileOptions
): Promise<AppBskyActorGetProfile.OutputSchema> {
  return retryWithBackoff(
    async () => {
      const response = await agent.getProfile({ actor })
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
      throw new Error(`Failed to fetch profile: ${error.message}`)
    }
    throw new Error('Failed to fetch profile: Unknown error')
  })
}

/**
 * Fetches multiple user profiles in a single batch request
 * Maximum 25 actors per request (API limit)
 */
export async function getProfiles(
  agent: BskyAgent,
  actors: string[],
  options?: ProfileOptions
): Promise<AppBskyActorGetProfiles.OutputSchema> {
  if (actors.length === 0) {
    return { profiles: [] }
  }

  if (actors.length > 25) {
    throw new Error('getProfiles: Maximum 25 actors per request')
  }

  return retryWithBackoff(
    async () => {
      const response = await agent.getProfiles({ actors })
      return response.data
    },
    3,
    2000, // Longer base delay for batch operations
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
      throw new Error(`Failed to fetch profiles: ${error.message}`)
    }
    throw new Error('Failed to fetch profiles: Unknown error')
  })
}

/**
 * Pins a post to the user's profile.
 * Reads the current profile record, adds/updates the pinnedPost field, and writes it back.
 */
export async function pinPost(
  agent: BskyAgent,
  postUri: string,
  postCid: string,
  options?: ProfileOptions
): Promise<void> {
  const did = agent.session?.did
  if (!did) throw new Error('Not logged in')

  return retryWithBackoff(
    async () => {
      // Read current profile record
      const { data } = await agent.com.atproto.repo.getRecord({
        repo: did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
      })

      const currentRecord = data.value as Record<string, unknown>

      // Update with pinnedPost
      await agent.com.atproto.repo.putRecord({
        repo: did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
        record: {
          ...currentRecord,
          pinnedPost: { uri: postUri, cid: postCid },
        },
      })
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
      throw new Error(`Failed to pin post: ${error.message}`)
    }
    throw new Error('Failed to pin post: Unknown error')
  })
}

/**
 * Removes the pinned post from the user's profile.
 */
export async function unpinPost(
  agent: BskyAgent,
  options?: ProfileOptions
): Promise<void> {
  const did = agent.session?.did
  if (!did) throw new Error('Not logged in')

  return retryWithBackoff(
    async () => {
      const { data } = await agent.com.atproto.repo.getRecord({
        repo: did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
      })

      const currentRecord = data.value as Record<string, unknown>
      const { pinnedPost, ...rest } = currentRecord

      await agent.com.atproto.repo.putRecord({
        repo: did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
        record: rest,
      })
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
      throw new Error(`Failed to unpin post: ${error.message}`)
    }
    throw new Error('Failed to unpin post: Unknown error')
  })
}
