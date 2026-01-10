/**
 * Rate limit handling utilities
 */

import { throttleRequest } from './requestThrottle'
import { updateRateLimitState, clearRateLimitState } from './rateLimitState'

export interface RateLimitError extends Error {
  status?: number
  statusCode?: number
  code?: string
  headers?: Headers | Record<string, string>
  retryAfter?: number
}

export interface RateLimitInfo {
  isRateLimited: boolean
  retryAfter?: number // seconds until retry
  message?: string
}

/**
 * Check if an error is a rate limit error (429)
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
  if (typeof error !== 'object' || error === null) return false
  
  const err = error as any
  
  // Check status codes
  if (err?.status === 429 || err?.statusCode === 429) return true
  
  // Check error codes
  if (err?.code === 'RATE_LIMIT_EXCEEDED' || err?.error === 'RateLimitExceeded') return true
  
  // Check message content
  const message = err?.message || err?.error || ''
  if (typeof message === 'string' && message.toLowerCase().includes('rate limit')) return true
  
  // Check if @atproto/api wrapped error has response with 429
  if (err?.response?.status === 429) return true
  
  return false
}

/**
 * Extract retry-after time from error headers
 * Handles various error structures from @atproto/api
 */
export function getRetryAfter(error: RateLimitError): number | undefined {
  const err = error as any
  
  // Check if retryAfter is directly on the error
  if (typeof err.retryAfter === 'number') {
    return err.retryAfter
  }
  
  // Check headers on error
  let retryAfter: string | null | undefined = null
  if (err.headers) {
    if (err.headers instanceof Headers) {
      retryAfter = err.headers.get('retry-after') || err.headers.get('Retry-After')
    } else if (typeof err.headers === 'object') {
      retryAfter = err.headers['retry-after'] || err.headers['Retry-After'] || err.headers['retryAfter']
    }
  }
  
  // Check response headers (for @atproto/api wrapped errors)
  if (!retryAfter && err.response?.headers) {
    const responseHeaders = err.response.headers
    if (responseHeaders instanceof Headers) {
      retryAfter = responseHeaders.get('retry-after') || responseHeaders.get('Retry-After')
    } else if (typeof responseHeaders === 'object') {
      retryAfter = responseHeaders['retry-after'] || responseHeaders['Retry-After'] || responseHeaders['retryAfter']
    }
  }
  
  // Check for @atproto/api specific error structure
  // The library might wrap errors differently - check common patterns
  if (!retryAfter) {
    // Check if error has a cause chain
    let currentError: any = err
    for (let i = 0; i < 5 && currentError; i++) {
      if (currentError.response?.headers) {
        const headers = currentError.response.headers
        if (headers instanceof Headers) {
          retryAfter = headers.get('retry-after') || headers.get('Retry-After')
        } else if (typeof headers === 'object') {
          retryAfter = headers['retry-after'] || headers['Retry-After'] || headers['retryAfter']
        }
        if (retryAfter) break
      }
      currentError = currentError.cause || currentError.originalError || currentError.error
    }
  }
  
  if (!retryAfter) {
    // Debug: log error structure to help diagnose
    if (process.env.NODE_ENV === 'development') {
      console.debug('[Rate Limit] No retry-after header found in error:', {
        hasHeaders: !!err.headers,
        hasResponse: !!err.response,
        hasResponseHeaders: !!err.response?.headers,
        errorKeys: Object.keys(err).slice(0, 10),
      })
    }
    return undefined
  }
  
  // Parse retry-after (can be seconds as number or HTTP date)
  const seconds = parseInt(String(retryAfter), 10)
  if (!isNaN(seconds) && seconds > 0) {
    console.log(`[Rate Limit] Found retry-after: ${seconds}s`)
    return seconds
  }
  
  // Try parsing as date
  const date = new Date(String(retryAfter))
  if (!isNaN(date.getTime())) {
    const secondsUntil = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
    if (secondsUntil > 0) {
      console.log(`[Rate Limit] Found retry-after date: ${secondsUntil}s until clear`)
      return secondsUntil
    }
  }
  
  return undefined
}

/**
 * Get rate limit info from error
 */
export function getRateLimitInfo(error: unknown): RateLimitInfo {
  if (!isRateLimitError(error)) {
    return { isRateLimited: false }
  }
  
  const retryAfter = getRetryAfter(error) || error.retryAfter
  
  return {
    isRateLimited: true,
    retryAfter,
    message: error.message || 'Rate limit exceeded. Please wait before trying again.'
  }
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff on rate limit errors
 * Improved to better respect retry-after headers and add jitter
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  onRateLimit?: (info: RateLimitInfo) => void
): Promise<T> {
  let lastError: unknown
  let lastRetryAfter: number | undefined
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Throttle requests to prevent overwhelming the API
      const result = await throttleRequest(fn)
      // Clear rate limit state on success
      clearRateLimitState()
      return result
    } catch (error) {
      lastError = error
      
      if (isRateLimitError(error)) {
        const rateLimitInfo = getRateLimitInfo(error)
        
        // Update global rate limit state
        updateRateLimitState(rateLimitInfo.retryAfter)
        
        // Notify about rate limit
        if (onRateLimit) {
          onRateLimit(rateLimitInfo)
        }
        
        // Calculate delay
        let delay = baseDelay
        if (rateLimitInfo.retryAfter) {
          // Use server-specified retry-after time (always respect it)
          // Add a small buffer (10%) to account for clock skew
          delay = Math.ceil(rateLimitInfo.retryAfter * 1000 * 1.1)
          lastRetryAfter = rateLimitInfo.retryAfter
        } else if (lastRetryAfter) {
          // If we had a retry-after before, use exponential backoff from that
          delay = Math.ceil(lastRetryAfter * 1000 * Math.pow(2, attempt))
        } else {
          // Exponential backoff with jitter: baseDelay * 2^attempt + random(0-500ms)
          // Use longer delays when retry-after is not provided (server didn't specify)
          const exponentialDelay = baseDelay * Math.pow(2, attempt)
          const jitter = Math.random() * 500
          delay = exponentialDelay + jitter
          
          // When retry-after is not provided, use longer delays to be safe
          // Bluesky typically has 5-minute windows, so we should wait longer
          if (attempt === 0) {
            delay = Math.max(delay, 5000) // At least 5 seconds on first retry
          } else if (attempt === 1) {
            delay = Math.max(delay, 10000) // At least 10 seconds on second retry
          } else {
            delay = Math.max(delay, 30000) // At least 30 seconds on third retry
          }
        }
        
        // Cap maximum delay at 60 seconds (unless retry-after specifies longer)
        if (!rateLimitInfo.retryAfter && delay > 60000) {
          delay = 60000
        }
        
        // If this is the last attempt, throw the error
        if (attempt === maxRetries) {
          throw new Error(
            rateLimitInfo.message || 
            `Rate limit exceeded. Please wait ${Math.ceil(delay / 1000)} seconds before trying again.`
          )
        }
        
        console.log(`[Rate Limit] Retrying after ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries + 1})`)
        
        // Wait before retrying
        await sleep(delay)
        continue
      }
      
      // Not a rate limit error, throw immediately
      throw error
    }
  }
  
  throw lastError
}

