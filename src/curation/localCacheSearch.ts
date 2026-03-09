/**
 * Local cache search — parse search expressions and match against post summaries
 *
 * Search expression syntax:
 *   [@handlePattern(namePattern):] [textPattern]
 *
 * Examples:
 *   "hello world"               → text search only
 *   "@alice: hello"             → handle + text
 *   "@alice*(Alice): tech"      → handle + display name + text
 *   "@*(Bob):"                  → any handle, display name match
 *   "@user*"                    → handle only (no colon needed)
 *   "@*: #tech"                 → all handles, text search
 */

import { PostSummary, isStatusShow, isEditionPostStatus } from './types'
import { matchUserPattern, matchAtWordBoundary, normalizeText } from './skylimitEditionMatcher'
import { getAllPostSummaries, getAllFollows } from './skylimitCache'

export interface ParsedSearchExpression {
  handlePattern?: string    // e.g. "user*", "*suffix", "*"
  namePattern?: string      // display name pattern (same wildcard rules)
  textPattern?: string      // free text search
}

/**
 * Parse a search expression into structured components.
 *
 * If input starts with @, the handle/name portion is extracted.
 * The text after ':' (if present) becomes the text pattern.
 * If no '@', the entire input is the text pattern.
 */
export function parseSearchExpression(input: string): ParsedSearchExpression {
  const trimmed = input.trim().replace(/\s+/g, ' ')
  if (!trimmed) return {}

  if (!trimmed.startsWith('@')) {
    return { textPattern: trimmed }
  }

  // Starts with @ — parse handle, optional (name), optional : text
  // Match: @handlePattern(namePattern): textPattern
  // handlePattern can contain alphanumeric, dots, hyphens, underscores, and * wildcard
  const match = trimmed.match(/^@([^(:)\s]+|\*)(?:\(([^)]*)\))?(?::\s*(.*))?$/)

  if (!match) {
    // If the regex doesn't match, treat the whole thing as text search
    return { textPattern: trimmed }
  }

  const result: ParsedSearchExpression = {}

  const handlePart = match[1]?.trim()
  if (handlePart) {
    result.handlePattern = handlePart
  }

  const namePart = match[2]?.trim()
  if (namePart) {
    result.namePattern = namePart
  }

  const textPart = match[3]?.trim()
  if (textPart) {
    result.textPattern = textPart
  }

  return result
}

/**
 * Match a single post summary against a parsed search expression.
 *
 * Handle and name patterns match across all author roles (poster, reposter,
 * original author of repost, quoted post author). Text search also includes
 * all author handles and display names.
 */
export function matchPostSummary(
  post: PostSummary,
  parsed: ParsedSearchExpression,
  displayNameMap: Map<string, string>,
  usernameDisplayNameMap?: Map<string, string>
): boolean {
  // Handle pattern matching — OR across all author handles
  if (parsed.handlePattern) {
    const handleMatched =
      matchUserPattern(post.username, parsed.handlePattern) ||
      (!!post.orig_username && matchUserPattern(post.orig_username, parsed.handlePattern)) ||
      (!!post.quoted_username && matchUserPattern(post.quoted_username, parsed.handlePattern))
    if (!handleMatched) {
      return false
    }
  }

  // Display name pattern matching — OR across all authors' display names
  if (parsed.namePattern) {
    const displayName = displayNameMap.get(post.accountDid) || ''
    const origDisplayName = post.orig_username
      ? (usernameDisplayNameMap?.get(post.orig_username) || '') : ''
    const quotedDisplayName = post.quoted_username
      ? (usernameDisplayNameMap?.get(post.quoted_username) || '') : ''

    const nameMatched =
      (!!displayName && matchNamePattern(displayName, parsed.namePattern)) ||
      (!!origDisplayName && matchNamePattern(origDisplayName, parsed.namePattern)) ||
      (!!quotedDisplayName && matchNamePattern(quotedDisplayName, parsed.namePattern))

    if (!nameMatched) {
      return false
    }
  }

  // Text pattern matching with word boundaries
  // Includes post text, quoted text, and all author handles/display names
  if (parsed.textPattern) {
    let searchableText = (post.postText || '') + ' ' + (post.quotedText || '')

    // Add all author handles and display names to searchable text
    searchableText += ' ' + post.username
    const primaryDisplayName = displayNameMap.get(post.accountDid)
    if (primaryDisplayName) searchableText += ' ' + primaryDisplayName

    if (post.orig_username) {
      searchableText += ' ' + post.orig_username
      const origDisplayName = usernameDisplayNameMap?.get(post.orig_username)
      if (origDisplayName) searchableText += ' ' + origDisplayName
    }

    if (post.quoted_username) {
      searchableText += ' ' + post.quoted_username
      const quotedDisplayName = usernameDisplayNameMap?.get(post.quoted_username)
      if (quotedDisplayName) searchableText += ' ' + quotedDisplayName
    }

    const text = normalizeText(searchableText)
    const pattern = normalizeText(parsed.textPattern)

    if (!pattern) return true

    let mode: 'contains' | 'startsWith' | 'endsWith' = 'contains'
    let searchStr = pattern

    if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 2) {
      // *text* — pure substring match, no word boundary constraints
      searchStr = pattern.slice(1, -1)
      if (!text.includes(searchStr)) {
        return false
      }
      return true
    } else if (pattern.endsWith('*')) {
      mode = 'startsWith'
      searchStr = pattern.slice(0, -1)
    } else if (pattern.startsWith('*')) {
      mode = 'endsWith'
      searchStr = pattern.slice(1)
    }

    if (!matchAtWordBoundary(text, searchStr, mode)) {
      return false
    }
  }

  return true
}

/**
 * Match a display name against a name pattern.
 * Uses case-insensitive substring matching with wildcard support:
 * - "*" matches any name
 * - "prefix*" matches names starting with prefix
 * - "*suffix" matches names ending with suffix
 * - "exact" matches name containing the exact word
 *
 * Unlike handle matching (exact match on full string), name matching
 * uses word-boundary substring matching since display names are free-form text.
 */
function matchNamePattern(displayName: string, pattern: string): boolean {
  if (pattern === '*') return true

  const lowerName = displayName.toLowerCase()
  const lowerPattern = pattern.toLowerCase()

  if (lowerPattern.endsWith('*')) {
    const prefix = lowerPattern.slice(0, -1)
    return matchAtWordBoundary(lowerName, prefix, 'startsWith')
  }

  if (lowerPattern.startsWith('*')) {
    const suffix = lowerPattern.slice(1)
    return matchAtWordBoundary(lowerName, suffix, 'endsWith')
  }

  // For exact name patterns, do word-boundary contains match
  return matchAtWordBoundary(lowerName, lowerPattern, 'contains')
}

export interface LocalSearchOptions {
  shownOnly?: boolean
  offset?: number
  limit?: number
}

export interface LocalSearchResult {
  results: PostSummary[]
  total: number
  displayNameMap: Map<string, string>
}

/**
 * Search the local post summaries cache.
 *
 * @param expression - Search expression string
 * @param options - Filter and pagination options
 * @returns Matching post summaries (newest first), total count, and display name map
 */
export async function searchLocalCache(
  expression: string,
  options: LocalSearchOptions = {}
): Promise<LocalSearchResult> {
  const { shownOnly = true, offset = 0, limit = 50 } = options

  const parsed = parseSearchExpression(expression)

  // If nothing to search for, return empty
  if (!parsed.handlePattern && !parsed.namePattern && !parsed.textPattern) {
    return { results: [], total: 0, displayNameMap: new Map() }
  }

  // Load summaries and follows in parallel
  const [allSummaries, allFollows] = await Promise.all([
    getAllPostSummaries(),
    getAllFollows(),
  ])

  // Build display name map (accountDid → displayName)
  const displayNameMap = new Map<string, string>()
  // Build username → displayName map for searching orig/quoted author display names
  const usernameDisplayNameMap = new Map<string, string>()
  for (const follow of allFollows) {
    if (follow.displayName) {
      displayNameMap.set(follow.accountDid, follow.displayName)
      usernameDisplayNameMap.set(follow.username, follow.displayName)
    }
  }

  // Filter summaries
  const matched: PostSummary[] = []
  for (const post of allSummaries) {
    // Apply shown-only filter
    if (shownOnly && !isStatusShow(post.curation_status) && !isEditionPostStatus(post.curation_status)) {
      continue
    }

    if (matchPostSummary(post, parsed, displayNameMap, usernameDisplayNameMap)) {
      matched.push(post)
    }
  }

  // Sort by postTimestamp descending (newest first)
  matched.sort((a, b) => b.postTimestamp - a.postTimestamp)

  const total = matched.length
  const results = matched.slice(offset, offset + limit)

  return { results, total, displayNameMap }
}
