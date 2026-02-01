/**
 * Daily post counter for Skylimit curation (SIMPLIFIED)
 *
 * This module now reads pre-computed postNumber and curationNumber from the
 * post summaries cache, rather than computing them dynamically.
 *
 * The numbering logic has been moved to skylimitNumbering.ts which assigns
 * invariant numbers when posts are curated.
 *
 * Counter values:
 * - postNumber: Sequential count in follow feed (resets daily, 1-indexed)
 * - curationNumber: 0 for dropped, positive for shown, null if unassigned
 */

import { getPostSummary } from './skylimitCache'

/**
 * Get curation number for a post
 * Returns the pre-computed curationNumber from the summary
 *
 * @param uniqueId - The unique ID of the post (from getPostUniqueId)
 * @returns curationNumber (0 for dropped, positive for shown, null if unassigned)
 */
export async function getCurationNumber(uniqueId: string): Promise<number | null> {
  const summary = await getPostSummary(uniqueId)
  if (!summary) return null
  return summary.curationNumber ?? null
}

/**
 * Get post number for a post (the sequential feed position)
 * Returns the pre-computed postNumber from the summary
 *
 * @param uniqueId - The unique ID of the post (from getPostUniqueId)
 * @returns postNumber (positive integer, or null if unassigned)
 */
export async function getPostNumberFromSummary(uniqueId: string): Promise<number | null> {
  const summary = await getPostSummary(uniqueId)
  if (!summary) return null
  return summary.postNumber ?? null
}

/**
 * Legacy function for backward compatibility
 * Now delegates to getCurationNumber
 *
 * @param postUri - The unique ID of the post (from getPostUniqueId)
 * @param isDropped - Whether this post was dropped by curation (if true, returns 0)
 * @returns curationNumber or 0 if dropped/not found
 * @deprecated Use getCurationNumber instead
 */
export async function getPostNumber(
  postUri: string,
  isDropped = false
): Promise<number> {
  // Dropped posts should return 0
  if (isDropped) {
    return 0
  }

  const curationNum = await getCurationNumber(postUri)

  // If curationNumber is null (unassigned), return 0 for backward compatibility
  // The display logic in PostCard will handle null differently
  return curationNum ?? 0
}

/**
 * Get post number without assigning (if post already counted)
 * Now just returns the pre-computed number
 *
 * @param postUri - The unique ID of the post (from getPostUniqueId)
 * @deprecated Use getCurationNumber instead
 */
export async function getPostNumberIfExists(
  postUri: string
): Promise<number | null> {
  return getCurationNumber(postUri)
}

/**
 * Clear in-memory caches
 * Now a no-op since numbers are stored persistently in IndexedDB
 * Kept for backward compatibility with existing callers
 */
export function clearCounters(): void {
  // No-op - numbers are now stored persistently in summaries
  console.log('[Counter] clearCounters called (no-op - numbers are persistent in summaries)')
}

/**
 * Check if counter should be displayed
 */
export function shouldShowCounter(): boolean {
  // This will be controlled by settings
  // For now, always return true
  return true
}

/**
 * Get all counters (for debugging)
 * Now returns empty object - use getAllPostSummaries for debugging
 *
 * @deprecated Numbers are now in PostSummary, use getAllPostSummaries
 */
export async function getAllCounters(): Promise<Record<string, number>> {
  console.log('[Counter] getAllCounters is deprecated - numbers are in PostSummary')
  return {}
}
