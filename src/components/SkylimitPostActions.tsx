/**
 * Skylimit Post Actions Component
 * Faucet icon and popup menu for amp up/down controls
 */

import { useState, useRef, useEffect } from 'react'
import { AppBskyFeedDefs } from '@atproto/api'
import { CurationMetadata } from '../curation/types'
import { ampUp, ampDown } from '../curation/skylimitFollows'

interface SkylimitPostActionsProps {
  post: AppBskyFeedDefs.FeedViewPost
  curation?: CurationMetadata
  onAmpChange?: () => void
}

export default function SkylimitPostActions({ post, curation, onAmpChange }: SkylimitPostActionsProps) {
  const [showPopup, setShowPopup] = useState(false)
  const [loading, setLoading] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)

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

  const author = post.post.author
  const username = author.handle

  const handleAmpUp = async () => {
    try {
      setLoading(true)
      await ampUp(username)
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
      await ampDown(username)
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

  // Don't show for own posts
  // We'll need to pass myUsername or check differently
  // For now, we'll show it for all posts

  return (
    <div className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setShowPopup(!showPopup)
        }}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        title="Skylimit curation options"
        aria-label="Skylimit curation options"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="w-4 h-4"
        >
          {/* Faucet/droplet icon */}
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
        </svg>
      </button>

      {showPopup && (
        <div
          ref={popupRef}
          className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
            <div className="font-semibold text-sm">
              {author.displayName || username}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              @{username}
            </div>
          </div>

          {curation?.curation_dropped && (
            <div className="p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <div className="text-xs text-gray-600 dark:text-gray-400">
                <strong>Dropped:</strong> {curation.curation_dropped}
              </div>
              {curation.curation_msg && (
                <div className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                  {curation.curation_msg}
                </div>
              )}
            </div>
          )}

          {curation?.curation_high_boost && (
            <div className="p-3 border-b border-gray-200 dark:border-gray-700">
              <div className="text-xs text-gray-600 dark:text-gray-400">
                High boost post
              </div>
            </div>
          )}

          <div className="p-3">
            <div className="text-xs font-semibold mb-2">Amplification Factor</div>
            <div className="flex gap-2">
              <button
                onClick={handleAmpDown}
                disabled={loading}
                className="flex-1 px-3 py-2 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded disabled:opacity-50"
              >
                Amp Down (÷2)
              </button>
              <button
                onClick={handleAmpUp}
                disabled={loading}
                className="flex-1 px-3 py-2 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-50"
              >
                Amp Up (×2)
              </button>
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              Adjust how many posts you see from this account
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

