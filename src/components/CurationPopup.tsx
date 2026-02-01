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
  postingPerDay?: number               // SkylimitStatistics only
  repostingPerDay?: number             // SkylimitStatistics only
  regularProb?: number                 // Both (0-1 scale)
  priorityProb?: number                // Both (0-1 scale)
  curationMsg?: string                 // Fallback message
  isDropped?: boolean                  // For background styling

  // Amp buttons
  showAmpButtons: boolean
  onAmpUp: () => void
  onAmpDown: () => void
  ampLoading: boolean

  // Debug info
  debugMode: boolean
  curationStatus?: string              // PostCard only (post-level)
  followedAt?: string
  topics?: string
  timezone?: string

  // Actions
  onNavigateToSettings?: () => void    // Optional - show "Curation Settings" link if provided
}

const CurationPopup = forwardRef<HTMLDivElement, CurationPopupProps>(({
  displayName,
  handle,
  popupPosition,
  anchorRect,
  rawPostNumber,
  postingPerDay,
  repostingPerDay,
  regularProb,
  priorityProb,
  curationMsg,
  isDropped,
  showAmpButtons,
  onAmpUp,
  onAmpDown,
  ampLoading,
  debugMode,
  curationStatus,
  followedAt,
  topics,
  timezone,
  onNavigateToSettings,
}, ref) => {
  // Calculate fixed position styles if anchorRect is provided
  const getPositionStyle = (): React.CSSProperties => {
    if (!anchorRect) {
      // Fallback to relative positioning if no anchorRect
      return {}
    }

    const popupWidth = 256 // w-64 = 16rem = 256px
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
    if (popupPosition === 'above') {
      // Position above the anchor - use bottom to anchor from viewport bottom
      const bottom = window.innerHeight - anchorRect.top + margin
      return {
        position: 'fixed' as const,
        left: `${left}px`,
        bottom: `${bottom}px`,
      }
    } else {
      // Position below the anchor
      const top = anchorRect.bottom + margin
      return {
        position: 'fixed' as const,
        left: `${left}px`,
        top: `${top}px`,
      }
    }
  }

  const positionStyle = getPositionStyle()
  const useFixedPositioning = !!anchorRect

  const popupContent = (
    <div
      ref={ref}
      className={`${useFixedPositioning ? '' : 'absolute right-0'} w-64 max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 ${
        !useFixedPositioning && popupPosition === 'above'
          ? 'bottom-full mb-1'
          : !useFixedPositioning ? 'top-full mt-1' : ''
      }`}
      style={positionStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="font-semibold text-sm">
          {displayName || handle}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          @{handle}
        </div>
      </div>

      {/* Curation statistics */}
      <div className={`p-3 border-b border-gray-200 dark:border-gray-700 ${isDropped ? 'bg-gray-50 dark:bg-gray-900' : ''}`}>
        <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
          {/* PostCard: Raw post number */}
          {rawPostNumber !== undefined && rawPostNumber !== null && (
            <div>Raw post #{rawPostNumber}</div>
          )}

          {/* Posting rate (reposting moved to Debug Info) */}
          {postingPerDay !== undefined && (
            <div>Posting {postingPerDay.toFixed(1)}/day</div>
          )}

          {/* Probabilities */}
          {regularProb !== undefined && (
            <div>Regular show probability: {(regularProb * 100).toFixed(1)}%</div>
          )}
          {priorityProb !== undefined && (
            <div>Priority show probability: {(priorityProb * 100).toFixed(1)}%</div>
          )}

          {/* Fallback message */}
          {!regularProb && !priorityProb && curationMsg && (
            <div className="whitespace-pre-line">{curationMsg}</div>
          )}
        </div>
      </div>

      {/* Amp buttons */}
      {showAmpButtons && (
        <div className="p-3">
          <div className="text-xs font-semibold mb-2">Amplification Factor</div>
          <div className="flex gap-2">
            <button
              onClick={onAmpDown}
              disabled={ampLoading}
              className="flex-1 px-3 py-2 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded disabled:opacity-50"
            >
              Amp Down (÷2)
            </button>
            <button
              onClick={onAmpUp}
              disabled={ampLoading}
              className="flex-1 px-3 py-2 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-50"
            >
              Amp Up (×2)
            </button>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            Adjust how many posts you see from this account
          </div>
        </div>
      )}

      {/* Curation Settings link - only show when curationStatus is available (PostCard context) */}
      {onNavigateToSettings && curationStatus !== undefined && (
        <div className="p-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onNavigateToSettings}
            className="w-full text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Curation Settings
          </button>
        </div>
      )}

      {/* Debug Info section - only shown when debugMode is enabled */}
      {debugMode && (
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
          <div className="text-xs font-semibold mb-2">Debug Info</div>
          <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
            {curationStatus !== undefined && (
              <div>Curation status: {curationStatus || 'none'}</div>
            )}
            {repostingPerDay !== undefined && (
              <div>Reposting {repostingPerDay.toFixed(1)}/day</div>
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
          </div>
        </div>
      )}
    </div>
  )

  // Use portal for fixed positioning to escape overflow containers
  if (useFixedPositioning) {
    return createPortal(popupContent, document.body)
  }

  return popupContent
})

CurationPopup.displayName = 'CurationPopup'

export default CurationPopup
