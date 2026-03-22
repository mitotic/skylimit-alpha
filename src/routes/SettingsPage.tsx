/**
 * Settings Page - Combined Basic and Curation Settings with Tabs
 */

import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import { useTheme } from '../contexts/ThemeContext'
import { getSettings, updateSettings, FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT, VIEWS_PER_DAY_DEFAULT } from '../curation/skylimitStore'
import { parseEditionFile, invalidateEditionsCache, saveEditionLayout } from '../curation/skylimitEditions'
import { rematchHeldPosts } from '../curation/skylimitEditionMatcher'
import { PAGED_UPDATES_DEFAULTS } from '../curation/pagedUpdates'
import { SkylimitSettings, WEEKS_OF_DATA_OPTIONS, WEEKS_OF_DATA_DEFAULT, CURATION_STATUSES } from '../curation/types'
import { getBrowserTimezone } from '../utils/timezoneUtils'
import Button from '../components/Button'
import { version } from '../../package.json'
import log from '../utils/logger'
import SkylimitStatistics from '../components/SkylimitStatistics'
import { getPostSummariesCacheStats, PostSummariesCacheStats, clearSkylimitSettings, resetEverything, getPostSummaryTimestamps, getPostSummariesInRange, clearAllTimeVariantDataAndLogout, getAllFollows, getStorageUsage, formatBytes, type StorageUsage } from '../curation/skylimitCache'
import ConfirmModal from '../components/ConfirmModal'
import BugReportModal from '../components/BugReportModal'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'
import EditionLayoutEditor from '../components/EditionLayoutEditor'
import { getFeedCacheStats, FeedCacheStats, getFeedCacheTimestamps } from '../curation/skylimitFeedCache'
import { isReadOnlyMode } from '../utils/readOnlyMode'
import { helpGlossary } from '../data/helpGlossary'
import {
  exportCurationData, validateCurationImport, applyCurationImport,
  downloadJson, type ImportValidation
} from '../curation/curationDataTransfer'

type Tab = 'general' | 'curation' | 'editions' | 'following'

const SCROLL_STATE_KEY = 'websky_skylimit_settings_scroll'
const TAB_STATE_KEY = 'websky_settings_active_tab'

interface CacheTimeRange {
  startTime: number
  endTime: number
  postCount: number
}

interface SummaryCacheTimeRange extends CacheTimeRange {
  postNumberRange: string   // e.g. "42-87" or "42" or "—"
}

const DEFAULT_GAP_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes

function computeTimeRanges(
  sortedTimestamps: number[],
  gapThresholdMs: number = DEFAULT_GAP_THRESHOLD_MS
): CacheTimeRange[] {
  if (sortedTimestamps.length === 0) return []

  const ranges: CacheTimeRange[] = []
  let rangeStart = sortedTimestamps[0]
  let rangePrev = sortedTimestamps[0]
  let count = 1

  for (let i = 1; i < sortedTimestamps.length; i++) {
    const current = sortedTimestamps[i]
    if (current - rangePrev > gapThresholdMs) {
      ranges.push({ startTime: rangeStart, endTime: rangePrev, postCount: count })
      rangeStart = current
      count = 1
    } else {
      count++
    }
    rangePrev = current
  }

  ranges.push({ startTime: rangeStart, endTime: rangePrev, postCount: count })
  return ranges.reverse()
}

function DisclosureSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className={`inline-block transition-transform text-xs ${open ? 'rotate-90' : ''}`}>&#9654;</span>
        <h2 className="text-xl font-semibold">{title}</h2>
      </button>
      {open && <div className="mt-4">{children}</div>}
    </section>
  )
}

export default function SettingsPage() {
  const { session, agent, logout } = useSession()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Initialize tab: URL query parameter determines tab, sessionStorage only used when no URL param
  // Any URL param triggers a fresh start (useEffect below clears URL and sessionStorage)
  const getInitialTab = (): Tab => {
    const urlTab = searchParams.get('tab')
    if (urlTab === 'curation') return 'curation'
    if (urlTab === 'editions') return 'editions'
    if (urlTab === 'following') return 'following'
    if (urlTab === 'general' || urlTab === 'basic') return 'general'
    // No URL param - check sessionStorage for preserved tab
    const savedTab = sessionStorage.getItem(TAB_STATE_KEY)
    if (savedTab === 'curation' || savedTab === 'editions' || savedTab === 'following') return savedTab as Tab
    return 'general'
  }
  const [activeTab, setActiveTab] = useState<Tab>(getInitialTab)

  // Save active tab to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem(TAB_STATE_KEY, activeTab)
  }, [activeTab])

  // Handle any ?tab= param as a fresh start - clear URL and sessionStorage
  // This ensures back navigation uses sessionStorage (which preserves tab state)
  // Also switches to the requested tab (needed when already on /settings)
  useEffect(() => {
    const urlTab = searchParams.get('tab')
    if (urlTab) {
      // Switch to the requested tab
      if (urlTab === 'curation' || urlTab === 'editions' || urlTab === 'following' || urlTab === 'general' || urlTab === 'basic') {
        setActiveTab(urlTab === 'basic' ? 'general' : urlTab as Tab)
      }
      // Clear the query parameter from URL (replace to avoid history pollution)
      navigate('/settings', { replace: true })
      // Clear saved tab and scroll position
      sessionStorage.removeItem(TAB_STATE_KEY)
      sessionStorage.removeItem(SCROLL_STATE_KEY)
    }
  }, [searchParams, navigate])

  // Curation tab state
  const [settings, setSettings] = useState<SkylimitSettings | null>(null)
  const [originalSettings, setOriginalSettings] = useState<SkylimitSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editionFeedback, setEditionFeedback] = useState<{ type: 'success' | 'error'; message: string; actionLabel?: string; onAction?: () => void } | null>(null)
  const [editionWarning, setEditionWarning] = useState<string[] | null>(null)
  const [visualEditorMode, setVisualEditorMode] = useState(true)
  const [showExample, setShowExample] = useState(false)
  const [showEditionHelp, setShowEditionHelp] = useState(() => {
    const stored = localStorage.getItem('websky_beginner_mode')
    return stored === null ? true : stored === 'true'
  })
  const [feedCacheStats, setFeedCacheStats] = useState<FeedCacheStats | null>(null)
  const [summariesStats, setSummariesStats] = useState<PostSummariesCacheStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(true)
  const [showCacheGaps, setShowCacheGaps] = useState(false)
  const [loadingCacheGaps, setLoadingCacheGaps] = useState(false)
  const [feedCacheRanges, setFeedCacheRanges] = useState<CacheTimeRange[]>([])
  const [summariesCacheRanges, setSummariesCacheRanges] = useState<SummaryCacheTimeRange[]>([])
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null)
  const [showResetFeedModal, setShowResetFeedModal] = useState(false)
  const [isResettingFeed, setIsResettingFeed] = useState(false)
  const [showResetDataModal, setShowResetDataModal] = useState(false)
  const [isResettingData, setIsResettingData] = useState(false)
  const [showClearSettingsModal, setShowClearSettingsModal] = useState(false)
  const [showBugReportModal, setShowBugReportModal] = useState(false)
  const [isClearingSettings, setIsClearingSettings] = useState(false)
  const [showResetAllModal, setShowResetAllModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const [showClearRecentModal, setShowClearRecentModal] = useState(false)
  const [isClearingRecent, setIsClearingRecent] = useState(false)
  const [showRecurateModal, setShowRecurateModal] = useState(false)
  const [isRecurating, setIsRecurating] = useState(false)
  const [showLogoutModal, setShowLogoutModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [importValidation, setImportValidation] = useState<ImportValidation | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, type === 'error' ? 10000 : 5000)
  }
  const [clickToBlueSky, setClickToBlueSky] = useState(() =>
    localStorage.getItem('websky_click_to_bluesky') === 'true'
  )
  const [readOnlyMode, setReadOnlyMode] = useState(() =>
    isReadOnlyMode()
  )
  const [beginnerMode, setBeginnerMode] = useState(() => {
    const stored = localStorage.getItem('websky_beginner_mode')
    return stored === null ? true : stored === 'true'
  })
  const [textSize, setTextSize] = useState<'small' | 'medium' | 'large'>(() => {
    const stored = localStorage.getItem('websky_text_size')
    if (stored === 'small' || stored === 'medium' || stored === 'large') return stored
    return window.matchMedia('(max-width: 768px)').matches ? 'medium' : 'small'
  })

  // Detect unsaved changes by comparing current settings to original
  const hasUnsavedChanges = useMemo(() => {
    if (!settings || !originalSettings) return false
    return JSON.stringify(settings) !== JSON.stringify(originalSettings)
  }, [settings, originalSettings])

  // Warn user before leaving page with unsaved changes (browser navigation/close)
  useEffect(() => {
    if (!hasUnsavedChanges) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  // Warn user before in-app navigation with unsaved changes
  // (useBlocker requires data router, so we intercept link clicks manually)
  useEffect(() => {
    if (!hasUnsavedChanges || activeTab !== 'curation') return

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement

      // Check for navigation links (React Router <Link> renders as <a>)
      const link = target.closest('a[href]') as HTMLAnchorElement | null

      // Also check for navigation buttons (like the logo button)
      const navButton = target.closest('button[aria-label="Go to home"]') as HTMLButtonElement | null

      // Handle navigation button (logo)
      if (navButton) {
        const confirmed = window.confirm(
          'You have unsaved curation settings. Are you sure you want to leave without saving?'
        )
        if (!confirmed) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }

      if (!link) return

      // Get the href attribute (relative path) rather than resolved href property
      const href = link.getAttribute('href')
      if (!href) return

      // Skip external links (opening in new tab or absolute URLs to other domains)
      if (link.target === '_blank') return
      if (href.startsWith('http://') || href.startsWith('https://')) return

      // Skip if staying within settings
      if (href.startsWith('/settings')) return

      // Show confirmation for navigation away from settings
      const confirmed = window.confirm(
        'You have unsaved curation settings. Are you sure you want to leave without saving?'
      )

      if (!confirmed) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    // Use capture phase to intercept before React Router
    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [hasUnsavedChanges, activeTab])

  // Load settings and cache stats on mount
  useEffect(() => {
    loadSettings()
    loadCacheStats()
  }, [])

  // Restore scroll position when Following tab loads (after content is ready)
  // Scroll is saved in SkylimitStatistics.tsx before navigation
  useEffect(() => {
    if (activeTab !== 'following') return

    const savedScrollY = sessionStorage.getItem(SCROLL_STATE_KEY)
    if (!savedScrollY) return

    const scrollY = parseInt(savedScrollY, 10)
    if (isNaN(scrollY) || scrollY <= 0) return

    // Wait for SkylimitStatistics table to load before restoring scroll
    const attemptRestore = (attempts: number) => {
      if (attempts <= 0) {
        window.scrollTo(0, scrollY)
        return
      }

      // Check if the Active Followees table has content (tbody with rows)
      const table = document.querySelector('table tbody tr')
      if (table) {
        window.scrollTo(0, scrollY)
      } else {
        setTimeout(() => attemptRestore(attempts - 1), 100)
      }
    }

    // Start attempting after a short delay, retry up to 30 times (3 seconds)
    setTimeout(() => attemptRestore(30), 100)
  }, [activeTab])

  const loadCacheStats = async () => {
    setLoadingStats(true)
    try {
      const [feedStats, summariesCacheStats] = await Promise.all([
        getFeedCacheStats(),
        getPostSummariesCacheStats(),
      ])
      setFeedCacheStats(feedStats)
      setSummariesStats(summariesCacheStats)
    } catch (error) {
      log.error('Settings', 'Failed to load cache stats:', error)
    } finally {
      setLoadingStats(false)
    }
  }

  const loadCacheGaps = async () => {
    if (showCacheGaps) {
      setShowCacheGaps(false)
      return
    }

    setLoadingCacheGaps(true)
    try {
      const [feedTimestamps, summaryTimestamps, usage] = await Promise.all([
        getFeedCacheTimestamps(),
        getPostSummaryTimestamps(),
        getStorageUsage(),
      ])
      setStorageUsage(usage)

      setFeedCacheRanges(computeTimeRanges(feedTimestamps))

      // Compute summary ranges and enrich with postNumber/curationNumber from boundary posts
      const baseRanges = computeTimeRanges(summaryTimestamps)
      const enrichedRanges: SummaryCacheTimeRange[] = await Promise.all(
        baseRanges.map(async (range) => {
          const formatRange = (startVal: number | null, endVal: number | null): string => {
            if (startVal === null && endVal === null) return '—'
            const s = startVal != null ? String(startVal) : '?'
            const e = endVal != null ? String(endVal) : '?'
            return s === e ? s : `${s}, ${e}`
          }

          // Look up summaries at the start and end boundary timestamps
          const [startSummaries, endSummaries] = await Promise.all([
            getPostSummariesInRange(range.startTime, range.startTime),
            range.startTime === range.endTime
              ? Promise.resolve([])
              : getPostSummariesInRange(range.endTime, range.endTime),
          ])

          const startSummary = startSummaries[0] ?? null
          const endSummary = range.startTime === range.endTime
            ? startSummary
            : (endSummaries[0] ?? null)

          log.debug('Settings', `Range ${new Date(range.startTime).toLocaleString()} – ${new Date(range.endTime).toLocaleString()}: startSummaries=${startSummaries.length}, endSummaries=${endSummaries.length}, startPostNum=${startSummary?.postNumber}, endPostNum=${endSummary?.postNumber}`)

          return {
            ...range,
            postNumberRange: formatRange(startSummary?.postNumber ?? null, endSummary?.postNumber ?? null),
          }
        })
      )
      setSummariesCacheRanges(enrichedRanges)
      setShowCacheGaps(true)
    } catch (error) {
      log.error('Settings', 'Failed to load cache gaps:', error)
    } finally {
      setLoadingCacheGaps(false)
    }
  }

  const loadSettings = async () => {
    try {
      const s = await getSettings()
      setSettings(s)
      setOriginalSettings(structuredClone(s))
    } catch (error) {
      log.error('Settings', 'Failed to load settings:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!settings) return

    setSaving(true)
    try {
      const timezoneChanged = originalSettings?.timezone !== settings.timezone

      // When timezone is saved, record current browser timezone so HomePage
      // can detect genuine browser timezone changes vs intentional selections
      const settingsToSave = timezoneChanged
        ? { ...settings, lastBrowserTimezone: getBrowserTimezone() }
        : settings
      await updateSettings(settingsToSave)
      await log.refreshLevel()

      // If timezone changed, clear numbering and re-assign
      if (timezoneChanged && settings.timezone) {
        log.info('Settings', `Timezone changed to ${settings.timezone}, re-numbering posts...`)
        const { clearAllNumbering } = await import('../curation/skylimitCache')
        await clearAllNumbering()
        const { assignAllNumbers } = await import('../curation/skylimitNumbering')
        await assignAllNumbers()
        log.info('Settings', 'Post re-numbering complete')
      }

      // Mark settings as saved (no longer dirty)
      setOriginalSettings(structuredClone(settings))

      addToast(timezoneChanged ? 'Settings saved! Posts re-numbered for new timezone.' : 'Settings saved!', 'success')
    } catch (error) {
      log.error('Settings', 'Failed to save settings:', error)
      addToast('Failed to save settings', 'error')
    } finally {
      setSaving(false)
    }
  }

  const updateSetting = <K extends keyof SkylimitSettings>(
    key: K,
    value: SkylimitSettings[K]
  ) => {
    if (!settings) return
    setSettings({ ...settings, [key]: value })
  }

  const handleResetData = async () => {
    setIsResettingData(true)
    try {
      // Clear sessionStorage feed/scroll state
      sessionStorage.removeItem('websky_home_feed_state')
      sessionStorage.removeItem('websky_home_scroll_state')
      sessionStorage.removeItem('websky_home_editions_feed_state')
      sessionStorage.removeItem('websky_home_editions_scroll_state')
      sessionStorage.removeItem('websky_home_active_tab')

      await clearAllTimeVariantDataAndLogout()
      // Function handles logout and redirect to /login
    } catch (error) {
      log.error('Settings', 'Failed to reset data:', error)
      setIsResettingData(false)
    }
  }

  const handleResetFeed = async () => {
    setIsResettingFeed(true)
    try {
      if (typeof (window as any).resetFeedAndReloadHomePage === 'function') {
        await (window as any).resetFeedAndReloadHomePage()
        setShowResetFeedModal(false)
        setIsResettingFeed(false)
        navigate('/')
      } else {
        sessionStorage.setItem('websky_reset_pending', '1')
        navigate('/')
        setTimeout(async () => {
          if (typeof (window as any).resetFeedAndReloadHomePage === 'function') {
            await (window as any).resetFeedAndReloadHomePage()
          }
          setIsResettingFeed(false)
        }, 500)
      }
    } catch (error) {
      log.error('Settings', 'Failed to reset feed:', error)
      setIsResettingFeed(false)
    }
  }

  const handleClearRecent = async () => {
    setIsClearingRecent(true)
    // Clear saved scroll position before navigating so scroll restoration doesn't override scroll-to-top
    sessionStorage.removeItem('websky_home_scroll_state')
    sessionStorage.removeItem('websky_home_editions_scroll_state')
    try {
      if (typeof (window as any).clearRecentAndReloadHomePage === 'function') {
        await (window as any).clearRecentAndReloadHomePage()
        setShowClearRecentModal(false)
        setIsClearingRecent(false)
        navigate('/')
      } else {
        sessionStorage.setItem('websky_reset_pending', '1')
        navigate('/')
        setTimeout(async () => {
          if (typeof (window as any).clearRecentAndReloadHomePage === 'function') {
            await (window as any).clearRecentAndReloadHomePage()
          }
          setIsClearingRecent(false)
        }, 500)
      }
    } catch (error) {
      log.error('Settings', 'Failed to clear recent:', error)
      setIsClearingRecent(false)
    }
  }

  const handleRecurate = async () => {
    setIsRecurating(true)
    sessionStorage.removeItem('websky_home_scroll_state')
    sessionStorage.removeItem('websky_home_editions_scroll_state')
    try {
      if (typeof (window as any).recurateAndReloadHomePage === 'function') {
        await (window as any).recurateAndReloadHomePage()
        setShowRecurateModal(false)
        setIsRecurating(false)
        navigate('/')
      } else {
        sessionStorage.setItem('websky_reset_pending', '1')
        navigate('/')
        setTimeout(async () => {
          if (typeof (window as any).recurateAndReloadHomePage === 'function') {
            await (window as any).recurateAndReloadHomePage()
          }
          setIsRecurating(false)
        }, 500)
      }
    } catch (error) {
      log.error('Settings', 'Failed to re-curate:', error)
      setIsRecurating(false)
    }
  }

  const handleClearSettings = async () => {
    setIsClearingSettings(true)
    try {
      await clearSkylimitSettings()
      // Refresh page to apply default settings
      window.location.reload()
    } catch (error) {
      log.error('Settings', 'Failed to clear settings:', error)
      setIsClearingSettings(false)
    }
  }

  const handleResetAll = () => {
    setIsResettingAll(true)
    resetEverything() // Redirects to /?reset=1
  }

  const handleExport = async () => {
    if (!session?.handle) return
    setIsExporting(true)
    try {
      const jsonString = await exportCurationData(session.handle)
      const dateStr = new Date().toISOString().slice(0, 10)
      downloadJson(jsonString, `websky-curation-${session.handle}-${dateStr}.json`)
    } catch (error) {
      log.error('Settings', 'Failed to export curation data:', error)
      addToast('Failed to export curation data', 'error')
    } finally {
      setIsExporting(false)
    }
  }

  const handleImportFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !session?.handle) return
    try {
      const text = await file.text()
      const result = await validateCurationImport(text, session.handle)
      if (result.success) {
        setImportValidation(result)
        setImportError(null)
      } else {
        setImportValidation(null)
        setImportError(result.error)
      }
      setShowImportModal(true)
    } catch {
      setImportError('Failed to read file')
      setImportValidation(null)
      setShowImportModal(true)
    }
    e.target.value = ''
  }

  const handleImportConfirm = async () => {
    if (!importValidation) return
    setIsImporting(true)
    try {
      const result = await applyCurationImport(importValidation.data)
      setShowImportModal(false)
      setImportValidation(null)
      await loadSettings()
      addToast(`Import complete: ${result.settingsUpdated} settings updated, ${result.followsUpdated} followee preferences updated, ${result.followsSkipped} skipped (not followed on this device).`, 'success')
    } catch (error) {
      log.error('Settings', 'Failed to import curation data:', error)
      addToast('Failed to import curation data', 'error')
    } finally {
      setIsImporting(false)
    }
  }

  // Render Basic tab content
  const renderBasicTab = () => (
    <div className="space-y-6">
      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Account</h2>
        <div className="flex items-center justify-between">
          <div>
            <span className="font-medium">Logged in as </span>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              @{session?.handle}
            </span>
          </div>
          <Button variant="danger" onClick={() => setShowLogoutModal(true)}>
            Logout
          </Button>
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Interaction</h2>
        <label className="flex items-center space-x-3">
          <input
            type="checkbox"
            checked={readOnlyMode}
            onChange={() => {
              const newValue = !readOnlyMode
              localStorage.setItem('websky_read_only_mode', newValue.toString())
              setReadOnlyMode(newValue)
            }}
            className="w-5 h-5"
          />
          <div>
            <span className="font-medium">Read-only Mode</span>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Prevent accidental likes, reposts, replies, bookmarks, and follows
            </div>
          </div>
        </label>
        {settings && (
          <label className="flex items-center space-x-3">
            <input
              type="checkbox"
              checked={settings.debugMode}
              onChange={(e) => {
                const newValue = e.target.checked
                updateSetting('debugMode', newValue)
                setOriginalSettings(prev => prev ? { ...prev, debugMode: newValue } : prev)
                updateSettings({ debugMode: newValue })
              }}
              className="w-5 h-5"
            />
            <div>
              <span className="font-medium">Debug Mode</span>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Enable additional UI features for debugging
              </div>
            </div>
          </label>
        )}
        <label className="flex items-center space-x-3">
          <input
            type="checkbox"
            checked={beginnerMode}
            onChange={() => {
              const newValue = !beginnerMode
              localStorage.setItem('websky_beginner_mode', newValue.toString())
              setBeginnerMode(newValue)
            }}
            className="w-5 h-5"
          />
          <div>
            <span className="font-medium">Beginner Mode</span>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Display additional help info for user interaction
            </div>
          </div>
        </label>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Navigation</h2>
        <label className="flex items-start space-x-3">
          <input
            type="checkbox"
            checked={clickToBlueSky}
            onChange={() => {
              const newValue = !clickToBlueSky
              localStorage.setItem('websky_click_to_bluesky', newValue.toString())
              setClickToBlueSky(newValue)
            }}
            className="w-5 h-5 mt-0.5 shrink-0"
          />
          <div>
            <span className="font-medium">Click to <span className="text-blue-500">Bluesky</span></span>
            {beginnerMode && (
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Open threads, search, saved posts, notifications, and profiles in Bluesky. Use back navigation to return to Skylimit.
              </div>
            )}
          </div>
        </label>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Appearance</h2>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Theme</div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {theme === 'dark' ? 'Dark mode' : 'Light mode'}
            </div>
          </div>
          <button
            onClick={toggleTheme}
            className="btn btn-secondary"
          >
            Switch to {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Text Size</div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {textSize === 'small' ? 'Small text' : textSize === 'medium' ? 'Medium text' : 'Large text'}
            </div>
          </div>
          <div className="flex gap-1">
            {(['small', 'medium', 'large'] as const).map((size) => (
              <button
                key={size}
                onClick={() => {
                  localStorage.setItem('websky_text_size', size)
                  setTextSize(size)
                  document.documentElement.classList.remove('font-size-medium', 'font-size-large')
                  if (size === 'medium') document.documentElement.classList.add('font-size-medium')
                  else if (size === 'large') document.documentElement.classList.add('font-size-large')
                }}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  textSize === size
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100'
                }`}
              >
                {size.charAt(0).toUpperCase() + size.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mt-6">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setShowClearRecentModal(true)}
          disabled={isClearingRecent}
          className="px-6 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-full"
        >
          Refetch recent posts
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setShowClearSettingsModal(true)}
          disabled={isClearingSettings}
          className="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-full"
        >
          Reset settings
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setShowResetAllModal(true)}
          disabled={isResettingAll}
          className="px-6 py-2 bg-red-500 hover:bg-red-600 text-white rounded-full"
        >
          Reset ALL
        </Button>
      </div>

      {/* Reset Settings Confirmation Modal */}
      <ConfirmModal
        isOpen={showClearSettingsModal}
        onClose={() => setShowClearSettingsModal(false)}
        onConfirm={handleClearSettings}
        title="Reset Settings"
        message={`This will reset all Skylimit settings to their default values.

Your cached data, follow list, and login session will be preserved.

This cannot be undone.`}
        confirmText={isClearingSettings ? 'Resetting...' : 'Reset Settings'}
        cancelText="Cancel"
        isDangerous={true}
        isLoading={isClearingSettings}
      />

      {/* Reset All Confirmation Modal */}
      <ConfirmModal
        isOpen={showResetAllModal}
        onClose={() => setShowResetAllModal(false)}
        onConfirm={handleResetAll}
        title="Reset All Data"
        message={`WARNING: This will completely wipe all Websky data — settings, caches, and login.

Use this only if the app is not working correctly. This cannot be undone.`}
        confirmText={isResettingAll ? 'Resetting...' : 'Reset Everything'}
        cancelText="Cancel"
        isDangerous={true}
        isLoading={isResettingAll}
      />

      <div className="card space-y-4">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setShowBugReportModal(true)}
          className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-full"
        >
          Report a bug
        </Button>
      </div>
      <BugReportModal
        isOpen={showBugReportModal}
        onClose={() => setShowBugReportModal(false)}
        initialLogLevel={settings?.consoleLogLevel ?? 2}
        onSubmitSuccess={() => addToast('Bug report submitted to Claude Code', 'success')}
        agent={agent}
        onDmSubmitSuccess={() => addToast('Bug report sent via DM', 'success')}
      />

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">About</h2>
        <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2">
          <p>Skylimit – A curating Bluesky client (alpha version)</p>
          <p>Version {version}</p>
          <p>
            Built with Vite, React, TypeScript, and Tailwind CSS
          </p>
          <p>
            Source code <a href="https://github.com/mitotic/skylimit-alpha#readme" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">on Github</a>
          </p>
        </div>
      </div>
    </div>
  )

  // Render Curation tab content
  const renderCurationTab = () => {
    if (loading) {
      return (
        <div className="p-6">
          <div className="text-center">Loading settings...</div>
        </div>
      )
    }

    if (!settings) {
      return (
        <div className="p-6">
          <div className="text-center text-red-500">Failed to load settings</div>
        </div>
      )
    }

    return (
      <div className="space-y-6">
        <div className="mb-6">
          <p className="text-gray-600 dark:text-gray-400">
            Configure your content curation preferences
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSave()
          }}
          className="space-y-6 border border-gray-200 dark:border-gray-700 rounded-lg p-5"
        >
          <section>
            <h2 className="text-xl font-semibold mb-4">Basic Settings</h2>

            <div className="mb-4">
              <label className="block mb-2 font-medium">
                Average views per day:
              </label>
              <input
                type="number"
                min="10"
                max="9999"
                value={settings.viewsPerDay}
                onChange={(e) => updateSetting('viewsPerDay', parseInt(e.target.value) || VIEWS_PER_DAY_DEFAULT)}
                className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
              />
              <p className="text-sm text-gray-500 mt-1">
                The average number of posts you want to see per day (statistical limit)
              </p>
            </div>

            <div className="mb-4">
              <label className="block mb-2 font-medium">
                Feed Page Length (posts per page):
              </label>
              <div className="flex gap-1">
                {([10, 20, 25, 50] as const).map((size) => (
                  <button
                    key={size}
                    onClick={() => updateSetting('feedPageLength', size)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      (settings.feedPageLength || 25) === size
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

          </section>

          <DisclosureSection title="Advanced Settings">
            <div className="space-y-4">
              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.showTime}
                  onChange={(e) => updateSetting('showTime', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Show post timestamp in home feed (hh:mm)</span>
              </label>

              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.showViewedStatus !== false}
                  onChange={(e) => updateSetting('showViewedStatus', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Show viewed status of posts (checkmark &amp; shading)</span>
              </label>

              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.infiniteScrollingOption || false}
                  onChange={(e) => updateSetting('infiniteScrollingOption', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Enable "infinite" scroll down</span>
              </label>

              <div>
                <label className="block mb-2 font-medium">
                  Full Page Wait Time (minutes):
                </label>
                <input
                  type="number"
                  min="5"
                  max="120"
                  value={settings.pagedUpdatesFullPageWaitMinutes ?? PAGED_UPDATES_DEFAULTS.fullPageWaitMinutes}
                  onChange={(e) => {
                    const value = parseInt(e.target.value, 10)
                    if (!isNaN(value) && value >= 5 && value <= 120) {
                      updateSetting('pagedUpdatesFullPageWaitMinutes', value)
                    }
                  }}
                  className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Time to wait for a full page before showing partial page. Range: 5-120 minutes.
                </p>
              </div>

              <div>
                <label className="block mb-2 font-medium">
                  Repost Display Interval (hours):
                </label>
                <input
                  type="number"
                  min="0"
                  max="96"
                  value={settings.repostDisplayIntervalHours ?? 24}
                  onChange={(e) => {
                    const value = parseInt(e.target.value, 10)
                    if (!isNaN(value) && value >= 0 && value <= 96) {
                      updateSetting('repostDisplayIntervalHours', value)
                    }
                  }}
                  className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Hide reposts if the original or another repost was shown within this interval. Set to 0 to disable. Range: 0-96 hours (up to 4 days).
                </p>
              </div>

              <div>
                <label className="block mb-2 font-medium">
                  Weeks of data to analyze:
                </label>
                <select
                  value={Math.round(settings.daysOfData / 7)}
                  onChange={(e) => updateSetting('daysOfData', (parseInt(e.target.value) || WEEKS_OF_DATA_DEFAULT) * 7)}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                >
                  {WEEKS_OF_DATA_OPTIONS.map((weeks) => (
                    <option key={weeks} value={weeks}>{weeks} {weeks === 1 ? 'week' : 'weeks'}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block mb-2 font-medium">
                  Seed string for randomization:
                </label>
                <input
                  type="text"
                  value={settings.secretKey}
                  onChange={(e) => updateSetting('secretKey', e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  placeholder="default"
                />
                <p className="text-sm text-gray-500 mt-1">
                  Secret key for deterministic post selection (keep same across devices)
                </p>
              </div>

              <div>
                <label className="block mb-2 font-medium">
                  Timezone for day boundaries:
                </label>
                <select
                  value={settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}
                  onChange={(e) => updateSetting('timezone', e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                >
                  {(() => {
                    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
                    const commonTimezones = [
                      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
                      'America/Anchorage', 'Pacific/Honolulu', 'America/Phoenix',
                      'America/Toronto', 'America/Vancouver',
                      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
                      'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai',
                      'Australia/Sydney', 'Australia/Perth',
                      'Pacific/Auckland',
                      'UTC',
                    ]
                    const tzSet = new Set(commonTimezones)
                    if (!tzSet.has(browserTz)) {
                      commonTimezones.unshift(browserTz)
                    }
                    const storedTz = settings.timezone
                    if (storedTz && !tzSet.has(storedTz)) {
                      commonTimezones.unshift(storedTz)
                    }
                    return commonTimezones.map(tz => (
                      <option key={tz} value={tz}>
                        {tz}{tz === browserTz ? ' (browser)' : ''}
                      </option>
                    ))
                  })()}
                </select>
                <p className="text-sm text-gray-500 mt-1">
                  Controls day boundaries for post numbering and curation. Changing this will re-number posts.
                </p>
              </div>

            </div>
          </DisclosureSection>

          <DisclosureSection title="Debug Settings">
            <div className="space-y-4">
              <label className="flex items-center space-x-3">
                <span>Console log level</span>
                <select
                  value={settings.consoleLogLevel ?? 2}
                  onChange={(e) => {
                    const level = Number(e.target.value)
                    updateSetting('consoleLogLevel', level)
                    log.setLevel(level)
                  }}
                  className="ml-2 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                >
                  <option value={0}>0 - Errors only</option>
                  <option value={1}>1 - Warnings</option>
                  <option value={2}>2 - Milestones</option>
                  <option value={3}>3 - Debug</option>
                  <option value={4}>4 - Verbose</option>
                </select>
              </label>

              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.showAllPosts}
                  onChange={(e) => updateSetting('showAllPosts', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Show dropped posts (grayed out)</span>
              </label>

              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.curationSuspended}
                  onChange={(e) => updateSetting('curationSuspended', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Suspend curation (temporarily turn off Skylimit)</span>
              </label>

              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.anonymizeUsernames}
                  onChange={(e) => updateSetting('anonymizeUsernames', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Anonymize usernames (for screenshots)</span>
              </label>

              <label className="flex items-center space-x-3">
                <span>Trace users:</span>
                <input
                  type="text"
                  value={settings.traceUsers ?? ''}
                  onChange={(e) => {
                    updateSetting('traceUsers', e.target.value)
                    log.setTraceUsers(e.target.value)
                  }}
                  placeholder="handle1, handle2, ..."
                  className="ml-2 flex-1 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                />
              </label>

              <label className="flex items-center space-x-3">
                <span>Highlight status prefix:</span>
                <input
                  type="text"
                  list="curation-status-options"
                  value={settings.highlightStatusPrefix ?? ''}
                  onChange={(e) => updateSetting('highlightStatusPrefix', e.target.value)}
                  placeholder="e.g. priority, regular_hi"
                  className="ml-2 flex-1 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                />
                <datalist id="curation-status-options">
                  {[...CURATION_STATUSES].sort().map((status) => (
                    <option key={status} value={status} />
                  ))}
                </datalist>
              </label>

              <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                <h3 className="text-lg font-semibold mb-4">Feed Redisplay Settings</h3>

                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">
                    Feed Redisplay Idle Interval (minutes)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="480"
                    value={settings.feedRedisplayIdleInterval ? settings.feedRedisplayIdleInterval / (60 * 1000) : FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT}
                    onChange={(e) => {
                      const minutes = parseInt(e.target.value, 10)
                      if (!isNaN(minutes) && minutes > 0) {
                        updateSetting('feedRedisplayIdleInterval', minutes * 60 * 1000)
                      }
                    }}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Time in minutes. If returning to home page within this interval, cached feed will be redisplayed instead of reloading from server.
                  </p>
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">
                    Max Displayed Feed Size
                  </label>
                  <input
                    type="number"
                    min="50"
                    max="500"
                    value={settings.maxDisplayedFeedSize || 300}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10)
                      if (!isNaN(value) && value >= 50 && value <= 500) {
                        updateSetting('maxDisplayedFeedSize', value)
                      }
                    }}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Maximum number of posts to keep in displayed feed. Older posts are trimmed during navigation. Range: 50-500.
                  </p>
                </div>


                <h3 className="text-lg font-semibold mb-4 mt-6">Paged Fresh Updates</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Delay viewing new posts so popularity metrics have time to accumulate, enabling better curation.
                </p>

                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">
                    New Post Batch Fetches
                  </label>
                  <select
                    value={settings.newPostBatchFetches ?? PAGED_UPDATES_DEFAULTS.newPostBatchFetches}
                    onChange={(e) => updateSetting('newPostBatchFetches', parseInt(e.target.value))}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Number of API fetches per probe. Higher values bridge gaps between new and cached posts. Default: 1.
                  </p>
                </div>

                <div className="mt-6">
                  <label className="block mb-2 font-medium">
                    Popularity Amplifier:
                  </label>
                  <select
                    value={settings.popAmp ?? 1}
                    onChange={(e) => updateSetting('popAmp', parseInt(e.target.value))}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  >
                    {[1, 2, 3, 4, 5].map(v => (
                      <option key={v} value={v}>{v}{v === 1 ? ' (disabled)' : ''}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Higher values boost popular posts and reduce less popular ones. 1 = no popularity weighting.
                  </p>
                </div>

                <h3 className="text-lg font-semibold mb-4 mt-6">Curation Interval</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Time period used for grouping posts in statistics calculations.
                </p>

                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">
                    Curation Interval (hours)
                  </label>
                  <select
                    value={settings.curationIntervalHours ?? 2}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10)
                      updateSetting('curationIntervalHours', value)
                    }}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  >
                    <option value={1}>1 hour</option>
                    <option value={2}>2 hours</option>
                    <option value={3}>3 hours</option>
                    <option value={4}>4 hours</option>
                    <option value={6}>6 hours</option>
                    <option value={8}>8 hours</option>
                    <option value={12}>12 hours</option>
                  </select>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Length of curation intervals. Default: 2 hours. Must be a factor of 24 (1-12). Changing this affects statistics calculations.
                  </p>
                </div>

                <h3 className="text-lg font-semibold mb-4 mt-6">Reply Handling</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Control how replies to non-followees are handled in your feed.
                </p>

                <div className="mb-4">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.hideUnfollowedReplies ?? false}
                      onChange={(e) => updateSetting('hideUnfollowedReplies', e.target.checked)}
                      className="w-5 h-5"
                    />
                    <span>Hide replies to non-followees</span>
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-8">
                    When enabled, all replies to non-followees are hidden. When disabled,
                    replies from &quot;quiet posters&quot; (those with 100% show probability) are shown.
                  </p>
                </div>
              </div>
            </div>

              <div className="flex flex-wrap gap-3 mt-6">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowResetDataModal(true)}
                  disabled={isResettingData}
                  className="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-full"
                >
                  Reset post archive
                </Button>
              </div>
          </DisclosureSection>

          <div className="flex justify-start pt-4">
            <Button
              type="submit"
              variant="primary"
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Update Curation Settings'}
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap gap-3 mt-6">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowResetFeedModal(true)}
            disabled={isResettingFeed}
            className="px-6 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-full"
          >
            Refresh post display
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowRecurateModal(true)}
            disabled={isRecurating}
            className="px-6 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-full"
          >
            Re-curate recent posts
          </Button>
        </div>

        {/* Curation Settings Transfer */}
        <div className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700">
          <h2 className="text-xl font-semibold mb-2">Curation Settings Transfer</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Export curation settings and followee preferences to sync across devices.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={handleExport}
              disabled={isExporting}
              className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-full"
            >
              {isExporting ? 'Exporting...' : 'Export settings to file'}
            </Button>
            <label className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-full cursor-pointer font-medium transition-colors inline-flex items-center">
              Import settings from file
              <input
                type="file"
                accept=".json"
                onChange={handleImportFileSelect}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {/* Import Confirmation Modal */}
        <ConfirmModal
          isOpen={showImportModal && importValidation !== null}
          onClose={() => { setShowImportModal(false); setImportValidation(null) }}
          onConfirm={handleImportConfirm}
          title="Import Curation Settings"
          message={importValidation
            ? `Import curation data from ${importValidation.data[0].username}?\n\nExported: ${importValidation.data[0].exported_at ? new Date(importValidation.data[0].exported_at).toLocaleString() : 'unknown'}\n\n• ${importValidation.totalSettingsKeys} curation settings will be overwritten\n• ${importValidation.matchedFollows} followee preferences will be updated\n• ${importValidation.skippedFollows} followees skipped (not followed on this device)\n\nThis will replace your current curation settings.`
            : ''}
          confirmText={isImporting ? 'Importing...' : 'Import'}
          isLoading={isImporting}
        />

        {/* Import Error Modal */}
        {showImportModal && importError && (
          <ConfirmModal
            isOpen={true}
            onClose={() => { setShowImportModal(false); setImportError(null) }}
            onConfirm={() => { setShowImportModal(false); setImportError(null) }}
            title="Import Failed"
            message={importError}
            confirmText="OK"
          />
        )}

        {/* Data Handling */}
        <div className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700">
        <DisclosureSection title="Data Handling">

          {/* Cache Statistics */}
            <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4">
              <h3 className="text-lg font-semibold mb-3">Cache Statistics</h3>

              {loadingStats ? (
                <div className="text-sm text-gray-600 dark:text-gray-400">Loading statistics...</div>
              ) : (
                <div className="space-y-4">
                  {/* Feed Cache Stats */}
                  <div>
                    <h4 className="font-medium mb-2">Feed Cache (feed_cache)</h4>
                    <div className="text-sm space-y-1 ml-4">
                      <div>
                        <span className="font-medium">Total posts cached:</span>{' '}
                        {feedCacheStats?.totalCount ?? 0}
                      </div>
                      {feedCacheStats?.oldestTimestamp && (
                        <div>
                          <span className="font-medium">Oldest post:</span>{' '}
                          {new Date(feedCacheStats.oldestTimestamp).toLocaleString()}
                        </div>
                      )}
                      {feedCacheStats?.newestTimestamp && (
                        <div>
                          <span className="font-medium">Newest post:</span>{' '}
                          {new Date(feedCacheStats.newestTimestamp).toLocaleString()}
                        </div>
                      )}
                      {!feedCacheStats?.oldestTimestamp && !feedCacheStats?.newestTimestamp && feedCacheStats?.totalCount === 0 && (
                        <div className="text-gray-500 dark:text-gray-400">No cached posts</div>
                      )}
                    </div>
                  </div>

                  {/* Summaries Stats */}
                  <div>
                    <h4 className="font-medium mb-2">Post Summaries (summaries)</h4>
                    <div className="text-sm space-y-1 ml-4">
                      <div>
                        <span className="font-medium">Total summaries cached:</span>{' '}
                        {summariesStats?.totalCount ?? 0}
                      </div>
                      {summariesStats?.oldestTimestamp && (
                        <div>
                          <span className="font-medium">Oldest summary:</span>{' '}
                          {new Date(summariesStats.oldestTimestamp).toLocaleString()}
                        </div>
                      )}
                      {summariesStats?.newestTimestamp && (
                        <div>
                          <span className="font-medium">Newest summary:</span>{' '}
                          {new Date(summariesStats.newestTimestamp).toLocaleString()}
                        </div>
                      )}
                      <div>
                        <span className="font-medium">Dropped by curation (recent):</span>{' '}
                        {summariesStats?.droppedCount ?? 0}
                        {summariesStats && summariesStats.totalCount > 0 && (
                          <span className="text-gray-500 dark:text-gray-400 ml-1">
                            ({((summariesStats.droppedCount / summariesStats.totalCount) * 100).toFixed(1)}%)
                          </span>
                        )}
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-4">
                          (Approximate - only counts recent summaries within last 48 hours)
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">Edited by curation (recent):</span>{' '}
                        {summariesStats?.editedCount ?? 0}
                        {summariesStats && summariesStats.totalCount > 0 && (
                          <span className="text-gray-500 dark:text-gray-400 ml-1">
                            ({((summariesStats.editedCount / summariesStats.totalCount) * 100).toFixed(1)}%)
                          </span>
                        )}
                      </div>
                      {!summariesStats?.oldestTimestamp && !summariesStats?.newestTimestamp && summariesStats?.totalCount === 0 && (
                        <div className="text-gray-500 dark:text-gray-400">No summaries cached</div>
                      )}
                    </div>
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={loadCacheStats}
                      className="text-sm text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      Refresh Statistics
                    </button>
                  </div>
                </div>
              )}
            </div>

          {/* New post loading counters - debug only */}
          {settings.debugMode && (
            <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4">
              <h3 className="text-lg font-semibold mb-3">New post loading</h3>
              <div className="text-sm space-y-1 ml-4">
                <div>
                  <span className="font-medium">Next Page</span> —
                  fetched: {sessionStorage.getItem('nextPageClicksFetched') || '0'},
                  retained: {sessionStorage.getItem('nextPageClicksRetained') || '0'}
                </div>
                <div>
                  <span className="font-medium">New posts</span> —
                  fetched: {sessionStorage.getItem('newPostsClicksFetched') || '0'},
                  retained: {sessionStorage.getItem('newPostsClicksRetained') || '0'}
                </div>
                <div>
                  <span className="font-medium">All new posts</span> —
                  fetched: {sessionStorage.getItem('allNewPostsClicksFetched') || '0'},
                  retained: {sessionStorage.getItem('allNewPostsClicksRetained') || '0'}
                </div>
              </div>
            </div>
          )}

          {/* Cache Gaps Analysis */}
          <div className="mb-4">
            <Button
              type="button"
              variant="secondary"
              onClick={loadCacheGaps}
              disabled={loadingCacheGaps}
              className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-full"
            >
              {loadingCacheGaps ? 'Loading...' : showCacheGaps ? 'Hide cache info' : 'Show cache info'}
            </Button>

            {showCacheGaps && (
              <div className="mt-4 space-y-4">
                {/* Storage Usage */}
                {storageUsage && (
                  <div>
                    <h4 className="font-medium mb-2">Storage Usage</h4>
                    <div className="text-sm space-y-1 ml-4">
                      <div>
                        <span className="font-medium">IndexedDB:</span>{' '}
                        {storageUsage.indexedDBBytes != null
                          ? formatBytes(storageUsage.indexedDBBytes)
                          : 'unavailable'}
                        {storageUsage.indexedDBQuota != null && (
                          <span className="text-gray-500 dark:text-gray-400">
                            {' '}(of {Math.round(storageUsage.indexedDBQuota / (1024 * 1024 * 1024))} GB quota)
                          </span>
                        )}
                      </div>
                      {Object.keys(storageUsage.storeRecordCounts).length > 0 && (
                        <div className="ml-4 text-xs text-gray-600 dark:text-gray-400">
                          {Object.entries(storageUsage.storeRecordCounts).map(([store, count]) => (
                            <div key={store}>{store}: {count.toLocaleString()} {count === 1 ? 'record' : 'records'}</div>
                          ))}
                        </div>
                      )}
                      <div>
                        <span className="font-medium">localStorage:</span>{' '}
                        {formatBytes(storageUsage.localStorageBytes)}
                      </div>
                      <div>
                        <span className="font-medium">sessionStorage:</span>{' '}
                        {formatBytes(storageUsage.sessionStorageBytes)}
                      </div>
                    </div>
                  </div>
                )}

                {/* Feed Cache Ranges */}
                <div>
                  <h4 className="font-medium mb-2">
                    Feed Cache Ranges ({feedCacheRanges.length} contiguous {feedCacheRanges.length === 1 ? 'range' : 'ranges'})
                  </h4>
                  {feedCacheRanges.length === 0 ? (
                    <div className="text-sm text-gray-500 dark:text-gray-400 ml-4">No cached posts</div>
                  ) : (
                    <div className="overflow-x-auto ml-4">
                      <table className="text-sm border-collapse">
                        <thead>
                          <tr className="text-left text-gray-600 dark:text-gray-400">
                            <th className="pr-4 pb-1 font-medium">Start</th>
                            <th className="pr-4 pb-1 font-medium">End</th>
                            <th className="pb-1 font-medium text-right">Posts</th>
                          </tr>
                        </thead>
                        <tbody>
                          {feedCacheRanges.map((range, i) => (
                            <tr key={i} className="text-gray-800 dark:text-gray-200">
                              <td className="pr-4 py-0.5 whitespace-nowrap">{new Date(range.startTime).toLocaleString()}</td>
                              <td className="pr-4 py-0.5 whitespace-nowrap">{new Date(range.endTime).toLocaleString()}</td>
                              <td className="py-0.5 text-right">{range.postCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Summaries Cache Ranges */}
                <div>
                  <h4 className="font-medium mb-2">
                    Post Summaries Ranges ({summariesCacheRanges.length} contiguous {summariesCacheRanges.length === 1 ? 'range' : 'ranges'})
                  </h4>
                  {summariesCacheRanges.length === 0 ? (
                    <div className="text-sm text-gray-500 dark:text-gray-400 ml-4">No cached summaries</div>
                  ) : (
                    <div className="overflow-x-auto ml-4">
                      <table className="text-sm border-collapse">
                        <thead>
                          <tr className="text-left text-gray-600 dark:text-gray-400">
                            <th className="pr-4 pb-1 font-medium">Start</th>
                            <th className="pr-4 pb-1 font-medium">End</th>
                            <th className="pr-4 pb-1 font-medium text-right">Posts</th>
                            <th className="pb-1 font-medium text-right">Post #</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summariesCacheRanges.map((range, i) => (
                            <tr key={i} className="text-gray-800 dark:text-gray-200">
                              <td className="pr-4 py-0.5 whitespace-nowrap">{new Date(range.startTime).toLocaleString()}</td>
                              <td className="pr-4 py-0.5 whitespace-nowrap">{new Date(range.endTime).toLocaleString()}</td>
                              <td className="pr-4 py-0.5 text-right">{range.postCount}</td>
                              <td className="py-0.5 text-right whitespace-nowrap">{range.postNumberRange}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </DisclosureSection>
        </div>



        {/* Refresh Post Display Confirmation Modal */}
        <ConfirmModal
          isOpen={showResetFeedModal}
          onClose={() => setShowResetFeedModal(false)}
          onConfirm={handleResetFeed}
          title="Refresh Post Display"
          message={`Clear the feed and reload posts using existing curation data.

All settings, summaries, and login are preserved.

You will be redirected to the home page.`}
          confirmText={isResettingFeed ? 'Resetting...' : 'Refresh Post Display'}
          cancelText="Cancel"
          isDangerous={false}
          isLoading={isResettingFeed}
        />

        {/* Reset Post Archive Confirmation Modal */}
        <ConfirmModal
          isOpen={showResetDataModal}
          onClose={() => setShowResetDataModal(false)}
          onConfirm={handleResetData}
          title="Reset Post Archive"
          message={`Clear all cached data (posts, summaries, stats, follow list) and log you out.

Your Skylimit settings will be preserved.`}
          confirmText={isResettingData ? 'Resetting...' : 'Reset Post Archive & Logout'}
          cancelText="Cancel"
          isDangerous={true}
          isLoading={isResettingData}
        />
      </div>
    )
  }

  // Render Editions tab content
  const handleSaveEditionLayout = async (text: string) => {
    if (!settings) return
    setEditionWarning(null)
    const trimmed = text.trim()
    if (!trimmed) {
      // Empty layout: clear editions — check for held posts first
      const { getEditionLookbackMs } = await import('../curation/skylimitEditionAssembly')
      const now = Date.now()
      const lookbackStart = now - await getEditionLookbackMs()
      const summaries = await getPostSummariesInRange(lookbackStart, now)
      const heldCount = summaries.filter(s => s.edition_status === 'hold').length

      if (heldCount > 0) {
        const confirmed = window.confirm(
          `${heldCount} post${heldCount !== 1 ? 's' : ''} scheduled for editions will be released and redisplayed in the home feed. Continue?`
        )
        if (!confirmed) {
          updateSetting('editionLayout', originalSettings?.editionLayout || '')
          setEditionFeedback(null)
          return
        }
      }

      updateSetting('editionLayout', '')
      await updateSettings({ ...settings, editionLayout: '' })
      invalidateEditionsCache()
      await rematchHeldPosts()
      setOriginalSettings({ ...settings, editionLayout: '' })
      setEditionFeedback({ type: 'success', message: `Edition layout cleared.` })
      if (heldCount > 0 && typeof (window as any).resetFeedAndReloadHomePage === 'function') {
        (window as any).resetFeedAndReloadHomePage()
      }
      return
    }
    const saveResult = await saveEditionLayout(trimmed)
    if (!saveResult.success) {
      setEditionFeedback({ type: 'error', message: saveResult.errors.join('\n') })
      return
    }
    updateSetting('editionLayout', trimmed)
    setOriginalSettings({ ...settings, editionLayout: trimmed })
    const parts: string[] = []
    if (saveResult.editionCount > 0) parts.push(`${saveResult.editionCount} edition${saveResult.editionCount > 1 ? 's' : ''}`)
    parts.push(`${saveResult.patternCount} pattern${saveResult.patternCount !== 1 ? 's' : ''}`)
    let debugInfo = ''
    if (settings.debugMode && saveResult.rematchResult && (saveResult.rematchResult.total > 0 || saveResult.rematchResult.released > 0)) {
      const rematchParts: string[] = []
      if (saveResult.rematchResult.rematched > 0) rematchParts.push(`${saveResult.rematchResult.rematched} re-matched`)
      if (saveResult.rematchResult.fallback > 0) rematchParts.push(`${saveResult.rematchResult.fallback} assigned to default`)
      if (saveResult.rematchResult.released > 0) rematchParts.push(`${saveResult.rematchResult.released} released`)
      debugInfo = ` [${saveResult.rematchResult.total} held post${saveResult.rematchResult.total !== 1 ? 's' : ''}: ${rematchParts.join(', ')}]`
    }
    // Check for unfollowed handles in the layout
    const result = parseEditionFile(trimmed)
    const literalHandles = new Set<string>()
    for (const edition of result.editions) {
      for (const section of edition.sections) {
        for (const pattern of section.patterns) {
          if (!pattern.userPattern.includes('*')) {
            literalHandles.add(pattern.userPattern)
          }
        }
      }
    }
    if (literalHandles.size > 0) {
      const allFollows = await getAllFollows()
      const followedSet = new Set(
        allFollows.filter(f => !f.username.startsWith('editor_')).map(f => f.username)
      )
      const unfollowed = [...literalHandles].filter(h => !followedSet.has(h)).sort()
      setEditionWarning(unfollowed.length > 0 ? unfollowed : null)
      const hasUnfollowed = unfollowed.length > 0
      setEditionFeedback({
        type: 'success',
        message: `Edition layout updated: ${parts.join(', ')}.${debugInfo} To re-assemble editions using recent posts, `,
        actionLabel: hasUnfollowed ? 'Refetch recent posts' : 'Re-curate recent posts',
        onAction: hasUnfollowed ? () => setShowClearRecentModal(true) : () => setShowRecurateModal(true),
      })
    } else {
      setEditionWarning(null)
      setEditionFeedback({
        type: 'success',
        message: `Edition layout updated: ${parts.join(', ')}.${debugInfo} To re-assemble editions using recent posts, `,
        actionLabel: 'Re-curate recent posts',
        onAction: () => setShowRecurateModal(true),
      })
    }
  }

  const renderEditionsTab = () => {
    if (loading) {
      return (
        <div className="p-6">
          <div className="text-center">Loading settings...</div>
        </div>
      )
    }

    if (!settings) {
      return (
        <div className="p-6">
          <div className="text-center text-red-500">Failed to load settings</div>
        </div>
      )
    }

    return (
      <div className="space-y-6">
          <div className="space-y-4">
            {/* Title + help icon */}
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edition Layout</h3>
              <button
                type="button"
                onClick={() => setShowEditionHelp(!showEditionHelp)}
                className={`w-6 h-6 rounded-full text-sm font-bold flex items-center justify-center transition-colors ${
                  showEditionHelp
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
                title="Toggle help"
              >
                ?
              </button>
            </div>
            {showEditionHelp && (
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed border border-gray-200 dark:border-gray-700 rounded-md p-3 space-y-2">
                {helpGlossary['Edition layout help'].split('\n\n').map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>
            )}
            {visualEditorMode ? (
              <EditionLayoutEditor
                key={showExample ? 'example' : 'editor'}
                layoutText={showExample ? helpGlossary['Edition layout placeholder'] : settings.editionLayout}
                onSave={handleSaveEditionLayout}
                onTextChange={showExample ? undefined : (text) => updateSetting('editionLayout', text)}
                editionFont={settings.editionFont || 'serif'}
                readOnly={showExample}
                headerContent={
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => {
                        setVisualEditorMode(false)
                        setEditionFeedback(null)
                      }}
                      className="px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 border border-blue-600 dark:border-blue-400 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30"
                    >
                      Switch to Text Editor
                    </button>
                    <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showExample}
                        onChange={(e) => setShowExample(e.target.checked)}
                        className="rounded"
                      />
                      Show example
                    </label>
                  </div>
                }
              />
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={() => {
                      setVisualEditorMode(true)
                      setEditionFeedback(null)
                    }}
                    className="px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 border border-blue-600 dark:border-blue-400 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30"
                  >
                    Switch to Visual Editor
                  </button>
                  <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showExample}
                      onChange={(e) => setShowExample(e.target.checked)}
                      className="rounded"
                    />
                    Show example
                  </label>
                </div>
                <textarea
                  value={showExample ? helpGlossary['Edition layout placeholder'] : settings.editionLayout}
                  onChange={(e) => {
                    if (!showExample) {
                      updateSetting('editionLayout', e.target.value)
                      setEditionFeedback(null)
                    }
                  }}
                  readOnly={showExample}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                  rows={28}
                  placeholder={helpGlossary['Edition layout placeholder']}
                />
                {beginnerMode && (
                  <p className="text-sm text-gray-500 mt-1">
                    Configure edition layout patterns. {helpGlossary['Edition layout']}
                  </p>
                )}
                {!showExample && (
                  <div className="mt-2 flex items-center gap-3">
                    <Button
                      variant="primary"
                      onClick={() => handleSaveEditionLayout(settings.editionLayout)}
                    >
                      Update Edition Layout
                    </Button>
                  </div>
                )}
              </div>
            )}
        </div>

        {/* Edition save feedback — shared by both editor modes */}
        {editionFeedback && (
          <span className={`text-sm ${editionFeedback.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
            {editionFeedback.message}
            {editionFeedback.actionLabel && editionFeedback.onAction && (
              <button
                type="button"
                onClick={editionFeedback.onAction}
                className="underline hover:no-underline font-medium"
              >
                {editionFeedback.actionLabel}
              </button>
            )}
          </span>
        )}

        {/* Unfollowed users warning — shared by both editor modes */}
        {editionWarning && editionWarning.length > 0 && (
          <div className="mt-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200 p-3 rounded-lg text-sm">
            <div className="font-medium mb-1">
              {editionWarning.length} unfollowed user{editionWarning.length !== 1 ? 's' : ''} in layout — follow them before refetching to have them appear in editions:
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {editionWarning.map(handle => (
                <a key={handle} onClick={() => navigate(`/profile/${handle}`)}
                   className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">
                  @{handle}
                </a>
              ))}
            </div>
          </div>
        )}

        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edition Settings</h3>
        <div>
          <label className="flex items-center space-x-3">
            <input
              type="checkbox"
              checked={settings.showEditionsInFeed || false}
              onChange={async (e) => {
                const newValue = e.target.checked
                updateSetting('showEditionsInFeed', newValue)
                await updateSettings({ ...settings, showEditionsInFeed: newValue })
              }}
              className="w-5 h-5"
            />
            <span>Show periodic editions in home feed</span>
          </label>
          <p className="text-sm text-gray-500 ml-8 mt-1">
            This inserts edition posts as timed reposts in the feed
          </p>
        </div>


        <div className="flex items-center space-x-3">
          <span>Edition font:</span>
          <div className="flex rounded border border-gray-300 dark:border-gray-600 overflow-hidden">
            {(['serif', 'sans-serif'] as const).map(font => (
              <button
                key={font}
                type="button"
                onClick={async () => {
                  updateSetting('editionFont', font)
                  await updateSettings({ ...settings, editionFont: font })
                }}
                className={`px-3 py-1 text-sm transition-colors ${
                  (settings.editionFont || 'serif') === font
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {font === 'serif' ? 'Serif' : 'Sans-serif'}
              </button>
            ))}
          </div>
        </div>

      </div>
    )
  }

  // Render Following tab content
  const renderFollowingTab = () => (
    <div className="space-y-6">
      <div className="mb-6">
        <p className="text-gray-600 dark:text-gray-400">
          View and manage your followed accounts and their posting statistics
        </p>
      </div>

      <SkylimitStatistics />
    </div>
  )

  return (
    <div className="pb-20 md:pb-0">
      {/* Header */}
      <div className="p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Settings</h1>
          <a
            href="https://bsky.app/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
          >
            Bluesky settings ↗
          </a>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        {(['general', 'curation', 'editions', 'following'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-4 py-3 text-center font-medium transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-blue-500 text-blue-500'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab === 'general' ? 'General' : tab === 'curation' ? 'Curation' : tab === 'editions' ? 'Editions' : 'Following'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className={`p-4 ${hasUnsavedChanges && activeTab === 'curation' ? 'pb-20' : ''}`}>
        {activeTab === 'general' && renderBasicTab()}
        {activeTab === 'curation' && renderCurationTab()}
        {activeTab === 'editions' && renderEditionsTab()}
        {activeTab === 'following' && renderFollowingTab()}
      </div>

      {/* Sticky save bar - shown when there are unsaved curation changes */}
      {hasUnsavedChanges && activeTab === 'curation' && (
        <div className="fixed bottom-0 left-0 right-0 bg-amber-50 dark:bg-amber-900/30 border-t border-amber-200 dark:border-amber-700 p-3 shadow-lg z-50">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
            <span className="text-amber-800 dark:text-amber-200 text-sm font-medium">
              You have unsaved changes
            </span>
            <Button
              variant="primary"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? 'Saving...' : 'Update Curation Settings'}
            </Button>
          </div>
        </div>
      )}

      {/* Logout Confirmation Modal */}
      <ConfirmModal
        isOpen={showLogoutModal}
        onClose={() => setShowLogoutModal(false)}
        onConfirm={logout}
        title="Logout"
        message="Are you sure you want to logout?"
        confirmText="Logout"
        cancelText="Cancel"
      />

      {/* Refetch Recent Posts Confirmation Modal */}
      <ConfirmModal
        isOpen={showClearRecentModal}
        onClose={() => setShowClearRecentModal(false)}
        onConfirm={handleClearRecent}
        title="Refetch Recent Posts"
        message={`Clear recent curation data and re-fetch posts from the server.

• Recent post summaries and edition entries will be re-created
• Older data, settings, follow list, and login are preserved

You will be redirected to the home page.`}
        confirmText={isClearingRecent ? 'Refetching...' : 'Refetch Recent Posts'}
        cancelText="Cancel"
        isDangerous={false}
        isLoading={isClearingRecent}
      />

      {/* Re-curate Recent Posts Confirmation Modal */}
      <ConfirmModal
        isOpen={showRecurateModal}
        onClose={() => setShowRecurateModal(false)}
        onConfirm={handleRecurate}
        title="Re-curate Recent Posts"
        message={`Re-curate recent posts from the cache (no server fetch needed).

• Recent post summaries and editions will be re-created
• Settings, follow list, and login are preserved

You will be redirected to the home page.`}
        confirmText={isRecurating ? 'Re-curating...' : 'Re-curate Recent Posts'}
        cancelText="Cancel"
        isDangerous={false}
        isLoading={isRecurating}
      />

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
      </div>
  )
}
