/**
 * Global rate limit state management
 * Tracks when we're rate limited to pause periodic operations
 */

interface RateLimitState {
  isRateLimited: boolean
  retryAfter?: number // seconds
  lastRateLimitTime: number // timestamp
}

let globalRateLimitState: RateLimitState = {
  isRateLimited: false,
  lastRateLimitTime: 0,
}

/**
 * Update global rate limit state
 */
export function updateRateLimitState(retryAfter?: number): void {
  globalRateLimitState = {
    isRateLimited: true,
    retryAfter,
    lastRateLimitTime: Date.now(),
  }
  
  // Auto-clear after retry-after time (or 60 seconds if not specified)
  const clearAfter = (retryAfter || 60) * 1000
  setTimeout(() => {
    globalRateLimitState.isRateLimited = false
  }, clearAfter)
}

/**
 * Clear rate limit state (when request succeeds)
 */
export function clearRateLimitState(): void {
  globalRateLimitState.isRateLimited = false
}

/**
 * Check if we're currently rate limited
 */
export function isRateLimited(): boolean {
  if (!globalRateLimitState.isRateLimited) {
    return false
  }
  
  // Check if retry-after time has passed
  if (globalRateLimitState.retryAfter) {
    const elapsed = (Date.now() - globalRateLimitState.lastRateLimitTime) / 1000
    if (elapsed >= globalRateLimitState.retryAfter) {
      globalRateLimitState.isRateLimited = false
      return false
    }
  } else {
    // If no retry-after, assume 60 seconds
    const elapsed = (Date.now() - globalRateLimitState.lastRateLimitTime) / 1000
    if (elapsed >= 60) {
      globalRateLimitState.isRateLimited = false
      return false
    }
  }
  
  return true
}

/**
 * Get time until rate limit clears (in seconds)
 */
export function getTimeUntilClear(): number {
  if (!globalRateLimitState.isRateLimited) {
    return 0
  }
  
  const elapsed = (Date.now() - globalRateLimitState.lastRateLimitTime) / 1000
  const retryAfter = globalRateLimitState.retryAfter || 60
  return Math.max(0, retryAfter - elapsed)
}

