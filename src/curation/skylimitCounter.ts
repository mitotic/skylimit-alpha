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
 * Check if counter should be displayed
 */
export function shouldShowCounter(): boolean {
  // This will be controlled by settings
  // For now, always return true
  return true
}
