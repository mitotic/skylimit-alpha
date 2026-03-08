/**
 * Edition registry: lightweight localStorage-based list of all created editions.
 * Used for navigation in the Periodic Editions tab without scanning post_summaries.
 */

import { EditionRegistryEntry } from './types'
import log from '../utils/logger'

const EDITION_REGISTRY_KEY = 'skylimit_edition_registry'

/** Get all registry entries, sorted newest-first by createdAt. */
export function getEditionRegistry(): EditionRegistryEntry[] {
  const raw = localStorage.getItem(EDITION_REGISTRY_KEY)
  if (!raw) return []
  try {
    const entries: EditionRegistryEntry[] = JSON.parse(raw)
    return entries.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    log.warn('EditionRegistry', 'Failed to parse registry, clearing')
    localStorage.removeItem(EDITION_REGISTRY_KEY)
    return []
  }
}

/** Append an entry to the registry (or update if editionKey already exists). */
export function saveEditionToRegistry(entry: EditionRegistryEntry): void {
  const entries = getEditionRegistry()
  const existingIdx = entries.findIndex(e => e.editionKey === entry.editionKey)
  if (existingIdx >= 0) {
    entries[existingIdx] = entry
  } else {
    entries.push(entry)
  }
  localStorage.setItem(EDITION_REGISTRY_KEY, JSON.stringify(entries))
}

/** Remove entries where oldestOriginalTimestamp < cutoffTimestamp. Returns count removed. */
export function cullEditionRegistry(cutoffTimestamp: number): number {
  const entries = getEditionRegistry()
  const kept = entries.filter(e => e.oldestOriginalTimestamp >= cutoffTimestamp)
  const removed = entries.length - kept.length
  if (removed > 0) {
    localStorage.setItem(EDITION_REGISTRY_KEY, JSON.stringify(kept))
  }
  return removed
}

/** Remove recent entries where createdAt >= cutoffTimestamp. Returns count removed. */
export function cullRecentEditionRegistry(cutoffTimestamp: number): number {
  const entries = getEditionRegistry()
  const kept = entries.filter(e => e.createdAt < cutoffTimestamp)
  const removed = entries.length - kept.length
  if (removed > 0) {
    localStorage.setItem(EDITION_REGISTRY_KEY, JSON.stringify(kept))
  }
  return removed
}

/** Get the newest registry entry (by createdAt), or null if empty. */
export function getNewestRegistryEntry(): EditionRegistryEntry | null {
  const entries = getEditionRegistry()
  return entries.length > 0 ? entries[0] : null
}

/** Check if an edition with the given key already exists in the registry. */
export function isEditionInRegistry(editionKey: string): boolean {
  return getEditionRegistry().some(e => e.editionKey === editionKey)
}

/** Mark an edition as viewed (sets viewedAt if not already set). */
export function markEditionViewed(editionKey: string, timestamp: number): void {
  const entries = getEditionRegistry()
  const entry = entries.find(e => e.editionKey === editionKey)
  if (entry && !entry.viewedAt) {
    entry.viewedAt = timestamp
    localStorage.setItem(EDITION_REGISTRY_KEY, JSON.stringify(entries))
  }
}

/** Check if the newest edition (by createdAt) has not been viewed. */
export function isNewestEditionUnviewed(): boolean {
  const newest = getNewestRegistryEntry()
  return newest != null && !newest.viewedAt
}

/** Clear the entire registry (for reset/debug). */
export function clearEditionRegistry(): void {
  localStorage.removeItem(EDITION_REGISTRY_KEY)
}
