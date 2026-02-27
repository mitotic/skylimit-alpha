/**
 * Edition assembly
 *
 * Assembles held posts into synthetic reposts by fictitious editor users
 * and inserts them into the feed during secondary-to-primary cache transfer.
 */

import { AppBskyFeedDefs } from '@atproto/api'
import type { BskyAgent } from '@atproto/api'
import { CurationFeedViewPost, FeedCacheEntry, PostSummary } from './types'
import { getPostSummariesInRange } from './skylimitCache'
import { getEditorHandle, getEditorUser, editorUserToProfileView, getParsedEditions } from './skylimitEditions'
import { clientNow } from '../utils/clientClock'

export const EDITION_LOOKBACK_HOURS = 25
const EDITION_LOOKBACK_MS = EDITION_LOOKBACK_HOURS * 60 * 60 * 1000

/**
 * Assemble an edition: collect held posts, sort them, and create synthetic reposts.
 *
 * This function is designed for reuse during secondary-to-primary cache transfer
 * for missed editions.
 *
 * @param editionNumber - The edition number (1-9)
 * @param editionTime - The edition time string ("hh:mm")
 * @param gapStart - Timestamp of the post before the gap
 * @param gapEnd - Timestamp of the post after the gap
 * @returns Array of synthetic FeedViewPost reposts to insert
 */
export async function tryCreateEdition(
  editionNumber: number,
  editionTime: string,
  gapStart: number,
  _gapEnd: number,
  pendingSummaries: PostSummary[] = []
): Promise<CurationFeedViewPost[]> {
  // Query held summaries older than the gap boundary.
  // In-memory pendingSummaries are filtered to <= gapStart and deduped
  // against IndexedDB results before concatenation.
  const lookbackStart = gapStart - EDITION_LOOKBACK_MS
  const dbSummaries = await getPostSummariesInRange(lookbackStart, gapStart)
  const inMemoryHeld = pendingSummaries.filter(s => s.postTimestamp <= gapStart)

  const dbUniqueIds = new Set(dbSummaries.map(s => s.uniqueId))
  const duplicateCount = inMemoryHeld.filter(s => dbUniqueIds.has(s.uniqueId)).length
  if (duplicateCount > 0) {
    console.warn(`[Edition] ${duplicateCount} duplicate summaries found between in-memory and IndexedDB sources`)
  }
  const dedupedInMemory = inMemoryHeld.filter(s => !dbUniqueIds.has(s.uniqueId))
  const summaries = [...dedupedInMemory, ...dbSummaries]

  const heldCount = summaries.filter(s => s.edition_status === 'hold').length
  console.log(`[Edition] Lookback window: ${new Date(lookbackStart).toLocaleString()} to ${new Date(gapStart).toLocaleString()} | sources: ${dedupedInMemory.length} in-memory, ${dbSummaries.length} IndexedDB (${summaries.length} total, ${heldCount} held)`)

  const editionStr = String(editionNumber)
  const heldPosts = summaries.filter(s =>
    s.edition_status === 'hold' &&
    s.edition_tag &&
    (s.edition_tag.startsWith(editionStr) || s.edition_tag.startsWith('0'))
  )

  if (heldPosts.length === 0) {
    console.log(`[Edition] No held posts for edition ${editionNumber} (${editionTime})`)
    return []
  }

  console.log(`[Edition] Assembling edition ${editionNumber} (${editionTime}) with ${heldPosts.length} held posts`)

  // Remap edition_tag first character to control sort order:
  // - Edition-N default section (section 'a') → change to '0' (combined default, sorts last)
  // - Edition0 named sections (digit 1-9) → change to '1' (sorts between default and edition-specific)
  for (const post of heldPosts) {
    const tag = post.edition_tag!
    const firstChar = tag.charAt(0)
    const sectionCode = tag.charAt(2) // format: <digit>.<section>.<pattern>
    if (firstChar !== '0' && sectionCode === 'a') {
      post.edition_tag = '0' + tag.substring(1)
    } else if (firstChar === '0' && sectionCode >= '1' && sectionCode <= '9') {
      post.edition_tag = '1' + tag.substring(1)
    }
  }

  // Sort by edition_tag descending (first section gets newest timestamp)
  // Within same tag: sort by username descending, then postTimestamp descending
  heldPosts.sort((a, b) => {
    const tagCmp = (b.edition_tag || '').localeCompare(a.edition_tag || '')
    if (tagCmp !== 0) return tagCmp
    const handleCmp = b.username.localeCompare(a.username)
    if (handleCmp !== 0) return handleCmp
    return b.postTimestamp - a.postTimestamp
  })

  // Create synthetic reposts with 1ms-spaced timestamps starting at gapStart + 1ms
  const syntheticPosts: CurationFeedViewPost[] = []
  const insertStartTime = gapStart + 1 // 1ms after gap start

  for (let i = 0; i < heldPosts.length; i++) {
    const summary = heldPosts[i]
    const insertTime = insertStartTime + i // 1ms spacing

    // Determine the section code from the edition_tag
    // Tag format: <edition>.<section_code>.<pattern_code>
    let sectionCode = summary.edition_tag!.charAt(2) // char after first period is section code
    // Edition0 default section (code '0') uses the target edition's default section user (code 'a')
    if (sectionCode === '0') sectionCode = 'a'

    // Get the editor user for this section
    const editorHandle = getEditorHandle(editionTime, sectionCode)
    const editorUser = getEditorUser(editorHandle)

    if (!editorUser) {
      console.warn(`[Edition] No editor user found for handle: ${editorHandle}`)
      continue
    }

    // Create a synthetic FeedViewPost that looks like a repost by the editor
    const syntheticPost: CurationFeedViewPost = {
      post: {
        uri: summary.uniqueId,
        cid: summary.cid,
        author: {
          did: summary.accountDid,
          handle: summary.username,
          displayName: summary.orig_username || summary.username,
        },
        record: {
          $type: 'app.bsky.feed.post',
          text: summary.postText || '',
          createdAt: new Date(summary.postTimestamp).toISOString(),
        },
        indexedAt: new Date(summary.postTimestamp).toISOString(),
        likeCount: 0,
        replyCount: 0,
        repostCount: summary.repostCount,
      },
      reason: {
        $type: 'app.bsky.feed.defs#reasonRepost',
        by: editorUserToProfileView(editorUser),
        indexedAt: new Date(insertTime).toISOString(),
      },
      curation: {
        curation_status: 'edition_publish_show',
        curation_msg: `Edition ${editionTime}: ${editorUser.displayName}`,
        edition_status: 'synthetic',
      },
    }

    syntheticPosts.push(syntheticPost)

    console.log(`[Edition/DEBUG] Synthetic: insertTime=${new Date(insertTime).toLocaleTimeString()} editor=@${editorHandle} ("${editorUser.displayName}") original=@${summary.username} tag=${summary.edition_tag} pattern="${summary.edition_pattern || ''}"`)

    // Mark the held post as published
    summary.edition_status = 'published'
  }

  // Save the updated summaries (with edition_status = "published")
  if (heldPosts.length > 0) {
    const { savePostSummaries } = await import('./skylimitCache')
    await savePostSummaries(heldPosts)
  }

  console.log(`[Edition] Created ${syntheticPosts.length} synthetic reposts for edition ${editionNumber} (${editionTime})`)

  return syntheticPosts
}

// --- Edition display data retrieval ---

export interface EditionDisplaySection {
  code: string            // section code: "a", "b", etc.
  name: string            // "" for default, "Tech" for named sections
  posts: CurationFeedViewPost[]
}

export interface EditionDisplayData {
  editionTime: string     // "08:00"
  editionDate: Date       // date derived from synthetic post timestamps
  editionName: string     // "Morning Edition"
  sections: EditionDisplaySection[]
}

/**
 * Parse an editor handle to extract edition time and section code.
 * Handle format: "editor_HH_MM_X" where X is the section code.
 * Returns null if the handle doesn't match the expected format.
 */
function parseEditorHandle(handle: string): { editionTime: string; sectionCode: string } | null {
  const match = handle.match(/^editor_(\d{2})_(\d{2})_([a-z0-9])$/)
  if (!match) return null
  return {
    editionTime: `${match[1]}:${match[2]}`,
    sectionCode: match[3],
  }
}

/**
 * Retrieve assembled editions from the cache for display in the Editions tab.
 *
 * Queries PostSummaries for synthetic edition posts, groups them by edition
 * and section, then retrieves the full original post data from the feed cache
 * (or server) for complete rendering with media.
 *
 * @param agent - BskyAgent for fetching posts not found in cache
 * @returns Array of editions ordered chronologically (newest first)
 */
export async function getAssembledEditions(agent: BskyAgent | null): Promise<EditionDisplayData[]> {
  const now = clientNow()
  const lookbackStart = now - EDITION_LOOKBACK_MS

  // Step 1: Get all synthetic summaries from the lookback window
  const allSummaries = await getPostSummariesInRange(lookbackStart, now)
  const syntheticSummaries = allSummaries.filter(s => s.edition_status === 'synthetic')

  if (syntheticSummaries.length === 0) {
    return []
  }

  // Step 2: Group summaries by edition date+time using editor handle
  // Key is "YYYY-MM-DD_HH:MM" to distinguish same-time editions on different days
  // Map: editionKey -> { editionTime, sectionMap: Map<sectionCode, PostSummary[]> }
  const editionMap = new Map<string, { editionTime: string; sectionMap: Map<string, PostSummary[]> }>()

  for (const summary of syntheticSummaries) {
    const parsed = parseEditorHandle(summary.username)
    if (!parsed) continue

    // Derive date from the synthetic post's timestamp
    const postDate = new Date(summary.postTimestamp)
    const dateStr = `${postDate.getFullYear()}-${String(postDate.getMonth() + 1).padStart(2, '0')}-${String(postDate.getDate()).padStart(2, '0')}`
    const editionKey = `${dateStr}_${parsed.editionTime}`

    let entry = editionMap.get(editionKey)
    if (!entry) {
      entry = { editionTime: parsed.editionTime, sectionMap: new Map() }
      editionMap.set(editionKey, entry)
    }

    let sectionPosts = entry.sectionMap.get(parsed.sectionCode)
    if (!sectionPosts) {
      sectionPosts = []
      entry.sectionMap.set(parsed.sectionCode, sectionPosts)
    }
    sectionPosts.push(summary)
  }

  // Step 3: Get edition metadata from parsed layout
  const parsedEditions = await getParsedEditions()
  const editionsByTime = new Map<string, { name: string; sectionNames: Map<string, string> }>()
  for (const edition of parsedEditions.editions) {
    if (edition.editionNumber === 0) continue // skip default edition (edition0 has no time)
    const sectionNames = new Map<string, string>()
    for (const section of edition.sections) {
      sectionNames.set(section.code, section.name)
    }
    editionsByTime.set(edition.time, { name: edition.name, sectionNames })
  }

  // Step 4: Retrieve full original posts for rendering
  // The synthetic posts in the feed cache lack embed data. The ORIGINAL posts
  // (which were held for the edition) should still be in the feed cache with
  // full data including embeds. Look up by repostUri (the original post URI).
  const { getDB } = await import('./skylimitCache')
  const database = await getDB()

  // Collect original post URIs from repostUri field
  const originalPostUris = new Set<string>()
  for (const summary of syntheticSummaries) {
    if (summary.repostUri) {
      originalPostUris.add(summary.repostUri)
    }
  }

  // Batch fetch original posts from feed cache
  const originalPostMap = new Map<string, AppBskyFeedDefs.PostView>()
  if (originalPostUris.size > 0) {
    const transaction = database.transaction(['feed_cache'], 'readonly')
    const store = transaction.objectStore('feed_cache')

    await Promise.all([...originalPostUris].map(uri =>
      new Promise<void>((resolve) => {
        const request = store.get(uri)
        request.onsuccess = () => {
          if (request.result) {
            const entry = request.result as FeedCacheEntry
            originalPostMap.set(uri, entry.post.post)
          }
          resolve()
        }
        request.onerror = () => resolve()
      })
    ))
  }

  // Fetch missing posts from server (older editions where originals were evicted)
  const missingUris = [...originalPostUris].filter(uri => !originalPostMap.has(uri))
  if (missingUris.length > 0 && agent) {
    console.log(`[Edition] Fetching ${missingUris.length} posts from server (not in feed cache)`)
    try {
      // agent.getPosts accepts up to 25 URIs at a time
      for (let i = 0; i < missingUris.length; i += 25) {
        const batch = missingUris.slice(i, i + 25)
        const response = await agent.getPosts({ uris: batch })
        for (const post of response.data.posts) {
          originalPostMap.set(post.uri, post)
        }
      }
    } catch (error) {
      console.warn('[Edition] Failed to fetch posts from server:', error)
    }
  }

  // Also fetch synthetic posts from feed cache (for the reason/curation metadata)
  const syntheticPostMap = new Map<string, CurationFeedViewPost>()
  {
    const transaction = database.transaction(['feed_cache'], 'readonly')
    const store = transaction.objectStore('feed_cache')

    await Promise.all(syntheticSummaries.map(s =>
      new Promise<void>((resolve) => {
        const request = store.get(s.uniqueId)
        request.onsuccess = () => {
          if (request.result) {
            const entry = request.result as FeedCacheEntry
            syntheticPostMap.set(s.uniqueId, entry.post as CurationFeedViewPost)
          }
          resolve()
        }
        request.onerror = () => resolve()
      })
    ))
  }

  // Step 5: Build EditionDisplayData array
  const editions: EditionDisplayData[] = []

  for (const [, { editionTime, sectionMap }] of editionMap) {
    const editionMeta = editionsByTime.get(editionTime)
    const editionName = editionMeta?.name || editionTime

    const sections: EditionDisplaySection[] = []

    // Sort section codes: 'a' (default) first, then alphabetically
    const sortedCodes = [...sectionMap.keys()].sort((a, b) => {
      if (a === 'a') return -1
      if (b === 'a') return 1
      return a.localeCompare(b)
    })

    for (const code of sortedCodes) {
      const summaries = sectionMap.get(code)!
      // Sort by postTimestamp descending (newest first) — timestamps preserve edition ordering
      summaries.sort((a, b) => b.postTimestamp - a.postTimestamp)

      const posts: CurationFeedViewPost[] = []
      for (const summary of summaries) {
        // Get the synthetic post (for reason/curation metadata)
        const syntheticPost = syntheticPostMap.get(summary.uniqueId)

        // Get the original post (for full post data with embeds)
        const originalPost = summary.repostUri ? originalPostMap.get(summary.repostUri) : undefined

        if (originalPost && syntheticPost) {
          // Combine: original post data + synthetic edition metadata
          const editionPost: CurationFeedViewPost = {
            post: originalPost,
            reason: syntheticPost.reason,
            curation: {
              curation_status: 'edition_publish_show',
              edition_status: 'synthetic',
              edition_summary_id: summary.uniqueId,
            },
          }
          posts.push(editionPost)
        } else if (syntheticPost) {
          // Fallback: use synthetic post as-is (text only, no embeds)
          if (!syntheticPost.curation) {
            syntheticPost.curation = {
              curation_status: 'edition_publish_show',
              edition_status: 'synthetic',
              edition_summary_id: summary.uniqueId,
            }
          }
          posts.push(syntheticPost)
        }
      }

      const sectionName = code === 'a'
        ? ''
        : editionMeta?.sectionNames.get(code) || `Section ${code.toUpperCase()}`

      if (posts.length > 0) {
        sections.push({ code, name: sectionName, posts })
      }
    }

    if (sections.length > 0) {
      // Derive edition date from actual assembly time of synthetic posts
      const allSummariesForEdition = [...sectionMap.values()].flat()
      const earliestTimestamp = Math.min(...allSummariesForEdition.map(s => s.postTimestamp))
      const editionDate = new Date(earliestTimestamp)

      editions.push({ editionTime, editionDate, editionName, sections })
    }
  }

  // Sort editions chronologically, newest first
  editions.sort((a, b) => b.editionDate.getTime() - a.editionDate.getTime())

  const cachedCount = syntheticSummaries.filter(s => s.repostUri && originalPostMap.has(s.repostUri)).length
  const fetchedCount = missingUris.filter(uri => originalPostMap.has(uri)).length
  console.log(`[Edition] Retrieved ${editions.length} editions for display (${syntheticSummaries.length} synthetic posts, ${cachedCount} from cache, ${fetchedCount} from server)`)
  return editions
}
