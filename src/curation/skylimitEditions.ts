/**
 * Edition file parser and fictitious editor user registry
 *
 * Parses the markdown-like edition description format and generates
 * fictitious "editor" users for each section in each edition.
 */

import { AppBskyActorDefs } from '@atproto/api'

/** Pre-offset before edition time for gap searching (15 minutes in ms) */
export const EDITION_PRE_OFFSET_MS = 15 * 60 * 1000

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
  code: string                 // digit (edition0) or letter (editions 1-9)
  patterns: EditionPattern[]
}

export interface Edition {
  editionNumber: number        // 0 for default, 1-9 for named editions
  time: string                 // "hh:mm" for editions 1-9, empty for edition0
  name: string                 // edition name (e.g., "Morning Edition")
  sections: EditionSection[]
}

export interface EditorUser {
  handle: string               // e.g., "editor_08_00_a"
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
 * Validate a section name: letters and numbers only
 */
function isValidSectionName(name: string): boolean {
  return /^[A-Za-z0-9]+$/.test(name)
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

  // State tracking
  let currentEdition: Edition = {
    editionNumber: 0,
    time: '',
    name: 'Default',
    sections: [],
  }
  let currentSection: EditionSection = {
    name: '',
    code: '0',
    patterns: [],
  }
  let edition0SectionCount = 0
  let patternIndexInSection = 0

  // Track all section names globally
  const edition0SectionNames = new Set<string>()
  const allEditionSectionNames = new Map<number, Set<string>>() // editionNumber → names

  // Start with default section of edition0
  currentEdition.sections.push(currentSection)
  edition0SectionCount = 1

  for (const line of lines) {
    // Edition header: # hh:mm [EditionName]
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      // Finish current section/edition
      finishCurrentEdition()

      // Parse edition header
      const headerMatch = line.match(/^#\s+(\d{2}:\d{2})\s*(?:\[(.+?)\])?/)
      if (!headerMatch) {
        errors.push(`Invalid edition header: "${line}"`)
        continue
      }

      const time = headerMatch[1]
      const name = headerMatch[2]?.trim() || `${time} Edition`
      const editionNumber = editions.length  // edition0 is at index 0, so first named is 1

      if (editionNumber > 9) {
        errors.push(`Too many editions (max 9): "${line}"`)
        continue
      }

      currentEdition = {
        editionNumber,
        time,
        name,
        sections: [],
      }
      // Start default section for this edition
      currentSection = {
        name: '',
        code: 'a',
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
        errors.push(`Invalid section name (letters and numbers only): "${sectionName}"`)
        continue
      }

      if (currentEdition.editionNumber === 0) {
        // Edition0 section
        if (edition0SectionCount >= 10) {
          errors.push(`Edition0 can have at most 10 sections: "${sectionName}"`)
          continue
        }
        if (edition0SectionNames.has(sectionName)) {
          errors.push(`Duplicate section name in edition0: "${sectionName}"`)
          continue
        }
        edition0SectionNames.add(sectionName)
        const code = String(edition0SectionCount)
        currentSection = { name: sectionName, code, patterns: [] }
        edition0SectionCount++
      } else {
        // Edition1-9 section
        if (edition0SectionNames.has(sectionName)) {
          errors.push(`Edition${currentEdition.editionNumber} section "${sectionName}" conflicts with edition0 section`)
          continue
        }
        const edSections = allEditionSectionNames.get(currentEdition.editionNumber) || new Set()
        if (edSections.has(sectionName)) {
          errors.push(`Duplicate section name in edition${currentEdition.editionNumber}: "${sectionName}"`)
          continue
        }
        edSections.add(sectionName)

        // Letter code: a=default (already used), b, c, ...
        const sectionIndex = currentEdition.sections.length
        const code = String.fromCharCode(97 + sectionIndex) // a, b, c, ...
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
  const namedEditions = editions.filter(e => e.editionNumber > 0)

  // Must have at least one edition time
  if (namedEditions.length === 0) {
    errors.push('Edition layout must contain at least one edition time (# hh:mm)')
  }

  // Must have at least one pattern
  const totalPatterns = editions.reduce((sum, e) => sum + e.sections.reduce((s, sec) => s + sec.patterns.length, 0), 0)
  if (totalPatterns === 0) {
    errors.push('Edition layout must contain at least one pattern (@...)')
  }

  // Edition times must be in chronological order
  for (let i = 1; i < namedEditions.length; i++) {
    if (namedEditions[i].time <= namedEditions[i - 1].time) {
      errors.push(`Edition times must be in chronological order: "${namedEditions[i].time}" is not after "${namedEditions[i - 1].time}"`)
    }
  }

  // Edition times must be at least 2 × EDITION_PRE_OFFSET apart
  const PRE_OFFSET_MINUTES = EDITION_PRE_OFFSET_MS / 60_000
  const MIN_SPACING_MINUTES = 2 * PRE_OFFSET_MINUTES
  for (let i = 1; i < namedEditions.length; i++) {
    const [h1, m1] = namedEditions[i - 1].time.split(':').map(Number)
    const [h2, m2] = namedEditions[i].time.split(':').map(Number)
    const diffMinutes = (h2 * 60 + m2) - (h1 * 60 + m1)
    if (diffMinutes < MIN_SPACING_MINUTES) {
      errors.push(`Edition times must be at least ${MIN_SPACING_MINUTES} minutes apart: "${namedEditions[i - 1].time}" and "${namedEditions[i].time}" are ${diffMinutes} minutes apart`)
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
 * Generate fictitious editor users for all editions
 */
function generateEditorUsers(editions: Edition[]): void {
  const edition0 = editions.find(e => e.editionNumber === 0)
  const namedEditions = editions.filter(e => e.editionNumber > 0)

  for (const edition of namedEditions) {
    const timeStr = edition.time.replace(':', '_')

    // Generate users for edition-specific sections (letter codes)
    for (const section of edition.sections) {
      const handle = `editor_${timeStr}_${section.code}`
      const displayName = section.name
        ? `${edition.name}: ${section.name}`
        : edition.name
      registerEditorUser(handle, displayName, edition.editionNumber, section.code)
    }

    // Generate users for edition0 sections that may appear in this edition (digit codes)
    if (edition0) {
      for (const section of edition0.sections) {
        if (section.code === '0') continue // edition0 default uses target edition's default section-a user
        const handle = `editor_${timeStr}_${section.code}`
        const displayName = section.name
          ? `${edition.name}: ${section.name}`
          : edition.name
        registerEditorUser(handle, displayName, edition.editionNumber, section.code)
      }
    }
  }
}

/**
 * Get the editor user handle for a given edition time and section code
 */
export function getEditorHandle(editionTime: string, sectionCode: string): string {
  const timeStr = editionTime.replace(':', '_')
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
        topics: '',
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
    console.warn('[Editions] Parse errors:', cachedParsedEditions.errors)
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
