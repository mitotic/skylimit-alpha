import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import { formatDistanceToNow } from 'date-fns'
import { useEffect, useState, useRef } from 'react'
import Avatar from './Avatar'
import PostActions from './PostActions'
import PostMedia from './PostMedia'
import RootPost from './RootPost'
import { getCurationNumber, getPostNumberFromSummary } from '../curation/skylimitCounter'
import { getSettings } from '../curation/skylimitStore'
import { getFeedViewPostTimestamp, isRepost, getBlueSkyPostUrl, getBlueSkyProfileUrl, getPostUniqueId } from '../curation/skylimitGeneral'
import { CurationFeedViewPost, isStatusDrop, UserEntry, FollowInfo } from '../curation/types'
import { ampUp, ampDown } from '../curation/skylimitFollows'
import { getFilter, getFollow } from '../curation/skylimitCache'
import { countTotalPostsForUser } from '../curation/skylimitStats'
import CurationPopup from './CurationPopup'

interface PostCardProps {
  post: AppBskyFeedDefs.FeedViewPost | CurationFeedViewPost
  onReply?: (uri: string) => void
  onRepost?: (uri: string, cid: string) => void
  onQuotePost?: (post: AppBskyFeedDefs.PostView) => void
  onLike?: (uri: string, cid: string) => void
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
}

export default function PostCard({ post, onReply, onRepost, onQuotePost, onLike, showCounter = false, onAmpChange, showRootPost = true, engagementStats }: PostCardProps) {
  const navigate = useNavigate()
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
  const [curationDisabled, setCurationDisabled] = useState(false)
  const [feedPageLength, setFeedPageLength] = useState<number>(25)
  const [clickToBlueSky, setClickToBlueSky] = useState(false)
  // Popup data for curation info
  const [rawPostNumber, setRawPostNumber] = useState<number | null>(null)
  const [userEntry, setUserEntry] = useState<UserEntry | null>(null)
  const [followInfo, setFollowInfo] = useState<FollowInfo | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const counterButtonRef = useRef<HTMLButtonElement>(null)
  const repostCounterButtonRef = useRef<HTMLButtonElement>(null)

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
  const timeAgo = formatDistanceToNow(postedAt, { addSuffix: true })
  
  // Extract curation metadata (must be defined before useEffect that uses it)
  const actualPost = post.post
  const curation = 'curation' in post ? (post as CurationFeedViewPost).curation : undefined

  // Get post number if counter should be shown
  useEffect(() => {
    if (showCounter) {
      const checkSettings = async () => {
        try {
          const settings = await getSettings()
          // Track curation disabled state for styling
          setCurationDisabled(settings?.disabled || false)
          // Load click to Bluesky setting from localStorage
          setClickToBlueSky(localStorage.getItem('websky_click_to_bluesky') === 'true')
          // Get page length for page boundary indicator
          setFeedPageLength(settings?.feedPageLength || 25)
          // Show counter unless curation is disabled
          // The counter (#number) should always show when curation is enabled
          // The time (hh:mm) display is controlled separately by showTime setting
          if (settings && !settings.disabled) {
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
          console.error('Error loading settings for post counter:', error)
          setShowCounterDisplay(false)
        }
      }
      checkSettings()
    } else {
      setShowCounterDisplay(false)
    }
  }, [showCounter, post.post.uri, postedAt, isReposted, repostedBy, curation])

  // Close popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        setShowPopup(false)
      }
    }

    if (showPopup) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
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
          const popupHeight = 300 // Approximate popup height in pixels (increased for new content)
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
            const [, userFilterData] = filterResult
            const entry = userFilterData[ampUsername]
            setUserEntry(entry || null)
          }

          // Get follow info for followed_at, topics, timezone
          const follow = await getFollow(ampUsername)
          setFollowInfo(follow)
        } catch (error) {
          console.error('Error fetching popup data:', error)
        }
      }
      setShowPopup(!wasOpen)
    }
  }


  // Get the username to use for amp operations (reposter for reposts, author for originals)
  const ampUsername = isReposted && repostedBy?.handle ? repostedBy.handle : author.handle
  // Get the display info for the popup (reposter for reposts, author for originals)
  const popupAuthor = isReposted && repostedBy ? repostedBy : author

  const handleAmpUp = async () => {
    try {
      setLoading(true)
      await ampUp(ampUsername)
      setShowPopup(false)
      if (onAmpChange) {
        onAmpChange()
      }
    } catch (error) {
      console.error('Failed to amp up:', error)
      alert('Failed to update amplification factor')
    } finally {
      setLoading(false)
    }
  }

  const handleAmpDown = async () => {
    try {
      setLoading(true)
      await ampDown(ampUsername)
      setShowPopup(false)
      if (onAmpChange) {
        onAmpChange()
      }
    } catch (error) {
      console.error('Failed to amp down:', error)
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

  const handlePostClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).closest('button') === null) {
      if (actualPost.uri) {
        if (clickToBlueSky) {
          // Open in Bluesky client (same tab)
          window.location.href = getBlueSkyPostUrl(actualPost.uri, author.handle)
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
      window.location.href = getBlueSkyProfileUrl(author.handle)
    } else {
      navigate(`/profile/${author.handle}`)
    }
  }

  const handleReposterClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (repostedBy?.handle) {
      if (clickToBlueSky) {
        window.location.href = getBlueSkyProfileUrl(repostedBy.handle)
      } else {
        navigate(`/profile/${repostedBy.handle}`)
      }
    }
  }

  // Page boundary: non-zero counter where counter % pageLength === 1
  const isPageBoundary = showCounterDisplay && postNumber !== null && postNumber > 0 && postNumber % feedPageLength === 1

  return (
    <article
      className={`${isPageBoundary ? 'border-b-4 border-blue-500 dark:border-blue-400' : 'border-b border-gray-200 dark:border-gray-700'} hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors`}
    >
      {repostedBy && (
        <div className={`px-4 pt-4 pb-2 text-sm text-gray-500 dark:text-gray-400 flex items-center justify-between relative ${'curation' in post && !curationDisabled && isStatusDrop((post as CurationFeedViewPost).curation?.curation_status) ? 'opacity-50' : ''}`}>
          <span
            onClick={handleReposterClick}
            className="hover:underline cursor-pointer"
          >
            🔄 Reposted by {repostedBy.displayName || repostedBy.handle}
          </span>
          {showCounterDisplay && curation && (
            <>
              <span className="flex items-center gap-1">
                {/* Time display - controlled by showTime setting */}
                {showTime && (
                  <span className="text-gray-500 dark:text-gray-400">
                    {String(postedAt.getHours()).padStart(2, '0')}:{String(postedAt.getMinutes()).padStart(2, '0')}
                  </span>
                )}
                {/* Counter number - clickable with blue color */}
                <button
                  ref={repostCounterButtonRef}
                  onClick={handleCounterClick}
                  className={curation
                    ? 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer underline'
                    : 'text-gray-500 dark:text-gray-400 cursor-default'
                  }
                  title={curation ? 'Click for Skylimit curation options' : 'Post number'}
                  disabled={!curation}
                >
                  {formatCounterDisplay(isStatusDrop(curation?.curation_status) ? 0 : postNumber)}
                </button>
              </span>
              {showPopup && curation && (
                <CurationPopup
                  ref={popupRef}
                  displayName={popupAuthor.displayName || ''}
                  handle={popupAuthor.handle}
                  popupPosition={popupPosition}
                  anchorRect={popupAnchorRect || undefined}
                  rawPostNumber={rawPostNumber}
                  postingPerDay={userEntry ? countTotalPostsForUser(userEntry) : undefined}
                  repostingPerDay={userEntry?.repost_daily}
                  regularProb={userEntry?.regular_prob}
                  priorityProb={userEntry?.priority_prob}
                  curationMsg={curation.curation_msg}
                  isDropped={isStatusDrop(curation.curation_status)}
                  showAmpButtons={true}
                  onAmpUp={handleAmpUp}
                  onAmpDown={handleAmpDown}
                  ampLoading={loading}
                  debugMode={debugMode}
                  curationStatus={curation.curation_status}
                  followedAt={followInfo?.followed_at}
                  topics={followInfo?.topics || userEntry?.topics}
                  timezone={followInfo?.timezone}
                  onNavigateToSettings={() => {
                    setShowPopup(false)
                    navigate('/settings?tab=curation')
                  }}
                />
              )}
            </>
          )}
        </div>
      )}
      
      {/* Show root post if this is a reply (but not in thread views where context is already shown, and not for dropped posts) */}
      {isReply && rootUri && showRootPost && !isStatusDrop(curation?.curation_status) && (
        <RootPost rootUri={rootUri} isDirectReply={isDirectReply} />
      )}

      <div
        className={`flex gap-3 ${isReply ? 'px-4 pb-4 pt-0' : 'p-4'} relative ${'curation' in post && !curationDisabled && isStatusDrop((post as CurationFeedViewPost).curation?.curation_status) ? 'opacity-50' : ''}`}
        onClick={handlePostClick}
        style={{ cursor: 'pointer' }}
      >
        {/* Counter for regular posts (not replies, not reposts) - show at top right */}
        {showCounterDisplay && !isReposted && !isReply && (
          <>
            <div className="absolute top-4 right-4 z-10 flex items-center gap-1">
              {/* Time display - controlled by showTime setting */}
              {showTime && (
                <span className="text-gray-500 dark:text-gray-400">
                  {String(postedAt.getHours()).padStart(2, '0')}:{String(postedAt.getMinutes()).padStart(2, '0')}
                </span>
              )}
              {/* Counter number - clickable with blue color */}
              <button
                ref={counterButtonRef}
                onClick={handleCounterClick}
                className={curation
                  ? 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer underline'
                  : 'text-gray-500 dark:text-gray-400 cursor-default'
                }
                title={curation ? 'Click for Skylimit curation options' : 'Post number'}
                disabled={!curation}
              >
                {formatCounterDisplay(isStatusDrop(curation?.curation_status) ? 0 : postNumber)}
              </button>
            </div>

            {showPopup && curation && (
              <CurationPopup
                ref={popupRef}
                displayName={popupAuthor.displayName || ''}
                handle={popupAuthor.handle}
                popupPosition={popupPosition}
                anchorRect={popupAnchorRect || undefined}
                rawPostNumber={rawPostNumber}
                postingPerDay={userEntry ? countTotalPostsForUser(userEntry) : undefined}
                repostingPerDay={userEntry?.repost_daily}
                regularProb={userEntry?.regular_prob}
                priorityProb={userEntry?.priority_prob}
                curationMsg={curation.curation_msg}
                isDropped={isStatusDrop(curation.curation_status)}
                showAmpButtons={true}
                onAmpUp={handleAmpUp}
                onAmpDown={handleAmpDown}
                ampLoading={loading}
                debugMode={debugMode}
                curationStatus={curation.curation_status}
                followedAt={followInfo?.followed_at}
                topics={followInfo?.topics || userEntry?.topics}
                timezone={followInfo?.timezone}
                onNavigateToSettings={() => {
                  setShowPopup(false)
                  navigate('/settings?tab=curation')
                }}
              />
            )}
          </>
        )}
        <div className="flex-shrink-0" onClick={handleAuthorClick} style={{ cursor: 'pointer' }}>
          <Avatar
            src={author.avatar}
            alt={author.displayName || author.handle}
            size="md"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 relative min-w-0 flex-wrap">
            <span
              onClick={handleAuthorClick}
              className="font-semibold hover:underline cursor-pointer truncate max-w-[40%] sm:max-w-none"
            >
              {author.displayName || author.handle}
            </span>
            <span
              onClick={handleAuthorClick}
              className="text-gray-500 dark:text-gray-400 hover:underline cursor-pointer truncate max-w-[30%] sm:max-w-none hidden sm:inline"
            >
              @{author.handle}
            </span>
            <span className="text-gray-500 dark:text-gray-400">·</span>
            <span className="text-gray-500 dark:text-gray-400 text-sm flex-shrink-0">{timeAgo}</span>
            {/* Counter for replies - show on same line as author name */}
            {isReply && showCounterDisplay && !isReposted && (
              <>
                <span className="ml-auto flex items-center gap-1">
                  {/* Time display - controlled by showTime setting */}
                  {showTime && (
                    <span className="text-gray-500 dark:text-gray-400">
                      {String(postedAt.getHours()).padStart(2, '0')}:{String(postedAt.getMinutes()).padStart(2, '0')}
                    </span>
                  )}
                  {/* Counter number - clickable with blue color */}
                  <button
                    ref={counterButtonRef}
                    onClick={handleCounterClick}
                    className={curation
                      ? 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer underline'
                      : 'text-gray-500 dark:text-gray-400 cursor-default'
                    }
                    title={curation ? 'Click for Skylimit curation options' : 'Post number'}
                    disabled={!curation}
                  >
                    {formatCounterDisplay(isStatusDrop(curation?.curation_status) ? 0 : postNumber)}
                  </button>
                </span>
                {showPopup && curation && (
                  <CurationPopup
                    ref={popupRef}
                    displayName={popupAuthor.displayName || ''}
                    handle={popupAuthor.handle}
                    popupPosition={popupPosition}
                    anchorRect={popupAnchorRect || undefined}
                    rawPostNumber={rawPostNumber}
                    postingPerDay={userEntry ? countTotalPostsForUser(userEntry) : undefined}
                    repostingPerDay={userEntry?.repost_daily}
                    regularProb={userEntry?.regular_prob}
                    priorityProb={userEntry?.priority_prob}
                    curationMsg={curation.curation_msg}
                    isDropped={isStatusDrop(curation.curation_status)}
                    showAmpButtons={true}
                    onAmpUp={handleAmpUp}
                    onAmpDown={handleAmpDown}
                    ampLoading={loading}
                    debugMode={debugMode}
                    curationStatus={curation.curation_status}
                    followedAt={followInfo?.followed_at}
                    topics={followInfo?.topics || userEntry?.topics}
                    timezone={followInfo?.timezone}
                    onNavigateToSettings={() => {
                      setShowPopup(false)
                      navigate('/settings?tab=curation')
                    }}
                  />
                )}
              </>
            )}
          </div>

          {record?.text && (
            <div className="mb-2 whitespace-pre-wrap break-words">
              {record.text}
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
            onReply={onReply}
            onRepost={onRepost}
            onQuotePost={onQuotePost}
            onLike={onLike}
          />
        </div>
      </div>
    </article>
  )
}

