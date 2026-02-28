import { describe, it, expect, beforeEach } from 'vitest'
import { parseEditionFile, getEditorUser, getAllEditorUsers, HEAD_EDITION_NUMBER, TAIL_EDITION_NUMBER } from '../skylimitEditions'

describe('parseEditionFile', () => {
  beforeEach(() => {
    // Parse clears the registry, so each test starts fresh
  })

  it('should parse empty input', () => {
    const result = parseEditionFile('')
    expect(result.editions).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('should parse editionA with default section patterns', () => {
    const result = parseEditionFile('@user1.bsky.social\n@user2*')
    // Validation errors expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')
    expect(result.editions).toHaveLength(1)

    const edA = result.editions[0]
    expect(edA.editionNumber).toBe(HEAD_EDITION_NUMBER)
    expect(edA.sections).toHaveLength(1)
    expect(edA.sections[0].code).toBe('0')
    expect(edA.sections[0].patterns).toHaveLength(2)
    expect(edA.sections[0].patterns[0].userPattern).toBe('user1.bsky.social')
    expect(edA.sections[0].patterns[0].userPatternCode).toBe('00')
    expect(edA.sections[0].patterns[1].userPattern).toBe('user2*')
    expect(edA.sections[0].patterns[1].userPatternCode).toBe('01')
  })

  it('should parse editionA with named sections using a-z codes', () => {
    const input = `@user1
## Tech
@user2
## Sports
@user3`
    const result = parseEditionFile(input)
    // Validation error expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')

    const edA = result.editions[0]
    expect(edA.sections).toHaveLength(3) // default + Tech + Sports
    expect(edA.sections[0].code).toBe('0')
    expect(edA.sections[0].name).toBe('')
    expect(edA.sections[1].code).toBe('a')
    expect(edA.sections[1].name).toBe('Tech')
    expect(edA.sections[2].code).toBe('b')
    expect(edA.sections[2].name).toBe('Sports')
  })

  it('should parse # HEAD marker before patterns', () => {
    const input = `# HEAD
@user1*
## Tech
@user2*
# 08:00 Morning
@morning*`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)

    const edA = result.editions.find(e => e.editionNumber === HEAD_EDITION_NUMBER)!
    expect(edA).toBeDefined()
    expect(edA.sections).toHaveLength(2) // default + Tech
    expect(edA.sections[0].code).toBe('0')
    expect(edA.sections[0].patterns[0].userPattern).toBe('user1*')
    expect(edA.sections[1].code).toBe('a')
    expect(edA.sections[1].name).toBe('Tech')
  })

  it('should parse # TAIL marker after timed editions', () => {
    const input = `@head*
# 08:00 Morning
@morning*
# TAIL
@tail*
## Catchall
@*: #news`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)

    const edZ = result.editions.find(e => e.editionNumber === TAIL_EDITION_NUMBER)!
    expect(edZ).toBeDefined()
    expect(edZ.editionNumber).toBe(25)
    expect(edZ.sections).toHaveLength(2) // default + Catchall
    expect(edZ.sections[0].code).toBe('0')
    expect(edZ.sections[0].patterns[0].userPattern).toBe('tail*')
    expect(edZ.sections[1].code).toBe('a')
    expect(edZ.sections[1].name).toBe('Catchall')
  })

  it('should reject # HEAD after a timed edition', () => {
    const input = `# 08:00 Morning
@morning*
# HEAD
@head*`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('HEAD must appear before'))).toBe(true)
  })

  it('should parse edition headers with time and name', () => {
    const input = `@default*
# 08:00 Morning Edition
@morning*
# 18:00 Evening Edition
@evening*`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)
    expect(result.editions).toHaveLength(3) // editionA + 2 timed

    expect(result.editions[1].editionNumber).toBe(1)
    expect(result.editions[1].time).toBe('08:00')
    expect(result.editions[1].name).toBe('Morning Edition')

    expect(result.editions[2].editionNumber).toBe(2)
    expect(result.editions[2].time).toBe('18:00')
    expect(result.editions[2].name).toBe('Evening Edition')
  })

  it('should use default edition name when not specified', () => {
    const input = `@default*
# 12:00`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)
    expect(result.editions[1].name).toBe('12:00 Edition')
  })

  it('should parse patterns with text patterns', () => {
    const input = '@user*: #tech, artificial intelligence*, *blockchain'
    const result = parseEditionFile(input)
    // Validation error expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')

    const pattern = result.editions[0].sections[0].patterns[0]
    expect(pattern.userPattern).toBe('user*')
    expect(pattern.textPatterns).toHaveLength(3)
    expect(pattern.textPatterns[0].pattern).toBe('#tech')
    expect(pattern.textPatterns[0].letterCode).toBe('a')
    expect(pattern.textPatterns[0].isHashtag).toBe(true)
    expect(pattern.textPatterns[1].pattern).toBe('artificial intelligence*')
    expect(pattern.textPatterns[1].letterCode).toBe('b')
    expect(pattern.textPatterns[2].pattern).toBe('*blockchain')
    expect(pattern.textPatterns[2].letterCode).toBe('c')
  })

  it('should detect domain patterns', () => {
    const input = '@*: example.com*, *github.io'
    const result = parseEditionFile(input)
    // Validation error expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')

    const tps = result.editions[0].sections[0].patterns[0].textPatterns
    expect(tps[0].isDomain).toBe(true)
    expect(tps[1].isDomain).toBe(true)
  })

  it('should assign 0 + a-z codes to timed edition sections', () => {
    const input = `@default*
# 08:00 Morning
@section0*
## News
@news*
## Sports
@sports*`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)

    const ed1 = result.editions[1]
    expect(ed1.sections[0].code).toBe('0') // default section
    expect(ed1.sections[1].code).toBe('a') // News
    expect(ed1.sections[2].code).toBe('b') // Sports
  })

  it('should reject invalid section names', () => {
    const input = '## Invalid Name!'
    const result = parseEditionFile(input)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('Invalid section name')
  })

  it('should reject duplicate section names in editionA', () => {
    const input = `## Tech
@a*
## Tech
@b*`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('Duplicate section name'))).toBe(true)
  })

  it('should reject edition section names that conflict with editionA', () => {
    const input = `## Tech
@a*
# 08:00 Morning
## Tech
@b*`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('conflicts with'))).toBe(true)
  })

  it('should limit editionA to 26 named sections', () => {
    const sections = Array.from({ length: 27 }, (_, i) => `## Section${i}\n@user${i}*`)
    const input = sections.join('\n')
    const result = parseEditionFile(input)
    // Section '0' (default) + 26 named = 27, but limit is 26 named
    expect(result.errors.some(e => e.includes('at most 26'))).toBe(true)
  })

  it('should limit named edition sections to 26', () => {
    const sections = Array.from({ length: 27 }, (_, i) => `## Section${i}\n@user${i}*`)
    const input = `@default*\n# 08:00 Morning\n${sections.join('\n')}`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('at most 26'))).toBe(true)
  })

  it('should limit to 24 timed editions', () => {
    const editions = Array.from({ length: 25 }, (_, i) => {
      const h = Math.floor(i / 4)
      const m = (i % 4) * 15
      return `# ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} Ed${i + 1}\n@user${i}*`
    })
    const input = `@default*\n${editions.join('\n')}`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('Too many timed editions'))).toBe(true)
  })

  it('should limit patterns per section to 100', () => {
    const patterns = Array.from({ length: 101 }, (_, i) => `@user${i}*`)
    const input = patterns.join('\n')
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('Too many patterns'))).toBe(true)
  })

  it('should reject invalid user patterns', () => {
    const input = '@user name with spaces'
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('Invalid user pattern'))).toBe(true)
  })

  it('should generate editor users with head_ prefix for editionA sections', () => {
    const input = `@default*
## Section1
@section1*
# 08:00 Morning Edition
## News
@news*`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)

    const users = getAllEditorUsers()
    expect(users.length).toBeGreaterThan(0)

    // Timed edition named section user
    const newsUser = getEditorUser('editor_08_00_a')
    expect(newsUser).toBeDefined()
    expect(newsUser!.displayName).toBe('Morning Edition: News')

    // Default section (code '0') uses timed edition's default user
    const defaultUser = getEditorUser('editor_08_00_0')
    expect(defaultUser).toBeDefined()

    // EditionA named section with head_ prefix
    const headSection1User = getEditorUser('editor_08_00_head_a')
    expect(headSection1User).toBeDefined()
    expect(headSection1User!.displayName).toBe('Morning Edition: Section1')
  })

  it('should generate editor users with tail_ prefix for editionZ sections', () => {
    const input = `@default*
# 08:00 Morning Edition
@morning*
# TAIL
## Catchall
@*: #news`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)

    // EditionZ named section with tail_ prefix
    const tailUser = getEditorUser('editor_08_00_tail_a')
    expect(tailUser).toBeDefined()
    expect(tailUser!.displayName).toBe('Morning Edition: Catchall')
  })

  it('should not create separate editor users for HEAD/TAIL default sections', () => {
    const input = `@default*
# 08:00 Morning
@morning*
# TAIL
@tail*`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)

    // HEAD default section '0' should NOT get its own head_ prefixed user
    const headDefaultUser = getEditorUser('editor_08_00_head_0')
    expect(headDefaultUser).toBeUndefined()

    // TAIL default section '0' should NOT get its own tail_ prefixed user
    const tailDefaultUser = getEditorUser('editor_08_00_tail_0')
    expect(tailDefaultUser).toBeUndefined()

    // All defaults share the timed edition's default user
    const defaultUser = getEditorUser('editor_08_00_0')
    expect(defaultUser).toBeDefined()
  })

  it('should ignore blank lines', () => {
    const input = `@user1*\n\n\n@user2*\n\n`
    const result = parseEditionFile(input)
    // Validation error expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')
    expect(result.editions[0].sections[0].patterns).toHaveLength(2)
  })

  it('should parse full HEAD + timed + TAIL layout', () => {
    const input = `# HEAD
@*: #breaking
## Department
@coworker*

# 08:00 Morning Edition
@atprotocol.dev
## Substacks
@writer*: blog.substack.com

# 18:00 Evening Edition
## Coding
@simonwillison.net: vibe-coding

# TAIL
@*: longform*`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)

    // 4 editions: editionA, 2 timed, editionZ
    expect(result.editions).toHaveLength(4)

    const edA = result.editions.find(e => e.editionNumber === HEAD_EDITION_NUMBER)!
    expect(edA.sections).toHaveLength(2) // default + Department
    expect(edA.sections[0].code).toBe('0')
    expect(edA.sections[1].code).toBe('a')
    expect(edA.sections[1].name).toBe('Department')

    const edZ = result.editions.find(e => e.editionNumber === TAIL_EDITION_NUMBER)!
    expect(edZ.sections).toHaveLength(1) // default only
    expect(edZ.sections[0].code).toBe('0')

    const timed = result.editions.filter(e => e.editionNumber > 0 && e.editionNumber < TAIL_EDITION_NUMBER)
    expect(timed).toHaveLength(2)
    expect(timed[0].time).toBe('08:00')
    expect(timed[1].time).toBe('18:00')
  })
})
