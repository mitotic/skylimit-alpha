/**
 * Edition assembly
 *
 * Assembles held posts into synthetic reposts by fictitious editor users
 * and inserts them into the feed during secondary-to-primary cache transfer.
 */

import { CurationFeedViewPost, PostSummary } from './types'
import { getPostSummariesInRange } from './skylimitCache'
import { getEditorHandle, getEditorUser, editorUserToProfileView } from './skylimitEditions'

const EDITION_LOOKBACK_HOURS = 25
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
        curation_edition: true,
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
