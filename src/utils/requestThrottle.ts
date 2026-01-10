/**
 * Request throttling to prevent overwhelming the API
 * Limits concurrent requests and adds delays between requests
 */

interface QueuedRequest<T> {
  fn: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

class RequestThrottle {
  private queue: QueuedRequest<any>[] = []
  private activeRequests = 0
  private readonly maxConcurrent: number
  private readonly minDelay: number
  private lastRequestTime = 0

  constructor(maxConcurrent: number = 5, minDelay: number = 100) {
    this.maxConcurrent = maxConcurrent
    this.minDelay = minDelay
  }

  async throttle<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject })
      this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    // Don't process if we're at max concurrent requests
    if (this.activeRequests >= this.maxConcurrent) {
      return
    }

    // Don't process if queue is empty
    if (this.queue.length === 0) {
      return
    }

    // Check if we need to wait before next request
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime
    if (timeSinceLastRequest < this.minDelay) {
      setTimeout(() => this.processQueue(), this.minDelay - timeSinceLastRequest)
      return
    }

    // Get next request from queue
    const request = this.queue.shift()
    if (!request) {
      return
    }

    this.activeRequests++
    this.lastRequestTime = Date.now()

    try {
      const result = await request.fn()
      request.resolve(result)
    } catch (error) {
      request.reject(error)
    } finally {
      this.activeRequests--
      // Process next request in queue
      setTimeout(() => this.processQueue(), this.minDelay)
    }
  }

  getQueueLength(): number {
    return this.queue.length
  }

  getActiveRequests(): number {
    return this.activeRequests
  }
}

// Global throttle instance
// Bluesky rate limit: 3000 req/5min = 10 req/s sustained
// Allow 10 concurrent with 20ms delay = 50 req/s burst capacity (safe for page loads)
export const requestThrottle = new RequestThrottle(10, 20)

/**
 * Throttle a function call to prevent overwhelming the API
 */
export async function throttleRequest<T>(fn: () => Promise<T>): Promise<T> {
  return requestThrottle.throttle(fn)
}

