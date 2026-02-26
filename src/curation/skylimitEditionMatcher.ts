/**
 * Edition pattern matcher
 *
 * Matches incoming posts against edition patterns to determine if they
 * should be held for an edition. Generates edition_tag values.
 *
 * Edition tag format:
 *   <match_edition_number (1 digit: 0-9)>.<section_code>.<userpattern_code (2 digits: 00-99)><textpattern_letter?>
 *
 * Matching order:
 *   1. Iterate editions 1-9 cyclically starting from nearest upcoming edition
 *   2. Within each edition, match patterns bottom-to-top
 *   3. If no edition-specific match, check edition0 patterns (bottom-to-top)
 *   4. If edition0 matches, tag starts with 0 (deferred to assembly)
 */

import { PostSummary } from './types'
import { Edition, EditionPattern, TextPattern, ParsedEditions } from './skylimitEditions'
import { clientDate } from '../utils/clientClock'

/**
 * Match result when a post matches an edition pattern
 */
export interface EditionMatchResult {
  editionTag: string           // the full edition_tag
  editionPattern: string       // string representation of matched pattern, e.g. "@user*: #tech"
  matchedEditionNumber: number // which edition's pattern matched (0-9)
  sectionCode: string          // section code within matched edition
  editionTime: string          // hh:mm of the nearest edition (for logging)
}

/**
 * Match a user handle against a user pattern with wildcard support
 * Patterns: "*" (match all), "prefix*", "*suffix", "exact.handle"
 */
export function matchUserPattern(handle: string, pattern: string): boolean {
  if (pattern === '*') return true

  const lowerHandle = handle.toLowerCase()
  const lowerPattern = pattern.toLowerCase()

  if (lowerPattern.endsWith('*')) {
    // prefix wildcard: "prefix*"
    const prefix = lowerPattern.slice(0, -1)
    return lowerHandle.startsWith(prefix)
  }

  if (lowerPattern.startsWith('*')) {
    // suffix wildcard: "*suffix"
    const suffix = lowerPattern.slice(1)
    return lowerHandle.endsWith(suffix)
  }

  // exact match
  return lowerHandle === lowerPattern
}

/**
 * Normalize text for matching: lowercase, collapse multiple whitespace to single space, trim
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Check if a character is a word boundary (not a letter, digit, or underscore)
 */
function isWordBoundaryChar(ch: string): boolean {
  return !/\w/.test(ch)
}

/**
 * Match a substring within text respecting word boundaries.
 *
 * @param text - normalized text to search in
 * @param substring - normalized substring to find
 * @param mode - 'startsWith': word boundary required at start of match only
 *               'endsWith': word boundary required at end of match only
 *               'contains': word boundaries required at both start and end
 * @returns true if substring is found with the specified boundary constraints
 */
export function matchAtWordBoundary(
  text: string,
  substring: string,
  mode: 'contains' | 'startsWith' | 'endsWith'
): boolean {
  if (!substring) return true
  if (!text) return false

  let startPos = 0
  while (true) {
    const idx = text.indexOf(substring, startPos)
    if (idx === -1) return false

    const atStart = idx === 0 || isWordBoundaryChar(text[idx - 1])
    const endIdx = idx + substring.length
    const atEnd = endIdx === text.length || isWordBoundaryChar(text[endIdx])

    const startOk = mode === 'endsWith' || atStart
    const endOk = mode === 'startsWith' || atEnd

    if (startOk && endOk) return true

    startPos = idx + 1
  }
}

/**
 * Match post text against a text pattern with word-boundary semantics
 *
 * Text patterns:
 * - "word sequence" → word-boundary match on both sides (case-insensitive)
 * - "prefix*" → word-boundary match at start of pattern
 * - "*suffix" → word-boundary match at end of pattern
 * - "#hashtag" → hashtag present in post tags
 * - "domain.com*" or "*domain.com" → domain matching with word boundaries
 *
 * Multiple spaces in patterns and text are normalized to single spaces.
 */
export function matchTextPattern(
  postText: string,
  quotedText: string | undefined,
  postTags: string[],
  pattern: TextPattern
): boolean {
  const text = normalizeText((postText || '') + ' ' + (quotedText || ''))

  if (pattern.isHashtag) {
    // Hashtag matching: check if tag is in post tags
    const tag = pattern.pattern.substring(1).toLowerCase()
    return postTags.some(t => t.toLowerCase() === tag)
  }

  const patternStr = normalizeText(pattern.pattern)

  if (pattern.isDomain) {
    const domain = patternStr.replace(/\*/g, '')
    if (patternStr.endsWith('*')) {
      return matchAtWordBoundary(text, domain, 'startsWith')
    }
    if (patternStr.startsWith('*')) {
      return matchAtWordBoundary(text, domain, 'endsWith')
    }
    return matchAtWordBoundary(text, domain, 'contains')
  }

  // Word sequence matching with word boundaries
  if (patternStr.endsWith('*')) {
    const prefix = patternStr.slice(0, -1)
    return matchAtWordBoundary(text, prefix, 'startsWith')
  }
  if (patternStr.startsWith('*')) {
    const suffix = patternStr.slice(1)
    return matchAtWordBoundary(text, suffix, 'endsWith')
  }

  // Exact word sequence match with word boundaries on both sides
  return matchAtWordBoundary(text, patternStr, 'contains')
}

/**
 * Get the nearest upcoming edition index, for cyclical iteration
 * Returns the index into the namedEditions array (editions with editionNumber > 0)
 */
export function getNearestUpcomingEditionIndex(namedEditions: Edition[], timezone?: string): number {
  if (namedEditions.length === 0) return -1

  const now = clientDate()
  let currentTime: string

  if (timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    currentTime = formatter.format(now)
    // Normalize "24:00" → "00:00"
    if (currentTime.startsWith('24')) currentTime = '00' + currentTime.substring(2)
  } else {
    currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }

  // Find the nearest upcoming edition (or wrap around)
  let nearestIdx = 0
  let found = false

  for (let i = 0; i < namedEditions.length; i++) {
    if (namedEditions[i].time >= currentTime) {
      nearestIdx = i
      found = true
      break
    }
  }

  if (!found) {
    // All editions are past today's current time; wrap to first edition (tomorrow)
    nearestIdx = 0
  }

  return nearestIdx
}

/**
 * Match a post against all edition patterns
 *
 * @param summary - The post summary to match
 * @param parsedEditions - The parsed edition configuration
 * @param timezone - User timezone for determining nearest edition
 * @returns Match result or null if no match
 */
export function matchPost(
  summary: PostSummary,
  parsedEditions: ParsedEditions,
  timezone?: string
): EditionMatchResult | null {
  const { editions } = parsedEditions
  if (editions.length === 0) return null

  const edition0 = editions.find(e => e.editionNumber === 0)
  const namedEditions = editions.filter(e => e.editionNumber > 0)

  if (namedEditions.length === 0) return null

  // Determine nearest upcoming edition for cyclical iteration
  const nearestIdx = getNearestUpcomingEditionIndex(namedEditions, timezone)
  if (nearestIdx < 0) return null

  const nearestEdition = namedEditions[nearestIdx]

  // 1. Iterate editions 1-9 cyclically starting from nearest upcoming
  for (let offset = 0; offset < namedEditions.length; offset++) {
    const idx = (nearestIdx + offset) % namedEditions.length
    const edition = namedEditions[idx]

    const match = matchPostAgainstEdition(summary, edition)
    if (match) {
      return {
        editionTag: `${edition.editionNumber}.${match.sectionCode}.${match.patternTag}`,
        editionPattern: match.patternString,
        matchedEditionNumber: edition.editionNumber,
        sectionCode: match.sectionCode,
        editionTime: edition.time,
      }
    }
  }

  // 2. Check edition0 patterns if no edition-specific match
  if (edition0) {
    const match = matchPostAgainstEdition(summary, edition0)
    if (match) {
      return {
        editionTag: `0.${match.sectionCode}.${match.patternTag}`,
        editionPattern: match.patternString,
        matchedEditionNumber: 0,
        sectionCode: match.sectionCode,
        editionTime: nearestEdition.time,
      }
    }
  }

  return null
}

/**
 * Match a post against a single edition's patterns
 * Iterates sections, and within each section matches bottom-to-top
 */
function matchPostAgainstEdition(
  summary: PostSummary,
  edition: Edition
): { sectionCode: string; patternTag: string; patternString: string } | null {
  // Match bottom-to-top: iterate sections in reverse, patterns in reverse
  for (let si = edition.sections.length - 1; si >= 0; si--) {
    const section = edition.sections[si]
    for (let pi = section.patterns.length - 1; pi >= 0; pi--) {
      const pattern = section.patterns[pi]
      const match = matchSinglePattern(summary, pattern)
      if (match !== null) {
        const patternTag = match.letterCode
          ? `${pattern.userPatternCode}${match.letterCode}`
          : pattern.userPatternCode
        // Build pattern string showing only the specific text pattern that matched
        const patternString = match.matchedTextPattern
          ? `@${pattern.userPattern}: ${match.matchedTextPattern}`
          : `@${pattern.userPattern}`
        return { sectionCode: section.code, patternTag, patternString }
      }
    }
  }
  return null
}

/**
 * Single pattern match result
 */
interface SinglePatternMatch {
  letterCode: string           // empty if user-only match, letter code if text match
  matchedTextPattern: string   // the specific text pattern that matched (empty if user-only)
}

/**
 * Match a post against a single pattern (user + optional text)
 *
 * @returns null if no match, SinglePatternMatch if matched
 */
function matchSinglePattern(
  summary: PostSummary,
  pattern: EditionPattern
): SinglePatternMatch | null {
  // Check user handle match
  if (!matchUserPattern(summary.username, pattern.userPattern)) {
    return null
  }

  // If no text patterns, user match is sufficient
  if (pattern.textPatterns.length === 0) {
    return { letterCode: '', matchedTextPattern: '' }
  }

  // Check text patterns (any match is sufficient)
  for (const tp of pattern.textPatterns) {
    if (matchTextPattern(
      summary.postText || '',
      summary.quotedText,
      summary.tags,
      tp
    )) {
      return { letterCode: tp.letterCode, matchedTextPattern: tp.pattern }
    }
  }

  // User matched but no text pattern matched → no match
  return null
}
