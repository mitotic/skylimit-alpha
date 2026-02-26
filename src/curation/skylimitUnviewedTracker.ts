/**
 * Tracks unviewed posts since midnight of the current calendar day.
 *
 * The Map is populated during computePostStats() and entries are removed
 * as posts are marked viewed via the dwell-time IntersectionObserver.
 */

// Module-level singleton state
let unviewedPostsToday: Map<string, number> = new Map()  // uniqueId → postTimestamp
let boundaryMidnight: number = 0  // midnight cutoff timestamp (client time)
let unviewedPostsYesterday: Map<string, number> = new Map()  // uniqueId → postTimestamp
let boundaryYesterdayMidnight: number = 0  // yesterday midnight cutoff timestamp
let revision = 0  // bumped on every mutation, used as React memo dependency
const listeners: Set<(rev: number) => void> = new Set()

/**
 * Replace the unviewed posts map and boundary for today.
 * Called by computePostStats() after iterating all post summaries.
 */
export function setUnviewedPostsTodayMap(map: Map<string, number>, boundary: number): void {
  unviewedPostsToday = map
  boundaryMidnight = boundary
  revision++
  notify()
}

/**
 * Replace the unviewed posts map and boundary for yesterday.
 * Called by computePostStats() only when cache data covers yesterday.
 */
export function setUnviewedPostsYesterdayMap(map: Map<string, number>, boundary: number): void {
  unviewedPostsYesterday = map
  boundaryYesterdayMidnight = boundary
  revision++
  notify()
}

/**
 * Remove a post from the unviewed map when it has been viewed.
 * Called from the dwell-time callback after VIEW_DWELL_TIME_MS.
 */
export function markPostViewed(uniqueId: string): void {
  const deletedToday = unviewedPostsToday.delete(uniqueId)
  const deletedYesterday = unviewedPostsYesterday.delete(uniqueId)
  if (deletedToday || deletedYesterday) {
    revision++
    notify()
  }
}

/**
 * Get the current count of unviewed posts and the midnight boundary.
 * Returns { count: 0, boundary: 0 } if stats have not been computed yet.
 */
export function getUnviewedPostsInfo(): { count: number; boundary: number } {
  return { count: unviewedPostsToday.size, boundary: boundaryMidnight }
}

/**
 * Count unviewed posts in the today map that are older than the given timestamp.
 */
export function countUnviewedOlderThan(timestamp: number): number {
  let count = 0
  for (const postTimestamp of unviewedPostsToday.values()) {
    if (postTimestamp < timestamp) count++
  }
  return count
}

/**
 * Get the current count of unviewed posts from yesterday and the yesterday boundary.
 * Returns { count: 0, boundary: 0 } if yesterday data is not available.
 */
export function getUnviewedPostsYesterdayInfo(): { count: number; boundary: number } {
  return { count: unviewedPostsYesterday.size, boundary: boundaryYesterdayMidnight }
}

/**
 * Count unviewed posts in the yesterday map that are older than the given timestamp.
 */
export function countUnviewedYesterdayOlderThan(timestamp: number): number {
  let count = 0
  for (const postTimestamp of unviewedPostsYesterday.values()) {
    if (postTimestamp < timestamp) count++
  }
  return count
}

/**
 * Check if any of the given uniqueIds are in the unviewed map.
 * Used to check prefetched previousPageFeed posts.
 */
export function hasUnviewedInSet(uniqueIds: string[]): boolean {
  return uniqueIds.some(id => unviewedPostsToday.has(id))
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
