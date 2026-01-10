import { useState, useEffect } from 'react'

export interface RateLimitStatus {
  isActive: boolean
  retryAfter?: number // seconds
  message?: string
}

interface RateLimitIndicatorProps {
  status: RateLimitStatus | null
}

export default function RateLimitIndicator({ status }: RateLimitIndicatorProps) {
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null)

  useEffect(() => {
    if (!status?.isActive || !status.retryAfter) {
      setTimeRemaining(null)
      return
    }

    setTimeRemaining(status.retryAfter)

    const interval = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev === null || prev <= 1) {
          return null
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [status?.isActive, status?.retryAfter])

  if (!status?.isActive) {
    return null
  }

  const formatTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds}s`
    }
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  }

  return (
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-yellow-500 dark:bg-yellow-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-pulse">
      <svg 
        className="w-5 h-5" 
        fill="none" 
        stroke="currentColor" 
        viewBox="0 0 24 24"
      >
        <path 
          strokeLinecap="round" 
          strokeLinejoin="round" 
          strokeWidth={2} 
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" 
        />
      </svg>
      <span className="text-sm font-medium">
        {status.message || 'Rate limit: '}
        {timeRemaining !== null && timeRemaining > 0 && (
          <span className="font-bold">Retry in {formatTime(timeRemaining)}</span>
        )}
      </span>
    </div>
  )
}

