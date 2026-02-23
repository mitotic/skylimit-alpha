/**
 * Settings Page - Combined Basic and Curation Settings with Tabs
 */

import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import { useTheme } from '../contexts/ThemeContext'
import { getSettings, updateSettings, FEED_REDISPLAY_IDLE_INTERVAL_DEFAULT } from '../curation/skylimitStore'
import { PAGED_UPDATES_DEFAULTS } from '../curation/pagedUpdates'
import { SkylimitSettings } from '../curation/types'
import { getBrowserTimezone } from '../utils/timezoneUtils'
import Button from '../components/Button'
import SkylimitStatistics from '../components/SkylimitStatistics'
import { getPostSummariesCacheStats, PostSummariesCacheStats, clearSkylimitSettings, resetEverything, getPostSummaryTimestamps, getPostSummariesInRange } from '../curation/skylimitCache'
import ConfirmModal from '../components/ConfirmModal'
import { getFeedCacheStats, FeedCacheStats, getFeedCacheTimestamps } from '../curation/skylimitFeedCache'

type Tab = 'basic' | 'curation' | 'following'

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
  const { session, logout } = useSession()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Initialize tab: URL query parameter determines tab, sessionStorage only used when no URL param
  // Any URL param triggers a fresh start (useEffect below clears URL and sessionStorage)
  const getInitialTab = (): Tab => {
    const urlTab = searchParams.get('tab')
    if (urlTab === 'curation') return 'curation'
    if (urlTab === 'following') return 'following'
    if (urlTab === 'basic') return 'basic'
    // No URL param - check sessionStorage for preserved tab
    const savedTab = sessionStorage.getItem(TAB_STATE_KEY)
    if (savedTab === 'curation' || savedTab === 'following') return savedTab as Tab
    return 'basic'
  }
  const [activeTab, setActiveTab] = useState<Tab>(getInitialTab)

  // Save active tab to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem(TAB_STATE_KEY, activeTab)
  }, [activeTab])

  // Handle any ?tab= param as a fresh start - clear URL and sessionStorage
  // This ensures back navigation uses sessionStorage (which preserves tab state)
  useEffect(() => {
    const urlTab = searchParams.get('tab')
    if (urlTab) {
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
  const [feedCacheStats, setFeedCacheStats] = useState<FeedCacheStats | null>(null)
  const [summariesStats, setSummariesStats] = useState<PostSummariesCacheStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(true)
  const [showCacheGaps, setShowCacheGaps] = useState(false)
  const [loadingCacheGaps, setLoadingCacheGaps] = useState(false)
  const [feedCacheRanges, setFeedCacheRanges] = useState<CacheTimeRange[]>([])
  const [summariesCacheRanges, setSummariesCacheRanges] = useState<SummaryCacheTimeRange[]>([])
  const [showResetFeedModal, setShowResetFeedModal] = useState(false)
  const [isResettingFeed, setIsResettingFeed] = useState(false)
  const [showResetCurationModal, setShowResetCurationModal] = useState(false)
  const [isResettingCuration, setIsResettingCuration] = useState(false)
  const [showClearSettingsModal, setShowClearSettingsModal] = useState(false)
  const [isClearingSettings, setIsClearingSettings] = useState(false)
  const [showResetAllModal, setShowResetAllModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const [showLogoutModal, setShowLogoutModal] = useState(false)
  const [clickToBlueSky, setClickToBlueSky] = useState(() =>
    localStorage.getItem('websky_click_to_bluesky') === 'true'
  )
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
      console.error('Failed to load cache stats:', error)
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
      const [feedTimestamps, summaryTimestamps] = await Promise.all([
        getFeedCacheTimestamps(),
        getPostSummaryTimestamps(),
      ])

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

          console.log(`[Cache Gaps] Range ${new Date(range.startTime).toLocaleString()} – ${new Date(range.endTime).toLocaleString()}: startSummaries=${startSummaries.length}, endSummaries=${endSummaries.length}, startPostNum=${startSummary?.postNumber}, endPostNum=${endSummary?.postNumber}`)

          return {
            ...range,
            postNumberRange: formatRange(startSummary?.postNumber ?? null, endSummary?.postNumber ?? null),
          }
        })
      )
      setSummariesCacheRanges(enrichedRanges)
      setShowCacheGaps(true)
    } catch (error) {
      console.error('Failed to load cache gaps:', error)
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
      console.error('Failed to load settings:', error)
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

      // If timezone changed, clear numbering and re-assign
      if (timezoneChanged && settings.timezone) {
        console.log(`[Settings] Timezone changed to ${settings.timezone}, re-numbering posts...`)
        const { clearAllNumbering } = await import('../curation/skylimitCache')
        await clearAllNumbering()
        const { assignAllNumbers } = await import('../curation/skylimitNumbering')
        await assignAllNumbers()
        console.log('[Settings] Post re-numbering complete')
      }

      // Mark settings as saved (no longer dirty)
      setOriginalSettings(structuredClone(settings))

      alert(timezoneChanged ? 'Settings saved! Posts re-numbered for new timezone.' : 'Settings saved!')
    } catch (error) {
      console.error('Failed to save settings:', error)
      alert('Failed to save settings')
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

  const handleResetCuration = async () => {
    setIsResettingCuration(true)
    try {
      if (typeof (window as any).clearCacheAndReloadHomePage === 'function') {
        await (window as any).clearCacheAndReloadHomePage()
        setShowResetCurationModal(false)
        setIsResettingCuration(false)
        navigate('/')
      } else {
        navigate('/')
        setTimeout(async () => {
          if (typeof (window as any).clearCacheAndReloadHomePage === 'function') {
            await (window as any).clearCacheAndReloadHomePage()
          }
          setIsResettingCuration(false)
        }, 500)
      }
    } catch (error) {
      console.error('Failed to reset curation:', error)
      setIsResettingCuration(false)
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
        navigate('/')
        setTimeout(async () => {
          if (typeof (window as any).resetFeedAndReloadHomePage === 'function') {
            await (window as any).resetFeedAndReloadHomePage()
          }
          setIsResettingFeed(false)
        }, 500)
      }
    } catch (error) {
      console.error('Failed to reset feed:', error)
      setIsResettingFeed(false)
    }
  }

  const handleClearSettings = async () => {
    setIsClearingSettings(true)
    try {
      await clearSkylimitSettings()
      // Refresh page to apply default settings
      window.location.reload()
    } catch (error) {
      console.error('Failed to clear settings:', error)
      setIsClearingSettings(false)
    }
  }

  const handleResetAll = () => {
    setIsResettingAll(true)
    resetEverything() // Redirects to /?reset=1
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
        <h2 className="text-lg font-semibold">Navigation</h2>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Click to <span className="text-blue-500">Bluesky</span></div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Open posts, profiles, and notifications in Bluesky. Return to Skylimit by using back navigation repeatedly.
            </div>
          </div>
          <button
            onClick={() => {
              const newValue = !clickToBlueSky
              localStorage.setItem('websky_click_to_bluesky', newValue.toString())
              setClickToBlueSky(newValue)
            }}
            className="btn bg-blue-500 hover:bg-blue-600 text-white"
          >
            {clickToBlueSky ? 'Disable' : 'Enable'}
          </button>
        </div>
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

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">About</h2>
        <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2">
          <p>Skylimit – A curating Bluesky client (alpha version)</p>
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
          className="space-y-6"
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
                onChange={(e) => updateSetting('viewsPerDay', parseInt(e.target.value) || 300)}
                className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
              />
              <p className="text-sm text-gray-500 mt-1">
                The average number of posts you want to see per day (statistical limit)
              </p>
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
                  checked={settings.infiniteScrollingOption || false}
                  onChange={(e) => updateSetting('infiniteScrollingOption', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Enable "infinite" scroll down</span>
              </label>

              <div>
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

              <div>
                <label className="block mb-2 font-medium">
                  Full Page Wait Time (minutes):
                </label>
                <input
                  type="number"
                  min="5"
                  max="120"
                  value={settings.pagedUpdatesFullPageWaitMinutes ?? 30}
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
                  Days of data to analyze:
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={settings.daysOfData}
                  onChange={(e) => updateSetting('daysOfData', parseInt(e.target.value) || 30)}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                />
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

          <DisclosureSection title="Experimental Settings">
            <div className="space-y-4">
              <div>
                <label className="block mb-2 font-medium">
                  Digest edition times (comma-separated, e.g., "08:00,15:00"):
                </label>
                <input
                  type="text"
                  value={settings.editionTimes}
                  onChange={(e) => updateSetting('editionTimes', e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  placeholder="08:00,15:00"
                />
              </div>

              <div>
                <label className="block mb-2 font-medium">
                  Digest edition layout:
                </label>
                <textarea
                  value={settings.editionLayout}
                  onChange={(e) => updateSetting('editionLayout', e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  rows={6}
                  placeholder="@user1.bsky.social @user2.bsky.social#hashtag&#10;SectionName&#10;@user3.bsky.social"
                />
                <p className="text-sm text-gray-500 mt-1">
                  Configure which accounts appear in digest editions
                </p>
              </div>

              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.anonymizeUsernames}
                  onChange={(e) => updateSetting('anonymizeUsernames', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Anonymize usernames (for screenshots)</span>
              </label>
            </div>
          </DisclosureSection>

          <DisclosureSection title="Debug Settings">
            <div className="space-y-4">
              <label className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  checked={settings.debugMode}
                  onChange={(e) => updateSetting('debugMode', e.target.checked)}
                  className="w-5 h-5"
                />
                <span>Debug mode (enables additional UI features)</span>
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
                    Variability Factor
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="3"
                    step="0.1"
                    value={settings.pagedUpdatesVarFactor ?? PAGED_UPDATES_DEFAULTS.varFactor}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value)
                      if (!isNaN(value) && value >= 1 && value <= 3) {
                        updateSetting('pagedUpdatesVarFactor', value)
                      }
                    }}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Multiplier for raw posts to fetch (accounts for filtering variability). Higher = more reliable page fill. Range: 1-3.
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
          </DisclosureSection>

          <div className="flex justify-start pt-4 border-t">
            <Button
              type="submit"
              variant="primary"
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Update Curation Settings'}
            </Button>
          </div>
        </form>

        {/* Data Management */}
        <div className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700">
        <DisclosureSection title="Data Management">

          {/* Cache Statistics - only show if debug mode is enabled */}
          {settings.debugMode && (
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
              {loadingCacheGaps ? 'Loading...' : showCacheGaps ? 'Hide Cache Gaps' : 'Show Cache Gaps'}
            </Button>

            {showCacheGaps && (
              <div className="mt-4 space-y-4">
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

        <div className="flex flex-wrap gap-3 mt-6">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowResetFeedModal(true)}
            disabled={isResettingFeed}
            className="px-6 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-full"
          >
            Reset feed
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowResetCurationModal(true)}
            disabled={isResettingCuration}
            className="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-full"
          >
            Reset curation
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowClearSettingsModal(true)}
            disabled={isClearingSettings}
            className="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-full"
          >
            Reset Skylimit settings
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowResetAllModal(true)}
            disabled={isResettingAll}
            className="px-6 py-2 bg-red-500 hover:bg-red-600 text-white rounded-full"
          >
            Reset all
          </Button>
        </div>

        {/* Reset Feed Confirmation Modal */}
        <ConfirmModal
          isOpen={showResetFeedModal}
          onClose={() => setShowResetFeedModal(false)}
          onConfirm={handleResetFeed}
          title="Reset Feed"
          message={`This will clear the feed and reload posts using existing curation data:
• Feed posts and pagination state
• Session storage state

Curation summaries will be preserved, so posts will be curated on-the-fly without a full lookback.

Your Skylimit settings, follow list, and login session will be preserved.

You will be redirected to the home page with a refreshed feed.`}
          confirmText={isResettingFeed ? 'Resetting...' : 'Reset Feed'}
          cancelText="Cancel"
          isDangerous={false}
          isLoading={isResettingFeed}
        />

        {/* Reset Curation Confirmation Modal */}
        <ConfirmModal
          isOpen={showResetCurationModal}
          onClose={() => setShowResetCurationModal(false)}
          onConfirm={handleResetCuration}
          title="Reset Curation"
          message={`This will clear all cached data including curation summaries and reload the home feed:
• Feed posts and pagination state
• Curation summaries cache
• Session storage state

Your Skylimit settings, follow list, and login session will be preserved.

You will be redirected to the home page with a fresh curation pass.`}
          confirmText={isResettingCuration ? 'Resetting...' : 'Reset Curation'}
          cancelText="Cancel"
          isDangerous={false}
          isLoading={isResettingCuration}
        />

        {/* Reset Skylimit Settings Confirmation Modal */}
        <ConfirmModal
          isOpen={showClearSettingsModal}
          onClose={() => setShowClearSettingsModal(false)}
          onConfirm={handleClearSettings}
          title="Reset Skylimit Settings"
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
          message={`WARNING: This will completely wipe all Websky data:
• All cached posts and summaries
• All Skylimit settings
• Follow list data
• Login session (you will be logged out)

This is a complete reset to factory state. Use this only if the app is not working correctly.

This cannot be undone.`}
          confirmText={isResettingAll ? 'Resetting...' : 'Reset Everything'}
          cancelText="Cancel"
          isDangerous={true}
          isLoading={isResettingAll}
        />
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
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        {(['basic', 'curation', 'following'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-4 py-3 text-center font-medium transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-blue-500 text-blue-500'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab === 'basic' ? 'Basic' : tab === 'curation' ? 'Curation' : 'Following'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className={`p-4 ${hasUnsavedChanges && activeTab === 'curation' ? 'pb-20' : ''}`}>
        {activeTab === 'basic' && renderBasicTab()}
        {activeTab === 'curation' && renderCurationTab()}
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

      </div>
  )
}
