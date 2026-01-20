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

type SortField = 'username' | 'postsPerDay' | 'shownPerDay' | 'name'
type SortDirection = 'asc' | 'desc'

export default function SkylimitStatistics() {
  const { session } = useSession()
  const navigate = useNavigate()
  const [stats, setStats] = useState<GlobalStats | null>(null)
  const [userFilter, setUserFilter] = useState<UserFilter | null>(null)
  const [_follows, setFollows] = useState<FollowInfo[]>([])
  const [accountStats, setAccountStats] = useState<AccountStatistics[]>([])
  const [loading, setLoading] = useState(true)
  const [anonymize, setAnonymize] = useState(false)
  const [filterTimestamp, setFilterTimestamp] = useState<number | null>(null)
  const [followedTags, setFollowedTags] = useState<string[]>([])
  const [curationTimezone, setCurationTimezone] = useState<string>('')
  const [viewsPerDay, setViewsPerDay] = useState<number>(0)
  const [showPopup, setShowPopup] = useState<string | null>(null) // username of account to show popup for
  const [popupPosition, setPopupPosition] = useState<'above' | 'below'>('below') // Position of popup relative to cell
  const [loadingAmp, setLoadingAmp] = useState(false)
  const [sortField, setSortField] = useState<SortField>('postsPerDay')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const popupRef = useRef<HTMLDivElement>(null)
  const cellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map())
  const myUsername = session?.handle || ''

  useEffect(() => {
    loadStatistics()
  }, [])

  const loadStatistics = async () => {
    try {
      setLoading(true)

      // Get settings for anonymization and views per day
      const settings = await getSettings()
      setAnonymize(settings?.anonymizeUsernames || false)
      setViewsPerDay(settings?.viewsPerDay || 0)
      
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
          post_daily: 0,
          boost_daily: 0,
          reblog2_daily: 0,
          engaged_daily: 0,
          total_daily: 0,
          net_prob: 0,
          priority_prob: 0,
          post_prob: 0,
          reblog2_avg: 0,
        }
        
        // Use total_daily for posts per day (like Mahoot does)
        // If total_daily is not set, calculate it from the daily values
        const postsPerDay = entry.total_daily > 0 
          ? entry.total_daily 
          : (entry.motx_daily || 0) + (entry.priority_daily || 0) + (entry.post_daily || 0) + (entry.boost_daily || 0)
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

  // Close popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        setShowPopup(null)
      }
    }

    if (showPopup) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showPopup])


  // Format curation message from userEntry and followInfo
  const formatCurationMessage = (userEntry: UserEntry, followInfo?: FollowInfo): string => {
    const postingCount = Math.round(countTotalPostsForUser(userEntry))
    const repostingCount = Math.round(userEntry.boost_daily)
    const showProb = (userEntry.post_prob * 100).toFixed(1)
    const ampFactor = followInfo?.amp_factor ?? userEntry.amp_factor
    
    let msg = `Posting ${postingCount}/day (reposting ${repostingCount}/day)\nShow probability: ${showProb}%`
    if (ampFactor !== null && ampFactor !== undefined) {
      msg += `\nAmp factor: ${ampFactor}`
    }
    return msg
  }

  const handleAmpUp = async (username: string) => {
    try {
      setLoadingAmp(true)
      await ampUp(username)
      setShowPopup(null)
      // Reload statistics to reflect the change
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
      await ampDown(username)
      setShowPopup(null)
      // Reload statistics to reflect the change
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
        case 'shownPerDay':
          const shownA = a.postsPerDay * (a.displayProbability / 100)
          const shownB = b.postsPerDay * (b.displayProbability / 100)
          comparison = shownA - shownB
          break
        case 'name':
          const nameA = a.followInfo?.displayName || a.username
          const nameB = b.followInfo?.displayName || b.username
          comparison = nameA.localeCompare(nameB)
          break
      }

      return sortDirection === 'asc' ? comparison : -comparison
    })
  }, [accountStats, sortField, sortDirection])

  // Get sort indicator for column header
  const getSortIndicator = (field: SortField): string => {
    if (sortField !== field) return ''
    return sortDirection === 'asc' ? ' ↑' : ' ↓'
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
              {/* Posts/day breakdown with original vs reposts */}
              <div>
                Analyzed {stats.status_daily.toFixed(0)} posts/day
                {stats.original_posts_daily !== undefined && stats.reposts_daily !== undefined && (
                  <> ({stats.original_posts_daily.toFixed(0)} original, {stats.reposts_daily.toFixed(0)} reposts)</>
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
                  Summaries (complete intervals): {stats.summaries_total} total, {stats.summaries_accumulated ?? 0} processed (from followees), {stats.summaries_skipped ?? 0} skipped (from non-followees)
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
        <h3 className="text-lg font-semibold mb-3">Active Followees</h3>
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
                    const cell = e.currentTarget.closest('td') as HTMLTableCellElement
                    if (cell) {
                      cellRefs.current.set(account.username, cell)
                      
                      // Calculate position before showing popup
                      const cellRect = cell.getBoundingClientRect()
                      const popupHeight = 250 // Approximate popup height in pixels
                      const spaceBelow = window.innerHeight - cellRect.bottom
                      const spaceAbove = cellRect.top
                      
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
                const curationMessage = formatCurationMessage(account.userEntry, account.followInfo)
                
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
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm relative">
                      {formatPostCount(shownPerDay)} (
                        <button
                          onClick={handleProbabilityClick}
                          className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          {formatPercentage(probabilityPercent)}%
                        </button>
                      )
                      {isPopupOpen && (
                        <div
                          ref={popupRef}
                          className={`absolute right-0 w-64 max-w-[calc(100vw-2rem)] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 ${
                            popupPosition === 'above'
                              ? 'bottom-full mb-1'
                              : 'top-full mt-1'
                          }`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="p-3 border-b border-gray-200 dark:border-gray-700">
                            <div className="font-semibold text-sm">
                              {account.followInfo?.displayName || account.displayName || account.username}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              @{account.username}
                            </div>
                          </div>

                          {/* Show statistics */}
                          {curationMessage && (
                            <div className="p-3 border-b border-gray-200 dark:border-gray-700">
                              <div className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-line">
                                {curationMessage}
                              </div>
                            </div>
                          )}

                          {/* Amp Up/Down buttons */}
                          {!account.isHashtag && (
                            <div className="p-3">
                              <div className="text-xs font-semibold mb-2">Amplification Factor</div>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleAmpDown(account.username)}
                                  disabled={loadingAmp}
                                  className="flex-1 px-3 py-2 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded disabled:opacity-50"
                                >
                                  Amp Down (÷2)
                                </button>
                                <button
                                  onClick={() => handleAmpUp(account.username)}
                                  disabled={loadingAmp}
                                  className="flex-1 px-3 py-2 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-50"
                                >
                                  Amp Up (×2)
                                </button>
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                                Adjust how many posts you see from this account
                              </div>
                            </div>
                          )}
                        </div>
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
