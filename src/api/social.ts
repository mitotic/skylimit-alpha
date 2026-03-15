/**
 * Social operations (follow/unfollow)
 */

import { BskyAgent, AppBskyActorDefs } from '@atproto/api'
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

/**
 * Fetches followers of a user with pagination and rate limit handling
 */
export async function getFollowers(
  agent: BskyAgent,
  actor: string,
  options?: SocialOptions & { limit?: number; cursor?: string }
): Promise<{ followers: AppBskyActorDefs.ProfileView[]; cursor?: string }> {
  return retryWithBackoff(
    async () => {
      const response = await agent.app.bsky.graph.getFollowers({
        actor,
        limit: options?.limit ?? 25,
        cursor: options?.cursor,
      })
      return {
        followers: response.data.followers,
        cursor: response.data.cursor,
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
      throw new Error(`Failed to fetch followers: ${error.message}`)
    }
    throw new Error('Failed to fetch followers: Unknown error')
  })
}

/**
 * Fetches users that a user is following with pagination and rate limit handling
 */
export async function getFollowing(
  agent: BskyAgent,
  actor: string,
  options?: SocialOptions & { limit?: number; cursor?: string }
): Promise<{ follows: AppBskyActorDefs.ProfileView[]; cursor?: string }> {
  return retryWithBackoff(
    async () => {
      const response = await agent.app.bsky.graph.getFollows({
        actor,
        limit: options?.limit ?? 25,
        cursor: options?.cursor,
      })
      return {
        follows: response.data.follows,
        cursor: response.data.cursor,
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
      throw new Error(`Failed to fetch following: ${error.message}`)
    }
    throw new Error('Failed to fetch following: Unknown error')
  })
}

/**
 * Fetches the logged-in user's Bluesky lists.
 * Returns list name and URI for each list.
 */
export async function getUserLists(
  agent: BskyAgent
): Promise<{ uri: string; name: string }[]> {
  const did = agent.session?.did
  if (!did) throw new Error('Not logged in')

  const lists: { uri: string; name: string }[] = []
  let cursor: string | undefined

  do {
    const response = await agent.app.bsky.graph.getLists({
      actor: did,
      limit: 100,
      cursor,
    })
    for (const list of response.data.lists) {
      lists.push({ uri: list.uri, name: list.name })
    }
    cursor = response.data.cursor
  } while (cursor)

  lists.sort((a, b) => a.name.localeCompare(b.name))
  return lists
}

/**
 * Fetches all member handles from a Bluesky list.
 * Returns handles sorted alphabetically.
 */
export async function getListMembers(
  agent: BskyAgent,
  listUri: string
): Promise<string[]> {
  const handles: string[] = []
  let cursor: string | undefined

  do {
    const response = await agent.app.bsky.graph.getList({
      list: listUri,
      limit: 100,
      cursor,
    })
    for (const item of response.data.items) {
      if (item.subject.handle) {
        handles.push(item.subject.handle)
      }
    }
    cursor = response.data.cursor
  } while (cursor)

  handles.sort((a, b) => a.localeCompare(b))
  return handles
}
