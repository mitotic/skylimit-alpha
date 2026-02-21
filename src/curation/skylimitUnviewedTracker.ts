/**
 * Tracks unviewed posts within the last 24 hours.
 *
 * The Map is populated during computePostStats() and entries are removed
 * as posts are marked viewed via the dwell-time IntersectionObserver.
 */

// Module-level singleton state
let unviewedPosts24h: Map<string, number> = new Map()  // uniqueId → postTimestamp
let boundary24h: number = 0  // 24-hour cutoff timestamp (client time)
let revision = 0  // bumped on every mutation, used as React memo dependency
const listeners: Set<(rev: number) => void> = new Set()

/**
 * Replace the unviewed posts map and boundary.
 * Called by computePostStats() after iterating all post summaries.
 */
export function setUnviewedPosts24hMap(map: Map<string, number>, boundary: number): void {
  unviewedPosts24h = map
  boundary24h = boundary
  revision++
  notify()
}

/**
 * Remove a post from the unviewed map when it has been viewed.
 * Called from the dwell-time callback after VIEW_DWELL_TIME_MS.
 */
export function markPostViewed(uniqueId: string): void {
  if (unviewedPosts24h.delete(uniqueId)) {
    revision++
    notify()
  }
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

/**
 * Get the current revision number of the unviewed tracker.
 * Increments on every mutation; used as a React memo dependency
 * to trigger recomputation when the underlying data changes.
 */
export function getUnviewedRevision(): number {
  return revision
}

function notify(): void {
  for (const fn of listeners) fn(revision)
}

/**
 * Subscribe to unviewed tracker changes.
 * Returns an unsubscribe function.
 */
export function onUnviewedChange(fn: (rev: number) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
