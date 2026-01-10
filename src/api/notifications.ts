/**
 * Notifications API operations
 * 
 * Handles fetching notifications and unread counts from Bluesky
 */

import { BskyAgent, AppBskyNotificationListNotifications } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

export interface NotificationOptions {
  limit?: number
  cursor?: string
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
}

/**
 * Fetches notifications for the authenticated user with rate limit handling
 */
export async function getNotifications(
  agent: BskyAgent,
  options: NotificationOptions = {}
): Promise<{
  notifications: AppBskyNotificationListNotifications.OutputSchema['notifications']
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await agent.listNotifications({
        limit: options.limit || 50,
        cursor: options.cursor,
      })

      return {
        notifications: response.data.notifications,
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
      throw new Error(`Failed to fetch notifications: ${error.message}`)
    }
    throw new Error('Failed to fetch notifications: Unknown error')
  })
}

/**
 * Gets the unread notification count for the authenticated user
 */
export async function getUnreadCount(
  agent: BskyAgent,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<number> {
  return retryWithBackoff(
    async () => {
      const response = await agent.countUnreadNotifications()
      return response.data.count
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
      throw new Error(`Failed to fetch unread count: ${error.message}`)
    }
    throw new Error('Failed to fetch unread count: Unknown error')
  })
}

/**
 * Marks notifications as seen
 */
export async function updateSeenNotifications(
  agent: BskyAgent,
  seenAt?: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<void> {
  return retryWithBackoff(
    async () => {
      // Ensure seenAt is a string in ISO format
      const seenAtString = seenAt || new Date().toISOString()
      await agent.updateSeenNotifications(seenAtString)
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
      throw new Error(`Failed to update seen notifications: ${error.message}`)
    }
    throw new Error('Failed to update seen notifications: Unknown error')
  })
}

