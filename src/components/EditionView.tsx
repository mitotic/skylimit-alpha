/**
 * EditionView — displays assembled editions in the Periodic Editions tab.
 *
 * Shows one edition at a time with ◀/▶ navigation between editions.
 * Each edition has a masthead banner, default section (always expanded),
 * and named sections with collapsible accordion headers.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBskyFeedDefs } from '@atproto/api'
import type { BskyAgent } from '@atproto/api'
import PostCard from './PostCard'
import { getEditionList, getEditionContent, EditionDisplayData } from '../curation/skylimitEditionAssembly'
import { getPostUniqueId } from '../curation/skylimitGeneral'
import { getSettings } from '../curation/skylimitStore'
import { useSwipeNavigation } from '../hooks/useSwipeNavigation'
import { useViewTracking } from '../hooks/useViewTracking'
import { CurationFeedViewPost, EditionRegistryEntry } from '../curation/types'
import { getPostSummariesByIds } from '../curation/skylimitCache'
import { markEditionViewed } from '../curation/editionRegistry'
import { clientNow } from '../utils/clientClock'

interface EditionViewProps {
  agent: BskyAgent | null
  onReply?: (uri: string) => void
  onRepost?: (uri: string, cid: string) => void
  onQuotePost?: (post: AppBskyFeedDefs.PostView) => void
  onLike?: (uri: string, cid: string) => void
  onBookmark?: (uri: string, cid: string) => void
  onEditionViewed?: () => void
}

const EDITION_INDEX_KEY = 'websky_edition_current_index'
const EDITION_SCROLL_KEY = 'websky_home_editions_scroll_state'

/** Get the summary ID for an edition post (for view tracking against IndexedDB) */
function getSummaryId(post: AppBskyFeedDefs.FeedViewPost): string {
  return (post as CurationFeedViewPost).curation?.edition_summary_id || getPostUniqueId(post)
}

export default function EditionView({
  agent,
  onReply,
  onRepost,
  onQuotePost,
  onLike,
  onBookmark,
  onEditionViewed,
}: EditionViewProps) {
  const navigate = useNavigate()
  const [registryEntries, setRegistryEntries] = useState<EditionRegistryEntry[]>([])
  const [currentEdition, setCurrentEdition] = useState<EditionDisplayData | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [sectionsExpanded, setSectionsExpanded] = useState(true)
  const [loading, setLoading] = useState(true)
  const [editionLoading, setEditionLoading] = useState(false)
  const [hasLayout, setHasLayout] = useState(true)

  // View tracking: map from summary uniqueId → viewedAt timestamp
  const [viewedAtMap, setViewedAtMap] = useState<Map<string, number>>(new Map())

  // Load edition registry on mount (lightweight, no post loading)
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        // Check if edition layout is configured
        const settings = await getSettings()
        if (!settings.editionLayout?.trim()) {
          if (!cancelled) setHasLayout(false)
          return
        }

        const entries = getEditionList()
        if (cancelled) return
        setRegistryEntries(entries)

        // Restore saved index if valid
        const savedIndex = sessionStorage.getItem(EDITION_INDEX_KEY)
        if (savedIndex !== null) {
          const idx = parseInt(savedIndex, 10)
          if (!isNaN(idx) && idx >= 0 && idx < entries.length) {
            setCurrentIndex(idx)
          }
        }
      } catch (error) {
        console.error('[EditionView] Failed to load edition registry:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Load edition content on demand when index or registry changes
  useEffect(() => {
    if (registryEntries.length === 0) return
    const entry = registryEntries[currentIndex]
    if (!entry) return

    let cancelled = false
    setEditionLoading(true)

    async function loadEdition() {
      try {
        const content = await getEditionContent(entry, agent)
        if (cancelled) return
        setCurrentEdition(content)

        // Mark this edition as viewed in the registry
        if (content && !entry.viewedAt) {
          markEditionViewed(entry.editionKey, clientNow())
          entry.viewedAt = clientNow()
          onEditionViewed?.()
        }

        // Hydrate viewedAt from IndexedDB for this edition's posts
        if (content) {
          const summaryIds = content.sections.flatMap(s => s.posts.map(getSummaryId))
          if (summaryIds.length > 0) {
            const summaries = await getPostSummariesByIds(summaryIds)
            const hydrated = new Map<string, number>()
            for (const [id, summary] of summaries) {
              if (summary.viewedAt) hydrated.set(id, summary.viewedAt)
            }
            if (!cancelled && hydrated.size > 0) setViewedAtMap(hydrated)
          }
        }

        // Restore scroll position after content renders
        if (!cancelled) {
          const savedScrollY = sessionStorage.getItem(EDITION_SCROLL_KEY)
          if (savedScrollY) {
            const scrollY = parseInt(savedScrollY, 10)
            if (!isNaN(scrollY) && scrollY > 0) {
              requestAnimationFrame(() => {
                const attemptRestore = (attempt: number) => {
                  if (cancelled) return
                  setTimeout(() => {
                    const scrollHeight = document.documentElement.scrollHeight
                    const clientHeight = window.innerHeight
                    const maxScroll = Math.max(scrollHeight - clientHeight, 0)
                    if (scrollHeight > clientHeight && maxScroll >= scrollY * 0.8) {
                      window.scrollTo(0, Math.min(scrollY, maxScroll))
                    } else if (attempt < 10) {
                      attemptRestore(attempt + 1)
                    }
                  }, attempt * 50)
                }
                attemptRestore(1)
              })
            }
          }
        }
      } catch (error) {
        console.error('[EditionView] Failed to load edition content:', error)
      } finally {
        if (!cancelled) setEditionLoading(false)
      }
    }
    loadEdition()
    return () => { cancelled = true }
  }, [registryEntries, currentIndex, agent])

  // Persist current index
  useEffect(() => {
    sessionStorage.setItem(EDITION_INDEX_KEY, String(currentIndex))
  }, [currentIndex])

  // Save scroll position continuously (debounced)
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const handleScroll = () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        const scrollY = window.scrollY
        if (scrollY < 50) {
          sessionStorage.removeItem(EDITION_SCROLL_KEY)
        } else {
          sessionStorage.setItem(EDITION_SCROLL_KEY, scrollY.toString())
        }
      }, 150)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (timeout) clearTimeout(timeout)
    }
  }, [])

  const goToPrev = useCallback(() => {
    sessionStorage.removeItem(EDITION_SCROLL_KEY)
    setViewedAtMap(new Map())
    setCurrentIndex(i => Math.min(i + 1, registryEntries.length - 1))
  }, [registryEntries.length])

  const goToNext = useCallback(() => {
    sessionStorage.removeItem(EDITION_SCROLL_KEY)
    setViewedAtMap(new Map())
    setCurrentIndex(i => Math.max(i - 1, 0))
  }, [])

  const toggleSections = useCallback(() => {
    setSectionsExpanded(prev => !prev)
  }, [])

  // Swipe left/right to navigate between editions on mobile
  const containerRef = useRef<HTMLDivElement>(null)
  useSwipeNavigation({
    containerRef,
    onSwipeLeft: goToNext,
    onSwipeRight: goToPrev,
    enabled: registryEntries.length > 1,
  })

  // View tracking: build flat feed with viewedAt injected for current edition
  const edition = currentEdition

  const currentFeed = useMemo(() => {
    if (!edition) return []
    return edition.sections.flatMap(s => s.posts.map(post => {
      const summaryId = getSummaryId(post)
      const viewedAt = viewedAtMap.get(summaryId)
      if (viewedAt && 'curation' in post) {
        const cp = post as CurationFeedViewPost
        if (!cp.curation?.viewedAt) {
          return { ...cp, curation: { ...cp.curation, viewedAt } } as AppBskyFeedDefs.FeedViewPost
        }
      }
      return post
    }))
  }, [edition, viewedAtMap])

  // setFeed adapter: extract viewedAt updates from the hook's state mapper
  const setFeedAdapter = useCallback<React.Dispatch<React.SetStateAction<AppBskyFeedDefs.FeedViewPost[]>>>((updater) => {
    setViewedAtMap(prev => {
      // We need to apply the updater to extract newly viewed posts.
      // The hook always passes a function updater (prev => prev.map(...)).
      if (typeof updater !== 'function') return prev
      // Apply the updater to a snapshot to see what changed
      const updated = updater(currentFeed)
      let changed = false
      const next = new Map(prev)
      for (const p of updated) {
        const cp = p as CurationFeedViewPost
        if (cp.curation?.viewedAt) {
          const id = cp.curation.edition_summary_id || getPostUniqueId(p)
          if (!prev.has(id)) {
            next.set(id, cp.curation.viewedAt)
            changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [currentFeed])

  useViewTracking({ feed: currentFeed, setFeed: setFeedAdapter })

  // Helper to get a post with viewedAt injected
  const getPostWithViewed = useCallback((post: AppBskyFeedDefs.FeedViewPost): AppBskyFeedDefs.FeedViewPost => {
    const summaryId = getSummaryId(post)
    const viewedAt = viewedAtMap.get(summaryId)
    if (viewedAt) {
      const cp = post as CurationFeedViewPost
      if (!cp.curation?.viewedAt) {
        return { ...cp, curation: { ...cp.curation, viewedAt } } as AppBskyFeedDefs.FeedViewPost
      }
    }
    return post
  }, [viewedAtMap])

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p>Loading editions...</p>
      </div>
    )
  }

  if (!hasLayout) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p className="text-lg font-medium mb-2">Periodic Editions</p>
        <p>
          No edition layout provided. Go to{' '}
          <button
            onClick={() => navigate('/settings')}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Edition Settings under the Settings/Curation tab
          </button>
          {' '}to define the layout for periodic editions.
        </p>
      </div>
    )
  }

  if (registryEntries.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p className="text-lg font-medium mb-2">Periodic Editions</p>
        <p>No editions available yet.</p>
      </div>
    )
  }

  if (editionLoading || !edition) {
    return (
      <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        <p>Loading edition...</p>
      </div>
    )
  }

  const defaultSection = edition.sections.find(s => s.code === '0')
  const namedSections = edition.sections.filter(s => s.code !== '0')
  const hasPrev = currentIndex < registryEntries.length - 1  // older editions
  const hasNext = currentIndex > 0                            // newer editions
  const prevUnviewed = hasPrev && !registryEntries[currentIndex + 1]?.viewedAt
  const nextUnviewed = hasNext && !registryEntries[currentIndex - 1]?.viewedAt

  return (
    <div ref={containerRef} className="pb-8">
      {/* Edition masthead banner */}
      <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between px-4 py-3">
          <button
            onClick={goToPrev}
            disabled={!hasPrev}
            className="p-2 text-gray-500 dark:text-gray-400 disabled:opacity-30 hover:text-gray-700 dark:hover:text-gray-200 flex items-center"
            aria-label="Previous edition (older)"
          >
            {prevUnviewed && <span className="text-red-500 text-xs mr-0.5">●</span>}
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M13 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <div className="text-center">
            <div className="font-semibold text-lg text-gray-900 dark:text-gray-100">
              {edition.editionName}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {edition.editionDate.toLocaleString(undefined, {
                hour: 'numeric', minute: '2-digit',
                month: 'long', day: 'numeric', year: 'numeric',
              })}
            </div>
          </div>

          <button
            onClick={goToNext}
            disabled={!hasNext}
            className="p-2 text-gray-500 dark:text-gray-400 disabled:opacity-30 hover:text-gray-700 dark:hover:text-gray-200 flex items-center"
            aria-label="Next edition (newer)"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {nextUnviewed && <span className="text-red-500 text-xs ml-0.5">●</span>}
          </button>
        </div>

        {/* Open/Close Sections toggle */}
        {namedSections.length > 0 && (
          <div className="text-center pb-2">
            <button
              onClick={toggleSections}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              {sectionsExpanded ? 'Close Sections' : 'Open Sections'}
            </button>
          </div>
        )}
      </div>

      {/* Default section (always expanded, no header) */}
      {defaultSection && defaultSection.posts.map(post => {
        const viewedPost = getPostWithViewed(post)
        return (
          <div key={getPostUniqueId(post)} data-post-uri={post.post.uri} data-post-id={getSummaryId(post)}>
            <PostCard
              post={viewedPost}
              onReply={onReply}
              onRepost={onRepost}
              onQuotePost={onQuotePost}
              onLike={onLike}
              onBookmark={onBookmark}
            />
          </div>
        )
      })}

      {/* Named sections */}
      {namedSections.map(section => (
        <div key={section.code}>
          {/* Section divider/header */}
          <div
            onClick={toggleSections}
            className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50"
          >
            <span className="text-blue-600 dark:text-blue-400 text-base">
              {sectionsExpanded ? '▼' : '▶'}
            </span>
            <div className="flex-1 flex items-center gap-2">
              <span className="h-px flex-1 bg-blue-400 dark:bg-blue-500" />
              <span className="text-base font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">
                {section.name}
              </span>
              <span className="h-px flex-1 bg-blue-400 dark:bg-blue-500" />
            </div>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              viewed {section.posts.filter(p => viewedAtMap.has(getSummaryId(p))).length}/{section.posts.length}
            </span>
          </div>

          {/* Section posts */}
          {sectionsExpanded && section.posts.map(post => {
            const viewedPost = getPostWithViewed(post)
            return (
              <div key={getPostUniqueId(post)} data-post-uri={post.post.uri} data-post-id={getSummaryId(post)}>
                <PostCard
                  post={viewedPost}
                  onReply={onReply}
                  onRepost={onRepost}
                  onQuotePost={onQuotePost}
                  onLike={onLike}
                  onBookmark={onBookmark}
                />
              </div>
            )
          })}
        </div>
      ))}

      {/* End of Edition marker */}
      <div className="text-center py-6 text-gray-400 dark:text-gray-500 text-sm">
        <span className="inline-flex items-center gap-2">
          <span className="h-px w-12 bg-gray-300 dark:bg-gray-600" />
          End of Edition
          <span className="h-px w-12 bg-gray-300 dark:bg-gray-600" />
        </span>
      </div>
    </div>
  )
}
