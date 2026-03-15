/**
 * Chat/DM API operations
 *
 * Handles conversations and messaging via the AT Protocol chat.bsky.convo lexicons
 */

import { BskyAgent, ChatBskyConvoDefs } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

const CHAT_SERVICE_DID = 'did:web:api.bsky.chat'

/**
 * Creates a proxied agent configured for chat API calls.
 * Chat calls require the atproto-proxy header pointing to the chat service.
 */
function getChatAgent(agent: BskyAgent): BskyAgent {
  return agent.withProxy('bsky_chat' as any, CHAT_SERVICE_DID) as BskyAgent
}

/**
 * Checks if an error is due to app password lacking DM permissions.
 * Bluesky app passwords can be created without "Direct Messages" access,
 * which causes the chat proxy to reject the token with "Bad token method".
 */
export function isAppPasswordDMError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return msg.includes('bad token method') || msg.includes('bad token scope')
      || msg.includes('does not have direct message access')
  }
  return false
}

export const APP_PASSWORD_DM_MESSAGE =
  'Your app password does not have Direct Message access. ' +
  'Create a new app password in Bluesky Settings → Privacy and Security → App Passwords ' +
  'with the "Allow access to your direct messages" option enabled.'

/**
 * Wraps a chat API error with a user-friendly message when the cause
 * is an app password without DM permission.
 */
function friendlyChatError(error: unknown, fallbackMsg: string): Error {
  if (isAppPasswordDMError(error)) {
    return new Error(
      'Your app password does not have Direct Message access. ' +
      'Create a new app password in Bluesky Settings → Privacy and Security → App Passwords ' +
      'with the "Allow access to your direct messages" option enabled.'
    )
  }
  if (error instanceof Error) {
    return new Error(`${fallbackMsg}: ${error.message}`)
  }
  return new Error(`${fallbackMsg}: Unknown error`)
}

export type ConvoView = ChatBskyConvoDefs.ConvoView
export type MessageView = ChatBskyConvoDefs.MessageView
export type DeletedMessageView = ChatBskyConvoDefs.DeletedMessageView

export interface ChatOptions {
  limit?: number
  cursor?: string
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
}

/**
 * Fetches the list of conversations for the authenticated user
 */
export async function listConversations(
  agent: BskyAgent,
  options: ChatOptions & { status?: 'request' | 'accepted' } = {}
): Promise<{
  convos: ConvoView[]
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.listConvos({
        limit: options.limit || 25,
        cursor: options.cursor,
        status: options.status,
      })
      return {
        convos: response.data.convos,
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
    throw friendlyChatError(error, 'Failed to fetch conversations')
  })
}

/**
 * Fetches a single conversation by ID
 */
export async function getConversation(
  agent: BskyAgent,
  convoId: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<{ convo: ConvoView }> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.getConvo({ convoId })
      return { convo: response.data.convo }
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
    throw friendlyChatError(error, 'Failed to fetch conversation')
  })
}

/**
 * Fetches messages in a conversation
 */
export async function getMessages(
  agent: BskyAgent,
  convoId: string,
  options: ChatOptions = {}
): Promise<{
  messages: ChatBskyConvoDefs.MessageView[]
  cursor?: string
}> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.getMessages({
        convoId,
        limit: options.limit || 50,
        cursor: options.cursor,
      })
      // Map messages, converting deleted ones to pseudo-MessageViews
      const allMessages: ChatBskyConvoDefs.MessageView[] = []
      for (const m of response.data.messages) {
        if (ChatBskyConvoDefs.isMessageView(m)) {
          allMessages.push(m)
        } else if (ChatBskyConvoDefs.isDeletedMessageView(m)) {
          allMessages.push({
            id: m.id,
            rev: m.rev,
            text: '',
            sender: m.sender,
            sentAt: m.sentAt,
            _deleted: true,
          } as unknown as ChatBskyConvoDefs.MessageView)
        }
      }
      return {
        messages: allMessages,
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
    throw friendlyChatError(error, 'Failed to fetch messages')
  })
}

/**
 * Sends a message in a conversation
 */
export async function sendMessage(
  agent: BskyAgent,
  convoId: string,
  message: { text: string; facets?: ChatBskyConvoDefs.MessageInput['facets'] },
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<ChatBskyConvoDefs.MessageView> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.sendMessage({
        convoId,
        message: {
          text: message.text,
          facets: message.facets,
        },
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
    throw friendlyChatError(error, 'Failed to send message')
  })
}

/**
 * Gets or creates a conversation with the specified member
 */
export async function getOrCreateConversation(
  agent: BskyAgent,
  memberDid: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<{ convo: ConvoView }> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.getConvoForMembers({
        members: [memberDid],
      })
      return { convo: response.data.convo }
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
    throw friendlyChatError(error, 'Failed to get/create conversation')
  })
}

/**
 * Marks a conversation as read
 */
export async function markConversationRead(
  agent: BskyAgent,
  convoId: string,
  messageId?: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<{ convo: ConvoView }> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.updateRead({
        convoId,
        messageId,
      })
      return { convo: response.data.convo }
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
    throw friendlyChatError(error, 'Failed to mark conversation read')
  })
}

/**
 * Mutes a conversation
 */
export async function muteConversation(
  agent: BskyAgent,
  convoId: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<{ convo: ConvoView }> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.muteConvo({ convoId })
      return { convo: response.data.convo }
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
    throw friendlyChatError(error, 'Failed to mute conversation')
  })
}

/**
 * Unmutes a conversation
 */
export async function unmuteConversation(
  agent: BskyAgent,
  convoId: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<{ convo: ConvoView }> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.unmuteConvo({ convoId })
      return { convo: response.data.convo }
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
    throw friendlyChatError(error, 'Failed to unmute conversation')
  })
}

/**
 * Leaves a conversation
 */
export async function leaveConversation(
  agent: BskyAgent,
  convoId: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<void> {
  return retryWithBackoff(
    async () => {
      await getChatAgent(agent).chat.bsky.convo.leaveConvo({ convoId })
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
    throw friendlyChatError(error, 'Failed to leave conversation')
  })
}

/**
 * Accepts a conversation request
 */
export async function acceptConversation(
  agent: BskyAgent,
  convoId: string,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<void> {
  return retryWithBackoff(
    async () => {
      await getChatAgent(agent).chat.bsky.convo.acceptConvo({ convoId })
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
    throw friendlyChatError(error, 'Failed to accept conversation')
  })
}

/**
 * Gets the total unread chat message count across all conversations
 */
export async function getUnreadChatCount(
  agent: BskyAgent,
  onRateLimit?: (info: { retryAfter?: number; message?: string }) => void
): Promise<number> {
  return retryWithBackoff(
    async () => {
      const response = await getChatAgent(agent).chat.bsky.convo.listConvos({
        limit: 100,
      })
      return response.data.convos.reduce((sum, convo) => sum + convo.unreadCount, 0)
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
    throw friendlyChatError(error, 'Failed to fetch unread chat count')
  })
}
