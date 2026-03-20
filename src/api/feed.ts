/**
 * Feed API operations
 * 
 * Handles fetching timelines, home feeds, and post threads
 */

import { BskyAgent, AppBskyFeedGetTimeline, AppBskyFeedGetAuthorFeed, AppBskyFeedGetPostThread, AppBskyFeedGetLikes, AppBskyFeedGetRepostedBy, AppBskyFeedDefs, AppBskyBookmarkDefs, AppBskyActorDefs } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'
import { applyTimeShift, isClockAccelerated } from '../utils/clientClock'
import log from '../utils/logger'

// --- Skyspeed Command Event System ---

export type SkyspeedCommand =
  | { type: 'CLICK'; buttonName: 'NextPage' | 'AllNewPosts' | 'PrevPage' }
  | { type: 'SCROLL'; direction: 'TOP' | 'BOTTOM' }
  | { type: 'FIND'; target: string }

type SkyspeedCommandListener = (command: SkyspeedCommand) => void
const skyspeedCommandListeners = new Set<SkyspeedCommandListener>()

/** Subscribe to Skyspeed commands received from the server. */
export function onSkyspeedCommand(listener: SkyspeedCommandListener): void {
  skyspeedCommandListeners.add(listener)
}

/** Unsubscribe from Skyspeed commands. */
export function offSkyspeedCommand(listener: SkyspeedCommandListener): void {
  skyspeedCommandListeners.delete(listener)
}

function notifySkyspeedCommand(command: SkyspeedCommand): void {
  for (const listener of skyspeedCommandListeners) {
    try {
      listener(command)
    } catch (e) {
      log.warn('Skyspeed Command', 'Listener error:', e)
    }
  }
}

function parseSkyspeedCommandHeader(headerValue: string): SkyspeedCommand | null {
  // CLICK NextPage|AllNewPosts|PrevPage
  const clickMatch = headerValue.match(/^CLICK\s+(NextPage|AllNewPosts|PrevPage)$/)
  if (clickMatch) {
    return { type: 'CLICK', buttonName: clickMatch[1] as 'NextPage' | 'AllNewPosts' | 'PrevPage' }
  }

  // FIND <target>
  const findMatch = headerValue.match(/^FIND\s+(.+)$/)
  if (findMatch) {
    return { type: 'FIND', target: findMatch[1].trim() }
  }

  // SCROLL TOP|BOTTOM
  const scrollMatch = headerValue.match(/^SCROLL\s+(TOP|BOTTOM)$/)
  if (scrollMatch) {
    return { type: 'SCROLL', direction: scrollMatch[1] as 'TOP' | 'BOTTOM' }
  }

  return null
}

// --- Feed API ---

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

      // Check for time shift header from Skyspeed server
      if (isClockAccelerated()) {
        const timeShiftHeader = response.headers?.['x-skyspeed-timeshift']
        if (timeShiftHeader) {
          const timeShiftMs = parseInt(timeShiftHeader, 10)
          if (!isNaN(timeShiftMs) && timeShiftMs > 0) {
            applyTimeShift(timeShiftMs)
          }
        }
      }

      // Check for Skyspeed command header
      const commandHeader = response.headers?.['x-skyspeed-command']
      if (commandHeader && skyspeedCommandListeners.size > 0) {
        const command = parseSkyspeedCommandHeader(commandHeader)
        if (command) {
          log.debug('Skyspeed Command', 'Received:', commandHeader)
          notifySkyspeedCommand(command)
        } else {
          log.warn('Skyspeed Command', 'Unrecognized command:', commandHeader)
        }
      }

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
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void,
  parentHeight?: number
): Promise<AppBskyFeedGetPostThread.OutputSchema> {
  return retryWithBackoff(
    async () => {
      const response = await agent.getPostThread({
        uri,
        depth,
        ...(parentHeight !== undefined && { parentHeight }),
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
export const MAX_PARENT_CHAIN_DEPTH = 8

export async function fetchParentChain(
  agent: BskyAgent,
  parentUri: string,
  maxDepth: number = MAX_PARENT_CHAIN_DEPTH,
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
      log.warn('Feed', 'Failed to fetch parent post:', error)
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

/**
 * Fetches the user's bookmarked posts with rate limit handling
 */
export async function getBookmarks(
  agent: BskyAgent,
  options: { limit?: number; cursor?: string; onRateLimit?: (info: { retryAfter?: number; message?: string }) => void } = {}
): Promise<{
  bookmarks: AppBskyBookmarkDefs.BookmarkView[]
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await agent.app.bsky.bookmark.getBookmarks({
        limit: options.limit || 25,
        cursor: options.cursor,
      })
      return {
        bookmarks: response.data.bookmarks,
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
      throw new Error(`Failed to fetch bookmarks: ${error.message}`)
    }
    throw new Error('Failed to fetch bookmarks: Unknown error')
  })
}

/**
 * Fetches the user's saved/pinned feed generators with their display info.
 * Returns GeneratorView objects for feeds of type 'feed' (excludes lists and timelines).
 */
export async function getSavedFeeds(
  agent: BskyAgent
): Promise<AppBskyFeedDefs.GeneratorView[]> {
  const prefs = await agent.getPreferences()
  const feedItems = (prefs.savedFeeds || []).filter(
    (f: AppBskyActorDefs.SavedFeed) => f.type === 'feed' && f.pinned
  )
  if (feedItems.length === 0) return []

  const feedUris = feedItems.map((f: AppBskyActorDefs.SavedFeed) => f.value)
  const response = await agent.app.bsky.feed.getFeedGenerators({ feeds: feedUris })
  return response.data.feeds
}

/**
 * Fetches posts from a custom feed generator with rate limit handling
 */
export async function getCustomFeed(
  agent: BskyAgent,
  feedUri: string,
  options: FeedOptions = {}
): Promise<{
  feed: AppBskyFeedDefs.FeedViewPost[]
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await agent.app.bsky.feed.getFeed({
        feed: feedUri,
        limit: options.limit || 25,
        cursor: options.cursor,
      })

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
      throw new Error(`Failed to fetch custom feed: ${error.message}`)
    }
    throw new Error('Failed to fetch custom feed: Unknown error')
  })
}
