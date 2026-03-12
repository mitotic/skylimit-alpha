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
import { clientNow } from '../utils/clientClock'
import log from '../utils/logger'

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

type SortField = 'username' | 'postsPerDay' | 'allowedPerDay' | 'probability' | 'amp' | 'engaged' | 'name'
type SortDirection = 'asc' | 'desc'

type ChartMode = 'posting' | 'normalized'

interface ChartDataPoint {
  index: number
  username: string
  normalizedDaily: number
  actualDaily: number
  allowedPerDay: number
  shownDaily: number
}

function CurationChart({ data, highlightUsername, mode }: { data: ChartDataPoint[], highlightUsername?: string | null, mode: ChartMode }) {
  const margin = { top: 20, right: 2, bottom: 40, left: 38 }
  const width = 640
  const height = 300
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  const xMax = data.length
  const yMin = 1 // log scale floor (avoid log(0))
  const allValues = mode === 'normalized'
    ? data.flatMap(d => [d.normalizedDaily, d.actualDaily, d.allowedPerDay]).filter(v => v > 0)
    : data.flatMap(d => [d.actualDaily, d.shownDaily, d.allowedPerDay]).filter(v => v > 0)
  const yMaxData = Math.max(...allValues, 1)
  const logMin = Math.log(yMin)
  const logMax = Math.log(Math.max(yMaxData * 1.1, 100, yMin + 1))

  const xScale = (i: number) => margin.left + ((i - 1) / Math.max(xMax - 1, 1)) * plotW
  const yScale = (v: number) => {
    const clamped = Math.max(v, yMin)
    return margin.top + plotH - ((Math.log(clamped) - logMin) / (logMax - logMin)) * plotH
  }

  // Y-axis ticks: fixed labels, data may overflow above 100
  const yTicks = [2, 3, 5, 10, 20, 30, 40, 60, 100]

  // X-axis ticks: round numbers (~8 ticks)
  const xRawStep = xMax / 8
  const xMag = Math.pow(10, Math.floor(Math.log10(xRawStep || 1)))
  const xNorm = xRawStep / xMag
  const xNiceStep = xNorm <= 1 ? xMag : xNorm <= 2 ? 2 * xMag : xNorm <= 5 ? 5 * xMag : 10 * xMag
  const xTicks: number[] = []
  for (let i = Math.max(xNiceStep, 1); i <= xMax; i += xNiceStep || 1) xTicks.push(Math.round(i))

  const xAxisLabel = mode === 'normalized'
    ? 'Followee (sorted by normalized rate)'
    : 'Followee (sorted by posting rate)'

  return (
    <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
      <h3 className="text-lg font-semibold mb-2">Curation Rate Distribution</h3>
      <svg viewBox={`-30 0 ${width + 30} ${height}`} width="100%" className="max-h-[250px]">
        {/* Grid lines */}
        {yTicks.map(v => (
          <line key={`grid-${v}`} x1={margin.left} x2={width - margin.right}
            y1={yScale(v)} y2={yScale(v)}
            className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={0.5} />
        ))}

        {/* Y-axis */}
        <line x1={margin.left} x2={margin.left}
          y1={margin.top} y2={margin.top + plotH}
          className="stroke-gray-400 dark:stroke-gray-500" strokeWidth={1} />
        {yTicks.map(v => (
          <text key={`y-${v}`} x={margin.left - 6} y={yScale(v) + 5}
            textAnchor="end" style={{ fontSize: 'var(--post-secondary-text-size)' }}
            className="fill-gray-600 dark:fill-gray-400">{v}</text>
        ))}
        <text x={-18} y={margin.top + plotH / 2}
          textAnchor="middle" style={{ fontSize: 'var(--post-secondary-text-size)' }} transform={`rotate(-90, -18, ${margin.top + plotH / 2})`}
          className="fill-gray-600 dark:fill-gray-400">Posts / day</text>

        {/* X-axis */}
        <line x1={margin.left} x2={width - margin.right}
          y1={margin.top + plotH} y2={margin.top + plotH}
          className="stroke-gray-400 dark:stroke-gray-500" strokeWidth={1} />
        {xTicks.map(i => (
          <text key={`x-${i}`} x={xScale(i)} y={margin.top + plotH + 18}
            textAnchor="middle" style={{ fontSize: 'var(--post-secondary-text-size)' }}
            className="fill-gray-600 dark:fill-gray-400">{i}</text>
        ))}
        <text x={margin.left + plotW / 2} y={height - 2}
          textAnchor="middle" style={{ fontSize: 'var(--post-secondary-text-size)' }}
          className="fill-gray-600 dark:fill-gray-400">{xAxisLabel}</text>

        {mode === 'normalized' ? (
          <>
            {/* Normalized daily rate - line */}
            <polyline points={data.map(d => `${xScale(d.index)},${yScale(d.normalizedDaily)}`).join(' ')} fill="none"
              className="stroke-blue-500 dark:stroke-blue-400" strokeWidth={1.5} />

            {/* Posting rate - solid triangles (amber) */}
            {data.map(d => {
              const cx = xScale(d.index)
              const cy = yScale(d.actualDaily)
              const s = 3
              const points = `${cx},${cy - s} ${cx - s},${cy + s} ${cx + s},${cy + s}`
              return (
                <polygon key={`actual-${d.index}`} points={points}
                  className="fill-amber-500 dark:fill-amber-400" />
              )
            })}

            {/* Allow rate - open blue squares */}
            {data.map(d => {
              const cx = xScale(d.index)
              const cy = yScale(d.allowedPerDay)
              const s = 2.5
              return (
                <rect key={`allowed-${d.index}`} x={cx - s} y={cy - s} width={s * 2} height={s * 2}
                  fill="none" className="stroke-blue-500 dark:stroke-blue-400" strokeWidth={1.5} />
              )
            })}

            {/* Legend */}
            <line x1={margin.left + 10} x2={margin.left + 28} y1={margin.top + 8} y2={margin.top + 8}
              className="stroke-blue-500 dark:stroke-blue-400" strokeWidth={1.5} />
            <text x={margin.left + 32} y={margin.top + 13} style={{ fontSize: 'var(--post-secondary-text-size)' }}
              className="fill-gray-700 dark:fill-gray-300">Normalized rate</text>

            <polygon points={`${margin.left + 19},${margin.top + 21} ${margin.left + 15},${margin.top + 28} ${margin.left + 23},${margin.top + 28}`}
              className="fill-amber-500 dark:fill-amber-400" />
            <text x={margin.left + 32} y={margin.top + 29} style={{ fontSize: 'var(--post-secondary-text-size)' }}
              className="fill-gray-700 dark:fill-gray-300">Posting rate</text>

            <rect x={margin.left + 15.5} y={margin.top + 36.5} width={7} height={7}
              fill="none" className="stroke-blue-500 dark:stroke-blue-400" strokeWidth={1.5} />
            <text x={margin.left + 32} y={margin.top + 45} style={{ fontSize: 'var(--post-secondary-text-size)' }}
              className="fill-gray-700 dark:fill-gray-300">Allow rate</text>
          </>
        ) : (
          <>
            {/* Allow rate - open blue squares (skylimit_number × amp_factor) — drawn first (back) */}
            {data.map(d => {
              const cx = xScale(d.index)
              const cy = yScale(d.allowedPerDay)
              const s = 2.5
              return (
                <rect key={`computed-${d.index}`} x={cx - s} y={cy - s} width={s * 2} height={s * 2}
                  fill="none" className="stroke-blue-500 dark:stroke-blue-400" strokeWidth={1.5} />
              )
            })}

            {/* Show rate - filled green circles (actual shown from data) — drawn middle */}
            {data.map(d => (
              <circle key={`shown-${d.index}`} cx={xScale(d.index)} cy={yScale(d.shownDaily)}
                r={3} className="fill-green-600 dark:fill-green-400" />
            ))}

            {/* Posting rate - solid amber triangles — drawn last (front) */}
            {data.map(d => {
              const cx = xScale(d.index)
              const cy = yScale(d.actualDaily)
              const s = 3
              const points = `${cx},${cy - s} ${cx - s},${cy + s} ${cx + s},${cy + s}`
              return (
                <polygon key={`actual-${d.index}`} points={points}
                  className="fill-amber-500 dark:fill-amber-400" />
              )
            })}

            {/* Legend */}
            <polygon points={`${margin.left + 19},${margin.top + 5} ${margin.left + 15},${margin.top + 12} ${margin.left + 23},${margin.top + 12}`}
              className="fill-amber-500 dark:fill-amber-400" />
            <text x={margin.left + 32} y={margin.top + 13} style={{ fontSize: 'var(--post-secondary-text-size)' }}
              className="fill-gray-700 dark:fill-gray-300">Posting rate</text>

            <circle cx={margin.left + 19} cy={margin.top + 24} r={3.5}
              className="fill-green-600 dark:fill-green-400" />
            <text x={margin.left + 32} y={margin.top + 29} style={{ fontSize: 'var(--post-secondary-text-size)' }}
              className="fill-gray-700 dark:fill-gray-300">Show rate</text>

            <rect x={margin.left + 15.5} y={margin.top + 36.5} width={7} height={7}
              fill="none" className="stroke-blue-500 dark:stroke-blue-400" strokeWidth={1.5} />
            <text x={margin.left + 32} y={margin.top + 45} style={{ fontSize: 'var(--post-secondary-text-size)' }}
              className="fill-gray-700 dark:fill-gray-300">Allow rate</text>
          </>
        )}

        {/* Highlight vertical line for selected user */}
        {highlightUsername && (() => {
          const point = data.find(d => d.username === highlightUsername)
          if (!point) return null
          const x = xScale(point.index)
          return (
            <line x1={x} x2={x} y1={margin.top} y2={margin.top + plotH}
              className="stroke-red-500 dark:stroke-red-400" strokeWidth={1.5} strokeDasharray="4 3" />
          )
        })()}
      </svg>
    </div>
  )
}

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
  const [storedTimezone, setStoredTimezone] = useState<string>('')
  const [viewsPerDay, setViewsPerDay] = useState<number>(0)
  const [showPopup, setShowPopup] = useState<string | null>(null) // username of account to show popup for
  const [popupPosition, setPopupPosition] = useState<'above' | 'below'>('below') // Position of popup relative to cell
  const [popupAnchorRect, setPopupAnchorRect] = useState<DOMRect | null>(null) // Anchor rect for fixed positioning
  const [loadingAmp, setLoadingAmp] = useState(false)
  const [sortField, setSortField] = useState<SortField>('postsPerDay')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [debugMode, setDebugMode] = useState(false)
  const [chartMode, setChartMode] = useState<ChartMode>('posting')
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
      setStoredTimezone(settings?.timezone || '')
      
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
          priorityPatterns: follow.priorityPatterns || '',
          amp_factor: follow.amp_factor || 1.0,
          periodic_daily: 0,
          priority_daily: 0,
          original_daily: 0,
          followed_reply_daily: 0,
          unfollowed_reply_daily: 0,
          repost_daily: 0,
          engaged_daily: 0,
          total_daily: 0,
          shown_daily: 0,
          net_prob: 0,
          priority_prob: 0,
          regular_prob: 0,
        }

        // Use total_daily for posts per day (like Mahoot does)
        // If total_daily is not set, calculate it from the daily values
        const postsPerDay = entry.total_daily > 0
          ? entry.total_daily
          : (entry.periodic_daily || 0) + (entry.priority_daily || 0) + (entry.original_daily || 0) + (entry.followed_reply_daily || 0) + (entry.unfollowed_reply_daily || 0) + (entry.repost_daily || 0)
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
      log.error('Stats', 'Failed to load statistics:', error)
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
    priorityPerDay: number
    repostsPerDay: number
    followedRepliesPerDay: number
    unfollowedRepliesPerDay: number
    editedPerDay: number
    regularProb: number
    priorityProb: number
    ampFactor: number | null
  } => {
    const postingCount = Math.round(countTotalPostsForUser(userEntry))
    const originalsPerDay = userEntry.original_daily
    const priorityPerDay = userEntry.priority_daily
    const repostsPerDay = userEntry.repost_daily
    const followedRepliesPerDay = userEntry.followed_reply_daily
    const unfollowedRepliesPerDay = userEntry.unfollowed_reply_daily
    const editedPerDay = userEntry.edited_daily
    const regularProb = userEntry.regular_prob * 100
    const priorityProb = userEntry.priority_prob * 100
    const ampFactor = followInfo?.amp_factor ?? userEntry.amp_factor ?? null

    return { postingCount, originalsPerDay, priorityPerDay, repostsPerDay, followedRepliesPerDay, unfollowedRepliesPerDay, editedPerDay, regularProb, priorityProb, ampFactor }
  }

  const handleAmpUp = async (username: string) => {
    try {
      setLoadingAmp(true)
      await ampUp(username, myUsername)
      // Reload statistics to reflect recomputed probabilities
      await loadStatistics()
    } catch (error) {
      log.error('Stats', 'Failed to amp up:', error)
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
      log.error('Stats', 'Failed to amp down:', error)
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

  // Chart data: users sorted by normalized daily rate ascending
  const chartDataNormalized = useMemo(() => {
    if (!accountStats.length || !stats) return null

    const users = accountStats.filter(a => !a.isSelf && !a.isHashtag && a.postsPerDay > 0)
    const sorted = [...users].sort((a, b) => {
      const normA = a.userEntry.total_daily / (a.amplificationFactor || 1)
      const normB = b.userEntry.total_daily / (b.amplificationFactor || 1)
      return normA - normB
    })

    return sorted.map((a, i) => ({
      index: i + 1,
      username: a.username,
      normalizedDaily: a.userEntry.total_daily / (a.amplificationFactor || 1),
      actualDaily: a.userEntry.total_daily,
      allowedPerDay: stats.skylimit_number * (a.amplificationFactor || 1),
      shownDaily: a.userEntry.shown_daily,
    }))
  }, [accountStats, stats])

  // Chart data: users sorted by actual posting rate ascending
  const chartDataPosting = useMemo(() => {
    if (!accountStats.length || !stats) return null

    const users = accountStats.filter(a => !a.isSelf && !a.isHashtag && a.postsPerDay > 0)
    const sorted = [...users].sort((a, b) => a.userEntry.total_daily - b.userEntry.total_daily)

    return sorted.map((a, i) => ({
      index: i + 1,
      username: a.username,
      normalizedDaily: a.userEntry.total_daily / (a.amplificationFactor || 1),
      actualDaily: a.userEntry.total_daily,
      allowedPerDay: stats.skylimit_number * (a.amplificationFactor || 1),
      shownDaily: a.userEntry.shown_daily,
    }))
  }, [accountStats, stats])

  const chartData = chartMode === 'normalized' ? chartDataNormalized : chartDataPosting

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
        case 'allowedPerDay': {
          const allowA = stats ? stats.skylimit_number * (a.amplificationFactor || 1) : 0
          const allowB = stats ? stats.skylimit_number * (b.amplificationFactor || 1) : 0
          comparison = allowA - allowB
          break
        }
        case 'probability':
          comparison = a.displayProbability - b.displayProbability
          break
        case 'amp':
          comparison = a.amplificationFactor - b.amplificationFactor
          break
        case 'engaged':
          comparison = a.userEntry.engaged_daily - b.userEntry.engaged_daily
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
      // Unsorted: stacked up/down chevron outlines to indicate sortable
      return <span className="text-gray-400 dark:text-gray-500 ml-1 inline-flex flex-col align-middle leading-none"><svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-2" fill="none" viewBox="0 0 24 16" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 12l7-7 7 7" /></svg><svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-2" fill="none" viewBox="0 0 24 16" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M19 4l-7 7-7-7" /></svg></span>
    }
    // Sorted: filled green triangle pointing up (asc) or down (desc)
    return <span className="text-green-600 dark:text-green-400 ml-1 inline-flex align-middle">{sortDirection === 'asc' ? <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24"><polygon points="12,3 23,21 1,21" fill="currentColor" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24"><polygon points="12,21 1,3 23,3" fill="currentColor" /></svg>}</span>
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
          {stats && (
            <>
              <div>
                Expected average daily views = {viewsPerDay}
              </div>
              <div>
                <strong>Skylimit number={stats.skylimit_number.toFixed(1)}</strong> [daily views guaranteed per normal followee (amp=1)]
              </div>
              {filterTimestamp && (
                <div>
                  <em>
                    Updated: {new Date(filterTimestamp).toLocaleString('en-US', storedTimezone ? { timeZone: storedTimezone } : undefined)} {storedTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone}
                  </em>
                </div>
              )}
              <details>
                <summary className="cursor-pointer text-blue-500">Details</summary>
                <div className="mt-1 space-y-1">
                  {curationTimezone && (
                    <div>
                      <em>Curation timezone: {curationTimezone}</em>
                    </div>
                  )}
                  {followedTags.length > 0 && (
                    <div>
                      Following tags: #{followedTags.join(', #')}
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
                  {/* Edition post count */}
                  {stats.edition_post_total_cached !== undefined && stats.edition_post_total_cached > 0 && (
                    <div>
                      Edition posts held: {stats.edition_post_total_cached}
                    </div>
                  )}
                  {/* Summaries cache timestamps */}
                  {stats.summaries_oldest_time && stats.summaries_newest_time && (
                    <div>
                      Summaries time range: {new Date(stats.summaries_oldest_time).toLocaleString('en-US', storedTimezone ? { timeZone: storedTimezone } : undefined)} - {new Date(stats.summaries_newest_time).toLocaleString('en-US', storedTimezone ? { timeZone: storedTimezone } : undefined)}
                    </div>
                  )}
                </div>
              </details>
            </>
          )}
        </div>
      </div>

      {/* Curation Rate Distribution Chart */}
      {chartData && chartData.length > 0 && (
        <div>
          <div className="mb-2">
            <select
              value={chartMode}
              onChange={e => setChartMode(e.target.value as ChartMode)}
              className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="posting">Posting rate</option>
              <option value="normalized">Normalized posting rate</option>
            </select>
          </div>
          <CurationChart data={chartData} highlightUsername={showPopup} mode={chartMode} />
        </div>
      )}

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
                  onClick={() => handleSort('amp')}
                >
                  Amp{getSortIndicator('amp')}
                </th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('postsPerDay')}
                >
                  Posts{getSortIndicator('postsPerDay')}
                </th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('allowedPerDay')}
                >
                  Allow{getSortIndicator('allowedPerDay')}
                </th>
                {debugMode && (
                  <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold">
                    Shown
                  </th>
                )}
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('probability')}
                >
                  Prob{getSortIndicator('probability')}
                </th>
                <th
                  className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-sm font-semibold cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 select-none"
                  onClick={() => handleSort('engaged')}
                >
                  Enggd{getSortIndicator('engaged')}
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

                // Calculate allowed posts per day (skylimit_number × amp_factor)
                const allowedPerDay = stats ? stats.skylimit_number * (account.amplificationFactor || 1) : 0
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
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm relative">
                      <button
                        onClick={handleProbabilityClick}
                        className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                      >
                        {account.amplificationFactor >= 1 ? account.amplificationFactor.toFixed(1) : account.amplificationFactor.toFixed(2)}{account.followInfo?.amp_factor_changed_at && (clientNow() - account.followInfo.amp_factor_changed_at < 7 * 24 * 60 * 60 * 1000) ? '*' : ''}
                      </button>
                      {isPopupOpen && (
                        <CurationPopup
                          ref={popupRef}
                          displayName={account.followInfo?.displayName || account.displayName || ''}
                          handle={account.username}
                          popupPosition={popupPosition}
                          anchorRect={popupAnchorRect || undefined}
                          postingPerDay={curationStats.postingCount}
                          allowedPerDay={stats ? stats.skylimit_number * (account.amplificationFactor || 1) : undefined}
                          originalsPerDay={curationStats.originalsPerDay}
                          priorityPerDay={curationStats.priorityPerDay}
                          repostsPerDay={curationStats.repostsPerDay}
                          followedRepliesPerDay={curationStats.followedRepliesPerDay}
                          unfollowedRepliesPerDay={curationStats.unfollowedRepliesPerDay}
                          editedPerDay={curationStats.editedPerDay}
                          regularProb={curationStats.regularProb / 100}
                          priorityProb={curationStats.priorityProb / 100}
                          skylimitNumber={stats?.skylimit_number}
                          showAmpButtons={!account.isHashtag}
                          ampFactor={curationStats.ampFactor ?? undefined}
                          onAmpUp={() => handleAmpUp(account.username)}
                          onAmpDown={() => handleAmpDown(account.username)}
                          ampLoading={loadingAmp}
                          debugMode={debugMode}
                          followedAt={account.followInfo?.followed_at}
                          priorityPatterns={account.followInfo?.priorityPatterns || account.userEntry?.priorityPatterns}
                          timezone={account.followInfo?.timezone}
                          onNavigateToSettings={() => {
                            setShowPopup(null)
                            navigate('/settings?tab=editions')
                          }}
                          onClose={() => setShowPopup(null)}
                        />
                      )}
                    </td>
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">{formatPostCount(account.postsPerDay)}</td>
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">
                      {formatPostCount(allowedPerDay)}
                    </td>
                    {debugMode && (
                      <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">
                        {formatPostCount(account.userEntry.shown_daily)}
                      </td>
                    )}
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">
                      {formatPercentage(probabilityPercent)}%
                    </td>
                    <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm">
                      {account.userEntry.engaged_daily.toFixed(1)}
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
