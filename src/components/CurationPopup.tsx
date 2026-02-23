import { forwardRef } from 'react'
import { createPortal } from 'react-dom'

export interface CurationPopupProps {
  // Display
  displayName: string
  handle: string
  popupPosition: 'above' | 'below'

  // Fixed positioning (viewport coordinates)
  anchorRect?: DOMRect                 // Bounding rect of the trigger element for fixed positioning

  // Curation stats (optional - different data for PostCard vs SkylimitStatistics)
  rawPostNumber?: number | null        // PostCard only
  postingPerDay?: number               // Total posts/day (all types)
  originalsPerDay?: number             // Original posts/day (Debug Info)
  priorityPerDay?: number              // Priority posts/day (Debug Info)
  repostsPerDay?: number               // Reposts/day (Debug Info)
  followedRepliesPerDay?: number       // Replies to followees/day (Debug Info)
  unfollowedRepliesPerDay?: number     // Replies to non-followees/day (Debug Info)
  shownPerDay?: number                 // Posts shown per day after curation
  regularProb?: number                 // Both (0-1 scale)
  priorityProb?: number                // Both (0-1 scale)
  curationMsg?: string                 // Fallback message
  isDropped?: boolean                  // For background styling

  // Guaranteed posts
  skylimitNumber?: number             // Default skylimit number (daily views guaranteed per followee)

  // Amp buttons
  showAmpButtons: boolean
  ampFactor?: number                  // Current amplification factor (0.125-8.0)
  onAmpUp: () => void
  onAmpDown: () => void
  ampLoading: boolean

  // Debug info
  debugMode: boolean
  curationStatus?: string              // PostCard only (post-level)
  followedAt?: string
  topics?: string
  timezone?: string
  viewedAt?: number                    // Client time timestamp when post was first viewed

  // Actions
  onNavigateToSettings?: () => void    // Optional - show "Curation Settings" link if provided
  onClose?: () => void                 // Called when backdrop is tapped (mobile dismiss)
}

const CurationPopup = forwardRef<HTMLDivElement, CurationPopupProps>(({
  displayName,
  handle,
  popupPosition,
  anchorRect,
  rawPostNumber,
  postingPerDay,
  shownPerDay,
  originalsPerDay,
  priorityPerDay,
  repostsPerDay,
  followedRepliesPerDay,
  unfollowedRepliesPerDay,
  regularProb,
  priorityProb,
  curationMsg,
  isDropped,
  skylimitNumber,
  showAmpButtons,
  ampFactor,
  onAmpUp,
  onAmpDown,
  ampLoading,
  debugMode,
  curationStatus,
  followedAt,
  topics,
  timezone,
  viewedAt,
  onNavigateToSettings,
  onClose,
}, ref) => {
  // Format count: show 1 decimal if < 10, otherwise round to integer
  const formatCount = (count: number): string => {
    if (count < 10) return count.toFixed(1)
    return Math.round(count).toString()
  }

  // Calculate fixed position styles if anchorRect is provided
  const getPositionStyle = (): React.CSSProperties => {
    if (!anchorRect) {
      // Fallback to relative positioning if no anchorRect
      return {}
    }

    const popupWidth = 320 // w-80 = 20rem = 320px
    const margin = 4 // 1 unit of margin

    // Calculate horizontal position - align right edge with anchor right edge, but keep within viewport
    let left = anchorRect.right - popupWidth
    if (left < 16) {
      left = 16 // Keep 16px margin from left edge
    }
    if (left + popupWidth > window.innerWidth - 16) {
      left = window.innerWidth - popupWidth - 16 // Keep 16px margin from right edge
    }

    // Calculate vertical position based on popupPosition
    // Use 'bottom' for above positioning and 'top' for below positioning
    const viewportPadding = 16 // Breathing room from viewport edges

    if (popupPosition === 'above') {
      // Position above the anchor - use bottom to anchor from viewport bottom
      const bottom = window.innerHeight - anchorRect.top + margin
      const maxHeight = anchorRect.top - margin - viewportPadding
      return {
        position: 'fixed' as const,
        left: `${left}px`,
        bottom: `${bottom}px`,
        maxHeight: `${maxHeight}px`,
        overflowY: 'auto' as const,
      }
    } else {
      // Position below the anchor
      const top = anchorRect.bottom + margin
      const maxHeight = window.innerHeight - anchorRect.bottom - margin - viewportPadding
      return {
        position: 'fixed' as const,
        left: `${left}px`,
        top: `${top}px`,
        maxHeight: `${maxHeight}px`,
        overflowY: 'auto' as const,
      }
    }
  }

  const positionStyle = getPositionStyle()
  const useFixedPositioning = !!anchorRect

  const popupContent = (
    <div
      ref={ref}
      className={`${useFixedPositioning ? '' : 'absolute right-0 max-h-[80vh] overflow-y-auto'} w-80 max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 ${
        !useFixedPositioning && popupPosition === 'above'
          ? 'bottom-full mb-1'
          : !useFixedPositioning ? 'top-full mt-1' : ''
      }`}
      style={positionStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 leading-snug">
        <div className="font-semibold text-sm">
          {displayName || handle}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          @{handle}
        </div>
      </div>

      {/* Curation statistics */}
      <div className={`px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 ${isDropped ? 'bg-gray-50 dark:bg-gray-900' : ''}`}>
        <div className="text-sm text-gray-600 dark:text-gray-400 leading-snug">
          {/* PostCard: Raw post number */}
          {rawPostNumber !== undefined && rawPostNumber !== null && (
            <div>Raw post #{rawPostNumber}</div>
          )}

          {/* Posting rate and shown rate */}
          {postingPerDay !== undefined && (
            <div>Posting {formatCount(postingPerDay)}/day{shownPerDay !== undefined ? `, showing ${formatCount(shownPerDay)}/day` : ''}</div>
          )}

          {/* Probabilities */}
          {regularProb !== undefined && (
            <div>Regular show probability: {(regularProb * 100).toFixed(1)}%</div>
          )}
          {priorityProb !== undefined && (
            <div>{priorityPerDay === 0 ? 'No priority posts' : `Priority show probability: ${(priorityProb * 100).toFixed(1)}%`}</div>
          )}

          {/* Fallback message */}
          {!regularProb && !priorityProb && curationMsg && (
            <div className="whitespace-pre-line">{curationMsg}</div>
          )}
        </div>
      </div>

      {/* Amp buttons */}
      {showAmpButtons && (
        <div className="px-3 py-1.5 leading-snug">
          {skylimitNumber !== undefined && ampFactor !== undefined && (
            <div className="text-sm font-semibold">
              Guaranteed posts shown: {(skylimitNumber * ampFactor).toFixed(1)}/day
            </div>
          )}
          <div className="text-sm font-semibold mb-1">
            Amplification Factor: {ampFactor !== undefined ? ampFactor.toFixed(1) : '1.0'}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onAmpDown}
              disabled={ampLoading}
              className="flex-1 px-3 py-1.5 text-sm bg-red-700 hover:bg-red-800 text-white rounded disabled:opacity-50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg> Amp Down
            </button>
            <button
              onClick={onAmpUp}
              disabled={ampLoading}
              className="flex-1 px-3 py-1.5 text-sm bg-green-700 hover:bg-green-800 text-white rounded disabled:opacity-50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg> Amp Up
            </button>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Adjust how many posts you see from this account
          </div>
        </div>
      )}

      {/* Curation Settings link - only show when curationStatus is available (PostCard context) */}
      {onNavigateToSettings && curationStatus !== undefined && (
        <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onNavigateToSettings}
            className="w-full text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Curation Settings
          </button>
        </div>
      )}

      {/* Debug Info section - only shown when debugMode is enabled */}
      {debugMode && (
        <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
          <div className="text-sm font-semibold">Debug Info</div>
          <div className="text-sm text-gray-600 dark:text-gray-400 leading-snug">
            {curationStatus !== undefined && (
              <div>Curation status: {curationStatus || 'none'}</div>
            )}
            {(originalsPerDay !== undefined || repostsPerDay !== undefined) && (
              <div>Originals {(originalsPerDay ?? 0).toFixed(1)}/day, Reposts {(repostsPerDay ?? 0).toFixed(1)}/day</div>
            )}
            {priorityPerDay !== undefined && (
              <div>Priority {priorityPerDay.toFixed(1)}/day</div>
            )}
            {(followedRepliesPerDay !== undefined || unfollowedRepliesPerDay !== undefined) && (
              <div>Replies (followed: {(followedRepliesPerDay ?? 0).toFixed(1)}/day, unfollowed: {(unfollowedRepliesPerDay ?? 0).toFixed(1)}/day)</div>
            )}
            {followedAt && (
              <div>Followed at: {new Date(followedAt).toLocaleString()}</div>
            )}
            {topics && (
              <div>Topics: {topics}</div>
            )}
            {timezone && (
              <div>Timezone: {timezone}</div>
            )}
            <div>Viewed at: {viewedAt
              ? `${new Date(viewedAt).toLocaleDateString()}, ${String(new Date(viewedAt).getHours()).padStart(2, '0')}:${String(new Date(viewedAt).getMinutes()).padStart(2, '0')}`
              : '—'}</div>
          </div>
        </div>
      )}
    </div>
  )

  // Use portal for fixed positioning to escape overflow containers
  // Include an invisible backdrop to catch taps on mobile (prevents tap-through to posts)
  if (useFixedPositioning) {
    return createPortal(
      <>
        <div
          className="fixed inset-0 z-40"
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
          onTouchStart={(e) => { e.stopPropagation(); onClose?.() }}
          aria-hidden="true"
        />
        {popupContent}
      </>,
      document.body
    )
  }

  return popupContent
})

CurationPopup.displayName = 'CurationPopup'

export default CurationPopup
