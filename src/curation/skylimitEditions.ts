/**
 * Edition file parser and fictitious editor user registry
 *
 * Parses the markdown-like edition description format and generates
 * fictitious "editor" users for each section in each edition.
 *
 * Edition layout format:
 *   # HEAD          — optional, marks editionA (default/leading patterns)
 *   # hh:mm Name    — timed editions (b-y), up to 24
 *   # TAIL          — marks editionZ (trailing/fallback patterns)
 *
 * Edition letters: editionA='a' (HEAD), timed='b'-'y', editionZ='z' (TAIL)
 * Section codes: '0' for default, 'a'-'z' for named sections (uniform across all editions)
 */

import { AppBskyActorDefs } from '@atproto/api'
import log from '../utils/logger'

/** Pre-offset before edition time for gap searching (15 minutes in ms) */
export const EDITION_PRE_OFFSET_MS = 15 * 60 * 1000

/** Internal editionNumber for HEAD (editionA) */
export const HEAD_EDITION_NUMBER = 0

/** Internal editionNumber for TAIL (editionZ) */
export const TAIL_EDITION_NUMBER = 25

/** Convert editionNumber to edition letter: HEAD(0)→'a', timed(1-24)→'b'-'y', TAIL(25)→'z' */
export function editionLetter(editionNumber: number): string {
  return String.fromCharCode(97 + editionNumber)
}

// --- Types ---

export interface EditionPattern {
  userPattern: string          // e.g., "*", "prefix*", "*suffix"
  userPatternCode: string      // 2-digit code "00"-"99"
  textPatterns: TextPattern[]  // up to 26 text patterns
}

export interface TextPattern {
  pattern: string              // the raw text pattern
  letterCode: string           // single letter "a"-"z"
  isDomain: boolean            // contains period → domain matching
  isHashtag: boolean           // starts with #
}

export interface EditionSection {
  name: string                 // section name (empty string for default section)
  code: string                 // '0' for default, 'a'-'z' for named sections
  patterns: EditionPattern[]
}

export interface Edition {
  editionNumber: number        // 0=editionA (HEAD), 1-24=timed, 25=editionZ (TAIL)
  time: string                 // "hh:mm" for timed editions, empty for editionA/editionZ
  name: string                 // edition name (e.g., "Morning Edition")
  sections: EditionSection[]
}

export interface EditorUser {
  handle: string               // e.g., "editor_08_00_0", "editor_08_00_head_a"
  displayName: string          // e.g., "Morning Edition: Tech"
  did: string                  // synthetic DID
  editionNumber: number
  sectionCode: string
}

export interface ParsedEditions {
  editions: Edition[]
  errors: string[]
}

// --- Editor User Registry ---

const editorUserRegistry = new Map<string, EditorUser>()

export function getEditorUser(handle: string): EditorUser | undefined {
  return editorUserRegistry.get(handle)
}

export function getAllEditorUsers(): EditorUser[] {
  return Array.from(editorUserRegistry.values())
}

/**
 * Create a synthetic DID for a fictitious editor user
 */
function makeEditorDid(handle: string): string {
  return `did:plc:editor_${handle}`
}

/**
 * Create an editor user and register it
 */
function registerEditorUser(
  handle: string,
  displayName: string,
  editionNumber: number,
  sectionCode: string
): EditorUser {
  const user: EditorUser = {
    handle,
    displayName,
    did: makeEditorDid(handle),
    editionNumber,
    sectionCode,
  }
  editorUserRegistry.set(handle, user)
  return user
}

/**
 * Create a Bluesky ProfileViewBasic for a fictitious editor user
 */
export function editorUserToProfileView(user: EditorUser): AppBskyActorDefs.ProfileViewBasic {
  return {
    did: user.did,
    handle: user.handle,
    displayName: user.displayName,
  }
}

// --- Parser ---

/**
 * Validate a section name: letters, numbers, spaces, and hyphens.
 * Must start and end with a letter or number.
 */
export function isValidSectionName(name: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9 \-]*[A-Za-z0-9])?$/.test(name)
}

/**
 * Validate user pattern: *, *suffix, prefix*, or literal handle chars
 * Valid handle chars: letters, numbers, dots, hyphens
 */
function isValidUserPattern(pattern: string): boolean {
  if (pattern === '*') return true
  // prefix* or *suffix or literal
  const stripped = pattern.replace(/\*/g, '')
  return /^[a-zA-Z0-9.\-]+$/.test(stripped) &&
    (pattern.split('*').length - 1) <= 1 // at most one wildcard
}

/**
 * Validate text pattern: letters, numbers, hyphens, periods, spaces, leading #
 * Wildcards (* at start or end) are stripped before validation.
 */
function isValidTextPattern(pattern: string): boolean {
  // Special case: #* matches any hashtag
  if (pattern === '#*') return true
  // Strip leading # for hashtags
  let p = pattern.startsWith('#') ? pattern.substring(1) : pattern
  // Strip wildcards
  p = p.replace(/^\*/, '').replace(/\*$/, '')
  if (p.length === 0) return false
  return /^[a-zA-Z0-9\-. ]+$/.test(p)
}

/**
 * Check if a text pattern is a domain name (contains a period)
 */
function isDomainPattern(pattern: string): boolean {
  const p = pattern.startsWith('#') ? pattern.substring(1) : pattern
  return p.includes('.')
}

/**
 * Parse a pattern line starting with @
 * Format: @userpattern or @userpattern: textpattern1, textpattern2, ...
 */
function parsePatternLine(line: string, patternIndex: number): { pattern: EditionPattern; error?: string } | { pattern: null; error: string } {
  // Remove leading @
  const content = line.substring(1).trim()

  // Split on colon for user pattern : text patterns
  const colonIdx = content.indexOf(':')
  let userPatternStr: string
  let textPatternsStr: string | null = null

  if (colonIdx >= 0) {
    userPatternStr = content.substring(0, colonIdx).trim()
    textPatternsStr = content.substring(colonIdx + 1).trim()
  } else {
    userPatternStr = content.trim()
  }

  if (!isValidUserPattern(userPatternStr)) {
    return { pattern: null, error: `Invalid user pattern: "${userPatternStr}"` }
  }

  // Bare @* without text patterns would match all posts — require at least one text pattern
  if (userPatternStr === '*' && (!textPatternsStr || textPatternsStr.trim() === '')) {
    return { pattern: null, error: `@* requires a colon followed by one or more text patterns (bare @* would match all posts)` }
  }

  const userPatternCode = String(patternIndex).padStart(2, '0')
  const textPatterns: TextPattern[] = []

  if (textPatternsStr) {
    const parts = textPatternsStr.split(',').map(p => p.trim()).filter(p => p)
    if (parts.length > 26) {
      return { pattern: null, error: `Too many text patterns (max 26) for user pattern "${userPatternStr}"` }
    }
    for (let i = 0; i < parts.length; i++) {
      const tp = parts[i]
      if (!isValidTextPattern(tp)) {
        return { pattern: null, error: `Invalid text pattern: "${tp}"` }
      }
      textPatterns.push({
        pattern: tp,
        letterCode: String.fromCharCode(97 + i), // a-z
        isDomain: isDomainPattern(tp),
        isHashtag: tp.startsWith('#'),
      })
    }
  }

  return {
    pattern: {
      userPattern: userPatternStr,
      userPatternCode,
      textPatterns,
    }
  }
}

/**
 * Parse the edition description file text
 */
export function parseEditionFile(text: string): ParsedEditions {
  const errors: string[] = []
  const editions: Edition[] = []

  // Clear the editor user registry for fresh parse
  editorUserRegistry.clear()

  if (!text || !text.trim()) {
    return { editions, errors }
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  // State tracking — start with editionA (HEAD)
  let currentEdition: Edition = {
    editionNumber: HEAD_EDITION_NUMBER,
    time: '',
    name: 'Default',
    sections: [],
  }
  let currentSection: EditionSection = {
    name: '',
    code: '0',
    patterns: [],
  }
  let editionASectionCount = 0
  let patternIndexInSection = 0

  // Track all section names globally
  const editionASectionNames = new Set<string>()
  const allEditionSectionNames = new Map<number, Set<string>>() // editionNumber → names

  // Start with default section of editionA
  currentEdition.sections.push(currentSection)
  editionASectionCount = 1

  for (const line of lines) {
    // Edition header: # hh:mm, # HEAD, # TAIL, or # hh:mm EditionName
    if (line.startsWith('# ') && !line.startsWith('## ')) {

      // # HEAD — marks start of editionA (optional, must be before any timed edition)
      if (/^#\s+HEAD\s*$/i.test(line)) {
        if (editions.length > 0 || currentEdition.editionNumber !== HEAD_EDITION_NUMBER) {
          errors.push('# HEAD must appear before any timed edition')
        }
        continue  // editionA already initialized — HEAD is a no-op marker
      }

      // # TAIL — marks start of editionZ
      if (/^#\s+TAIL\s*$/i.test(line)) {
        finishCurrentEdition()
        currentEdition = { editionNumber: TAIL_EDITION_NUMBER, time: '', name: 'Tail', sections: [] }
        currentSection = { name: '', code: '0', patterns: [] }
        patternIndexInSection = 0
        currentEdition.sections.push(currentSection)
        allEditionSectionNames.set(TAIL_EDITION_NUMBER, new Set<string>())
        continue
      }

      // Finish current section/edition
      finishCurrentEdition()

      // Parse timed edition header
      const headerMatch = line.match(/^#\s+(\d{2}:\d{2})(?:\s+(.+))?/)
      if (!headerMatch) {
        errors.push(`Invalid edition header: "${line}"`)
        continue
      }

      const time = headerMatch[1]
      const name = headerMatch[2]?.trim() || `${time} Edition`
      const editionNumber = editions.length  // editionA is at index 0, so first timed is 1

      if (editionNumber > 24) {
        errors.push(`Too many timed editions (max 24): "${line}"`)
        continue
      }

      currentEdition = {
        editionNumber,
        time,
        name,
        sections: [],
      }
      // Start default section for this timed edition with code '0'
      currentSection = {
        name: '',
        code: '0',
        patterns: [],
      }
      patternIndexInSection = 0
      currentEdition.sections.push(currentSection)
      allEditionSectionNames.set(editionNumber, new Set<string>())
      continue
    }

    // Section header: ## SectionName
    if (line.startsWith('## ')) {
      const sectionName = line.substring(3).trim()

      if (!isValidSectionName(sectionName)) {
        errors.push(`Invalid section name (letters, numbers, spaces, hyphens; must start/end with letter or number): "${sectionName}"`)
        continue
      }

      if (currentEdition.editionNumber === HEAD_EDITION_NUMBER) {
        // EditionA section — uses '0' for default + 'a'-'z' for named
        if (editionASectionCount >= 27) {  // 1 default + 26 named
          errors.push(`HEAD can have at most 26 named sections: "${sectionName}"`)
          continue
        }
        if (editionASectionNames.has(sectionName)) {
          errors.push(`Duplicate section name in HEAD: "${sectionName}"`)
          continue
        }
        editionASectionNames.add(sectionName)
        const sectionIndex = currentEdition.sections.length
        const code = String.fromCharCode(96 + sectionIndex) // a, b, c, ... (index 1→a, 2→b, ...)
        currentSection = { name: sectionName, code, patterns: [] }
        editionASectionCount++
      } else if (currentEdition.editionNumber === TAIL_EDITION_NUMBER) {
        // EditionZ section — validate against editionA section names
        if (editionASectionNames.has(sectionName)) {
          errors.push(`TAIL section "${sectionName}" conflicts with HEAD section`)
          continue
        }
        if (currentEdition.sections.length >= 27) {
          errors.push(`TAIL can have at most 26 named sections: "${sectionName}"`)
          continue
        }
        const edSections = allEditionSectionNames.get(TAIL_EDITION_NUMBER) || new Set()
        if (edSections.has(sectionName)) {
          errors.push(`Duplicate section name in TAIL: "${sectionName}"`)
          continue
        }
        edSections.add(sectionName)
        const sectionIndex = currentEdition.sections.length
        const code = String.fromCharCode(96 + sectionIndex) // a, b, c, ...
        currentSection = { name: sectionName, code, patterns: [] }
      } else {
        // Timed edition section
        if (editionASectionNames.has(sectionName)) {
          errors.push(`Edition ${currentEdition.name} section "${sectionName}" conflicts with HEAD section`)
          continue
        }
        const edSections = allEditionSectionNames.get(currentEdition.editionNumber) || new Set()
        if (edSections.has(sectionName)) {
          errors.push(`Duplicate section name in edition ${currentEdition.name}: "${sectionName}"`)
          continue
        }
        edSections.add(sectionName)

        if (currentEdition.sections.length >= 27) {
          errors.push(`Edition ${currentEdition.name} can have at most 26 named sections: "${sectionName}"`)
          continue
        }

        // Named section index starts at 1 (index 0 is default section with code '0')
        const sectionIndex = currentEdition.sections.length
        const code = String.fromCharCode(96 + sectionIndex) // a, b, c, ... (index 1→a)
        currentSection = { name: sectionName, code, patterns: [] }
      }

      patternIndexInSection = 0
      currentEdition.sections.push(currentSection)
      continue
    }

    // Pattern line: @userpattern or @userpattern: textpatterns
    if (line.startsWith('@')) {
      if (patternIndexInSection >= 100) {
        errors.push(`Too many patterns (max 100) in section: "${line}"`)
        continue
      }

      const result = parsePatternLine(line, patternIndexInSection)
      if (result.error) {
        errors.push(result.error)
      }
      if (result.pattern) {
        currentSection.patterns.push(result.pattern)
        patternIndexInSection++
      }
      continue
    }

    // Unknown line
    errors.push(`Unrecognized line: "${line}"`)
  }

  // Finish last edition
  finishCurrentEdition()

  // --- Validate edition layout ---
  const timedEditions = editions.filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)

  // Must have at least one timed edition
  if (timedEditions.length === 0) {
    errors.push('Edition layout must contain at least one edition time (# hh:mm)')
  }

  // Must have at least one pattern
  const totalPatterns = editions.reduce((sum, e) => sum + e.sections.reduce((s, sec) => s + sec.patterns.length, 0), 0)
  if (totalPatterns === 0) {
    errors.push('Edition layout must contain at least one user/topic specification (@...)')
  }

  // Edition times must be in chronological order
  for (let i = 1; i < timedEditions.length; i++) {
    if (timedEditions[i].time <= timedEditions[i - 1].time) {
      errors.push(`Edition times must be in chronological order: "${timedEditions[i].time}" is not after "${timedEditions[i - 1].time}"`)
    }
  }

  // Edition times must be at least 2 × EDITION_PRE_OFFSET apart
  const PRE_OFFSET_MINUTES = EDITION_PRE_OFFSET_MS / 60_000
  const MIN_SPACING_MINUTES = 2 * PRE_OFFSET_MINUTES
  for (let i = 1; i < timedEditions.length; i++) {
    const [h1, m1] = timedEditions[i - 1].time.split(':').map(Number)
    const [h2, m2] = timedEditions[i].time.split(':').map(Number)
    const diffMinutes = (h2 * 60 + m2) - (h1 * 60 + m1)
    if (diffMinutes < MIN_SPACING_MINUTES) {
      errors.push(`Edition times must be at least ${MIN_SPACING_MINUTES} minutes apart: "${timedEditions[i - 1].time}" and "${timedEditions[i].time}" are ${diffMinutes} minutes apart`)
    }
  }

  // Generate fictitious editor users
  generateEditorUsers(editions)

  return { editions, errors }

  function finishCurrentEdition() {
    // Remove empty sections
    currentEdition.sections = currentEdition.sections.filter(
      s => s.patterns.length > 0 || currentEdition.sections.indexOf(s) === 0
    )
    editions.push(currentEdition)
  }
}

/**
 * Generate fictitious editor users for all editions.
 * EditionA named sections get 'head_' prefix, editionZ named sections get 'tail_' prefix.
 * All default sections (code '0') share the timed edition's default user (editor_HH_MM_0).
 */
function generateEditorUsers(editions: Edition[]): void {
  const editionA = editions.find(e => e.editionNumber === HEAD_EDITION_NUMBER)
  const editionZ = editions.find(e => e.editionNumber === TAIL_EDITION_NUMBER)
  const timedEditions = editions.filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)

  for (const edition of timedEditions) {
    // Timed edition sections (no prefix)
    for (const section of edition.sections) {
      const handle = getEditorHandle(edition.time, section.code)
      const displayName = section.name
        ? `${edition.name}: ${section.name}`
        : edition.name
      registerEditorUser(handle, displayName, edition.editionNumber, section.code)
    }

    // EditionA named sections (head_ prefix, skip default '0' — uses timed default user)
    if (editionA) {
      for (const section of editionA.sections) {
        if (section.code === '0') continue
        const handle = getEditorHandle(edition.time, section.code, 'head')
        const displayName = section.name
          ? `${edition.name}: ${section.name}`
          : edition.name
        registerEditorUser(handle, displayName, edition.editionNumber, section.code)
      }
    }

    // EditionZ named sections (tail_ prefix, skip default '0' — uses timed default user)
    if (editionZ) {
      for (const section of editionZ.sections) {
        if (section.code === '0') continue
        const handle = getEditorHandle(edition.time, section.code, 'tail')
        const displayName = section.name
          ? `${edition.name}: ${section.name}`
          : edition.name
        registerEditorUser(handle, displayName, edition.editionNumber, section.code)
      }
    }
  }
}

/**
 * Get the editor user handle for a given edition time and section code.
 * Optional prefix 'head' or 'tail' for editionA/editionZ named sections.
 */
export function getEditorHandle(editionTime: string, sectionCode: string, prefix?: 'head' | 'tail'): string {
  const timeStr = editionTime.replace(':', '_')
  if (prefix) {
    return `editor_${timeStr}_${prefix}_${sectionCode}`
  }
  return `editor_${timeStr}_${sectionCode}`
}

// --- Editor follows sync ---

/**
 * Sync editor users to the follows store in IndexedDB.
 * Adds current editor users and removes stale editor_* follows.
 */
async function syncEditorFollows(): Promise<void> {
  const { saveFollow, getAllFollows, deleteFollow } = await import('./skylimitCache')
  const existingFollows = await getAllFollows()
  const currentEditors = getAllEditorUsers()
  const currentHandles = new Set(currentEditors.map(e => e.handle))

  // Remove stale editor follows not in current registry
  for (const follow of existingFollows) {
    if (follow.username.startsWith('editor_') && !currentHandles.has(follow.username)) {
      await deleteFollow(follow.username)
    }
  }

  // Add current editor users that aren't already in follows
  const existingSet = new Set(existingFollows.map(f => f.username))
  for (const editor of currentEditors) {
    if (!existingSet.has(editor.handle)) {
      await saveFollow({
        accountDid: editor.did,
        username: editor.handle,
        followed_at: new Date().toISOString(),
        amp_factor: 1.0,
        priorityPatterns: '',
        timezone: '',
        displayName: editor.displayName,
      })
    }
  }
}

// --- Cached parsed state ---

let cachedParsedEditions: ParsedEditions | null = null
let cachedEditionText: string | null = null

/**
 * Get parsed editions, using cache if edition text hasn't changed
 */
export async function getParsedEditions(): Promise<ParsedEditions> {
  const { getSettings } = await import('./skylimitStore')
  const settings = await getSettings()
  const editionText = settings.editionLayout || ''

  if (cachedParsedEditions && cachedEditionText === editionText) {
    return cachedParsedEditions
  }

  cachedParsedEditions = parseEditionFile(editionText)
  cachedEditionText = editionText

  if (cachedParsedEditions.errors.length > 0) {
    log.warn('Editions', 'Parse errors:', cachedParsedEditions.errors)
  }

  // Sync editor users to follows store (add new, remove stale)
  await syncEditorFollows()

  return cachedParsedEditions
}

/**
 * Invalidate the cached parsed editions (call when settings change)
 */
export function invalidateEditionsCache(): void {
  cachedParsedEditions = null
  cachedEditionText = null
}

// --- Edition Match types and helpers ---

export interface EditionMatch {
  editionName: string   // e.g., "08:00 Morning" or "(head)" for HEAD
  sectionName: string   // e.g., "Tech" or "(default)"
  textPatterns: string  // e.g., "#tech, ai*" or ""
  lineIndex: number     // line number in the raw text (0-based) for editing/removal
  rawLine: string       // the full raw line
}

/**
 * Find all edition layout lines that exactly match a user handle.
 * Scans the raw layout text line-by-line, tracking edition/section context.
 */
export function findEditionMatchesForUser(editionLayout: string, handle: string): EditionMatch[] {
  if (!editionLayout?.trim()) return []

  const lines = editionLayout.split('\n')
  const matches: EditionMatch[] = []
  let currentEditionName = '(head)'
  let currentSectionName = '(default)'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Edition header
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      if (/^#\s+HEAD\s*$/i.test(line)) {
        currentEditionName = '(head)'
      } else if (/^#\s+TAIL\s*$/i.test(line)) {
        currentEditionName = '(tail)'
      } else {
        const headerMatch = line.match(/^#\s+(\d{2}:\d{2})(?:\s+(.+))?/)
        if (headerMatch) {
          currentEditionName = headerMatch[2]?.trim() || `${headerMatch[1]} Edition`
        }
      }
      currentSectionName = '(default)'
      continue
    }

    // Section header
    if (line.startsWith('## ')) {
      currentSectionName = line.substring(3).trim() || '(default)'
      continue
    }

    // Pattern line: @userpattern or @userpattern: textpatterns
    if (line.startsWith('@')) {
      const content = line.substring(1).trim()
      const colonIdx = content.indexOf(':')
      const userPattern = colonIdx >= 0 ? content.substring(0, colonIdx).trim() : content.trim()
      const textPatternsStr = colonIdx >= 0 ? content.substring(colonIdx + 1).trim() : ''

      if (userPattern === handle) {
        matches.push({
          editionName: currentEditionName,
          sectionName: currentSectionName,
          textPatterns: textPatternsStr,
          lineIndex: i,
          rawLine: lines[i],
        })
      }
    }
  }

  return matches
}

/**
 * Extract editions and their sections from raw layout text for dropdown population.
 * Lightweight line scanner — does not validate, just extracts structure.
 */
export interface LayoutEditionInfo {
  editionName: string    // display name, e.g., "Morning" or "(head)" for HEAD, "(tail)" for TAIL
  editionTime: string    // "hh:mm" or "" for HEAD/TAIL
  isHead: boolean
  isTail: boolean
  sectionNames: string[] // ["(default)", "Tech", ...] — (default) first if implicit default section exists
}

export function getEditionsFromLayout(editionLayout: string): LayoutEditionInfo[] {
  if (!editionLayout?.trim()) return []

  const lines = editionLayout.split('\n')
  const editions: LayoutEditionInfo[] = []
  let current: LayoutEditionInfo | null = null
  let hasDefaultSection = false  // patterns seen before any ## in current edition

  const finishEdition = () => {
    if (current) {
      if (hasDefaultSection || current.sectionNames.length === 0) {
        current.sectionNames.unshift('(default)')
      }
      editions.push(current)
    }
  }

  // Start with implicit HEAD edition
  current = { editionName: '(head)', editionTime: '', isHead: true, isTail: false, sectionNames: [] }
  hasDefaultSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Edition header
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      if (/^#\s+HEAD\s*$/i.test(trimmed)) {
        // HEAD is a no-op marker — current is already HEAD
        continue
      }

      finishEdition()
      hasDefaultSection = false

      if (/^#\s+TAIL\s*$/i.test(trimmed)) {
        current = { editionName: '(tail)', editionTime: '', isHead: false, isTail: true, sectionNames: [] }
      } else {
        const headerMatch = trimmed.match(/^#\s+(\d{2}:\d{2})(?:\s+(.+))?/)
        if (headerMatch) {
          const time = headerMatch[1]
          const name = headerMatch[2]?.trim() || `${time} Edition`
          current = { editionName: name, editionTime: time, isHead: false, isTail: false, sectionNames: [] }
        }
      }
      continue
    }

    // Section header
    if (trimmed.startsWith('## ')) {
      const sectionName = trimmed.substring(3).trim() || '(default)'
      if (current && !current.sectionNames.includes(sectionName)) {
        current.sectionNames.push(sectionName)
      }
      continue
    }

    // Pattern line — means the current (possibly implicit default) section has content
    if (trimmed.startsWith('@') && current) {
      // If no ## seen yet in this edition, there's an implicit default section
      if (current.sectionNames.length === 0 || (!current.sectionNames.includes('(default)') && !hasDefaultSection)) {
        hasDefaultSection = true
      }
    }
  }

  finishEdition()

  // Filter out HEAD edition if it has no content (only "(default)" section with no patterns)
  // Actually, keep it — user might want to add to HEAD. But filter if layout has no HEAD content
  // and has timed editions. Keep it simple: always include HEAD if it was populated or is the only option.

  return editions
}

/**
 * Find the line index to insert a new pattern line at the top of a given edition/section.
 * Returns the line index after which the new line should be inserted.
 * Returns -1 if the edition/section is not found.
 */
export function findInsertionLineIndex(
  editionLayout: string,
  editionTime: string,
  isHead: boolean,
  isTail: boolean,
  sectionName: string
): number {
  const lines = editionLayout.split('\n')
  let inTargetEdition = isHead  // HEAD starts at line 0
  let insertAfterLine = isHead ? -1 : -1  // -1 means "insert at line 0" (prepend)
  const targetIsDefaultSection = sectionName === '(default)'

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue

    // Edition header
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      if (inTargetEdition && !isHead) {
        // We were in target edition but hit the next edition — section not found explicitly
        // Insert at the end of the target edition (before this line)
        break
      }

      if (/^#\s+HEAD\s*$/i.test(trimmed)) {
        if (isHead) {
          inTargetEdition = true
          insertAfterLine = i
        }
        continue
      }
      if (/^#\s+TAIL\s*$/i.test(trimmed)) {
        if (isHead) {
          // End of HEAD section — if we haven't found the section, insert before TAIL
          break
        }
        if (isTail) {
          inTargetEdition = true
          insertAfterLine = i
        }
        continue
      }

      const headerMatch = trimmed.match(/^#\s+(\d{2}:\d{2})/)
      if (headerMatch) {
        if (isHead) {
          // End of HEAD — break
          break
        }
        if (headerMatch[1] === editionTime) {
          inTargetEdition = true
          insertAfterLine = i
        } else if (inTargetEdition) {
          // Past target edition
          break
        }
      }
      continue
    }

    if (!inTargetEdition) continue

    // Section header within target edition
    if (trimmed.startsWith('## ')) {
      if (targetIsDefaultSection) {
        // Hit a named section — default section is before this, so insert before this line
        break
      }
      const secName = trimmed.substring(3).trim() || '(default)'
      if (secName === sectionName) {
        insertAfterLine = i
        // Continue to find the first pattern line position (right after header)
        continue
      } else if (insertAfterLine >= 0 && !targetIsDefaultSection) {
        // We were in the target section and hit a different section
        break
      }
      continue
    }

    // Pattern line — update insert position if we're in the right section
    if (trimmed.startsWith('@') && insertAfterLine >= 0) {
      // If we found the section header (or are in default section), the insert point is
      // right after the section/edition header, not after patterns
      // So we don't update insertAfterLine here — we want to insert at the TOP
      break
    }
  }

  return insertAfterLine
}

/**
 * Find the line index of the last content line belonging to a given edition.
 * Used for appending new sections at the end of an edition.
 * Returns -1 if the edition is not found.
 */
export function findEditionEndLineIndex(
  editionLayout: string,
  editionTime: string,
  isHead: boolean,
  isTail: boolean
): number {
  const lines = editionLayout.split('\n')
  let inTargetEdition = isHead
  let lastContentLine = isHead ? -1 : -1

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()

    // Edition header
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      if (inTargetEdition && !isHead) {
        // Hit next edition — we're done
        break
      }

      if (/^#\s+HEAD\s*$/i.test(trimmed)) {
        if (isHead) { inTargetEdition = true; lastContentLine = i }
        continue
      }
      if (/^#\s+TAIL\s*$/i.test(trimmed)) {
        if (isHead) break
        if (isTail) { inTargetEdition = true; lastContentLine = i }
        continue
      }

      const headerMatch = trimmed.match(/^#\s+(\d{2}:\d{2})/)
      if (headerMatch) {
        if (isHead) break
        if (headerMatch[1] === editionTime) {
          inTargetEdition = true
          lastContentLine = i
        } else if (inTargetEdition) {
          break
        }
      }
      continue
    }

    if (!inTargetEdition) continue

    // Track the last non-empty line in this edition
    if (trimmed) {
      lastContentLine = i
    }
  }

  return lastContentLine
}

/**
 * Save an edition layout with full validation, cache invalidation, and post re-matching.
 * Shared by SettingsPage and ProfilePage to avoid duplicating the save flow.
 */
export async function saveEditionLayout(
  newLayout: string
): Promise<{ success: boolean; errors: string[]; editionCount: number; patternCount: number; rematchResult?: { total: number; rematched: number; fallback: number; released: number } }> {
  const { updateSettings } = await import('./skylimitStore')
  const { rematchHeldPosts } = await import('./skylimitEditionMatcher')

  const trimmed = newLayout.trim()

  if (!trimmed) {
    await updateSettings({ editionLayout: '' })
    invalidateEditionsCache()
    const rematchResult = await rematchHeldPosts()
    return { success: true, errors: [], editionCount: 0, patternCount: 0, rematchResult }
  }

  const result = parseEditionFile(trimmed)
  if (result.errors.length > 0) {
    return { success: false, errors: result.errors, editionCount: 0, patternCount: 0 }
  }

  const editionCount = result.editions.filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER).length
  const patternCount = result.editions.reduce(
    (sum, e) => sum + e.sections.reduce((s, sec) => s + sec.patterns.length, 0), 0
  )

  await updateSettings({ editionLayout: trimmed })
  invalidateEditionsCache()
  const rematchResult = await rematchHeldPosts()

  return { success: true, errors: [], editionCount, patternCount, rematchResult }
}
