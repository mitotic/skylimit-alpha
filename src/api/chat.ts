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
    if (error instanceof Error) {
      throw new Error(`Failed to fetch conversations: ${error.message}`)
    }
    throw new Error('Failed to fetch conversations: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to fetch conversation: ${error.message}`)
    }
    throw new Error('Failed to fetch conversation: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to fetch messages: ${error.message}`)
    }
    throw new Error('Failed to fetch messages: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to send message: ${error.message}`)
    }
    throw new Error('Failed to send message: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to get/create conversation: ${error.message}`)
    }
    throw new Error('Failed to get/create conversation: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to mark conversation read: ${error.message}`)
    }
    throw new Error('Failed to mark conversation read: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to mute conversation: ${error.message}`)
    }
    throw new Error('Failed to mute conversation: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to unmute conversation: ${error.message}`)
    }
    throw new Error('Failed to unmute conversation: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to leave conversation: ${error.message}`)
    }
    throw new Error('Failed to leave conversation: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to accept conversation: ${error.message}`)
    }
    throw new Error('Failed to accept conversation: Unknown error')
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
    if (error instanceof Error) {
      throw new Error(`Failed to fetch unread chat count: ${error.message}`)
    }
    throw new Error('Failed to fetch unread chat count: Unknown error')
  })
}
