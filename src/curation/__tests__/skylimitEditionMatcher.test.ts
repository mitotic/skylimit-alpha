import { describe, it, expect } from 'vitest'
import { matchUserPattern, matchTextPattern, matchPost, matchAtWordBoundary, normalizeText } from '../skylimitEditionMatcher'
import { parseEditionFile, HEAD_EDITION_NUMBER, TAIL_EDITION_NUMBER } from '../skylimitEditions'
import { PostSummary } from '../types'
import { TextPattern } from '../skylimitEditions'

describe('matchUserPattern', () => {
  it('should match wildcard *', () => {
    expect(matchUserPattern('anyone.bsky.social', '*')).toBe(true)
  })

  it('should match exact handle', () => {
    expect(matchUserPattern('user.bsky.social', 'user.bsky.social')).toBe(true)
    expect(matchUserPattern('user.bsky.social', 'other.bsky.social')).toBe(false)
  })

  it('should match prefix wildcard', () => {
    expect(matchUserPattern('techguy.bsky.social', 'tech*')).toBe(true)
    expect(matchUserPattern('sportsguy.bsky.social', 'tech*')).toBe(false)
  })

  it('should match suffix wildcard', () => {
    expect(matchUserPattern('user.bsky.social', '*.bsky.social')).toBe(true)
    expect(matchUserPattern('user.custom.domain', '*.bsky.social')).toBe(false)
  })

  it('should be case-insensitive', () => {
    expect(matchUserPattern('TechGuy.bsky.social', 'techguy*')).toBe(true)
    expect(matchUserPattern('user.bsky.social', 'User.Bsky.Social')).toBe(true)
  })
})

describe('matchTextPattern', () => {
  const makeTextPattern = (pattern: string): TextPattern => ({
    pattern,
    letterCode: 'a',
    isDomain: pattern.includes('.') && !pattern.startsWith('#'),
    isHashtag: pattern.startsWith('#'),
  })

  it('should match hashtag in post tags', () => {
    const tp = makeTextPattern('#tech')
    expect(matchTextPattern('some text', undefined, ['tech', 'news'], tp)).toBe(true)
    expect(matchTextPattern('some text', undefined, ['sports'], tp)).toBe(false)
  })

  it('should match exact word sequence', () => {
    const tp = makeTextPattern('artificial intelligence')
    expect(matchTextPattern('The future of artificial intelligence is here', undefined, [], tp)).toBe(true)
    expect(matchTextPattern('AI is the future', undefined, [], tp)).toBe(false)
  })

  it('should match prefix text pattern', () => {
    const tp = makeTextPattern('machine learn*')
    expect(matchTextPattern('machine learning is great', undefined, [], tp)).toBe(true)
    expect(matchTextPattern('deep learning', undefined, [], tp)).toBe(false)
  })

  it('should match suffix text pattern', () => {
    const tp = makeTextPattern('*blockchain')
    expect(matchTextPattern('the future of blockchain', undefined, [], tp)).toBe(true)
    expect(matchTextPattern('chain of blocks', undefined, [], tp)).toBe(false)
  })

  it('should match domain patterns', () => {
    const tp = makeTextPattern('github.com*')
    expect(matchTextPattern('check out github.com/repo', undefined, [], tp)).toBe(true)
    expect(matchTextPattern('no domain here', undefined, [], tp)).toBe(false)
  })

  it('should search in both post text and quoted text', () => {
    const tp = makeTextPattern('important topic')
    expect(matchTextPattern('random text', 'this is an important topic', [], tp)).toBe(true)
  })

  it('should be case-insensitive', () => {
    const tp = makeTextPattern('Machine Learning')
    expect(matchTextPattern('MACHINE LEARNING is cool', undefined, [], tp)).toBe(true)
  })

  it('should respect word boundaries for prefix pattern', () => {
    const tp = makeTextPattern('tech*')
    // "tech" at word boundary start → match
    expect(matchTextPattern('technology is advancing', undefined, [], tp)).toBe(true)
    // "tech" not at word boundary start → no match
    expect(matchTextPattern('biotech is growing', undefined, [], tp)).toBe(false)
    // "tech" at start of text → match
    expect(matchTextPattern('tech news today', undefined, [], tp)).toBe(true)
  })

  it('should respect word boundaries for suffix pattern', () => {
    const tp = makeTextPattern('*ology')
    // "ology" at word boundary end → match
    expect(matchTextPattern('studying technology', undefined, [], tp)).toBe(true)
    // "ology" not at word boundary end → no match
    expect(matchTextPattern('technological advances', undefined, [], tp)).toBe(false)
    // "ology" at end of text → match
    expect(matchTextPattern('advances in biology', undefined, [], tp)).toBe(true)
  })

  it('should respect word boundaries for exact pattern', () => {
    const tp = makeTextPattern('block')
    // "block" at word boundaries → match
    expect(matchTextPattern('a block of code', undefined, [], tp)).toBe(true)
    // "block" inside another word → no match
    expect(matchTextPattern('the blockchain revolution', undefined, [], tp)).toBe(false)
    // "block" at start of text → match
    expect(matchTextPattern('block party tonight', undefined, [], tp)).toBe(true)
  })

  it('should normalize multiple spaces in text and pattern', () => {
    const tp = makeTextPattern('machine  learning')
    expect(matchTextPattern('machine  learning is great', undefined, [], tp)).toBe(true)
    expect(matchTextPattern('machine learning is great', undefined, [], tp)).toBe(true)
  })

  it('should match domain with word boundary at start', () => {
    const tp = makeTextPattern('nytimes.com*')
    expect(matchTextPattern('check out nytimes.com/article', undefined, [], tp)).toBe(true)
    expect(matchTextPattern('visit fakenytimes.com', undefined, [], tp)).toBe(false)
  })

  it('should match domain with word boundary at end', () => {
    const tp = makeTextPattern('*.github.com')
    expect(matchTextPattern('visit user.github.com today', undefined, [], tp)).toBe(true)
    expect(matchTextPattern('visit user.github.company', undefined, [], tp)).toBe(false)
  })
})

describe('normalizeText', () => {
  it('should collapse multiple spaces', () => {
    expect(normalizeText('hello   world')).toBe('hello world')
  })

  it('should trim and lowercase', () => {
    expect(normalizeText('  Hello World  ')).toBe('hello world')
  })

  it('should normalize tabs and newlines', () => {
    expect(normalizeText('hello\t\nworld')).toBe('hello world')
  })
})

describe('matchAtWordBoundary', () => {
  it('contains mode requires both boundaries', () => {
    expect(matchAtWordBoundary('a block of code', 'block', 'contains')).toBe(true)
    expect(matchAtWordBoundary('the blockchain', 'block', 'contains')).toBe(false)
    expect(matchAtWordBoundary('blocked user', 'block', 'contains')).toBe(false)
  })

  it('startsWith mode requires only start boundary', () => {
    expect(matchAtWordBoundary('the blockchain', 'block', 'startsWith')).toBe(true)
    expect(matchAtWordBoundary('sunblock cream', 'block', 'startsWith')).toBe(false)
  })

  it('endsWith mode requires only end boundary', () => {
    expect(matchAtWordBoundary('a roadblock ahead', 'block', 'endsWith')).toBe(true)
    expect(matchAtWordBoundary('the blockchain', 'block', 'endsWith')).toBe(false)
  })

  it('matches at text start/end as word boundaries', () => {
    expect(matchAtWordBoundary('block of code', 'block', 'contains')).toBe(true)
    expect(matchAtWordBoundary('big block', 'block', 'contains')).toBe(true)
    expect(matchAtWordBoundary('block', 'block', 'contains')).toBe(true)
  })

  it('handles empty inputs', () => {
    expect(matchAtWordBoundary('some text', '', 'contains')).toBe(true)
    expect(matchAtWordBoundary('', 'word', 'contains')).toBe(false)
  })
})

describe('matchPost', () => {
  function makeSummary(overrides: Partial<PostSummary> = {}): PostSummary {
    return {
      uniqueId: 'at://did:plc:test/app.bsky.feed.post/123',
      cid: 'test-cid',
      username: 'testuser.bsky.social',
      accountDid: 'did:plc:test',
      tags: [],
      repostCount: 0,
      timestamp: new Date(),
      postTimestamp: Date.now(),
      postEngagement: undefined,
      ...overrides,
    }
  }

  it('should return null for empty editions', () => {
    const parsed = parseEditionFile('')
    const summary = makeSummary()
    expect(matchPost(summary, parsed)).toBeNull()
  })

  it('should return null when no patterns match', () => {
    const parsed = parseEditionFile(`@specific.user
# 08:00 Morning
@another.user`)
    const summary = makeSummary({ username: 'nomatch.bsky.social' })
    expect(matchPost(summary, parsed)).toBeNull()
  })

  it('should match user pattern in timed edition section', () => {
    const parsed = parseEditionFile(`@default*
# 08:00 Morning
@testuser*`)
    const summary = makeSummary({ username: 'testuser.bsky.social' })
    const result = matchPost(summary, parsed)

    expect(result).not.toBeNull()
    expect(result!.matchedEditionNumber).toBe(1)
    expect(result!.editionTime).toBe('08:00')
  })

  it('should match editionA (HEAD) pattern and assign to HEAD', () => {
    const parsed = parseEditionFile(`@testuser*
# 08:00 Morning
@other*`)
    const summary = makeSummary({ username: 'testuser.bsky.social' })
    const result = matchPost(summary, parsed)

    expect(result).not.toBeNull()
    expect(result!.matchedEditionNumber).toBe(HEAD_EDITION_NUMBER)
    // EditionA tag starts with 'a.'
    expect(result!.editionTag).toMatch(/^a\./)
  })

  it('should generate correct edition_tag format with letter codes', () => {
    const parsed = parseEditionFile(`@default.user
# 08:00 Morning
## News
@testuser*: #tech`)
    const summary = makeSummary({
      username: 'testuser.bsky.social',
      tags: ['tech'],
      postText: 'some text about #tech',
    })
    const result = matchPost(summary, parsed)

    expect(result).not.toBeNull()
    // match_edition=1 → letter 'b', section_code=a (News is 2nd section → 'a'), userpattern=00, textpattern=a
    expect(result!.editionTag).toBe('b.a.00a')
  })

  it('should match with text pattern including hashtag', () => {
    const parsed = parseEditionFile(`# 08:00 Morning
@*: #programming`)
    const summary = makeSummary({
      username: 'anyone.bsky.social',
      tags: ['programming'],
    })
    const result = matchPost(summary, parsed)

    expect(result).not.toBeNull()
    expect(result!.editionTag).toContain('00a') // first pattern, first text pattern
  })

  it('should not match when user matches but text pattern does not', () => {
    const parsed = parseEditionFile(`# 08:00 Morning
@testuser*: #specific`)
    const summary = makeSummary({
      username: 'testuser.bsky.social',
      tags: ['different'],
    })
    const result = matchPost(summary, parsed)
    expect(result).toBeNull()
  })

  it('should match top-to-bottom within edition (first match wins)', () => {
    const parsed = parseEditionFile(`# 08:00 Morning
@testuser*
@*: #tech`)
    // Both patterns match, but top-to-bottom means @testuser* (first/top) is checked first
    const summary = makeSummary({ username: 'testuser.bsky.social', tags: ['tech'] })
    const result = matchPost(summary, parsed)

    expect(result).not.toBeNull()
    // @testuser* is pattern index 00 (first in list), matched top-to-bottom
    expect(result!.editionTag).toContain('00')
  })

  it('should match HEAD patterns before timed editions', () => {
    const parsed = parseEditionFile(`@testuser*
# 08:00 Morning
@testuser*: #tech`)
    // HEAD has @testuser* (matches without text), timed has @testuser*: #tech
    const summary = makeSummary({ username: 'testuser.bsky.social', tags: ['tech'] })
    const result = matchPost(summary, parsed)

    expect(result).not.toBeNull()
    // HEAD matches first, so matchedEditionNumber should be 0
    expect(result!.matchedEditionNumber).toBe(HEAD_EDITION_NUMBER)
    expect(result!.editionTag).toMatch(/^a\./)
  })

  it('should match TAIL patterns only if HEAD and timed do not match', () => {
    const parsed = parseEditionFile(`@specific.user
# 08:00 Morning
@another.specific.user
# TAIL
@testuser*`)
    const summary = makeSummary({ username: 'testuser.bsky.social' })
    const result = matchPost(summary, parsed)

    expect(result).not.toBeNull()
    expect(result!.matchedEditionNumber).toBe(TAIL_EDITION_NUMBER)
    expect(result!.editionTag).toMatch(/^z\./)
  })

  it('should produce correct tags for HEAD, timed, and TAIL', () => {
    const parsed = parseEditionFile(`@head.user
# 08:00 Morning
@timed.user
# TAIL
@tail.user`)

    // HEAD match
    const headResult = matchPost(makeSummary({ username: 'head.user' }), parsed)
    expect(headResult).not.toBeNull()
    expect(headResult!.editionTag).toBe('a.0.00')

    // Timed match
    const timedResult = matchPost(makeSummary({ username: 'timed.user' }), parsed)
    expect(timedResult).not.toBeNull()
    expect(timedResult!.editionTag).toBe('b.0.00')

    // TAIL match
    const tailResult = matchPost(makeSummary({ username: 'tail.user' }), parsed)
    expect(tailResult).not.toBeNull()
    expect(tailResult!.editionTag).toBe('z.0.00')
  })

  it('should reject bare @* without text patterns', () => {
    const parsed = parseEditionFile(`# 08:00 Morning
@*`)
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.errors[0]).toContain('@* requires')
  })
})
