import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChatBskyConvoDefs } from '@atproto/api'
import { useSession } from '../auth/SessionContext'
import { useRateLimit } from '../contexts/RateLimitContext'
import {
  listConversations,
  getConversation,
  getMessages,
  sendMessage,
  markConversationRead,
  muteConversation,
  unmuteConversation,
  leaveConversation,
  acceptConversation,
  isAppPasswordDMError,
  APP_PASSWORD_DM_MESSAGE,
  ConvoView,
} from '../api/chat'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import { clientInterval, clearClientInterval } from '../utils/clientClock'
import { searchActors } from '../api/search'
import { getOrCreateConversation } from '../api/chat'
import Spinner from '../components/Spinner'
import Avatar from '../components/Avatar'
import RichText from '../components/RichText'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import RateLimitIndicator from '../components/RateLimitIndicator'
import ConfirmModal from '../components/ConfirmModal'
import PostMedia from '../components/PostMedia'
import { PencilIcon } from '../components/NavIcons'
import log from '../utils/logger'

export default function ChatPage() {
  const { convoId } = useParams<{ convoId?: string }>()
  const { rateLimitStatus, setRateLimitStatus } = useRateLimit()
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [dmAccessError, setDmAccessError] = useState(false)

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  const onRateLimit = useCallback((info: { retryAfter?: number; message?: string }) => {
    setRateLimitStatus({
      isActive: true,
      retryAfter: info.retryAfter,
      message: info.message || 'Rate limit exceeded. Please wait before trying again.'
    })
  }, [setRateLimitStatus])

  if (dmAccessError) {
    return (
      <div className="pb-20 md:pb-0">
        <div className="mx-4 mt-6 p-4 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700 rounded-lg">
          <p className="text-yellow-800 dark:text-yellow-200" style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}>
            {APP_PASSWORD_DM_MESSAGE}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="pb-20 md:pb-0">
      <RateLimitIndicator status={rateLimitStatus} />
      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
      {convoId ? (
        <ChatDetail
          convoId={convoId}
          addToast={addToast}
          onRateLimit={onRateLimit}
          onDmAccessError={() => setDmAccessError(true)}
        />
      ) : (
        <ChatList
          addToast={addToast}
          onRateLimit={onRateLimit}
          onDmAccessError={() => setDmAccessError(true)}
        />
      )}
    </div>
  )
}

// ---- Chat List View ----

interface ChatListProps {
  addToast: (message: string, type: 'success' | 'error' | 'info') => void
  onRateLimit: (info: { retryAfter?: number; message?: string }) => void
  onDmAccessError: () => void
}

function ChatList({ addToast, onRateLimit, onDmAccessError }: ChatListProps) {
  const navigate = useNavigate()
  const { agent, session } = useSession()
  const { setRateLimitStatus } = useRateLimit()
  const [convos, setConvos] = useState<ConvoView[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [activeTab, setActiveTab] = useState<'accepted' | 'request'>('accepted')
  const [showNewChat, setShowNewChat] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isCreatingConvo, setIsCreatingConvo] = useState(false)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadConversations = useCallback(async (loadCursor?: string) => {
    if (!agent || !session) return

    try {
      setRateLimitStatus(null)
      const { convos: newConvos, cursor: newCursor } = await listConversations(agent, {
        cursor: loadCursor,
        limit: 25,
        status: activeTab,
        onRateLimit,
      })

      setRateLimitStatus(null)

      if (loadCursor) {
        setConvos(prev => [...prev, ...newConvos])
      } else {
        setConvos(newConvos)
      }
      setCursor(newCursor)
    } catch (error) {
      log.error('ChatList', 'Failed to load conversations:', error)
      if (isAppPasswordDMError(error)) {
        onDmAccessError()
        return
      }
      addToast(error instanceof Error ? error.message : 'Failed to load conversations', 'error')
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [agent, session, activeTab, onRateLimit, setRateLimitStatus, addToast, onDmAccessError])

  useEffect(() => {
    setIsLoading(true)
    setConvos([])
    setCursor(undefined)
    loadConversations()
  }, [loadConversations])

  const handleLoadMore = () => {
    if (!cursor || isLoadingMore) return
    setIsLoadingMore(true)
    loadConversations(cursor)
  }

  const handleTabChange = (tab: 'accepted' | 'request') => {
    setActiveTab(tab)
  }

  const handleSearchUsers = (query: string) => {
    setSearchQuery(query)
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    if (!query.trim()) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    searchTimeoutRef.current = setTimeout(async () => {
      if (!agent) return
      try {
        const data = await searchActors(agent, query.trim(), 10)
        setSearchResults(data.actors.filter(a => a.did !== session?.did))
      } catch {
        setSearchResults([])
      } finally {
        setIsSearching(false)
      }
    }, 300)
  }

  const handleStartConversation = async (did: string) => {
    if (!agent || isCreatingConvo) return
    setIsCreatingConvo(true)
    try {
      const { convo } = await getOrCreateConversation(agent, did, onRateLimit)
      setShowNewChat(false)
      setSearchQuery('')
      setSearchResults([])
      navigate(`/chat/${convo.id}`)
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to start conversation', 'error')
    } finally {
      setIsCreatingConvo(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Chats</h1>
          <a
            href="https://bsky.app/messages"
            className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
          >
            View on Bluesky ↗
          </a>
        </div>
      </div>
      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => handleTabChange('accepted')}
          className={`flex-1 py-3 text-center font-medium transition-colors ${
            activeTab === 'accepted'
              ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
          style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}
        >
          Messages
        </button>
        <button
          onClick={() => handleTabChange('request')}
          className={`flex-1 py-3 text-center font-medium transition-colors ${
            activeTab === 'request'
              ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
          style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}
        >
          Requests
        </button>
      </div>

      {/* Conversation List */}
      {convos.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          {activeTab === 'accepted' ? 'No conversations yet' : 'No message requests'}
        </div>
      ) : (
        <div>
          {convos.map(convo => (
            <ConversationItem
              key={convo.id}
              convo={convo}
              currentDid={session?.did || ''}
              onClick={() => navigate(`/chat/${convo.id}`)}
            />
          ))}
        </div>
      )}

      {/* Load More */}
      {cursor && (
        <div className="flex justify-center py-4">
          <button
            onClick={handleLoadMore}
            disabled={isLoadingMore}
            className="px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors disabled:opacity-50"
          >
            {isLoadingMore ? <Spinner size="sm" /> : 'Load more'}
          </button>
        </div>
      )}

      {/* Floating new chat button */}
      {!isReadOnlyMode() && (
        <button
          onClick={() => setShowNewChat(true)}
          title="New chat"
          className="fixed bottom-20 right-6 md:bottom-8 md:right-8 bg-blue-500 hover:bg-blue-600 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all z-40 flex items-center justify-center w-14 h-14"
        >
          <PencilIcon className="w-7 h-7" />
        </button>
      )}

      {/* New chat modal */}
      {showNewChat && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-20" onClick={() => { setShowNewChat(false); setSearchQuery(''); setSearchResults([]) }}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold">New Chat</h2>
              <button
                onClick={() => { setShowNewChat(false); setSearchQuery(''); setSearchResults([]) }}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl"
              >
                ✕
              </button>
            </div>
            <div className="px-4 py-3">
              <input
                type="text"
                value={searchQuery}
                onChange={e => handleSearchUsers(e.target.value)}
                placeholder="Search by name or handle..."
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="max-h-80 overflow-y-auto">
              {isSearching && (
                <div className="flex justify-center py-4">
                  <Spinner size="sm" />
                </div>
              )}
              {!isSearching && searchQuery && searchResults.length === 0 && (
                <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">No users found</div>
              )}
              {searchResults.map(actor => (
                <button
                  key={actor.did}
                  onClick={() => handleStartConversation(actor.did)}
                  disabled={isCreatingConvo}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left disabled:opacity-50"
                >
                  <Avatar src={actor.avatar} alt={actor.displayName || actor.handle} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{actor.displayName || actor.handle}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">@{actor.handle}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Conversation List Item ----

interface ConversationItemProps {
  convo: ConvoView
  currentDid: string
  onClick: () => void
}

function ConversationItem({ convo, currentDid, onClick }: ConversationItemProps) {
  // Find the other member(s)
  const otherMembers = convo.members.filter(m => m.did !== currentDid)
  const displayMember = otherMembers[0]

  // Get last message preview
  let lastMessageText = ''
  let lastMessageTime = ''
  if (convo.lastMessage) {
    if (ChatBskyConvoDefs.isMessageView(convo.lastMessage)) {
      const msg = convo.lastMessage
      const isSelf = msg.sender.did === currentDid
      lastMessageText = (isSelf ? 'You: ' : '') + msg.text
      lastMessageTime = formatRelativeTime(msg.sentAt)
    } else if (ChatBskyConvoDefs.isDeletedMessageView(convo.lastMessage)) {
      lastMessageText = '[Message deleted]'
      lastMessageTime = formatRelativeTime(convo.lastMessage.sentAt)
    }
  }

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left border-b border-gray-100 dark:border-gray-800 ${
        convo.unreadCount > 0 ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
      }`}
    >
      <Avatar
        src={displayMember?.avatar}
        alt={displayMember?.displayName || displayMember?.handle || '?'}
        size="md"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate ${
            convo.unreadCount > 0
              ? 'font-bold text-gray-900 dark:text-white'
              : 'font-medium text-gray-900 dark:text-white'
          }`} style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}>
            {displayMember?.displayName || displayMember?.handle || 'Unknown'}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {convo.muted && (
              <span className="text-gray-400 dark:text-gray-500 text-xs">muted</span>
            )}
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {lastMessageTime}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <p className={`truncate ${
            convo.unreadCount > 0
              ? 'font-medium text-gray-700 dark:text-gray-300'
              : 'text-gray-500 dark:text-gray-400'
          }`} style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}>
            {lastMessageText || 'No messages yet'}
          </p>
          {convo.unreadCount > 0 && (
            <span className="flex-shrink-0 w-2.5 h-2.5 bg-blue-500 rounded-full" />
          )}
        </div>
      </div>
    </button>
  )
}

// ---- Chat Detail View ----

interface ChatDetailProps {
  convoId: string
  addToast: (message: string, type: 'success' | 'error' | 'info') => void
  onRateLimit: (info: { retryAfter?: number; message?: string }) => void
  onDmAccessError: () => void
}

function ChatDetail({ convoId, addToast, onRateLimit, onDmAccessError }: ChatDetailProps) {
  const navigate = useNavigate()
  const { agent, session } = useSession()
  const { setRateLimitStatus } = useRateLimit()
  const [convoDetails, setConvoDetails] = useState<ConvoView | null>(null)
  const [messages, setMessages] = useState<ChatBskyConvoDefs.MessageView[]>([])
  const [messageCursor, setMessageCursor] = useState<string | undefined>()
  const [isLoadingMessages, setIsLoadingMessages] = useState(true)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showLeaveModal, setShowLeaveModal] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const convoRevRef = useRef<string>('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isAtBottomRef = useRef(true)

  const currentDid = session?.did || ''

  // Get other member for header display
  const otherMembers = convoDetails?.members.filter(m => m.did !== currentDid) || []
  const displayMember = otherMembers[0]
  const isRequest = convoDetails?.status === 'request'

  // Scroll to bottom
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  // Track if user is at bottom of messages
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return
    const threshold = 50
    isAtBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < threshold
  }, [])

  // Load initial messages
  const loadMessages = useCallback(async () => {
    if (!agent) return

    try {
      setRateLimitStatus(null)

      // Fetch convo details and messages in parallel
      const [convoResult, messagesResult] = await Promise.all([
        getConversation(agent, convoId, onRateLimit),
        getMessages(agent, convoId, { limit: 50, onRateLimit }),
      ])

      setConvoDetails(convoResult.convo)
      convoRevRef.current = convoResult.convo.rev

      // Messages come newest-first from API, reverse for display
      const reversed = [...messagesResult.messages].reverse()
      setMessages(reversed)
      setMessageCursor(messagesResult.cursor)

      // Mark as read (skip in read-only mode)
      if (!isReadOnlyMode() && convoResult.convo.unreadCount > 0) {
        try {
          await markConversationRead(agent, convoId, undefined, onRateLimit)
        } catch {
          // Non-critical, don't show error
        }
      }
    } catch (error) {
      log.error('ChatDetail', 'Failed to load messages:', error)
      if (isAppPasswordDMError(error)) {
        onDmAccessError()
        return
      }
      addToast(error instanceof Error ? error.message : 'Failed to load messages', 'error')
    } finally {
      setIsLoadingMessages(false)
    }
  }, [agent, convoId, onRateLimit, setRateLimitStatus, addToast, onDmAccessError])

  useEffect(() => {
    loadMessages()
  }, [loadMessages])

  // Scroll to bottom after initial load
  useEffect(() => {
    if (!isLoadingMessages && messages.length > 0) {
      scrollToBottom()
    }
  }, [isLoadingMessages]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for new messages every 5 seconds
  useEffect(() => {
    if (!agent || isLoadingMessages) return

    const intervalRef = { current: clientInterval(async () => {
      try {
        // Check if rev changed first
        const convoResult = await getConversation(agent, convoId, onRateLimit)
        if (convoResult.convo.rev === convoRevRef.current) return

        convoRevRef.current = convoResult.convo.rev
        setConvoDetails(convoResult.convo)

        // Fetch latest messages
        const result = await getMessages(agent, convoId, { limit: 20, onRateLimit })
        const reversed = [...result.messages].reverse()

        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id))
          const newMsgs = reversed.filter(m => !existingIds.has(m.id))
          if (newMsgs.length === 0) return prev
          return [...prev, ...newMsgs]
        })

        // Auto-scroll if at bottom
        if (isAtBottomRef.current) {
          setTimeout(() => scrollToBottom('smooth'), 50)
        }

        // Mark as read
        if (!isReadOnlyMode() && convoResult.convo.unreadCount > 0) {
          try {
            await markConversationRead(agent, convoId, undefined, onRateLimit)
          } catch {
            // Non-critical
          }
        }
      } catch (error) {
        log.verbose('ChatDetail', 'Poll failed:', error)
      }
    }, 5000) }

    return () => clearClientInterval(intervalRef.current)
  }, [agent, convoId, isLoadingMessages, onRateLimit, scrollToBottom])

  // Load older messages
  const handleLoadOlder = async () => {
    if (!agent || !messageCursor || isLoadingOlder) return

    const container = messagesContainerRef.current
    const prevScrollHeight = container?.scrollHeight || 0

    setIsLoadingOlder(true)
    try {
      const result = await getMessages(agent, convoId, {
        cursor: messageCursor,
        limit: 50,
        onRateLimit,
      })
      const reversed = [...result.messages].reverse()
      setMessages(prev => [...reversed, ...prev])
      setMessageCursor(result.cursor)

      // Preserve scroll position
      requestAnimationFrame(() => {
        if (container) {
          const newScrollHeight = container.scrollHeight
          container.scrollTop = newScrollHeight - prevScrollHeight
        }
      })
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to load older messages', 'error')
    } finally {
      setIsLoadingOlder(false)
    }
  }

  // Send message
  const handleSend = async () => {
    if (!agent || !messageText.trim() || isSending) return

    if (isReadOnlyMode()) {
      addToast('Disable Read-only mode in Settings to send messages', 'error')
      return
    }

    const text = messageText.trim()
    setMessageText('')
    setIsSending(true)

    // Resize textarea back
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Optimistic: add a placeholder message
    const optimisticId = `optimistic-${Date.now()}`
    const optimisticMsg: ChatBskyConvoDefs.MessageView = {
      id: optimisticId,
      rev: '',
      text,
      sender: { did: currentDid },
      sentAt: new Date().toISOString(),
    }
    setMessages(prev => [...prev, optimisticMsg])
    setTimeout(() => scrollToBottom('smooth'), 50)

    try {
      // Detect facets using RichText API
      const { RichText: RichTextAPI } = await import('@atproto/api')
      const rt = new RichTextAPI({ text })
      await rt.detectFacets(agent)

      const sent = await sendMessage(agent, convoId, {
        text,
        facets: rt.facets,
      }, onRateLimit)

      // Replace optimistic message with real one
      setMessages(prev => prev.map(m => m.id === optimisticId ? sent : m))
    } catch (error) {
      // Remove optimistic message on failure
      setMessages(prev => prev.filter(m => m.id !== optimisticId))
      addToast(error instanceof Error ? error.message : 'Failed to send message', 'error')
      setMessageText(text) // Restore the text
    } finally {
      setIsSending(false)
      textareaRef.current?.focus()
    }
  }

  // Handle key press in textarea
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Auto-resize textarea
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessageText(e.target.value)
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'
  }

  // Conversation management
  const handleMuteToggle = async () => {
    if (!agent || !convoDetails) return
    setShowMenu(false)
    try {
      if (convoDetails.muted) {
        const result = await unmuteConversation(agent, convoId, onRateLimit)
        setConvoDetails(result.convo)
        addToast('Conversation unmuted', 'success')
      } else {
        const result = await muteConversation(agent, convoId, onRateLimit)
        setConvoDetails(result.convo)
        addToast('Conversation muted', 'success')
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to update mute setting', 'error')
    }
  }

  const handleLeave = async () => {
    if (!agent) return
    try {
      await leaveConversation(agent, convoId, onRateLimit)
      navigate('/chat')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to leave conversation', 'error')
    }
  }

  const handleAccept = async () => {
    if (!agent) return
    try {
      await acceptConversation(agent, convoId, onRateLimit)
      // Refresh convo details after accepting
      const refreshed = await getConversation(agent, convoId, onRateLimit)
      setConvoDetails(refreshed.convo)
      addToast('Conversation accepted', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to accept conversation', 'error')
    }
  }

  if (isLoadingMessages) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-45px-80px)] md:h-[calc(100vh-45px)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <button
          onClick={() => navigate('/chat')}
          className="md:hidden p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
          aria-label="Back to conversations"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={() => {
            if (displayMember?.handle) navigate(`/profile/${displayMember.handle}`)
          }}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <Avatar
            src={displayMember?.avatar}
            alt={displayMember?.displayName || displayMember?.handle || '?'}
            size="sm"
          />
          <div className="text-left">
            <div className="font-medium text-gray-900 dark:text-white" style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}>
              {displayMember?.displayName || displayMember?.handle || 'Unknown'}
            </div>
            {displayMember?.displayName && displayMember?.handle && (
              <div className="text-gray-500 dark:text-gray-400" style={{ fontSize: 'calc(var(--post-text-size) - 2px)' }}>
                @{displayMember.handle}
              </div>
            )}
          </div>
        </button>
        <div className="flex-1" />

        {/* Menu button */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
            aria-label="Conversation options"
          >
            <svg className="w-5 h-5 text-gray-500 dark:text-gray-400" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-10 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 min-w-[160px]">
                <button
                  onClick={handleMuteToggle}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  {convoDetails?.muted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  onClick={() => { setShowMenu(false); setShowLeaveModal(true) }}
                  className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  Leave conversation
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-1"
      >
        {/* Load older */}
        {messageCursor && (
          <div className="flex justify-center pb-4">
            <button
              onClick={handleLoadOlder}
              disabled={isLoadingOlder}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
            >
              {isLoadingOlder ? <Spinner size="sm" /> : 'Load older messages'}
            </button>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg, idx) => {
          const isSelf = msg.sender.did === currentDid
          const prevMsg = idx > 0 ? messages[idx - 1] : null
          const showSender = !prevMsg || prevMsg.sender.did !== msg.sender.did

          // Day separator
          const msgDate = new Date(msg.sentAt).toLocaleDateString()
          const prevDate = prevMsg ? new Date(prevMsg.sentAt).toLocaleDateString() : null
          const showDateSeparator = msgDate !== prevDate

          const isDeleted = '_deleted' in msg && (msg as any)._deleted
          const isOptimistic = msg.id.startsWith('optimistic-')

          return (
            <div key={msg.id}>
              {showDateSeparator && (
                <div className="flex justify-center py-3">
                  <span className="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-full">
                    {formatDateSeparator(msg.sentAt)}
                  </span>
                </div>
              )}
              <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'} ${showSender ? 'mt-2' : 'mt-0.5'}`}>
                <div className={`max-w-[75%] ${isSelf ? 'order-1' : ''}`}>
                  <div
                    className={`px-3 py-2 rounded-2xl break-words ${
                      isDeleted
                        ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 italic'
                        : isSelf
                          ? 'bg-blue-500 text-white'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                    } ${isOptimistic ? 'opacity-60' : ''}`}
                    style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}
                  >
                    {isDeleted ? (
                      '[Message deleted]'
                    ) : msg.facets && msg.facets.length > 0 ? (
                      <RichText
                        text={msg.text}
                        facets={msg.facets}
                        className={isSelf ? 'text-white [&_a]:text-blue-100 [&_span]:text-blue-100' : ''}
                      />
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.text}</span>
                    )}
                  </div>
                  {!isDeleted && (msg as any).embed && (
                    <div className="mt-1 rounded-xl overflow-hidden">
                      <PostMedia embed={(msg as any).embed} />
                    </div>
                  )}
                  <div className={`text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 ${isSelf ? 'text-right' : ''}`}>
                    {formatMessageTime(msg.sentAt)}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Message Input / Accept Bar */}
      {isRequest ? (
        <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 px-4 py-3 flex gap-3">
          <button
            onClick={handleAccept}
            className="flex-1 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors"
          >
            Accept
          </button>
          <button
            onClick={() => navigate('/chat')}
            className="flex-1 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
          >
            Decline
          </button>
        </div>
      ) : (
        <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 px-4 py-2">
          {isReadOnlyMode() ? (
            <div className="text-center text-sm text-gray-400 dark:text-gray-500 py-2">
              Read-only mode — disable in Settings to send messages
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={messageText}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                rows={1}
                className="flex-1 resize-none bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white rounded-2xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 max-h-[120px]"
                style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}
              />
              <button
                onClick={handleSend}
                disabled={!messageText.trim() || isSending}
                className="p-2 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-full transition-colors disabled:opacity-30 disabled:hover:bg-transparent flex-shrink-0"
                aria-label="Send message"
              >
                {isSending ? (
                  <Spinner size="sm" />
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Leave Confirmation Modal */}
      <ConfirmModal
        isOpen={showLeaveModal}
        onClose={() => setShowLeaveModal(false)}
        onConfirm={handleLeave}
        title="Leave Conversation"
        message="Are you sure you want to leave this conversation? You will no longer receive messages from this conversation."
        confirmText="Leave"
        cancelText="Cancel"
        isDangerous={true}
      />
    </div>
  )
}

// ---- Helpers ----

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'now'
  if (diffMin < 60) return `${diffMin}m`
  if (diffHour < 24) return `${diffHour}h`
  if (diffDay < 7) return `${diffDay}d`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatMessageTime(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function formatDateSeparator(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}
