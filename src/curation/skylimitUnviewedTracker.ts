/**
 * Tracks unviewed posts within the last 24 hours.
 *
 * The Map is populated during computePostStats() and entries are removed
 * as posts are marked viewed via the dwell-time IntersectionObserver.
 */

// Module-level singleton state
let unviewedPosts24h: Map<string, number> = new Map()  // uniqueId → postTimestamp
let boundary24h: number = 0  // 24-hour cutoff timestamp (client time)

/**
 * Replace the unviewed posts map and boundary.
 * Called by computePostStats() after iterating all post summaries.
 */
export function setUnviewedPosts24hMap(map: Map<string, number>, boundary: number): void {
  unviewedPosts24h = map
  boundary24h = boundary
}

/**
 * Remove a post from the unviewed map when it has been viewed.
 * Called from the dwell-time callback after VIEW_DWELL_TIME_MS.
 */
export function markPostViewed(uniqueId: string): void {
  unviewedPosts24h.delete(uniqueId)
}

/**
 * Get the current count of unviewed posts and the 24-hour boundary.
 * Returns { count: 0, boundary: 0 } if stats have not been computed yet.
 */
export function getUnviewedPostsInfo(): { count: number; boundary: number } {
  return { count: unviewedPosts24h.size, boundary: boundary24h }
}

/**
 * Count unviewed posts in the map that are older than the given timestamp.
 */
export function countUnviewedOlderThan(timestamp: number): number {
  let count = 0
  for (const postTimestamp of unviewedPosts24h.values()) {
    if (postTimestamp < timestamp) count++
  }
  return count
}

/**
 * Check if any of the given uniqueIds are in the unviewed map.
 * Used to check prefetched previousPageFeed posts.
 */
export function hasUnviewedInSet(uniqueIds: string[]): boolean {
  return uniqueIds.some(id => unviewedPosts24h.has(id))
}
