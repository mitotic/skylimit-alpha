import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistance } from 'date-fns'
import { clientDate, clientNow } from '../utils/clientClock'
import { useEffect, useState, useRef } from 'react'
import Avatar from './Avatar'
import PostActions from './PostActions'
import PostMedia from './PostMedia'
import RootPost from './RootPost'
import { getCurationNumber, getPostNumberFromSummary } from '../curation/skylimitCounter'
import { getSettings } from '../curation/skylimitStore'
import { getFeedViewPostTimestamp, isRepost, isPeriodicEdition, getPostUrl, getProfileUrl, getPostUniqueId } from '../curation/skylimitGeneral'
import { CurationFeedViewPost, isStatusDrop, UserEntry, FollowInfo, ENGAGEMENT_CLICKED } from '../curation/types'
import { updatePostSummaryEngagement } from '../curation/skylimitCache'
import { getTimeInTimezone, getBrowserTimezone, timezonesAreDifferent, getTimezoneAbbreviation } from '../utils/timezoneUtils'
import { ampUp, ampDown } from '../curation/skylimitFollows'
import { getCachedParentPost, saveCachedParentPost } from '../curation/parentPostCache'
import { getPostThread } from '../api/feed'
import { getFilter, getFollow } from '../curation/skylimitCache'
import { countTotalPostsForUser } from '../curation/skylimitStats'
import { useSession } from '../auth/SessionContext'
import { useTheme } from '../contexts/ThemeContext'
import CurationPopup from './CurationPopup'
import RichText from './RichText'
import log from '../utils/logger'

interface PostCardProps {
  post: AppBskyFeedDefs.FeedViewPost | CurationFeedViewPost
  onReply?: (uri: string) => void
  onRepost?: (uri: string, cid: string) => void
  onQuotePost?: (post: AppBskyFeedDefs.PostView) => void
  onLike?: (uri: string, cid: string) => void
  onBookmark?: (uri: string, cid: string) => void
  onDeletePost?: (uri: string) => void
  onPinPost?: (uri: string, cid: string) => void
  /**
   * If true, show the daily post counter (only on home page)
   */
  showCounter?: boolean
  /**
   * Callback when amp factor changes (to reload feed)
   */
  onAmpChange?: () => void
  /**
   * If true, highlight this post (used to highlight the clicked reply in thread view)
   */
  highlighted?: boolean
  /**
   * If true, show root post for replies (default true for home feed, false for thread view)
   */
  showRootPost?: boolean
  /**
   * Optional slot for engagement stats (reposts/likes) - rendered between content and action buttons
   */
  engagementStats?: React.ReactNode
  /**
   * If true, use stacked layout with avatar+header on top and full-width body below (for thread anchor posts)
   */
  stackedLayout?: boolean
  /** If true, use newspaper view layout (avatar + display name only, side actions) */
  newspaperView?: boolean
  /** Font family for edition layout display */
  editionFont?: 'serif' | 'sans-serif'
  /** If true, hide the author avatar (used in notification embeds) */
  hideAvatar?: boolean
}

export default function PostCard({ post, onReply, onRepost, onQuotePost, onLike, onBookmark, onDeletePost, onPinPost, showCounter = false, onAmpChange, showRootPost = true, engagementStats, stackedLayout = false, newspaperView = false, editionFont, hideAvatar = false }: PostCardProps) {
  const navigate = useNavigate()
  const { session, agent } = useSession()
  const { theme } = useTheme()
  const myUsername = session?.handle || ''
  const record = post.post.record as any
  const author = post.post.author
  const embed = post.post.embed
  const [postNumber, setPostNumber] = useState<number | null>(null)
  const [showCounterDisplay, setShowCounterDisplay] = useState(false)
  const [showPopup, setShowPopup] = useState(false)
  const [popupPosition, setPopupPosition] = useState<'above' | 'below'>('below')
  const [popupAnchorRect, setPopupAnchorRect] = useState<DOMRect | null>(null)
  const [loading, setLoading] = useState(false)
  const [debugMode, setDebugMode] = useState(false)
  const [showTime, setShowTime] = useState(false)
  const [showViewedStatus, setShowViewedStatus] = useState(true)
  const [showAllPosts, setShowAllPosts] = useState(false)
  const [curationSuspended, setCurationSuspended] = useState(false)
  const [highlightStatusPrefix, setHighlightStatusPrefix] = useState<string>('')
  const [feedPageLength, setFeedPageLength] = useState<number>(25)
  const [clickToBlueSky, setClickToBlueSky] = useState(false)
  const [settingsTimezone, setSettingsTimezone] = useState<string>('')
  // Popup data for curation info
  const [rawPostNumber, setRawPostNumber] = useState<number | null>(null)
  const [userEntry, setUserEntry] = useState<UserEntry | null>(null)
  const [followInfo, setFollowInfo] = useState<FollowInfo | null>(null)
  const [skylimitNumber, setSkylimitNumber] = useState<number | undefined>(undefined)
  const popupRef = useRef<HTMLDivElement>(null)
  const counterButtonRef = useRef<HTMLButtonElement>(null)
  const repostCounterButtonRef = useRef<HTMLButtonElement>(null)
  const popupClosedAtRef = useRef<number>(0)

  // State for parent post context in newspaper view
  const [newspaperParentPost, setNewspaperParentPost] = useState<AppBskyFeedDefs.PostView | null>(null)

  // Format the counter display based on postNumber value
  // - null: show "#" only (pending, number not yet assigned)
  // - 0: show "#0" (dropped post)
  // - positive: show "#{number}" (shown post)
  const formatCounterDisplay = (num: number | null): string => {
    if (num === null) return '#'
    return `#${num}`
  }

  // Handle repost wrapper
  const repostedBy = post.reason?.$type === 'app.bsky.feed.defs#reasonRepost'
    ? (post.reason as any).by
    : null
  
  // Get the correct timestamp: for reposts, use feedReceivedTime if available
  // For original posts, use createdAt (when created)
  // Note: feedReceivedTime is not available in PostCard, so we'll use the function's fallback
  const postedAt = getFeedViewPostTimestamp(post)
  const isReposted = isRepost(post)
  const timeAgo = formatDistance(postedAt, clientDate(), { addSuffix: true })
  
  // Extract curation metadata (must be defined before useEffect that uses it)
  const actualPost = post.post
  const curation = 'curation' in post ? (post as CurationFeedViewPost).curation : undefined
  const isViewedOld = showViewedStatus && !!(curation?.viewedAt && (clientNow() - curation.viewedAt > 15 * 60 * 1000))
  const isAlwaysShow = curation?.curation_status === 'priority_always_show' || curation?.curation_status === 'regular_always_show'

  // Get post number if counter should be shown
  useEffect(() => {
    if (showCounter) {
      const checkSettings = async () => {
        try {
          const settings = await getSettings()
          // Track showAllPosts and curationSuspended for styling (grayed out posts)
          setShowAllPosts(settings?.showAllPosts || false)
          setCurationSuspended(settings?.curationSuspended || false)
          setHighlightStatusPrefix(settings?.highlightStatusPrefix || '')
          setShowViewedStatus(settings?.showViewedStatus !== false)
          // Load click to Bluesky setting from localStorage
          setClickToBlueSky(localStorage.getItem('websky_click_to_bluesky') === 'true')
          setSettingsTimezone(settings?.timezone || getBrowserTimezone())
          // Get page length for page boundary indicator
          setFeedPageLength(settings?.feedPageLength || 25)
          // Show counter unless curation is suspended
          // The counter (#number) should always show when curation is enabled
          // The time (hh:mm) display is controlled separately by showTime setting
          if (settings && !settings.curationSuspended) {
            // Check if this post has been curated (has curation data in summaries cache)
            // Posts without curation data (empty curation object) won't have counter numbers
            const hasCurationData = curation && Object.keys(curation).length > 0

            // Get curation number: prefer passed value from curation prop, fall back to IndexedDB lookup
            // Returns: null (unassigned), 0 (dropped), or positive integer (shown)
            let curationNum: number | null = null
            if (curation?.curationNumber !== undefined) {
              // Use value passed via curation prop (avoids IndexedDB lookup)
              curationNum = curation.curationNumber
            } else {
              // Fall back to IndexedDB lookup for posts without passed numbers
              const postUri = getPostUniqueId(post)
              curationNum = await getCurationNumber(postUri)
            }

            // Show counter if we have curation data OR a valid curation number
            // curationNum can be null (pending), 0 (dropped), or positive (shown)
            if (hasCurationData || curationNum !== null) {
              setPostNumber(curationNum)  // Can be null, 0, or positive
              // Use debugMode setting for Debug Info section
              setDebugMode(settings.debugMode || false)
              // Use showTime setting for timestamp display
              setShowTime(settings.showTime || false)
              setShowCounterDisplay(true)
            } else {
              setShowCounterDisplay(false)
            }
          } else {
            setShowCounterDisplay(false)
            // Debug: log why counter is not showing (only in development)
            // Removed to avoid TypeScript errors - can be re-enabled if needed
          }
        } catch (error) {
          log.error('PostCard', 'Error loading settings for post counter:', error)
          setShowCounterDisplay(false)
        }
      }
      checkSettings()
    } else {
      setShowCounterDisplay(false)
    }
  }, [showCounter, post.post.uri, postedAt, isReposted, repostedBy, curation])

  // Track when popup closes to prevent ghost clicks on Android
  useEffect(() => {
    if (!showPopup) {
      popupClosedAtRef.current = Date.now()
    }
  }, [showPopup])

  // Close popup when clicking/touching outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        setShowPopup(false)
      }
    }

    if (showPopup) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('touchstart', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('touchstart', handleClickOutside)
      }
    }
  }, [showPopup])

  const handleCounterClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    // Always allow clicking, but only show popup if curation exists
    if (curation) {
      const wasOpen = showPopup
      if (!wasOpen) {
        // Calculate position before showing popup
        const button = e.currentTarget as HTMLButtonElement
        if (button) {
          const buttonRect = button.getBoundingClientRect()
          const popupHeight = 400 // Approximate popup height in pixels (accounts for debug section)
          const spaceBelow = window.innerHeight - buttonRect.bottom
          const spaceAbove = buttonRect.top

          // Store the anchor rect for fixed positioning
          setPopupAnchorRect(buttonRect)

          // Position above if not enough space below but enough space above
          if (spaceBelow < popupHeight && spaceAbove > spaceBelow) {
            setPopupPosition('above')
          } else {
            setPopupPosition('below')
          }
        }

        // Fetch popup data when opening
        try {
          // Get raw post number: prefer passed value from curation prop, fall back to IndexedDB lookup
          if (curation?.postNumber !== undefined) {
            setRawPostNumber(curation.postNumber)
          } else {
            const postUri = getPostUniqueId(post)
            const rawNum = await getPostNumberFromSummary(postUri)
            setRawPostNumber(rawNum)
          }

          // Get user filter data for probabilities
          const filterResult = await getFilter()
          if (filterResult) {
            const [globalStats, userFilterData] = filterResult
            const entry = userFilterData[ampUsername]
            setUserEntry(entry || null)
            setSkylimitNumber(globalStats.skylimit_number)
          }

          // Get follow info for followed_at, topics, timezone
          const follow = await getFollow(ampUsername)
          setFollowInfo(follow)
        } catch (error) {
          log.error('PostCard', 'Error fetching popup data:', error)
        }
      }
      setShowPopup(!wasOpen)
    }
  }


  // Get the username to use for amp operations (reposter for reposts, author for originals)
  // For periodic editions, use original author (not the synthetic editor)
  const isEditionPost = isPeriodicEdition(curation)
  const ampUsername = isEditionPost ? author.handle : (isReposted && repostedBy?.handle ? repostedBy.handle : author.handle)
  // Get the display info for the popup (reposter for reposts, author for originals)
  const popupAuthor = isEditionPost ? author : (isReposted && repostedBy ? repostedBy : author)

  const refreshAfterAmpChange = async () => {
    // Refresh followInfo and userEntry to reflect updated amp_factor and probabilities
    const follow = await getFollow(ampUsername)
    setFollowInfo(follow)
    const filterResult = await getFilter()
    if (filterResult) {
      const [globalStats, userFilterData] = filterResult
      setUserEntry(userFilterData[ampUsername] || null)
      setSkylimitNumber(globalStats.skylimit_number)
    }
    if (onAmpChange) {
      onAmpChange()
    }
  }

  const handleAmpUp = async () => {
    try {
      setLoading(true)
      await ampUp(ampUsername, myUsername)
      await refreshAfterAmpChange()
    } catch (error) {
      log.error('PostCard', 'Failed to amp up:', error)
      alert('Failed to update amplification factor')
    } finally {
      setLoading(false)
    }
  }

  const handleAmpDown = async () => {
    try {
      setLoading(true)
      await ampDown(ampUsername, myUsername)
      await refreshAfterAmpChange()
    } catch (error) {
      log.error('PostCard', 'Failed to amp down:', error)
      alert('Failed to update amplification factor')
    } finally {
      setLoading(false)
    }
  }

  // Check if this is a reply
  const isReply = record?.reply !== undefined
  const parentUri = record?.reply?.parent?.uri
  const rootUri = record?.reply?.root?.uri
  // A direct reply is when the parent is the root (depth 1)
  const isDirectReply = parentUri === rootUri

  // Fetch parent post for newspaper view reply context
  useEffect(() => {
    if (!newspaperView || !isReply || !parentUri || !agent) return

    const fetchParent = async () => {
      try {
        const childPostId = getPostUniqueId(post)
        const cached = await getCachedParentPost(childPostId)
        if (cached) {
          setNewspaperParentPost(cached)
          return
        }
        const threadData = await getPostThread(agent, parentUri, 0)
        if (threadData.thread && 'post' in threadData.thread) {
          const threadPost = threadData.thread as AppBskyFeedDefs.ThreadViewPost
          await saveCachedParentPost(childPostId, threadPost.post)
          setNewspaperParentPost(threadPost.post)
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (!msg.includes('Post not found')) {
          log.warn('PostCard', 'Failed to fetch parent post for newspaper view:', error)
        }
      }
    }

    fetchParent()
  }, [newspaperView, isReply, parentUri, agent, post])

  const handlePostClick = (e: React.MouseEvent) => {
    // Ignore ghost clicks from popup dismiss on Android (tap-through prevention)
    if (Date.now() - popupClosedAtRef.current < 400) return
    if (e.target === e.currentTarget || (e.target as HTMLElement).closest('button') === null) {
      if (actualPost.uri) {
        // Track click engagement
        const uniqueId = getPostUniqueId(post)
        updatePostSummaryEngagement(uniqueId, ENGAGEMENT_CLICKED, myUsername)

        if (clickToBlueSky) {
          // Open in Bluesky client (same tab)
          window.location.href = getPostUrl(actualPost.uri, author.handle)
        } else {
          // Navigate within Websky
          const encodedUri = encodeURIComponent(actualPost.uri)
          navigate(`/post/${encodedUri}`)
        }
      }
    }
  }

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (clickToBlueSky) {
      window.location.href = getProfileUrl(author.handle)
    } else {
      navigate(`/profile/${author.handle}`)
    }
  }

  const handleReposterClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (repostedBy?.handle) {
      if (clickToBlueSky) {
        window.location.href = getProfileUrl(repostedBy.handle)
      } else {
        navigate(`/profile/${repostedBy.handle}`)
      }
    }
  }

  // Page boundary: non-zero counter where counter % pageLength === 1
  const isPageBoundary = showCounterDisplay && postNumber !== null && postNumber > 0 && postNumber % feedPageLength === 1
  const isHighlighted = !!(highlightStatusPrefix && curation?.curation_status?.startsWith(highlightStatusPrefix))

  return (
    <article
      className={`${isPageBoundary ? 'border-b-4 border-blue-500 dark:border-blue-400' : 'border-b border-gray-200 dark:border-gray-700'} hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors`}
      style={{
        ...(isHighlighted ? { boxShadow: 'inset 0 0 0 2px #ef4444' } : {}),
        ...(isViewedOld ? {
          background: theme === 'dark'
            ? 'linear-gradient(to bottom, rgba(120,113,108,0.15) 0%, transparent 6%, transparent 94%, rgba(120,113,108,0.15) 100%), linear-gradient(to right, rgba(120,113,108,0.15) 0%, transparent 48px, transparent calc(100% - 48px), rgba(120,113,108,0.15) 100%)'
            : 'linear-gradient(to bottom, rgba(168,162,158,0.18) 0%, transparent 6%, transparent 94%, rgba(168,162,158,0.18) 100%), linear-gradient(to right, rgba(168,162,158,0.18) 0%, transparent 48px, transparent calc(100% - 48px), rgba(168,162,158,0.18) 100%)'
        } : {}),
      }}
    >
      {repostedBy && !isPeriodicEdition(curation) && (
        <div className={`px-4 pt-4 pb-2 text-[0.9375rem] text-gray-500 dark:text-gray-400 flex items-center justify-between relative ${'curation' in post && showAllPosts && !curationSuspended && isStatusDrop((post as CurationFeedViewPost).curation?.curation_status) ? 'opacity-50' : ''}`}>
          <span
            onClick={handleReposterClick}
            className="hover:underline cursor-pointer"
          >
            <svg className="inline-block mr-1 -mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 1l4 4-4 4" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <path d="M7 23l-4-4 4-4" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            Reposted by {repostedBy.displayName || repostedBy.handle}
          </span>
          {showCounterDisplay && curation && (
            <>
              <span className="flex items-center gap-1">
                {/* Time display - controlled by showTime setting */}
                {showTime && (
                  <span className="text-gray-500 dark:text-gray-400">
                    {getTimeInTimezone(postedAt, settingsTimezone)}{settingsTimezone && timezonesAreDifferent(settingsTimezone, getBrowserTimezone()) ? ` ${getTimezoneAbbreviation(settingsTimezone)}` : ''}
                  </span>
                )}
                {/* Counter number - clickable with color based on curation status */}
                <button
                  ref={repostCounterButtonRef}
                  onClick={handleCounterClick}
                  className={curation
                    ? (isAlwaysShow
                        ? 'text-green-600 dark:text-green-500 hover:text-green-700 dark:hover:text-green-400 cursor-pointer'
                        : 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer')
                    : 'text-gray-500 dark:text-gray-400 cursor-default'
                  }
                  title={curation ? 'Click for Skylimit curation options' : 'Post number'}
                  disabled={!curation}
                >
                  {formatCounterDisplay(isStatusDrop(curation?.curation_status) ? 0 : postNumber)}
                </button>
                <span className="w-3 inline-block text-center text-gray-500 dark:text-gray-400 text-xs">{isViewedOld ? '✔' : ''}</span>
              </span>
              {showPopup && curation && (
                <CurationPopup
                  ref={popupRef}
                  displayName={popupAuthor.displayName || ''}
                  handle={popupAuthor.handle}
                  popupPosition={popupPosition}
                  anchorRect={popupAnchorRect || undefined}
                  likeCount={post.post.likeCount}
                  postProperties={{ rawPostNumber, viewedAt: curation?.viewedAt }}
                  postingPerDay={userEntry ? countTotalPostsForUser(userEntry) : undefined}
                  allowedPerDay={skylimitNumber !== undefined && userEntry ? skylimitNumber * (userEntry.amp_factor || 1) : undefined}
                  originalsPerDay={userEntry?.original_daily}
                  priorityPerDay={userEntry?.priority_daily}
                  repostsPerDay={userEntry?.reposts_daily}
                  followedRepliesPerDay={userEntry?.followed_reply_daily}
                  unfollowedRepliesPerDay={userEntry?.unfollowed_reply_daily}
                  editedPerDay={userEntry?.edited_daily}
                  regularProb={userEntry?.regular_prob}
                  priorityProb={userEntry?.priority_prob}
                  curationMsg={curation.curation_msg}
                  isDropped={isStatusDrop(curation.curation_status)}
                  skylimitNumber={skylimitNumber}
                  showAmpButtons={true}
                  ampFactor={followInfo?.amp_factor ?? userEntry?.amp_factor}
                  onAmpUp={handleAmpUp}
                  onAmpDown={handleAmpDown}
                  ampLoading={loading}
                  debugMode={debugMode}
                  curationStatus={curation.curation_status}
                  matchingPattern={curation.matching_pattern}
                  followedAt={followInfo?.followed_at}
                  priorityPatterns={followInfo?.priorityPatterns || userEntry?.priorityPatterns}
                  timezone={followInfo?.timezone}
                  onNavigateToSettings={() => {
                    setShowPopup(false)
                    navigate('/settings?tab=editions')
                  }}
                  onClose={() => setShowPopup(false)}
                />
              )}
            </>
          )}
        </div>
      )}
      
      {/* Counter for periodic edition posts (repost header hidden, counter shown at top right) */}
      {isEditionPost && !newspaperView && showCounterDisplay && curation && (
        <div className="px-4 pt-2 flex justify-end items-center gap-1 relative">
          <button
            ref={repostCounterButtonRef}
            onClick={handleCounterClick}
            className={isAlwaysShow
              ? 'text-green-600 dark:text-green-500 hover:text-green-700 dark:hover:text-green-400 cursor-pointer'
              : 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer'}
            title="Click for edition curation info"
          >
            {formatCounterDisplay(postNumber)}
          </button>
          <span className="w-3 inline-block text-center text-gray-500 dark:text-gray-400 text-xs">{isViewedOld ? '✔' : ''}</span>
          {showPopup && (
            <CurationPopup
              ref={popupRef}
              displayName={popupAuthor.displayName || ''}
              handle={popupAuthor.handle}
              popupPosition={popupPosition}
              anchorRect={popupAnchorRect || undefined}
              likeCount={post.post.likeCount}
              editionMode={true}
              postTimestamp={postedAt.getTime()}
              postProperties={{ rawPostNumber: null, viewedAt: curation?.viewedAt }}
              editedPerDay={userEntry?.edited_daily}
              matchingPattern={curation.matching_pattern}
              showAmpButtons={false}
              onAmpUp={() => {}}
              onAmpDown={() => {}}
              ampLoading={false}
              debugMode={debugMode}
              followedAt={followInfo?.followed_at}
              timezone={followInfo?.timezone}
              onNavigateToSettings={() => {
                setShowPopup(false)
                navigate('/settings?tab=editions')
              }}
              onClose={() => setShowPopup(false)}
            />
          )}
        </div>
      )}

      {/* Newspaper view layout for edition posts */}
      {newspaperView && isEditionPost ? (
        <div
          className="flex p-4 pr-2 min-h-[160px]"
          onClick={handlePostClick}
          style={{ cursor: 'pointer' }}
        >
          {/* Left: main content area */}
          <div className="flex-1 min-w-0">
            {/* Header: display name + post number (no avatar in newspaper view) */}
            <div className="flex items-center gap-2 mb-2">
              <span
                onClick={handleAuthorClick}
                className={`font-semibold hover:underline cursor-pointer truncate ${editionFont === 'sans-serif' ? 'font-newspaper-sans' : 'font-serif'}`}
              >
                {author.displayName || author.handle}
              </span>
              {/* Post number at right end of header */}
              {showCounterDisplay && curation && (
                <span className="ml-auto flex items-center gap-1 flex-shrink-0">
                  <button
                    ref={repostCounterButtonRef}
                    onClick={handleCounterClick}
                    className={isAlwaysShow
                      ? 'text-green-600 dark:text-green-500 hover:text-green-700 dark:hover:text-green-400 cursor-pointer'
                      : 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer'}
                    title="Click for edition curation info"
                  >
                    {formatCounterDisplay(postNumber)}
                  </button>
                  <span className="w-3 inline-block text-center text-gray-500 dark:text-gray-400 text-xs">{isViewedOld ? '✔' : ''}</span>
                </span>
              )}
            </div>

            {/* Parent post context for replies in newspaper view */}
            {newspaperParentPost && (() => {
              const parentRecord = newspaperParentPost.record as any
              return (
                <div className="mb-2 pl-3 opacity-60 border-l-2 border-gray-300 dark:border-gray-600">
                  <span className={`font-semibold italic ${editionFont === 'sans-serif' ? 'font-newspaper-sans' : 'font-serif'}`}>
                    {newspaperParentPost.author.displayName || newspaperParentPost.author.handle}
                  </span>
                  {parentRecord?.text && (
                    <div
                      className={`italic whitespace-pre-wrap break-words ${editionFont === 'sans-serif' ? 'font-newspaper-sans' : 'font-serif'}`}
                      style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}
                    >
                      <RichText text={parentRecord.text} facets={parentRecord.facets} />
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Post body with edition font */}
            {record?.text && (
              <div
                className={`mb-2 whitespace-pre-wrap break-words ${editionFont === 'sans-serif' ? 'font-newspaper-sans' : 'font-serif'}`}
                style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}
              >
                <RichText text={record.text} facets={record.facets} />
              </div>
            )}

            {embed && (
              <div className="mb-2">
                <PostMedia embed={embed as any} newspaperView={true} editionFont={editionFont} />
              </div>
            )}
          </div>

          {/* Right: vertical actions column */}
          <div className="flex-shrink-0 pl-2 ml-2 border-l border-gray-200 dark:border-gray-700">
            <PostActions
              post={actualPost}
              author={actualPost.author}
              isOwnPost={actualPost.author?.did === session?.did}
              onReply={onReply}
              onRepost={onRepost}
              onQuotePost={onQuotePost}
              onLike={onLike}
              onBookmark={onBookmark}
              onDeletePost={onDeletePost}
              onPinPost={onPinPost}
              verticalLayout={true}
            />
          </div>

          {/* Curation popup for newspaper view */}
          {showPopup && curation && (
            <CurationPopup
              ref={popupRef}
              displayName={popupAuthor.displayName || ''}
              handle={popupAuthor.handle}
              popupPosition={popupPosition}
              anchorRect={popupAnchorRect || undefined}
              likeCount={post.post.likeCount}
              editionMode={true}
              postTimestamp={postedAt.getTime()}
              postProperties={{ rawPostNumber: null, viewedAt: curation?.viewedAt }}
              editedPerDay={userEntry?.edited_daily}
              matchingPattern={curation.matching_pattern}
              showAmpButtons={false}
              onAmpUp={() => {}}
              onAmpDown={() => {}}
              ampLoading={false}
              debugMode={debugMode}
              followedAt={followInfo?.followed_at}
              timezone={followInfo?.timezone}
              onNavigateToSettings={() => {
                setShowPopup(false)
                navigate('/settings?tab=editions')
              }}
              onClose={() => setShowPopup(false)}
            />
          )}
        </div>
      ) : (
      <>
      {/* Show root post if this is a reply (but not in thread views where context is already shown, and not for dropped posts) */}
      {isReply && rootUri && showRootPost && !isStatusDrop(curation?.curation_status) && (
        <RootPost rootUri={rootUri} isDirectReply={isDirectReply} />
      )}

      <div
        className={`${stackedLayout ? 'flex flex-col' : 'flex gap-3'} ${isReply ? 'px-4 pb-4 pt-0' : 'p-4'} relative ${'curation' in post && showAllPosts && !curationSuspended && isStatusDrop((post as CurationFeedViewPost).curation?.curation_status) ? 'opacity-50' : ''}`}
        onClick={handlePostClick}
        style={{ cursor: 'pointer' }}
      >
        {/* Counter for regular posts (not replies, not reposts) - show at top right */}
        {showCounterDisplay && !isReposted && !isReply && !isEditionPost && (
          <>
            <div className="absolute top-4 right-4 z-10 flex items-center gap-1">
              {/* Time display - controlled by showTime setting */}
              {showTime && (
                <span className="text-gray-500 dark:text-gray-400">
                  {getTimeInTimezone(postedAt, settingsTimezone)}{settingsTimezone && timezonesAreDifferent(settingsTimezone, getBrowserTimezone()) ? ` ${getTimezoneAbbreviation(settingsTimezone)}` : ''}
                </span>
              )}
              {/* Counter number - clickable with color based on curation status */}
              <button
                ref={counterButtonRef}
                onClick={handleCounterClick}
                className={curation
                  ? (isAlwaysShow
                      ? 'text-green-600 dark:text-green-500 hover:text-green-700 dark:hover:text-green-400 cursor-pointer'
                      : 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer')
                  : 'text-gray-500 dark:text-gray-400 cursor-default'
                }
                title={curation ? 'Click for Skylimit curation options' : 'Post number'}
                disabled={!curation}
              >
                {formatCounterDisplay(isStatusDrop(curation?.curation_status) ? 0 : postNumber)}
              </button>
              <span className="w-3 inline-block text-center text-gray-500 dark:text-gray-400 text-xs">{isViewedOld ? '✔' : ''}</span>
            </div>

            {showPopup && curation && (
              <CurationPopup
                ref={popupRef}
                displayName={popupAuthor.displayName || ''}
                handle={popupAuthor.handle}
                popupPosition={popupPosition}
                anchorRect={popupAnchorRect || undefined}
                likeCount={post.post.likeCount}
                postProperties={{ rawPostNumber, viewedAt: curation?.viewedAt }}
                postingPerDay={userEntry ? countTotalPostsForUser(userEntry) : undefined}
                allowedPerDay={skylimitNumber !== undefined && userEntry ? skylimitNumber * (userEntry.amp_factor || 1) : undefined}
                originalsPerDay={userEntry?.original_daily}
                priorityPerDay={userEntry?.priority_daily}
                repostsPerDay={userEntry?.reposts_daily}
                followedRepliesPerDay={userEntry?.followed_reply_daily}
                unfollowedRepliesPerDay={userEntry?.unfollowed_reply_daily}
                editedPerDay={userEntry?.edited_daily}
                regularProb={userEntry?.regular_prob}
                priorityProb={userEntry?.priority_prob}
                curationMsg={curation.curation_msg}
                isDropped={isStatusDrop(curation.curation_status)}
                skylimitNumber={skylimitNumber}
                showAmpButtons={true}
                ampFactor={followInfo?.amp_factor ?? userEntry?.amp_factor}
                onAmpUp={handleAmpUp}
                onAmpDown={handleAmpDown}
                ampLoading={loading}
                debugMode={debugMode}
                curationStatus={curation.curation_status}
                matchingPattern={curation.matching_pattern}
                followedAt={followInfo?.followed_at}
                priorityPatterns={followInfo?.priorityPatterns || userEntry?.priorityPatterns}
                timezone={followInfo?.timezone}
                onNavigateToSettings={() => {
                  setShowPopup(false)
                  navigate('/settings?tab=editions')
                }}
                onClose={() => setShowPopup(false)}
              />
            )}
          </>
        )}
        {/* Header row: avatar + author info. In stacked layout, this is a flex row within the vertical column */}
        {stackedLayout ? (
          <div className="flex gap-3 items-center mb-2">
            {!hideAvatar && (
              <div className="flex-shrink-0" onClick={handleAuthorClick} style={{ cursor: 'pointer' }}>
                <Avatar
                  src={author.avatar}
                  alt={author.displayName || author.handle}
                  size="md"
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className={`flex items-center gap-2 relative min-w-0${showCounterDisplay && !isReposted && !isReply ? ' pr-28' : ''}`}>
                <span className="truncate min-w-0">
                  <span
                    onClick={handleAuthorClick}
                    className="font-semibold hover:underline cursor-pointer"
                  >
                    {author.displayName || author.handle}
                  </span>
                  <span
                    onClick={handleAuthorClick}
                    className="text-gray-500 dark:text-gray-400 hover:underline cursor-pointer hidden sm:inline ml-2"
                  >
                    @{author.handle}
                  </span>
                </span>
                {(!showTime || isReposted) && (
                  <>
                    <span className="text-gray-500 dark:text-gray-400 flex-shrink-0">·</span>
                    <span className="text-gray-500 dark:text-gray-400 text-sm flex-shrink-0">{timeAgo}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {!hideAvatar && (
              <div className="flex-shrink-0" onClick={handleAuthorClick} style={{ cursor: 'pointer' }}>
                <Avatar
                  src={author.avatar}
                  alt={author.displayName || author.handle}
                  size="md"
                />
              </div>
            )}
          </>
        )}
        <div className={stackedLayout ? '' : 'flex-1 min-w-0'}>
          {/* Header line - only in non-stacked layout (stacked layout renders it above) */}
          {!stackedLayout && (
          <div className={`flex items-center gap-2 mb-1 relative min-w-0${showCounterDisplay && !isReposted && !isReply ? ' pr-28' : ''}`}>
            <span className="truncate min-w-0">
              <span
                onClick={handleAuthorClick}
                className="font-semibold hover:underline cursor-pointer"
              >
                {author.displayName || author.handle}
              </span>
              <span
                onClick={handleAuthorClick}
                className="text-gray-500 dark:text-gray-400 hover:underline cursor-pointer hidden sm:inline ml-2"
              >
                @{author.handle}
              </span>
            </span>
            {(!showTime || isReposted) && (
              <>
                <span className="text-gray-500 dark:text-gray-400 flex-shrink-0">·</span>
                <span className="text-gray-500 dark:text-gray-400 text-sm flex-shrink-0">{timeAgo}</span>
              </>
            )}
            {/* Counter for replies - show on same line as author name */}
            {isReply && showCounterDisplay && !isReposted && !isEditionPost && (
              <>
                <span className="ml-auto flex items-center gap-1">
                  {/* Time display - controlled by showTime setting */}
                  {showTime && (
                    <span className="text-gray-500 dark:text-gray-400">
                      {getTimeInTimezone(postedAt, settingsTimezone)}{settingsTimezone && timezonesAreDifferent(settingsTimezone, getBrowserTimezone()) ? ` ${getTimezoneAbbreviation(settingsTimezone)}` : ''}
                    </span>
                  )}
                  {/* Counter number - clickable with blue color */}
                  <button
                    ref={counterButtonRef}
                    onClick={handleCounterClick}
                    className={curation
                      ? 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer'
                      : 'text-gray-500 dark:text-gray-400 cursor-default'
                    }
                    title={curation ? 'Click for Skylimit curation options' : 'Post number'}
                    disabled={!curation}
                  >
                    {formatCounterDisplay(isStatusDrop(curation?.curation_status) ? 0 : postNumber)}
                  </button>
                  <span className="w-3 inline-block text-center text-gray-500 dark:text-gray-400 text-xs">{isViewedOld ? '✔' : ''}</span>
                </span>
                {showPopup && curation && (
                  <CurationPopup
                    ref={popupRef}
                    displayName={popupAuthor.displayName || ''}
                    handle={popupAuthor.handle}
                    popupPosition={popupPosition}
                    anchorRect={popupAnchorRect || undefined}
                    likeCount={post.post.likeCount}
                    postProperties={{ rawPostNumber, viewedAt: curation?.viewedAt }}
                    postingPerDay={userEntry ? countTotalPostsForUser(userEntry) : undefined}
                    allowedPerDay={skylimitNumber !== undefined && userEntry ? skylimitNumber * (userEntry.amp_factor || 1) : undefined}
                    originalsPerDay={userEntry?.original_daily}
                    priorityPerDay={userEntry?.priority_daily}
                    repostsPerDay={userEntry?.reposts_daily}
                    followedRepliesPerDay={userEntry?.followed_reply_daily}
                    unfollowedRepliesPerDay={userEntry?.unfollowed_reply_daily}
                    editedPerDay={userEntry?.edited_daily}
                    regularProb={userEntry?.regular_prob}
                    priorityProb={userEntry?.priority_prob}
                    curationMsg={curation.curation_msg}
                    isDropped={isStatusDrop(curation.curation_status)}
                    skylimitNumber={skylimitNumber}
                    showAmpButtons={true}
                    ampFactor={followInfo?.amp_factor ?? userEntry?.amp_factor}
                    onAmpUp={handleAmpUp}
                    onAmpDown={handleAmpDown}
                    ampLoading={loading}
                    debugMode={debugMode}
                    curationStatus={curation.curation_status}
                    matchingPattern={curation.matching_pattern}
                    followedAt={followInfo?.followed_at}
                    priorityPatterns={followInfo?.priorityPatterns || userEntry?.priorityPatterns}
                    timezone={followInfo?.timezone}
                    onNavigateToSettings={() => {
                      setShowPopup(false)
                      navigate('/settings?tab=editions')
                    }}
                    onClose={() => setShowPopup(false)}
                  />
                )}
              </>
            )}
          </div>
          )}

          {record?.text && (
            <div className={`mb-2 whitespace-pre-wrap break-words ${isEditionPost && editionFont ? (editionFont === 'sans-serif' ? 'font-newspaper-sans' : 'font-serif') : ''}`} style={{ fontSize: 'var(--post-text-size)', lineHeight: 'var(--post-text-leading)' }}>
              <RichText text={record.text} facets={record.facets} />
            </div>
          )}

          {embed && (
            <div className="mb-2">
              <PostMedia embed={embed as any} />
            </div>
          )}

          {/* Engagement stats slot (for thread view anchor posts) */}
          {engagementStats}

          <PostActions
            post={actualPost}
            author={actualPost.author}
            isOwnPost={actualPost.author?.did === session?.did}
            onReply={onReply}
            onRepost={onRepost}
            onQuotePost={onQuotePost}
            onLike={onLike}
            onBookmark={onBookmark}
            onDeletePost={onDeletePost}
            onPinPost={onPinPost}
          />
        </div>
      </div>
      </>
      )}
    </article>
  )
}

