import { forwardRef, useRef, useEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_PRIORITY_PATTERNS, getPopIndex } from '../curation/types'

export interface CurationPopupProps {
  // Display
  displayName: string
  handle: string
  popupPosition: 'above' | 'below'

  // Fixed positioning (viewport coordinates)
  anchorRect?: DOMRect                 // Bounding rect of the trigger element for fixed positioning

  // Curation stats (optional - different data for PostCard vs SkylimitStatistics)
  postProperties?: { rawPostNumber?: number | null; viewedAt?: number } | null  // PostCard only
  postingPerDay?: number               // Total posts/day (all types)
  originalsPerDay?: number             // Original posts/day (Debug Info)
  priorityPerDay?: number              // Priority posts/day (Debug Info)
  repostsPerDay?: number               // Reposts/day (Debug Info)
  followedRepliesPerDay?: number       // Replies to followees/day (Debug Info)
  unfollowedRepliesPerDay?: number     // Replies to non-followees/day (Debug Info)
  editedPerDay?: number                // Edition-matched posts/day (Debug Info)
  allowedPerDay?: number               // Allowed posts per day (skylimit_number × amp_factor)
  regularProb?: number                 // Both (0-1 scale)
  priorityProb?: number                // Both (0-1 scale)
  curationMsg?: string                 // Fallback message
  likeCount?: number                   // Like count for popularity index display (Debug Info)
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
  matchingPattern?: string             // Matched priority/edition pattern string
  followedAt?: string
  priorityPatterns?: string
  timezone?: string
  // Actions
  onNavigateToSettings?: () => void    // Optional - show "Curation Settings" link if provided
  onClose?: () => void                 // Called when backdrop is tapped (mobile dismiss)

  // Edition mode
  editionMode?: boolean                // When true, show edition-specific popup layout
  postTimestamp?: number               // Post creation timestamp (for hh:mm display in edition mode header)
}

const CurationPopup = forwardRef<HTMLDivElement, CurationPopupProps>(({
  displayName,
  handle,
  popupPosition,
  anchorRect,
  postProperties,
  postingPerDay,
  // allowedPerDay not destructured — no longer displayed directly
  originalsPerDay,
  priorityPerDay,
  repostsPerDay,
  followedRepliesPerDay,
  unfollowedRepliesPerDay,
  editedPerDay,
  regularProb,
  priorityProb,
  curationMsg,
  likeCount,
  isDropped,
  skylimitNumber,
  showAmpButtons,
  ampFactor,
  onAmpUp,
  onAmpDown,
  ampLoading,
  debugMode,
  curationStatus,
  matchingPattern,
  followedAt,
  priorityPatterns,
  timezone,
  onNavigateToSettings,
  onClose,
  editionMode,
  postTimestamp,
}, ref) => {
  const [showCopied, setShowCopied] = useState(false)

  // Format count: show 1 decimal if < 10, otherwise round to integer
  const formatCount = (count: number): string => {
    if (count < 10) return count.toFixed(1)
    return Math.round(count).toString()
  }

  // Ref for backdrop to attach non-passive touchstart listener (React registers touch as passive)
  const backdropRef = useRef<HTMLDivElement>(null)
  const handleBackdropTouch = useCallback((e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onClose?.()
  }, [onClose])

  useEffect(() => {
    const el = backdropRef.current
    if (el) {
      el.addEventListener('touchstart', handleBackdropTouch, { passive: false })
      return () => el.removeEventListener('touchstart', handleBackdropTouch)
    }
  }, [handleBackdropTouch])

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
      {showCopied ? (
        <div className="px-4 py-3 text-sm leading-relaxed bg-blue-50 dark:bg-blue-900/30 rounded-lg">
          <div>Username <span className="font-semibold">@{handle}</span> copied to clipboard.</div>
          <div className="mt-2">
            Navigate to{' '}
            <button
              onClick={() => onNavigateToSettings?.()}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Settings/Editions
            </button>
            {' '}to add the user to an Edition.
          </div>
        </div>
      ) : (<>
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 leading-snug">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-sm">
            {displayName || handle}
          </div>
          {editionMode && postTimestamp ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {String(new Date(postTimestamp).getHours()).padStart(2, '0')}:{String(new Date(postTimestamp).getMinutes()).padStart(2, '0')}
            </div>
          ) : postProperties?.rawPostNumber != null ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">Raw #{postProperties.rawPostNumber}</div>
          ) : null}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          @{handle}
        </div>
      </div>

      {/* Curation statistics */}
      {editionMode ? (
        <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400 leading-snug">
            {editedPerDay !== undefined && (
              <div>Posts/day: {formatCount(editedPerDay)} edited</div>
            )}
            {matchingPattern && (
              <div>Matching pattern: {matchingPattern}</div>
            )}
          </div>
        </div>
      ) : (
        <div className={`px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 ${isDropped ? 'bg-gray-50 dark:bg-gray-900' : ''}`}>
          <div className="text-sm text-gray-600 dark:text-gray-400 leading-snug">
            {/* Posting rate */}
            {postingPerDay !== undefined && (() => {
              const hasPriority = (priorityPatterns !== undefined && priorityPatterns !== '' && priorityPatterns !== DEFAULT_PRIORITY_PATTERNS) || (priorityPerDay !== undefined && priorityPerDay > 0)
              const regularPerDay = hasPriority && priorityPerDay !== undefined ? postingPerDay - priorityPerDay : postingPerDay
              return (
                <div>Posts/day: {formatCount(regularPerDay)} regular{hasPriority && priorityPerDay !== undefined ? `, ${formatCount(priorityPerDay)} priority` : ''}</div>
              )
            })()}

            {/* Show probability */}
            {regularProb !== undefined && (() => {
              const hasPriority = (priorityPatterns !== undefined && priorityPatterns !== '' && priorityPatterns !== DEFAULT_PRIORITY_PATTERNS) || (priorityPerDay !== undefined && priorityPerDay > 0)
              const regularPct = (regularProb * 100).toFixed(1)
              const regularIs100 = regularProb >= 1.0
              return (
                <div>Show probability: <span className={regularIs100 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{regularPct}%</span> regular{hasPriority && priorityProb !== undefined ? <>, <span className={priorityProb >= 1.0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{(priorityProb * 100).toFixed(1)}%</span> priority</> : ''}</div>
              )
            })()}

            {/* Fallback message */}
            {!regularProb && !priorityProb && curationMsg && (
              <div className="whitespace-pre-line">{curationMsg}</div>
            )}
          </div>
        </div>
      )}

      {/* Amp buttons (hidden in edition mode) */}
      {showAmpButtons && !editionMode && (
        <div className="px-3 py-1.5 leading-snug">
          {skylimitNumber !== undefined && ampFactor !== undefined && (() => {
            const postsPerDay = skylimitNumber * ampFactor;
            const isWeekly = postsPerDay < 0.5;
            const displayValue = isWeekly ? (postsPerDay * 7).toFixed(1) : postsPerDay.toFixed(1);
            const defaultValue = isWeekly ? (skylimitNumber * 7).toFixed(1) : skylimitNumber.toFixed(1);
            return (
              <div className="text-sm">
                Guaranteed show: {displayValue}/{isWeekly ? 'week' : 'day'} (default: {defaultValue})
              </div>
            );
          })()}
          <div className="text-sm font-semibold mb-1">
            Amp factor: {ampFactor !== undefined ? (ampFactor < 1 ? ampFactor.toFixed(2) : ampFactor.toFixed(1)) : '1.0'} (default: 1.0)
          </div>
          <div className="flex gap-2">
            <button
              onClick={onAmpDown}
              disabled={ampLoading}
              className="flex-1 px-3 py-1.5 text-sm bg-red-400 hover:bg-red-500 text-white rounded disabled:opacity-50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 inline-block align-middle" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg> Amp Down
            </button>
            <button
              onClick={onAmpUp}
              disabled={ampLoading}
              className="flex-1 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 inline-block align-middle" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg> Amp Up
            </button>
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Adjust how many posts you see from this account
          </div>
        </div>
      )}

      {/* Settings link */}
      {onNavigateToSettings && (editionMode ? (
        <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onNavigateToSettings}
            className="w-full text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Remove pattern from edition
          </button>
        </div>
      ) : (
        <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={() => {
              navigator.clipboard.writeText(handle)
              setShowCopied(true)
            }}
            className="w-full text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            Add user to an Edition
          </button>
        </div>
      ))}

      {/* Debug Info section - only shown when debugMode is enabled */}
      {debugMode && editionMode ? (
        <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
          <div className="text-sm font-semibold">Debug Info</div>
          <div className="text-sm text-gray-600 dark:text-gray-400 leading-snug">
            {postProperties !== undefined && postProperties !== null && (
              <div>Viewed at: {postProperties.viewedAt
                ? `${new Date(postProperties.viewedAt).toLocaleDateString()}, ${String(new Date(postProperties.viewedAt).getHours()).padStart(2, '0')}:${String(new Date(postProperties.viewedAt).getMinutes()).padStart(2, '0')}`
                : '—'}</div>
            )}
            {followedAt && (
              <div>Followed at: {new Date(followedAt).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            )}
            {timezone && (
              <div>Timezone: {timezone}</div>
            )}
          </div>
        </div>
      ) : debugMode && (
        <div className="px-3 py-1.5 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
          <div className="text-sm font-semibold">Debug Info</div>
          <div className="text-sm text-gray-600 dark:text-gray-400 leading-snug">
            {curationStatus !== undefined && (
              <div>Curation status: {curationStatus || 'none'}</div>
            )}
            {likeCount !== undefined && (
              <div>Popularity index: {getPopIndex(likeCount)}</div>
            )}
            {matchingPattern && (
              <div>Matching pattern: {matchingPattern}</div>
            )}
            {(originalsPerDay !== undefined || repostsPerDay !== undefined) && (
              <div>Posts/day: {(originalsPerDay ?? 0).toFixed(1)} originals, {(repostsPerDay ?? 0).toFixed(1)} reposts, {(editedPerDay ?? 0).toFixed(1)} edited</div>
            )}
            {(followedRepliesPerDay !== undefined || unfollowedRepliesPerDay !== undefined) && (
              <div>Replies/day: {(followedRepliesPerDay ?? 0).toFixed(1)} followed, {(unfollowedRepliesPerDay ?? 0).toFixed(1)} unfollowed</div>
            )}
            {postProperties !== undefined && postProperties !== null && (
              <div>Viewed at: {postProperties.viewedAt
                ? `${new Date(postProperties.viewedAt).toLocaleDateString()}, ${String(new Date(postProperties.viewedAt).getHours()).padStart(2, '0')}:${String(new Date(postProperties.viewedAt).getMinutes()).padStart(2, '0')}`
                : '—'}</div>
            )}
            {followedAt && (
              <div>Followed at: {new Date(followedAt).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            )}
            {priorityPatterns && (
              <div>Priority patterns: {priorityPatterns}</div>
            )}
            {timezone && (
              <div>Timezone: {timezone}</div>
            )}
          </div>
        </div>
      )}
      </>)}
    </div>
  )

  // Use portal for fixed positioning to escape overflow containers
  // Include an invisible backdrop to catch taps on mobile (prevents tap-through to posts)
  if (useFixedPositioning) {
    return createPortal(
      <>
        <div
          ref={backdropRef}
          className="fixed inset-0 z-40"
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
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
