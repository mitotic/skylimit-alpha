import { describe, it, expect } from 'vitest'
import { parseSearchExpression, matchPostSummary } from '../localCacheSearch'
import { PostSummary } from '../types'

describe('parseSearchExpression', () => {
  it('should parse plain text as textPattern', () => {
    expect(parseSearchExpression('hello')).toEqual({ textPattern: 'hello' })
  })

  it('should parse handle + text with colon', () => {
    expect(parseSearchExpression('@alice: hello')).toEqual({
      handlePattern: 'alice',
      textPattern: 'hello',
    })
  })

  it('should parse handle with wildcard + text', () => {
    expect(parseSearchExpression('@alice*: hello')).toEqual({
      handlePattern: 'alice*',
      textPattern: 'hello',
    })
  })

  it('should parse handle + name + text', () => {
    expect(parseSearchExpression('@user*(Alice): tech')).toEqual({
      handlePattern: 'user*',
      namePattern: 'Alice',
      textPattern: 'tech',
    })
  })

  it('should parse wildcard handle + name with colon', () => {
    expect(parseSearchExpression('@*(Bob):')).toEqual({
      handlePattern: '*',
      namePattern: 'Bob',
    })
  })

  it('should parse handle-only without colon', () => {
    expect(parseSearchExpression('@alice')).toEqual({
      handlePattern: 'alice',
    })
  })

  it('should parse handle-only with wildcard', () => {
    expect(parseSearchExpression('@alice*')).toEqual({
      handlePattern: 'alice*',
    })
  })

  it('should return empty for empty input', () => {
    expect(parseSearchExpression('')).toEqual({})
    expect(parseSearchExpression('   ')).toEqual({})
  })

  it('should normalize multiple spaces', () => {
    expect(parseSearchExpression('hello   world')).toEqual({ textPattern: 'hello world' })
  })

  it('should handle suffix wildcard in handle', () => {
    expect(parseSearchExpression('@*.bsky.social: test')).toEqual({
      handlePattern: '*.bsky.social',
      textPattern: 'test',
    })
  })

  it('should handle name pattern with wildcard', () => {
    expect(parseSearchExpression('@*(Al*): news')).toEqual({
      handlePattern: '*',
      namePattern: 'Al*',
      textPattern: 'news',
    })
  })
})

describe('matchPostSummary', () => {
  function makePost(overrides: Partial<PostSummary> = {}): PostSummary {
    return {
      uniqueId: 'at://did:plc:test/app.bsky.feed.post/123',
      cid: 'test-cid',
      username: 'alice.bsky.social',
      accountDid: 'did:plc:alice',
      tags: [],
      repostCount: 0,
      timestamp: new Date(),
      postTimestamp: Date.now(),
      postEngagement: undefined,
      postText: 'Hello world',
      ...overrides,
    }
  }

  const emptyMap = new Map<string, string>()

  it('should match text pattern', () => {
    const post = makePost({ postText: 'The technology sector is growing' })
    expect(matchPostSummary(post, { textPattern: 'technology' }, emptyMap)).toBe(true)
    expect(matchPostSummary(post, { textPattern: 'biology' }, emptyMap)).toBe(false)
  })

  it('should match handle pattern', () => {
    const post = makePost({ username: 'alice.bsky.social' })
    expect(matchPostSummary(post, { handlePattern: 'alice*' }, emptyMap)).toBe(true)
    expect(matchPostSummary(post, { handlePattern: 'bob*' }, emptyMap)).toBe(false)
  })

  it('should match display name pattern', () => {
    const post = makePost({ accountDid: 'did:plc:alice' })
    const nameMap = new Map([['did:plc:alice', 'Alice Johnson']])
    expect(matchPostSummary(post, { handlePattern: '*', namePattern: 'Alice' }, nameMap)).toBe(true)
    expect(matchPostSummary(post, { handlePattern: '*', namePattern: 'Bob' }, nameMap)).toBe(false)
  })

  it('should require all specified patterns to match', () => {
    const post = makePost({ username: 'alice.bsky.social', postText: 'tech news today' })
    // Both match
    expect(matchPostSummary(post, { handlePattern: 'alice*', textPattern: 'tech' }, emptyMap)).toBe(true)
    // Handle matches, text doesn't
    expect(matchPostSummary(post, { handlePattern: 'alice*', textPattern: 'sports' }, emptyMap)).toBe(false)
    // Text matches, handle doesn't
    expect(matchPostSummary(post, { handlePattern: 'bob*', textPattern: 'tech' }, emptyMap)).toBe(false)
  })

  it('should use word boundary matching for text', () => {
    const post = makePost({ postText: 'technology is advancing fast' })
    expect(matchPostSummary(post, { textPattern: 'tech*' }, emptyMap)).toBe(true)
    expect(matchPostSummary(post, { textPattern: '*nology' }, emptyMap)).toBe(true)

    // "tech" without wildcard should not match inside "technology"
    expect(matchPostSummary(post, { textPattern: 'tech' }, emptyMap)).toBe(false)
  })

  it('should search quoted text too', () => {
    const post = makePost({ postText: 'my comment', quotedText: 'original post about science' })
    expect(matchPostSummary(post, { textPattern: 'science' }, emptyMap)).toBe(true)
  })

  it('should return true when no patterns specified', () => {
    const post = makePost()
    expect(matchPostSummary(post, {}, emptyMap)).toBe(true)
  })

  it('should fail name match when display name not in map', () => {
    const post = makePost({ accountDid: 'did:plc:unknown' })
    expect(matchPostSummary(post, { handlePattern: '*', namePattern: 'Someone' }, emptyMap)).toBe(false)
  })
})
