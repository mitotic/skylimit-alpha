/**
 * Edition assembly
 *
 * Assembles held posts into synthetic reposts by fictitious editor users
 * and inserts them into the feed during secondary-to-primary cache transfer.
 *
 * Edition tag format after remapping:
 *   a.0 = editionA (HEAD) default, a.1 = timed default, a.2 = editionZ (TAIL) default
 *   a.a-z = editionA named sections, b-y.a-z = timed named, z.a-z = editionZ named
 */

import { AppBskyFeedDefs } from '@atproto/api'
import type { BskyAgent } from '@atproto/api'
import { CurationFeedViewPost, EditionRegistryEntry, FeedCacheEntry, PostSummary } from './types'
import { getPostSummariesInRange } from './skylimitCache'
import { getEditorHandle, getEditorUser, editorUserToProfileView, getParsedEditions, editionLetter, HEAD_EDITION_NUMBER, TAIL_EDITION_NUMBER } from './skylimitEditions'
import { clientNow } from '../utils/clientClock'
import { getSettings } from './skylimitStore'
import { getEditionRegistry } from './editionRegistry'
import log from '../utils/logger'

export async function getEditionLookbackMs(): Promise<number> {
  const settings = await getSettings()
  const days = settings?.initialLookbackDays ?? 1
  return (24 * days + 1) * 60 * 60 * 1000
}

/**
 * Assemble an edition: collect held posts, sort them, and create synthetic reposts.
 *
 * This function is designed for reuse during secondary-to-primary cache transfer
 * for missed editions.
 *
 * @param editionNumber - The edition number (1-24 for timed editions)
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
  pendingSummaries: PostSummary[] = [],
  editionTimestamp: number
): Promise<CurationFeedViewPost[]> {
  // Query held summaries older than the gap boundary.
  // In-memory pendingSummaries are filtered to <= gapStart and deduped
  // against IndexedDB results before concatenation.
  const lookbackStart = gapStart - await getEditionLookbackMs()
  const dbSummaries = await getPostSummariesInRange(lookbackStart, gapStart)
  const inMemoryHeld = pendingSummaries.filter(s => s.postTimestamp <= gapStart)

  const dbUniqueIds = new Set(dbSummaries.map(s => s.uniqueId))
  const duplicateCount = inMemoryHeld.filter(s => dbUniqueIds.has(s.uniqueId)).length
  if (duplicateCount > 0) {
    log.warn('Edition', `${duplicateCount} duplicate summaries found between in-memory and IndexedDB sources`)
  }
  const dedupedInMemory = inMemoryHeld.filter(s => !dbUniqueIds.has(s.uniqueId))
  const summaries = [...dedupedInMemory, ...dbSummaries]

  const heldCount = summaries.filter(s => s.edition_status === 'hold').length
  log.debug('Edition', `Lookback window: ${new Date(lookbackStart).toLocaleString()} to ${new Date(gapStart).toLocaleString()} | sources: ${dedupedInMemory.length} in-memory, ${dbSummaries.length} IndexedDB (${summaries.length} total, ${heldCount} held)`)

  // Collect held posts: match timed edition letter, editionA ('a'), and editionZ ('z')
  const edLetter = editionLetter(editionNumber)
  const heldPosts = summaries.filter(s =>
    s.edition_status === 'hold' &&
    s.edition_tag &&
    (s.edition_tag.startsWith(edLetter) || s.edition_tag.startsWith('a') || s.edition_tag.startsWith('z'))
  )

  if (heldPosts.length === 0) {
    log.debug('Edition', `No held posts for edition ${editionNumber} (${editionTime})`)
    return []
  }

  log.debug('Edition', `Assembling edition ${editionNumber} (${editionTime}) with ${heldPosts.length} held posts`)

  // Compute editionKey early so we can store it on published summaries
  const keyDate = new Date(editionTimestamp)
  const dateStr = `${keyDate.getFullYear()}-${String(keyDate.getMonth() + 1).padStart(2, '0')}-${String(keyDate.getDate()).padStart(2, '0')}`
  const editionKey = `${dateStr}_${editionTime}`

  // Remap edition_tag to control sort order (only 2 rules):
  // - Timed edition default (N.0 where N=b-y) → 'a.1' (combined default)
  // - EditionZ default (z.0) → 'a.2' (combined default)
  // Everything else stays as-is:
  //   EditionA default (a.0), editionA named (a.a-z), timed named (b-y.a-z), editionZ named (z.a-z)
  for (const post of heldPosts) {
    const tag = post.edition_tag!
    const tagLetter = tag.charAt(0)
    const sectionCode = tag.charAt(2)

    if (tagLetter >= 'b' && tagLetter <= 'y' && sectionCode === '0') {
      // Timed edition default → combined default position 1
      post.edition_tag = 'a.1' + tag.substring(3)
    } else if (tagLetter === 'z' && sectionCode === '0') {
      // EditionZ default → combined default position 2
      post.edition_tag = 'a.2' + tag.substring(3)
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

    // Derive editor handle from the remapped edition_tag
    const tagEdLetter = summary.edition_tag!.charAt(0)
    const sectionCode = summary.edition_tag!.charAt(2)
    let editorHandle: string

    if (sectionCode === '0' || sectionCode === '1' || sectionCode === '2') {
      // All defaults (editionA, timed, editionZ) use timed edition's default user
      editorHandle = getEditorHandle(editionTime, '0')
    } else if (tagEdLetter === 'a') {
      // EditionA named section
      editorHandle = getEditorHandle(editionTime, sectionCode, 'head')
    } else if (tagEdLetter === 'z') {
      // EditionZ named section
      editorHandle = getEditorHandle(editionTime, sectionCode, 'tail')
    } else {
      // Timed named section
      editorHandle = getEditorHandle(editionTime, sectionCode)
    }

    const editorUser = getEditorUser(editorHandle)

    if (!editorUser) {
      log.warn('Edition', `No editor user found for handle: ${editorHandle}`)
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
        curationNumber: i + 1,  // 1 = oldest repost (lowest synthetic timestamp)
        matching_pattern: summary.matching_pattern || '',
      },
    }

    syntheticPosts.push(syntheticPost)

    log.verbose('Edition', `Synthetic: insertTime=${new Date(insertTime).toLocaleTimeString()} editor=@${editorHandle} ("${editorUser.displayName}") original=@${summary.username} tag=${summary.edition_tag} pattern="${summary.matching_pattern || ''}"`)

    // Mark the held post as published with its edition key
    summary.edition_status = `published:${editionKey}`
    log.trace('edited', summary.username, summary.postTimestamp, summary.postText || '',
      `edition=${editionTime} key=${editionKey} pattern="${summary.matching_pattern}"`)
  }

  // Save the updated summaries (with edition_status = "published:KEY").
  // Must use savePostSummariesForce because savePostSummaries skips existing
  // records — posts loaded from IndexedDB would have their update silently dropped.
  if (heldPosts.length > 0) {
    const { savePostSummariesForce } = await import('./skylimitCache')
    await savePostSummariesForce(heldPosts)
  }

  // Save edition to registry for navigation
  if (syntheticPosts.length > 0) {
    const { saveEditionToRegistry } = await import('./editionRegistry')
    const parsedEditions = await getParsedEditions()
    const editionMeta = parsedEditions.editions.find(e => e.time === editionTime)
    const editionName = editionMeta?.name || editionTime

    // editionKey was computed before the loop using editionTimestamp (nominal edition time),
    // NOT gapStart, to match the key constructed in feedCacheFetch.ts for duplicate checks.
    saveEditionToRegistry({
      editionKey,
      editionName,
      createdAt: clientNow(),
      startPostTimestamp: insertStartTime,
      endPostTimestamp: insertStartTime + syntheticPosts.length - 1,
      oldestOriginalTimestamp: Math.min(...heldPosts.map(s => s.postTimestamp)),
    })
    log.debug('Edition', `Saved registry entry: ${editionKey} (${editionName}), ${syntheticPosts.length} posts`)
  }

  log.debug('Edition', `Created ${syntheticPosts.length} synthetic reposts for edition ${editionNumber} (${editionTime})`)

  return syntheticPosts
}

// --- Edition display data retrieval ---

export interface EditionDisplaySection {
  code: string            // section code or composite key: "0", "a", "head_a", "tail_b"
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
 * Parsed editor handle with edition type information
 */
interface ParsedEditorHandle {
  editionTime: string
  sectionCode: string
  editionType: 'head' | 'timed' | 'tail'
}

/**
 * Parse an editor handle to extract edition time, section code, and edition type.
 * Handle formats:
 *   "editor_HH_MM_X"        — timed section (editionType='timed')
 *   "editor_HH_MM_head_X"   — editionA named section (editionType='head')
 *   "editor_HH_MM_tail_X"   — editionZ named section (editionType='tail')
 * Returns null if the handle doesn't match any expected format.
 */
function parseEditorHandle(handle: string): ParsedEditorHandle | null {
  const lower = handle.toLowerCase()
  // EditionA: editor_hh_mm_head_x
  const headMatch = lower.match(/^editor_(\d{2})_(\d{2})_head_([a-z0-9])$/)
  if (headMatch) {
    return { editionTime: `${headMatch[1]}:${headMatch[2]}`, sectionCode: headMatch[3], editionType: 'head' }
  }
  // EditionZ: editor_hh_mm_tail_x
  const tailMatch = lower.match(/^editor_(\d{2})_(\d{2})_tail_([a-z0-9])$/)
  if (tailMatch) {
    return { editionTime: `${tailMatch[1]}:${tailMatch[2]}`, sectionCode: tailMatch[3], editionType: 'tail' }
  }
  // Timed: editor_hh_mm_x
  const match = lower.match(/^editor_(\d{2})_(\d{2})_([a-z0-9])$/)
  if (!match) return null
  return { editionTime: `${match[1]}:${match[2]}`, sectionCode: match[3], editionType: 'timed' }
}

/**
 * Get the list of all editions from the registry (lightweight, no post loading).
 * Used by EditionView for navigation.
 */
export function getEditionList(): EditionRegistryEntry[] {
  return getEditionRegistry()
}

/**
 * Load content for a single edition on demand.
 *
 * Queries PostSummaries within the registry entry's timestamp range,
 * groups them by section, and retrieves the full original post data
 * from the feed cache (or server) for complete rendering with media.
 *
 * @param registryEntry - The edition registry entry to load content for
 * @param agent - BskyAgent for fetching posts not found in cache
 * @returns EditionDisplayData or null if no content found
 */
export async function getEditionContent(registryEntry: EditionRegistryEntry, agent: BskyAgent | null): Promise<EditionDisplayData | null> {
  // Step 1: Get synthetic summaries for this specific edition
  const allSummaries = await getPostSummariesInRange(registryEntry.startPostTimestamp, registryEntry.endPostTimestamp)
  const syntheticSummaries = allSummaries.filter(s => s.edition_status === 'synthetic')

  if (syntheticSummaries.length === 0) {
    return null
  }

  // Step 2: Group summaries by section using editor handle
  const sectionMap = new Map<string, PostSummary[]>()

  for (const summary of syntheticSummaries) {
    const parsed = parseEditorHandle(summary.username)
    if (!parsed) continue

    // Composite grouping key: timed sections use raw code, head/tail get prefix
    const groupKey = parsed.editionType === 'timed'
      ? parsed.sectionCode
      : `${parsed.editionType}_${parsed.sectionCode}`

    let sectionPosts = sectionMap.get(groupKey)
    if (!sectionPosts) {
      sectionPosts = []
      sectionMap.set(groupKey, sectionPosts)
    }
    sectionPosts.push(summary)
  }

  // Step 3: Get edition metadata from parsed layout
  const parsedEditions = await getParsedEditions()
  const editionsByTime = new Map<string, { name: string; sectionNames: Map<string, string> }>()
  for (const edition of parsedEditions.editions) {
    if (edition.editionNumber === HEAD_EDITION_NUMBER || edition.editionNumber === TAIL_EDITION_NUMBER) continue
    const sectionNames = new Map<string, string>()
    for (const section of edition.sections) {
      sectionNames.set(section.code, section.name)
    }
    editionsByTime.set(edition.time, { name: edition.name, sectionNames })
  }

  // EditionA and editionZ metadata for section name lookup
  const editionAMeta = parsedEditions.editions.find(e => e.editionNumber === HEAD_EDITION_NUMBER)
  const editionZMeta = parsedEditions.editions.find(e => e.editionNumber === TAIL_EDITION_NUMBER)

  // Extract editionTime from the registry entry key (format: "YYYY-MM-DD_HH:MM")
  const editionTime = registryEntry.editionKey.split('_').slice(1).join('_')
  const editionMeta = editionsByTime.get(editionTime)

  // Section name resolution using composite groupKey
  function getSectionName(groupKey: string): string {
    if (groupKey === '0') return ''  // combined default
    if (groupKey.startsWith('head_')) {
      const code = groupKey.substring(5)
      const section = editionAMeta?.sections.find(s => s.code === code)
      return section?.name || `Section ${code}`
    }
    if (groupKey.startsWith('tail_')) {
      const code = groupKey.substring(5)
      const section = editionZMeta?.sections.find(s => s.code === code)
      return section?.name || `Section ${code}`
    }
    // Timed section
    return editionMeta?.sectionNames.get(groupKey) || `Section ${groupKey}`
  }

  // Step 4: Retrieve full original posts for rendering
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
    log.debug('Edition', `Fetching ${missingUris.length} posts from server (not in feed cache)`)
    try {
      for (let i = 0; i < missingUris.length; i += 25) {
        const batch = missingUris.slice(i, i + 25)
        const response = await agent.getPosts({ uris: batch })
        for (const post of response.data.posts) {
          originalPostMap.set(post.uri, post)
        }
      }
    } catch (error) {
      log.warn('Edition', 'Failed to fetch posts from server:', error)
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

  // Step 5: Build sections
  const sections: EditionDisplaySection[] = []

  // Sort section codes: '0' (combined default) first,
  // then editionA named (head_*), timed (*), editionZ named (tail_*)
  const sortedCodes = [...sectionMap.keys()].sort((a, b) => {
    if (a === '0') return -1
    if (b === '0') return 1
    const rank = (k: string) => k.startsWith('head_') ? 0 : k.startsWith('tail_') ? 2 : 1
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
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
        // Ensure reason.uri matches the summary uniqueId for view tracking
        // (older feed_cache entries may lack reason.uri)
        if (!(syntheticPost.reason as any)?.uri) {
          (syntheticPost.reason as any).uri = summary.uniqueId
        }
        // Combine: original post data + synthetic edition metadata
        const editionPost: CurationFeedViewPost = {
          post: originalPost,
          reason: syntheticPost.reason,
          curation: {
            curation_status: 'edition_publish_show',
            edition_status: 'synthetic',
            edition_summary_id: summary.uniqueId,
            curationNumber: syntheticPost.curation?.curationNumber,
            matching_pattern: syntheticPost.curation?.matching_pattern,
          },
        }
        posts.push(editionPost)
      } else if (syntheticPost) {
        // Fallback: use synthetic post as-is (text only, no embeds)
        // Ensure reason.uri for view tracking (same as above)
        if (!(syntheticPost.reason as any)?.uri) {
          (syntheticPost.reason as any).uri = summary.uniqueId
        }
        if (!syntheticPost.curation) {
          syntheticPost.curation = {
            curation_status: 'edition_publish_show',
            edition_status: 'synthetic',
            edition_summary_id: summary.uniqueId,
          }
        } else {
          syntheticPost.curation.edition_summary_id = summary.uniqueId
        }
        posts.push(syntheticPost)
      }
    }

    const sectionName = getSectionName(code)

    if (posts.length > 0) {
      sections.push({ code, name: sectionName, posts })
    }
  }

  if (sections.length === 0) {
    return null
  }

  const editionDate = new Date(registryEntry.startPostTimestamp)
  const editionName = registryEntry.editionName

  const cachedCount = syntheticSummaries.filter(s => s.repostUri && originalPostMap.has(s.repostUri)).length
  const fetchedCount = missingUris.filter(uri => originalPostMap.has(uri)).length
  log.debug('Edition', `Loaded ${editionName} (${registryEntry.editionKey}): ${syntheticSummaries.length} synthetic posts, ${cachedCount} from cache, ${fetchedCount} from server`)

  return { editionTime, editionDate, editionName, sections }
}

/**
 * Retrieve assembled editions from the cache for display in the Editions tab.
 * Legacy wrapper that loads all editions. Prefer getEditionList() + getEditionContent() for on-demand loading.
 *
 * @param agent - BskyAgent for fetching posts not found in cache
 * @returns Array of editions ordered chronologically (newest first)
 */
export async function getAssembledEditions(agent: BskyAgent | null): Promise<EditionDisplayData[]> {
  const entries = getEditionList()
  if (entries.length === 0) return []

  const editions: EditionDisplayData[] = []
  for (const entry of entries) {
    const content = await getEditionContent(entry, agent)
    if (content) editions.push(content)
  }

  // Sort editions chronologically, newest first
  editions.sort((a, b) => b.editionDate.getTime() - a.editionDate.getTime())
  return editions
}
