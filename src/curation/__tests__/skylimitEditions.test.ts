import { describe, it, expect, beforeEach } from 'vitest'
import { parseEditionFile, getEditorUser, getAllEditorUsers } from '../skylimitEditions'

describe('parseEditionFile', () => {
  beforeEach(() => {
    // Parse clears the registry, so each test starts fresh
  })

  it('should parse empty input', () => {
    const result = parseEditionFile('')
    expect(result.editions).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('should parse edition0 with default section patterns', () => {
    const result = parseEditionFile('@user1.bsky.social\n@user2*')
    // Validation errors expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')
    expect(result.editions).toHaveLength(1)

    const ed0 = result.editions[0]
    expect(ed0.editionNumber).toBe(0)
    expect(ed0.sections).toHaveLength(1)
    expect(ed0.sections[0].code).toBe('0')
    expect(ed0.sections[0].patterns).toHaveLength(2)
    expect(ed0.sections[0].patterns[0].userPattern).toBe('user1.bsky.social')
    expect(ed0.sections[0].patterns[0].userPatternCode).toBe('00')
    expect(ed0.sections[0].patterns[1].userPattern).toBe('user2*')
    expect(ed0.sections[0].patterns[1].userPatternCode).toBe('01')
  })

  it('should parse edition0 with named sections', () => {
    const input = `@user1
## Tech
@user2
## Sports
@user3`
    const result = parseEditionFile(input)
    // Validation error expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')

    const ed0 = result.editions[0]
    expect(ed0.sections).toHaveLength(3) // default + Tech + Sports
    expect(ed0.sections[0].code).toBe('0')
    expect(ed0.sections[0].name).toBe('')
    expect(ed0.sections[1].code).toBe('1')
    expect(ed0.sections[1].name).toBe('Tech')
    expect(ed0.sections[2].code).toBe('2')
    expect(ed0.sections[2].name).toBe('Sports')
  })

  it('should parse edition headers with time and name', () => {
    const input = `@default*
# 08:00 Morning Edition
@morning*
# 18:00 Evening Edition
@evening*`
    const result = parseEditionFile(input)
    expect(result.errors).toHaveLength(0)
    expect(result.editions).toHaveLength(3) // edition0 + 2 named

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

  it('should assign letter codes to edition sections', () => {
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
    expect(ed1.sections[0].code).toBe('a') // default section
    expect(ed1.sections[1].code).toBe('b') // News
    expect(ed1.sections[2].code).toBe('c') // Sports
  })

  it('should reject invalid section names', () => {
    const input = '## Invalid Name!'
    const result = parseEditionFile(input)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('Invalid section name')
  })

  it('should reject duplicate section names in edition0', () => {
    const input = `## Tech
@a*
## Tech
@b*`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('Duplicate section name'))).toBe(true)
  })

  it('should reject edition section names that conflict with edition0', () => {
    const input = `## Tech
@a*
# 08:00 Morning
## Tech
@b*`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('conflicts with edition0'))).toBe(true)
  })

  it('should limit edition0 to 10 sections', () => {
    const sections = Array.from({ length: 11 }, (_, i) => `## Section${i}\n@user${i}*`)
    const input = sections.join('\n')
    const result = parseEditionFile(input)
    // Section0 (default) + 10 named = 11, but limit is 10 total
    expect(result.errors.some(e => e.includes('at most 10'))).toBe(true)
  })

  it('should limit named edition sections to 26', () => {
    const sections = Array.from({ length: 27 }, (_, i) => `## Section${i}\n@user${i}*`)
    const input = `@default*\n# 08:00 Morning\n${sections.join('\n')}`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('at most 26'))).toBe(true)
  })

  it('should limit to 9 editions', () => {
    const editions = Array.from({ length: 10 }, (_, i) =>
      `# ${String(i + 8).padStart(2, '0')}:00 Ed${i + 1}\n@user${i}*`
    )
    const input = `@default*\n${editions.join('\n')}`
    const result = parseEditionFile(input)
    expect(result.errors.some(e => e.includes('Too many editions'))).toBe(true)
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

  it('should generate fictitious editor users', () => {
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

    // Check edition-specific section user
    const newsUser = getEditorUser('editor_08_00_b')
    expect(newsUser).toBeDefined()
    expect(newsUser!.displayName).toBe('Morning Edition: News')

    // Edition0 default section (code '0') should NOT get its own user;
    // it remaps to the target edition's default section user (code 'a')
    const section0User = getEditorUser('editor_08_00_0')
    expect(section0User).toBeUndefined()

    const section1User = getEditorUser('editor_08_00_1')
    expect(section1User).toBeDefined()
    expect(section1User!.displayName).toBe('Morning Edition: Section1')
  })

  it('should ignore blank lines', () => {
    const input = `@user1*\n\n\n@user2*\n\n`
    const result = parseEditionFile(input)
    // Validation error expected: no edition time header
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('at least one edition time')
    expect(result.editions[0].sections[0].patterns).toHaveLength(2)
  })
})
