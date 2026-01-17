/**
 * Skylimit Settings Page
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSettings, updateSettings } from '../curation/skylimitStore'
import { SkylimitSettings } from '../curation/types'
import Button from '../components/Button'
import SkylimitStatistics from '../components/SkylimitStatistics'
import { getSummariesCacheStats, SummariesCacheStats, clearSkylimitSettings, resetEverything } from '../curation/skylimitCache'
import ConfirmModal from '../components/ConfirmModal'
import { getFeedCacheStats, FeedCacheStats } from '../curation/skylimitFeedCache'

export default function SkylimitSettingsPage() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<SkylimitSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [feedCacheStats, setFeedCacheStats] = useState<FeedCacheStats | null>(null)
  const [summariesStats, setSummariesStats] = useState<SummariesCacheStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(true)
  const [showCleanResetModal, setShowCleanResetModal] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [showClearSettingsModal, setShowClearSettingsModal] = useState(false)
  const [isClearingSettings, setIsClearingSettings] = useState(false)
  const [showResetAllModal, setShowResetAllModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)

  useEffect(() => {
    loadSettings()
    loadCacheStats()
  }, [])

  const loadCacheStats = async () => {
    setLoadingStats(true)
    try {
      const [feedStats, summariesCacheStats] = await Promise.all([
        getFeedCacheStats(),
        getSummariesCacheStats(),
      ])
      setFeedCacheStats(feedStats)
      setSummariesStats(summariesCacheStats)
    } catch (error) {
      console.error('Failed to load cache stats:', error)
    } finally {
      setLoadingStats(false)
    }
  }

  const loadSettings = async () => {
    try {
      const s = await getSettings()
      setSettings(s)
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
      // Get the currently stored settings to compare settings that affect filtering
      const storedSettings = await getSettings()
      const storedShowAllStatus = storedSettings?.showAllStatus ?? false
      const newShowAllStatus = settings.showAllStatus ?? false
      const storedDisabled = storedSettings?.disabled ?? false
      const newDisabled = settings.disabled ?? false

      await updateSettings(settings)

      // Trigger feed refilter if showAllStatus OR disabled changed
      // Both settings affect which posts are displayed
      if (newShowAllStatus !== storedShowAllStatus || newDisabled !== storedDisabled) {
        console.log(`[Settings] Filter settings changed (showAllStatus: ${storedShowAllStatus}→${newShowAllStatus}, disabled: ${storedDisabled}→${newDisabled}), triggering refilter`)
        // Set flag for HomePage to trigger refilter when it mounts/becomes active
        // (HomePage may not be mounted while on settings page)
        sessionStorage.setItem('skylimit_needs_refilter', 'true')
        // Also try to call directly if HomePage is mounted
        if ((window as any).refilterFeedFromCache) {
          (window as any).refilterFeedFromCache()
        }
      }

      alert('Settings saved!')
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

  const handleCleanCacheReset = async () => {
    setIsResetting(true)
    try {
      // Check if clearCacheAndReloadHomePage is available (set by HomePage)
      if (typeof (window as any).clearCacheAndReloadHomePage === 'function') {
        await (window as any).clearCacheAndReloadHomePage()
        setShowCleanResetModal(false)
        setIsResetting(false)
        // Navigate to home page
        navigate('/')
      } else {
        // Fallback: navigate to home first, then try again
        navigate('/')
        // Give the home page time to mount and set up the function
        setTimeout(async () => {
          if (typeof (window as any).clearCacheAndReloadHomePage === 'function') {
            await (window as any).clearCacheAndReloadHomePage()
          }
          setIsResetting(false)
        }, 500)
      }
    } catch (error) {
      console.error('Failed to reset cache:', error)
      setIsResetting(false)
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

  const handleResetAll = async () => {
    setIsResettingAll(true)
    try {
      await resetEverything()
      // Use reset flag URL so IndexedDB deletion happens before initDB opens a connection
      window.location.href = '/?reset=1'
    } catch (error) {
      console.error('Failed to reset all:', error)
      setIsResettingAll(false)
    }
  }

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
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/settings')}
          className="text-blue-500 hover:text-blue-600 mb-4"
        >
          ← Back to Settings
        </button>
        <h1 className="text-2xl font-bold">Skylimit Settings</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
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

        <section>
          <h2 className="text-xl font-semibold mb-4">Advanced Settings</h2>
          
          <div className="space-y-4">
            <label className="flex items-center space-x-3">
              <input
                type="checkbox"
                checked={settings.showTime}
                onChange={(e) => updateSetting('showTime', e.target.checked)}
                className="w-5 h-5"
              />
              <span>Display post timestamp (hh:mm) in home feed</span>
            </label>

            <label className="flex items-center space-x-3">
              <input
                type="checkbox"
                checked={settings.showAllStatus}
                onChange={(e) => updateSetting('showAllStatus', e.target.checked)}
                className="w-5 h-5"
              />
              <span>Show dropped posts (as grayed out)</span>
            </label>

            <label className="flex items-center space-x-3">
              <input
                type="checkbox"
                checked={settings.hideSelfReplies}
                onChange={(e) => updateSetting('hideSelfReplies', e.target.checked)}
                className="w-5 h-5"
              />
              <span>Hide self replies from home timeline</span>
            </label>

            <label className="flex items-center space-x-3">
              <input
                type="checkbox"
                checked={settings.hideDuplicateReposts}
                onChange={(e) => updateSetting('hideDuplicateReposts', e.target.checked)}
                className="w-5 h-5"
              />
              <span>Hide duplicate reposts</span>
            </label>

            <label className="flex items-center space-x-3">
              <input
                type="checkbox"
                checked={settings.disabled}
                onChange={(e) => updateSetting('disabled', e.target.checked)}
                className="w-5 h-5"
              />
              <span>Disable curation (temporarily turn off Skylimit)</span>
            </label>

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
          </div>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-4">Experimental Settings</h2>

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
                checked={settings.amplifyHighBoosts}
                onChange={(e) => updateSetting('amplifyHighBoosts', e.target.checked)}
                className="w-5 h-5"
              />
              <span>Amplify high reposts (increase probability for highly reposted content)</span>
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
              <input
                type="checkbox"
                checked={settings.debugMode}
                onChange={(e) => updateSetting('debugMode', e.target.checked)}
                className="w-5 h-5"
              />
              <span>Skylimit Debug Mode (enables additional UI features)</span>
            </label>

            {settings.debugMode && (
              <div className="mt-4 p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                <h3 className="text-lg font-semibold mb-4">Debug: Feed Redisplay Settings</h3>
                
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">
                    Feed Redisplay Idle Interval (minutes)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={settings.feedRedisplayIdleInterval ? settings.feedRedisplayIdleInterval / (60 * 1000) : 5}
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
                    Feed Page Length (posts per page)
                  </label>
                  <input
                    type="number"
                    min="10"
                    max="100"
                    value={settings.feedPageLength || 25}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10)
                      if (!isNaN(value) && value >= 10 && value <= 100) {
                        updateSetting('feedPageLength', value)
                      }
                    }}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Number of posts to load per page. Initial load from cache shows twice this amount. Range: 10-100.
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

                <div className="mb-4">
                  <label className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      checked={settings.infiniteScrollingOption || false}
                      onChange={(e) => updateSetting('infiniteScrollingOption', e.target.checked)}
                      className="w-5 h-5"
                    />
                    <span>Enable Infinite Scrolling</span>
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-8">
                    Automatically load more posts as you scroll down. When disabled, use 'Load More' button instead.
                  </p>
                </div>

                <h3 className="text-lg font-semibold mb-4 mt-6">Paged Fresh Updates</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Delay viewing new posts so popularity metrics have time to accumulate, enabling better curation.
                </p>

                <div className="mb-4">
                  <label className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      checked={settings.pagedUpdatesEnabled ?? true}
                      onChange={(e) => updateSetting('pagedUpdatesEnabled', e.target.checked)}
                      className="w-5 h-5"
                    />
                    <span>Enable Paged Fresh Updates</span>
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-8">
                    When enabled, new posts are fetched fresh on demand. Shows "Next Page" button instead of immediate "New Posts" notification.
                  </p>
                </div>

                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">
                    Variability Factor
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="3"
                    step="0.1"
                    value={settings.pagedUpdatesVarFactor ?? 1.5}
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

                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">
                    Max Wait Time (minutes)
                  </label>
                  <input
                    type="number"
                    min="5"
                    max="120"
                    value={settings.pagedUpdatesMaxWaitMinutes ?? 30}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10)
                      if (!isNaN(value) && value >= 5 && value <= 120) {
                        updateSetting('pagedUpdatesMaxWaitMinutes', value)
                      }
                    }}
                    className="w-32 px-4 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-700"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Maximum time to wait for a full page before showing partial page. Range: 5-120 minutes.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="flex justify-end space-x-4 pt-4 border-t">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate('/settings')}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Update Settings'}
          </Button>
        </div>
      </form>

      {/* Data Management */}
      <section className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-semibold mb-4">Data Management</h2>
        
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
        
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setShowCleanResetModal(true)}
            disabled={isResetting}
            className="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-full"
          >
            Reset cache
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
      </section>

      {/* Statistics Display */}
      <section className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700">
        <SkylimitStatistics />
      </section>

      {/* Clean Cache Reset Confirmation Modal */}
      <ConfirmModal
        isOpen={showCleanResetModal}
        onClose={() => setShowCleanResetModal(false)}
        onConfirm={handleCleanCacheReset}
        title="Reset Cache"
        message={`This will clear all cached data and reload the home feed:
• Feed posts and pagination state
• Curation summaries cache
• Session storage state

Your Skylimit settings, follow list, and login session will be preserved.

You will be redirected to the home page with a fresh feed.`}
        confirmText={isResetting ? 'Resetting...' : 'Reset Cache'}
        cancelText="Cancel"
        isDangerous={false}
        isLoading={isResetting}
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

