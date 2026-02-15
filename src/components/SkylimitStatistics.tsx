/**
 * Skylimit Statistics Display Component
 * Shows posting statistics for all followed accounts
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { getFilterWithTimestamp, getAllFollows } from '../curation/skylimitCache'
import { GlobalStats, UserFilter, UserEntry, FollowInfo } from '../curation/types'
import { countTotalPostsForUser } from '../curation/skylimitStats'
import { getSettings } from '../curation/skylimitStore'
import { useSession } from '../auth/SessionContext'
import { ampUp, ampDown } from '../curation/skylimitFollows'
import CurationPopup from './CurationPopup'

interface AccountStatistics {
  username: string
  displayName?: string
  postsPerDay: number
  displayProbability: number
  amplificationFactor: number
  userEntry: UserEntry
  followInfo?: FollowInfo
  isHashtag: boolean
  isSelf: boolean
}

type SortField = 'username' | 'postsPerDay' | 'shownPerDay' | 'probability' | 'name'
type SortDirection = 'asc' | 'desc'

export default function SkylimitStatistics() {
  const { session } = useSession()
  const navigate = useNavigate()
  const [stats, setStats] = useState<GlobalStats | null>(null)
  const [userFilter, setUserFilter] = useState<UserFilter | null>(null)
  const [, setFollows] = useState<FollowInfo[]>([])
  const [accountStats, setAccountStats] = useState<AccountStatistics[]>([])
  const [loading, setLoading] = useState(true)
  const [anonymize, setAnonymize] = useState(false)
  const [filterTimestamp, setFilterTimestamp] = useState<number | null>(null)
  const [followedTags, setFollowedTags] = useState<string[]>([])
  const [curationTimezone, setCurationTimezone] = useState<string>('')
  const [viewsPerDay, setViewsPerDay] = useState<number>(0)
  const [showPopup, setShowPopup] = useState<string | null>(null) // username of account to show popup for
  const [popupPosition, setPopupPosition] = useState<'above' | 'below'>('below') // Position of popup relative to cell
  const [popupAnchorRect, setPopupAnchorRect] = useState<DOMRect | null>(null) // Anchor rect for fixed positioning
  const [loadingAmp, setLoadingAmp] = useState(false)
  const [sortField, setSortField] = useState<SortField>('postsPerDay')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [debugMode, setDebugMode] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  const myUsername = session?.handle || ''

  useEffect(() => {
    loadStatistics()
  }, [])

  const loadStatistics = async () => {
    try {
      setLoading(true)

      // Get settings for anonymization, views per day, and debug mode
      const settings = await getSettings()
      setAnonymize(settings?.anonymizeUsernames || false)
      setViewsPerDay(settings?.viewsPerDay || 0)
      setDebugMode(settings?.debugMode || false)
      
      // Get statistics with timestamp
      const filterResult = await getFilterWithTimestamp()
      if (!filterResult) {
        setLoading(false)
        return
      }
      
      const [globalStats, userFilterData, timestamp] = filterResult
      setStats(globalStats)
      setUserFilter(userFilterData)
      setFilterTimestamp(timestamp)

      // Get followed hashtags and most common timezone
      const allFollows = await getAllFollows()
      const tags: string[] = []
      const timezoneCounts: Record<string, number> = {}
      
      for (const follow of allFollows) {
        // Collect hashtags (usernames starting with #)
        if (follow.username.startsWith('#')) {
          tags.push(follow.username.slice(1)) // Remove # prefix
        }
        // Count timezones
        if (follow.timezone && follow.timezone !== 'UTC') {
          timezoneCounts[follow.timezone] = (timezoneCounts[follow.timezone] || 0) + 1
        }
      }
      
      setFollowedTags(tags)
      
      // Get most common timezone, or use browser timezone as fallback
      const mostCommonTimezone = Object.entries(timezoneCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || Intl.DateTimeFormat().resolvedOptions().timeZone
      setCurationTimezone(mostCommonTimezone)
      
      // Get follows (already loaded above, but need for account stats)
      setFollows(allFollows)
      
      // Build account statistics
      // Iterate over ALL followed users (like Mahoot does), not just those in userFilter
      const accounts: AccountStatistics[] = []
      const followMap = new Map<string, FollowInfo>()
      for (const follow of allFollows) {
        followMap.set(follow.username, follow)
      }
      
      // Find self user (usually the one with altname 'user_0000' or matches current username)
      let selfUsername = myUsername
      if (!selfUsername) {
        for (const [username, userEntry] of Object.entries(userFilterData)) {
          if (userEntry.altname === 'user_0000') {
            selfUsername = username
            break
          }
        }
      }
      
      // Iterate over all follows (like Mahoot does in curation.html)
      for (const follow of allFollows) {
        const username = follow.username
        const userEntry = userFilterData[username]
        const isHashtag = username.startsWith('#')
        const isSelf = username === selfUsername
        
        // If user has no stats yet, create a default entry
        const entry = userEntry || {
          altname: isHashtag ? username : `user_${username.slice(0, 4)}`,
          acct_id: follow.accountDid || '',
          topics: follow.topics || '',
          amp_factor: follow.amp_factor || 1.0,
          motx_daily: 0,
          priority_daily: 0,
          original_daily: 0,
          followed_reply_daily: 0,
          unfollowed_reply_daily: 0,
          repost_daily: 0,
          engaged_daily: 0,
          total_daily: 0,
          net_prob: 0,
          priority_prob: 0,
          regular_prob: 0,
        }

        // Use total_daily for posts per day (like Mahoot does)
        // If total_daily is not set, calculate it from the daily values
        const postsPerDay = entry.total_daily > 0
          ? entry.total_daily
          : (entry.motx_daily || 0) + (entry.priority_daily || 0) + (entry.original_daily || 0) + (entry.followed_reply_daily || 0) + (entry.unfollowed_reply_daily || 0) + (entry.repost_daily || 0)
        const displayProbability = (entry.net_prob || 0) * 100
        
        // Get amplification factor from follow info
        const ampFactor = follow.amp_factor || 1.0
        
        accounts.push({
          username,
          displayName: follow.username || username,
          postsPerDay,
          displayProbability,
          amplificationFactor: ampFactor,
          userEntry: entry,
          followInfo: follow,
          isHashtag,
          isSelf,
        })
      }
      
      // Also include self user if not already in follows
      if (selfUsername && !followMap.has(selfUsername)) {
        const userEntry = userFilterData[selfUsername]
        if (userEntry) {
          const postsPerDay = userEntry.total_daily || 0
          const displayProbability = userEntry.net_prob * 100
          const ampFactor = userEntry.amp_factor || 1.0
          
          accounts.push({
            username: selfUsername,
            displayName: selfUsername,
            postsPerDay,
            displayProbability,
            amplificationFactor: ampFactor,
            userEntry,
            followInfo: undefined,
            isHashtag: false,
            isSelf: true,
          })
        }
      }
      
      // Filter out followees with zero posts
      const activeAccounts = accounts.filter(a => a.postsPerDay > 0)

      // Sort by posts per day (descending) - highest first (like Mahoot)
      activeAccounts.sort((a, b) => {
        // Primary sort: posts per day descending
        const diff = b.postsPerDay - a.postsPerDay
        if (Math.abs(diff) > 0.01) {
          return diff
        }
        // Secondary sort: username ascending
        return a.username.localeCompare(b.username)
      })

      setAccountStats(activeAccounts)
    } catch (error) {
      console.error('Failed to load statistics:', error)
    } finally {
      setLoading(false)
    }
  }

  // Reload when session changes
  useEffect(() => {
    if (session) {
      loadStatistics()
    }
  }, [session])

  // Close popup when clicking/touching outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        setShowPopup(null)
      }
    }

    if (showPopup) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('touchstart', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('touchstart', handleClickOutside)
      }
    }
  }, [showPopup])


  // Format curation message from userEntry and followInfo
  // Now returns structured data for the new popup format
  const formatCurationStats = (userEntry: UserEntry, followInfo?: FollowInfo): {
    postingCount: number
    originalsPerDay: number
    repostsPerDay: number
    followedRepliesPerDay: number
    unfollowedRepliesPerDay: number
    regularProb: number
    priorityProb: number
    ampFactor: number | null
  } => {
    const postingCount = Math.round(countTotalPostsForUser(userEntry))
    const originalsPerDay = userEntry.original_daily
    const repostsPerDay = userEntry.repost_daily
    const followedRepliesPerDay = userEntry.followed_reply_daily
    const unfollowedRepliesPerDay = userEntry.unfollowed_reply_daily
    const regularProb = userEntry.regular_prob * 100
    const priorityProb = userEntry.priority_prob * 100
    const ampFactor = followInfo?.amp_factor ?? userEntry.amp_factor ?? null

    return { postingCount, originalsPerDay, repostsPerDay, followedRepliesPerDay, unfollowedRepliesPerDay, regularProb, priorityProb, ampFactor }
  }

  const handleAmpUp = async (username: string) => {
    try {
      setLoadingAmp(true)
      await ampUp(username, myUsername)
      // Reload statistics to reflect recomputed probabilities
      await loadStatistics()
    } catch (error) {
      console.error('Failed to amp up:', error)
      alert('Failed to update amplification factor')
    } finally {
      setLoadingAmp(false)
    }
  }

  const handleAmpDown = async (username: string) => {
    try {
      setLoadingAmp(true)
      await ampDown(username, myUsername)
      // Reload statistics to reflect recomputed probabilities
      await loadStatistics()
    } catch (error) {
      console.error('Failed to amp down:', error)
      alert('Failed to update amplification factor')
    } finally {
      setLoadingAmp(false)
    }
  }

  // Format post count: show 1 decimal if < 10, otherwise round to integer
  const formatPostCount = (count: number): string => {
    if (count < 10) {
      return count.toFixed(1)
    }
    return Math.round(count).toString()
  }

  // Format percentage: show 1 decimal if < 10, otherwise round to integer
  const formatPercentage = (percent: number): string => {
    if (percent < 10) {
      return percent.toFixed(1)
    }
    return Math.round(percent).toString()
  }

  // Sort handler for table columns
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      // Default to descending for numeric fields, ascending for text fields
      setSortDirection(field === 'username' || field === 'name' ? 'asc' : 'desc')
    }
  }

  // Sorted account stats
  const sortedAccountStats = useMemo(() => {
    return [...accountStats].sort((a, b) => {
      let comparison = 0

      switch (sortField) {
        case 'username':
          comparison = a.username.localeCompare(b.username)
          break
        case 'postsPerDay':
          comparison = a.postsPerDay - b.postsPerDay
          break
        case 'shownPerDay': {
          const shownA = a.postsPerDay * (a.displayProbability / 100)
          const shownB = b.postsPerDay * (b.displayProbability / 100)
          comparison = shownA - shownB
          break
        }
        case 'probability':
          comparison = a.displayProbability - b.displayProbability
          break
        case 'name': {
          const nameA = a.followInfo?.displayName || a.username
          const nameB = b.followInfo?.displayName || b.username
          comparison = nameA.localeCompare(nameB)
          break
        }
      }

      return sortDirection === 'asc' ? comparison : -comparison
    })
  }, [accountStats, sortField, sortDirection])

  // Get sort indicator for column header
  const getSortIndicator = (field: SortField): JSX.Element => {
    if (sortField !== field) {
      return <span className="text-gray-400 dark:text-gray-500 ml-1">↓</span>
    }
    return <span className="text-green-600 dark:text-green-400 ml-1 font-bold">{sortDirection === 'asc' ? '↑' : '↓'}</span>
  }

  if (loading) {
    return (
      <div className="p-4 text-center text-gray-500 dark:text-gray-400">
        Loading statistics...
      </div>
    )
  }

  if (!stats || !userFilter) {
    return (
      <div className="p-4 text-center text-gray-500 dark:text-gray-400">
        No statistics available yet. Statistics are computed periodically as you use Skylimit.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Summary Statistics (like Mahoot) */}
      <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
        <h3 className="text-lg font-semibold mb-3">Summary Statistics</h3>
        <div className="space-y-1 text-sm">
          {filterTimestamp && (
            <div>
              <em>
                Updated: {new Date(filterTimestamp).toLocaleString()} {Intl.DateTimeFormat().resolvedOptions().timeZone}
              </em>
            </div>
          )}
          {curationTimezone && (
            <div>
              <em>Curation timezone: {curationTimezone}</em>
            </div>
          )}
          {stats && (
            <>
              <div>
                <strong>Expected average daily views = {viewsPerDay}</strong>
              </div>
              <div>
                <strong>
                  Default Skylimit Number={stats.skylimit_number.toFixed(1)} (daily views guaranteed per followee)
                </strong>
              </div>
              {followedTags.length > 0 && (
                <div>
                  <strong>Following tags: #{followedTags.join(', #')}</strong>
                </div>
              )}
              {/* Posts/day breakdown with original, replies, and reposts */}
              <div>
                Analyzed {stats.post_daily.toFixed(0)} posts/day
                {stats.original_daily !== undefined && (
                  <> ({stats.original_daily.toFixed(0)} original, {stats.followed_reply_daily?.toFixed(0) ?? 0} followed replies, {stats.unfollowed_reply_daily?.toFixed(0) ?? 0} unfollowed replies, {stats.reposts_daily?.toFixed(0) ?? 0} reposts)</>
                )}
                {' '}by {Object.keys(userFilter || {}).length} followees over{' '}
                {stats.complete_intervals_days !== undefined && stats.complete_intervals_days > 0 ? (
                  <>a non-contiguous period of {stats.day_total.toFixed(2)} days ({stats.intervals_complete} complete {stats.interval_length_hours}-hour intervals)</>
                ) : (
                  <>last {stats.day_total.toFixed(2)} days</>
                )}
                {stats.days_of_data !== undefined && <> within the last {stats.days_of_data} days</>}.
              </div>
              {/* Interval diagnostics with complete/incomplete breakdown */}
              {stats.intervals_expected !== undefined && stats.intervals_processed !== undefined && (
                <div>
                  Intervals: {stats.intervals_processed} of {stats.intervals_expected} expected ({((stats.intervals_processed / stats.intervals_expected) * 100).toFixed(1)}% coverage)
                  {stats.intervals_complete !== undefined && stats.intervals_incomplete !== undefined && (
                    <> ({stats.intervals_complete} complete, {stats.intervals_incomplete} incomplete)</>
                  )}
                </div>
              )}
              {stats.posts_per_interval_avg !== undefined && (
                <div>
                  Posts/interval: avg {stats.posts_per_interval_avg.toFixed(1)}
                  {stats.posts_per_interval_max !== undefined && <>, max {stats.posts_per_interval_max}</>}
                </div>
              )}
              {stats.intervals_sparse !== undefined && stats.intervals_sparse > 0 && stats.posts_per_interval_avg !== undefined && (
                <div className="text-yellow-600 dark:text-yellow-400">
                  Warning: {stats.intervals_sparse} intervals have &lt; {(stats.posts_per_interval_avg * 0.1).toFixed(0)} posts
                </div>
              )}
              {/* Cache vs accumulated diagnostics */}
              {stats.summaries_total !== undefined && (
                <div>
                  Summaries (complete intervals): {stats.summaries_total} total, {stats.summaries_accumulated ?? 0} processed
                </div>
              )}
              {/* Total cached summaries (all intervals) */}
              {stats.summaries_total_cached !== undefined && (
                <div>
                  Summaries: total {stats.summaries_total_cached}, dropped {stats.summaries_dropped_cached ?? 0} ({stats.summaries_total_cached > 0 ? ((stats.summaries_dropped_cached ?? 0) / stats.summaries_total_cached * 100).toFixed(1) : 0}%)
                </div>
              )}
              {/* Summaries cache timestamps */}
              {stats.summaries_oldest_time && stats.summaries_newest_time && (
                <div>
                  Summaries time range: {new Date(stats.summaries_oldest_time).toLocaleString()} - {new Date(stats.summaries_newest_time).toLocaleString()}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Active Followee Statistics Table */}
      <div className="w-full">
        <h3 className="text-lg font-semibold mb-1">Active Followees</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">Daily average statistics (* =&gt; probabilities updated within last week)</p>
        <div className="overflow-x-auto max-w-full" style={{ WebkitOverflowScrolling: 'touch' }}>
          <table className="w-full border-collapse border border-gray-300 dark:border-gray-600 text-sm">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold">#</th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('username')}
                >
                  Followee{getSortIndicator('username')}
                </th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('postsPerDay')}
                >
                  Posts{getSortIndicator('postsPerDay')}
                </th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('shownPerDay')}
                >
                  Shown{getSortIndicator('shownPerDay')}
                </th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('probability')}
                >
                  Prob{getSortIndicator('probability')}
                </th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('name')}
                >
                  Name{getSortIndicator('name')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedAccountStats.map((account, index) => {
                // For Name column: use displayName if available, otherwise altname if anonymized, otherwise username
                let name: string
                if (anonymize && !account.isSelf) {
                  name = account.userEntry.altname
                } else if (account.followInfo?.displayName) {
                  name = account.followInfo.displayName
                } else {
                  name = account.username
                }
                
                // Handle click on Followee handle
                const handleFolloweeClick = (e: React.MouseEvent) => {
                  e.stopPropagation()
                  // Only navigate if it's not a hashtag (hashtags don't have profile pages)
                  if (!account.isHashtag && account.username) {
                    // Save scroll position before navigation (for scroll restoration on back)
                    const scrollY = window.scrollY || document.documentElement.scrollTop
                    try {
                      sessionStorage.setItem('websky_skylimit_settings_scroll', scrollY.toString())
                    } catch (error) {
                      // Ignore storage errors
                    }
                    navigate(`/profile/${account.username}`)
                  }
                }

                // Calculate shown posts per day (posts displayed after curation)
                const shownPerDay = account.postsPerDay * (account.displayProbability / 100)
                const probabilityPercent = account.displayProbability

                // Handle click on probability percentage
                const handleProbabilityClick = (e: React.MouseEvent) => {
                  e.stopPropagation()
                  if (showPopup === account.username) {
                    setShowPopup(null)
                  } else {
                    // Store cell reference for positioning calculation
                    const button = e.currentTarget as HTMLButtonElement
                    if (button) {
                      const buttonRect = button.getBoundingClientRect()
                      const popupHeight = 250 // Approximate popup height in pixels
                      const spaceBelow = window.innerHeight - buttonRect.bottom
                      const spaceAbove = buttonRect.top

                      // Store the anchor rect for fixed positioning
                      setPopupAnchorRect(buttonRect)

                      // Position above if not enough space below but enough space above
                      if (spaceBelow < popupHeight && spaceAbove > spaceBelow) {
                        setPopupPosition('above')
                      } else {
                        setPopupPosition('below')
                      }
                    }
                    setShowPopup(account.username)
                  }
                }

                const isPopupOpen = showPopup === account.username
                const curationStats = formatCurationStats(account.userEntry, account.followInfo)
                
                return (
                  <tr
                    key={account.username}
                    className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">{index + 1}</td>
                    <td
                      className={`border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm ${
                        !account.isHashtag ? 'cursor-pointer text-blue-600 dark:text-blue-400 hover:underline' : ''
                      }`}
                      onClick={handleFolloweeClick}
                    >
                      <div className="max-w-[150px] truncate" title={account.username}>
                        {account.isHashtag ? `#${account.username.slice(1)}` : account.username}
                        {account.isSelf && <span className="text-gray-500 dark:text-gray-400 ml-1">(self)</span>}
                      </div>
                    </td>
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">{formatPostCount(account.postsPerDay)}</td>
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">
                      {formatPostCount(shownPerDay)}
                    </td>
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm relative">
                      <button
                        onClick={handleProbabilityClick}
                        className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                      >
                        {formatPercentage(probabilityPercent)}%{account.followInfo?.amp_factor_changed_at && (Date.now() - account.followInfo.amp_factor_changed_at < 7 * 24 * 60 * 60 * 1000) ? '*' : ''}
                      </button>
                      {isPopupOpen && (
                        <CurationPopup
                          ref={popupRef}
                          displayName={account.followInfo?.displayName || account.displayName || ''}
                          handle={account.username}
                          popupPosition={popupPosition}
                          anchorRect={popupAnchorRect || undefined}
                          postingPerDay={curationStats.postingCount}
                          shownPerDay={curationStats.postingCount * (account.displayProbability / 100)}
                          originalsPerDay={curationStats.originalsPerDay}
                          repostsPerDay={curationStats.repostsPerDay}
                          followedRepliesPerDay={curationStats.followedRepliesPerDay}
                          unfollowedRepliesPerDay={curationStats.unfollowedRepliesPerDay}
                          regularProb={curationStats.regularProb / 100}
                          priorityProb={curationStats.priorityProb / 100}
                          showAmpButtons={!account.isHashtag}
                          ampFactor={curationStats.ampFactor ?? undefined}
                          onAmpUp={() => handleAmpUp(account.username)}
                          onAmpDown={() => handleAmpDown(account.username)}
                          ampLoading={loadingAmp}
                          debugMode={debugMode}
                          followedAt={account.followInfo?.followed_at}
                          topics={account.followInfo?.topics || account.userEntry?.topics}
                          timezone={account.followInfo?.timezone}
                          onNavigateToSettings={() => {
                            setShowPopup(null)
                            navigate('/settings?tab=curation')
                          }}
                          onClose={() => setShowPopup(null)}
                        />
                      )}
                    </td>
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">
                      <div className="max-w-[120px] truncate" title={name}>{name}</div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
