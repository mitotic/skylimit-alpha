/**
 * Edition pattern matcher
 *
 * Matches incoming posts against edition patterns to determine if they
 * should be held for an edition. Generates edition_tag values.
 *
 * Edition tag format:
 *   <edition_letter (a-z)>.<section_code>.<userpattern_code (2 digits: 00-99)><textpattern_letter?>
 *
 * Edition letters: editionA='a' (HEAD), timed='b'-'y', editionZ='z' (TAIL)
 *
 * Matching order:
 *   1. Match editionA (HEAD) patterns first, top-to-bottom
 *   2. Iterate timed editions cyclically starting from nearest upcoming, top-to-bottom
 *   3. Match editionZ (TAIL) patterns last, top-to-bottom
 */

import { PostSummary } from './types'
import { Edition, EditionPattern, TextPattern, ParsedEditions, HEAD_EDITION_NUMBER, TAIL_EDITION_NUMBER, editionLetter } from './skylimitEditions'
import { clientDate } from '../utils/clientClock'
import log from '../utils/logger'

/**
 * Match result when a post matches an edition pattern
 */
export interface EditionMatchResult {
  editionTag: string           // the full edition_tag
  editionPattern: string       // string representation of matched pattern, e.g. "@user*: #tech"
  matchedEditionNumber: number // which edition's pattern matched (0=HEAD, 1-24=timed, 25=TAIL)
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
    const tag = pattern.pattern.substring(1).toLowerCase()
    if (tag === '*') return postTags.length > 0  // #* matches any post with tags
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
 * Returns the index into the timedEditions array (editions with editionNumber 1-24)
 *
 * @param referenceTimestamp - If provided, use this timestamp's time-of-day instead of
 *   the current client time. This ensures posts are matched to the nearest upcoming
 *   edition relative to when they were posted, not when the client processes them.
 */
export function getNearestUpcomingEditionIndex(timedEditions: Edition[], timezone?: string, referenceTimestamp?: number): number {
  if (timedEditions.length === 0) return -1

  const refDate = referenceTimestamp !== undefined ? new Date(referenceTimestamp) : clientDate()
  let currentTime: string

  if (timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    currentTime = formatter.format(refDate)
    // Normalize "24:00" → "00:00"
    if (currentTime.startsWith('24')) currentTime = '00' + currentTime.substring(2)
  } else {
    currentTime = `${String(refDate.getHours()).padStart(2, '0')}:${String(refDate.getMinutes()).padStart(2, '0')}`
  }

  // Find the nearest upcoming edition (or wrap around)
  let nearestIdx = 0
  let found = false

  for (let i = 0; i < timedEditions.length; i++) {
    if (timedEditions[i].time >= currentTime) {
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
 * Match a post against all edition patterns.
 * Order: editionA (HEAD) first → timed editions cyclically → editionZ (TAIL) last.
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

  const editionA = editions.find(e => e.editionNumber === HEAD_EDITION_NUMBER)
  const editionZ = editions.find(e => e.editionNumber === TAIL_EDITION_NUMBER)
  const timedEditions = editions.filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)

  if (timedEditions.length === 0) return null

  // Determine nearest upcoming edition for cyclical iteration based on post timestamp
  const nearestIdx = getNearestUpcomingEditionIndex(timedEditions, timezone, summary.postTimestamp)
  if (nearestIdx < 0) return null

  const nearestEdition = timedEditions[nearestIdx]

  // 1. Match editionA (HEAD) FIRST
  if (editionA) {
    const match = matchPostAgainstEdition(summary, editionA)
    if (match) {
      return {
        editionTag: `a.${match.sectionCode}.${match.patternTag}`,
        editionPattern: match.patternString,
        matchedEditionNumber: HEAD_EDITION_NUMBER,
        sectionCode: match.sectionCode,
        editionTime: nearestEdition.time,
      }
    }
  }

  // 2. Iterate timed editions cyclically starting from nearest upcoming
  for (let offset = 0; offset < timedEditions.length; offset++) {
    const idx = (nearestIdx + offset) % timedEditions.length
    const edition = timedEditions[idx]

    const match = matchPostAgainstEdition(summary, edition)
    if (match) {
      return {
        editionTag: `${editionLetter(edition.editionNumber)}.${match.sectionCode}.${match.patternTag}`,
        editionPattern: match.patternString,
        matchedEditionNumber: edition.editionNumber,
        sectionCode: match.sectionCode,
        editionTime: edition.time,
      }
    }
  }

  // 3. Match editionZ (TAIL) LAST
  if (editionZ) {
    const match = matchPostAgainstEdition(summary, editionZ)
    if (match) {
      return {
        editionTag: `z.${match.sectionCode}.${match.patternTag}`,
        editionPattern: match.patternString,
        matchedEditionNumber: TAIL_EDITION_NUMBER,
        sectionCode: match.sectionCode,
        editionTime: nearestEdition.time,
      }
    }
  }

  return null
}

/**
 * Match a post against a single edition's patterns.
 * Iterates sections and patterns top-to-bottom (first match wins).
 */
function matchPostAgainstEdition(
  summary: PostSummary,
  edition: Edition
): { sectionCode: string; patternTag: string; patternString: string } | null {
  // Match top-to-bottom: iterate sections forward, patterns forward
  for (let si = 0; si < edition.sections.length; si++) {
    const section = edition.sections[si]
    for (let pi = 0; pi < section.patterns.length; pi++) {
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

/**
 * Re-match held and orphaned posts against the current edition layout.
 *
 * Called when the edition layout changes in Settings. Queries held and
 * orphaned posts from IndexedDB within the edition lookback window and
 * re-runs matchPost() against the new parsed editions.
 *
 * - Matched posts are set to 'hold' (orphaned posts are re-held).
 * - Unmatched held posts get fallback tag 'a.0.00' (editionA default section).
 * - Unmatched orphaned posts are left as-is (already in the feed).
 * - If no timed editions remain, all held posts are released as orphaned.
 *
 * @returns Summary of how many posts were re-matched vs fell back to default
 */
export async function rematchHeldPosts(): Promise<{ total: number; rematched: number; fallback: number; released: number }> {
  const { getEditionLookbackMs } = await import('./skylimitEditionAssembly')
  const { getParsedEditions } = await import('./skylimitEditions')
  const { getPostSummariesInRange, savePostSummariesForce } = await import('./skylimitCache')
  const { getSettings } = await import('./skylimitStore')
  const { assignAllNumbers } = await import('./skylimitNumbering')

  const parsedEditions = await getParsedEditions()
  const settings = await getSettings()
  const timezone = settings?.timezone

  const now = Date.now()
  const lookbackStart = now - await getEditionLookbackMs()
  const summaries = await getPostSummariesInRange(lookbackStart, now)
  // Include both held and orphaned posts — orphaned get a second chance with new layout
  const postsToRematch = summaries.filter(s => s.edition_status === 'hold' || s.edition_status === 'orphaned')

  if (postsToRematch.length === 0) {
    log.debug('Edition/Rematch', 'No held or orphaned posts to re-match')
    return { total: 0, rematched: 0, fallback: 0, released: 0 }
  }

  const heldCount = postsToRematch.filter(s => s.edition_status === 'hold').length
  const orphanedCount = postsToRematch.filter(s => s.edition_status === 'orphaned').length
  const hasTimedEditions = parsedEditions.editions.some(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)

  // No timed editions remain: release held posts (orphaned already released)
  if (!hasTimedEditions) {
    const heldPosts = postsToRematch.filter(s => s.edition_status === 'hold')
    for (const summary of heldPosts) {
      summary.curation_status = 'edition_post_show'
      summary.curation_msg = '[Edition hold released]'
      summary.edition_status = 'orphaned'
      summary.edition_tag = undefined
      summary.matching_pattern = undefined
    }
    if (heldPosts.length > 0) {
      await savePostSummariesForce(heldPosts)
      await assignAllNumbers()
    }
    log.debug('Edition/Rematch', `Released ${heldPosts.length} held posts (no timed editions remain)`)
    return { total: heldPosts.length, rematched: 0, fallback: 0, released: heldPosts.length }
  }

  let rematched = 0
  let fallback = 0
  const changed: PostSummary[] = []

  for (const summary of postsToRematch) {
    const match = matchPost(summary, parsedEditions, timezone)
    if (match) {
      summary.edition_tag = match.editionTag
      summary.matching_pattern = match.editionPattern
      // Restore orphaned posts back to hold status
      if (summary.edition_status === 'orphaned') {
        summary.edition_status = 'hold'
        summary.curation_status = 'edition_post_drop'
        summary.curation_msg = '[Re-held from orphaned]'
      }
      changed.push(summary)
      rematched++
    } else if (summary.edition_status === 'hold') {
      // Held post with no match: assign fallback tag
      summary.edition_tag = 'a.0.00'
      summary.matching_pattern = ''
      changed.push(summary)
      fallback++
    }
    // Orphaned post with no match: leave as-is (already in feed)
  }

  if (changed.length > 0) {
    await savePostSummariesForce(changed)
  }

  log.debug('Edition/Rematch', `Re-matched ${postsToRematch.length} posts (${heldCount} held, ${orphanedCount} orphaned): ${rematched} matched, ${fallback} fallback`)
  return { total: postsToRematch.length, rematched, fallback, released: 0 }
}
