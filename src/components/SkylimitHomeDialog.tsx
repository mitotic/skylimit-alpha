/**
 * Skylimit Home Dialog Component
 * Popup showing curation statistics and options
 */

import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getFilter } from '../curation/skylimitCache'
import { GlobalStats } from '../curation/types'

interface SkylimitHomeDialogProps {
  isOpen: boolean
  onClose: () => void
}

export default function SkylimitHomeDialog({ isOpen, onClose }: SkylimitHomeDialogProps) {
  const navigate = useNavigate()
  const [stats, setStats] = useState<GlobalStats | null>(null)
  const [loading, setLoading] = useState(true)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      loadStatistics()
    }
  }, [isOpen])

  // Close dialog when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  const loadStatistics = async () => {
    try {
      setLoading(true)
      const filterResult = await getFilter()
      if (filterResult) {
        const [globalStats] = filterResult
        setStats(globalStats)
      }
    } catch (error) {
      console.error('Failed to load statistics:', error)
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Skylimit Statistics</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="text-center py-4 text-gray-500 dark:text-gray-400">
            Loading statistics...
          </div>
        ) : stats ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded">
                <div className="text-sm text-gray-600 dark:text-gray-400">Posts Received</div>
                <div className="text-2xl font-semibold">{stats.status_daily.toFixed(0)}</div>
                <div className="text-xs text-gray-500 dark:text-gray-500">per day (avg)</div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded">
                <div className="text-sm text-gray-600 dark:text-gray-400">Posts Displayed</div>
                <div className="text-2xl font-semibold">{stats.shown_daily.toFixed(0)}</div>
                <div className="text-xs text-gray-500 dark:text-gray-500">per day (avg)</div>
              </div>
            </div>

            <div className="bg-gray-50 dark:bg-gray-900 p-3 rounded">
              <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Default Skylimit Number</div>
              <div className="text-lg font-semibold">{stats.skylimit_number.toFixed(1)}</div>
              <div className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                Maximum views per account per day
              </div>
            </div>

            <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => {
                  onClose()
                  navigate('/settings/skylimit')
                }}
                className="w-full px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
              >
                Open Skylimit Settings
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center py-4 text-gray-500 dark:text-gray-400">
            No statistics available yet. Statistics are computed periodically as you use Skylimit.
          </div>
        )}
      </div>
    </div>
  )
}

