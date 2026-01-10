/**
 * Post operations (create, like, repost, etc.)
 */

import { BskyAgent } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

export interface PostOptions {
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
}

export interface CreatePostParams {
  text: string
  replyTo?: {
    uri: string
    cid: string
    rootUri?: string
    rootCid?: string
  }
  embed?: {
    images?: Array<{
      image: Blob
      alt: string
    }>
  }
}

export interface CreateQuotePostParams {
  text: string
  quotedPost: {
    uri: string
    cid: string
  }
  embed?: {
    images?: Array<{
      image: Blob
      alt: string
    }>
  }
}

/**
 * Creates a new post with rate limit handling
 */
export async function createPost(
  agent: BskyAgent,
  params: CreatePostParams,
  options?: PostOptions
): Promise<{ uri: string; cid: string }> {
  return retryWithBackoff(
    async () => {
      const record: any = {
        $type: 'app.bsky.feed.post',
        text: params.text,
        createdAt: new Date().toISOString(),
      }

      if (params.replyTo) {
        const root = params.replyTo.rootUri && params.replyTo.rootCid
          ? { uri: params.replyTo.rootUri, cid: params.replyTo.rootCid }
          : { uri: params.replyTo.uri, cid: params.replyTo.cid }
        
        record.reply = {
          root: root,
          parent: { uri: params.replyTo.uri, cid: params.replyTo.cid },
        }
      }

      // Handle image embeds with rate limit handling
      if (params.embed?.images && params.embed.images.length > 0) {
        // Upload images sequentially to avoid rate limits
        const imageRefs = []
        for (const { image, alt } of params.embed.images) {
          const blobResponse = await retryWithBackoff(
            async () => {
              return await agent.uploadBlob(image)
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
                `Rate limit exceeded while uploading image. Please wait ${info.retryAfter || 60} seconds before trying again.`
              )
            }
            throw error
          })
          
          imageRefs.push({
            image: blobResponse.data.blob,
            alt: alt || '',
          })
          
          // Small delay between image uploads to avoid rate limits
          if (params.embed.images.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 200))
          }
        }

        record.embed = {
          $type: 'app.bsky.embed.images',
          images: imageRefs,
        }
      }

      const response = await agent.post(record)

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
      throw new Error(`Failed to create post: ${error.message}`)
    }
    throw new Error('Failed to create post: Unknown error')
  })
}

/**
 * Likes a post with rate limit handling
 */
export async function likePost(
  agent: BskyAgent,
  uri: string,
  cid: string,
  options?: PostOptions
): Promise<{ uri: string; cid: string }> {
  return retryWithBackoff(
    async () => {
      const response = await agent.like(uri, cid)
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
      throw new Error(`Failed to like post: ${error.message}`)
    }
    throw new Error('Failed to like post: Unknown error')
  })
}

/**
 * Removes a like from a post with rate limit handling
 */
export async function unlikePost(
  agent: BskyAgent,
  likeUri: string,
  options?: PostOptions
): Promise<void> {
  return retryWithBackoff(
    async () => {
      await agent.deleteLike(likeUri)
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
      throw new Error(`Failed to unlike post: ${error.message}`)
    }
    throw new Error('Failed to unlike post: Unknown error')
  })
}

/**
 * Reposts a post with rate limit handling
 */
export async function repost(
  agent: BskyAgent,
  uri: string,
  cid: string,
  options?: PostOptions
): Promise<{ uri: string; cid: string }> {
  return retryWithBackoff(
    async () => {
      const response = await agent.repost(uri, cid)
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
      throw new Error(`Failed to repost: ${error.message}`)
    }
    throw new Error('Failed to repost: Unknown error')
  })
}

/**
 * Removes a repost with rate limit handling
 */
export async function removeRepost(
  agent: BskyAgent,
  repostUri: string,
  options?: PostOptions
): Promise<void> {
  return retryWithBackoff(
    async () => {
      await agent.deleteRepost(repostUri)
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
      throw new Error(`Failed to remove repost: ${error.message}`)
    }
    throw new Error('Failed to remove repost: Unknown error')
  })
}

/**
 * Creates a quote post (post with embedded record and optional images) with rate limit handling
 */
export async function createQuotePost(
  agent: BskyAgent,
  params: CreateQuotePostParams,
  options?: PostOptions
): Promise<{ uri: string; cid: string }> {
  return retryWithBackoff(
    async () => {
      const record: any = {
        $type: 'app.bsky.feed.post',
        text: params.text,
        createdAt: new Date().toISOString(),
      }

      const hasImages = params.embed?.images && params.embed.images.length > 0
      
      if (hasImages) {
        // Upload images sequentially to avoid rate limits
        const imageRefs = []
        for (const { image, alt } of params.embed!.images!) {
          const blobResponse = await retryWithBackoff(
            async () => {
              return await agent.uploadBlob(image)
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
                `Rate limit exceeded while uploading image. Please wait ${info.retryAfter || 60} seconds before trying again.`
              )
            }
            throw error
          })
          
          imageRefs.push({
            image: blobResponse.data.blob,
            alt: alt || '',
          })
          
          // Small delay between image uploads to avoid rate limits
          if (params.embed!.images!.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 200))
          }
        }

        record.embed = {
          $type: 'app.bsky.embed.recordWithMedia',
          record: {
            $type: 'app.bsky.embed.record',
            record: {
              uri: params.quotedPost.uri,
              cid: params.quotedPost.cid,
            },
          },
          media: {
            $type: 'app.bsky.embed.images',
            images: imageRefs,
          },
        }
      } else {
        record.embed = {
          $type: 'app.bsky.embed.record',
          record: {
            uri: params.quotedPost.uri,
            cid: params.quotedPost.cid,
          },
        }
      }

      const response = await agent.post(record)

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
      throw new Error(`Failed to create quote post: ${error.message}`)
    }
    throw new Error('Failed to create quote post: Unknown error')
  })
}




