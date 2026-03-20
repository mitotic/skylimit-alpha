/**
 * Follow management for Skylimit curation
 */

import { BskyAgent, AppBskyGraphGetFollows } from '@atproto/api'
import { FollowInfo, MIN_AMP_FACTOR, MAX_AMP_FACTOR } from './types'
import { getAllFollows, saveFollow, deleteFollow, getFilter } from './skylimitCache'
import { recomputeProbabilities } from './skylimitStats'
import { getSettings } from './skylimitStore'
import { extractPriorityPatternsFromProfile, extractTimezone } from './skylimitGeneral'
import { getProfiles } from '../api/profile'
import { AppBskyActorDefs } from '@atproto/api'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'
import { clientNow, clientDate } from '../utils/clientClock'
import log from '../utils/logger'

/**
 * Get last follow refresh time from cache
 */
async function getLastFollowRefreshTime(): Promise<number> {
  try {
    const { getSettings } = await import('./skylimitCache')
    const settings = await getSettings()
    return (settings as any)?.lastFollowRefreshTime || 0
  } catch {
    return 0
  }
}

/**
 * Save last follow refresh time
 */
async function saveLastFollowRefreshTime(): Promise<void> {
  try {
    const { getSettings, saveSettings } = await import('./skylimitCache')
    const settings = await getSettings() || {}
    await saveSettings({ ...settings, lastFollowRefreshTime: clientNow() })
  } catch (err) {
    log.warn('Follows', 'Failed to save last follow refresh time:', err)
  }
}

/**
 * Refresh follows from Bluesky
 * Only refreshes if force=true or if it's been more than 1 hour since last refresh
 * Only fetches profiles for new follows or when topics/timezone are missing
 */
export async function refreshFollows(agent: BskyAgent, myDid: string, force: boolean = false, onProgress?: (percent: number) => void): Promise<void> {
  try {
    // Check if we need to refresh (unless forced)
    if (!force) {
      const lastRefreshTime = await getLastFollowRefreshTime()
      const oneHour = 60 * 60 * 1000
      if (clientNow() - lastRefreshTime < oneHour) {
        return
      }
    }

    // Get all current follows from Bluesky with rate limit handling
    const follows: AppBskyGraphGetFollows.OutputSchema['follows'] = []
    let cursor: string | undefined
    
    do {
      const response = await retryWithBackoff(
        async () => {
          return await agent.getFollows({
            actor: myDid,
            limit: 100,
            cursor,
          })
        },
        3, // max retries
        2000, // base delay 2 seconds (longer for batch operations)
        (rateLimitInfo) => {
          log.warn('Follows', 'Rate limit in getFollows:', rateLimitInfo)
        }
      ).catch(error => {
        if (isRateLimitError(error)) {
          const info = getRateLimitInfo(error)
          throw new Error(
            info.message || 
            `Rate limit exceeded while fetching follows. Please wait ${info.retryAfter || 60} seconds before trying again.`
          )
        }
        throw error
      })
      
      follows.push(...response.data.follows)
      cursor = response.data.cursor
      
      // Add a small delay between pagination requests to avoid rate limits
      if (cursor) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } while (cursor)

    onProgress?.(10)

    // Get existing follows from cache
    const existingFollows = await getAllFollows()
    const existingMap = new Map<string, FollowInfo>()
    for (const f of existingFollows) {
      existingMap.set(f.username, f)
    }
    
    // Collect DIDs that need profile fetches
    // Only fetch if this is a NEW follow or displayName is missing
    const didsNeedingProfiles: string[] = []
    for (const follow of follows) {
      const existing = existingMap.get(follow.handle)
      if (!existing || !existing.displayName) {
        didsNeedingProfiles.push(follow.did)
      }
    }

    // Fetch profiles in batches of 25 (API limit)
    const BATCH_SIZE = 25
    const profileMap = new Map<string, AppBskyActorDefs.ProfileViewDetailed>()

    if (didsNeedingProfiles.length > 0) {
      const numBatches = Math.ceil(didsNeedingProfiles.length / BATCH_SIZE)
      log.debug('Follows', `Fetching ${didsNeedingProfiles.length} profiles in ${numBatches} batches of ${BATCH_SIZE}`)

      for (let i = 0; i < didsNeedingProfiles.length; i += BATCH_SIZE) {
        const batch = didsNeedingProfiles.slice(i, i + BATCH_SIZE)
        const batchNum = Math.floor(i / BATCH_SIZE) + 1

        try {
          const response = await getProfiles(agent, batch)
          for (const profile of response.profiles) {
            profileMap.set(profile.did, profile)
          }
          log.debug('Follows', `Batch ${batchNum}/${numBatches}: fetched ${response.profiles.length} profiles`)
        } catch (err) {
          log.warn('Follows', `Batch ${batchNum}/${numBatches} failed:`, err)
        }

        onProgress?.(10 + Math.round(90 * batchNum / numBatches))

        // Small delay between batches to avoid rate limits
        if (i + BATCH_SIZE < didsNeedingProfiles.length) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }

      log.info('Follows', `Completed batch fetching: ${profileMap.size} profiles retrieved`)
    } else {
      onProgress?.(100)
    }

    // Update or create follow entries using the fetched profiles
    for (const follow of follows) {
      const username = follow.handle
      const existing = existingMap.get(username)
      const profile = profileMap.get(follow.did)

      // Extract data from profile if we fetched one
      let priorityPatterns = existing?.priorityPatterns || ''
      let timezone = existing?.timezone || 'UTC'
      let displayName = existing?.displayName || ''

      if (profile) {
        const extractedPatterns = extractPriorityPatternsFromProfile(profile)
        const extractedTimezone = extractTimezone(profile)
        if (extractedPatterns) priorityPatterns = extractedPatterns
        if (extractedTimezone !== 'UTC') timezone = extractedTimezone
        if (profile.displayName) displayName = profile.displayName
      }

      const followInfo: FollowInfo = {
        accountDid: follow.did,
        username,
        followed_at: existing?.followed_at || clientDate().toISOString(),
        amp_factor: existing?.amp_factor || 1.0,
        priorityPatterns,
        timezone,
        displayName: displayName || undefined,
        followedBy: profile ? !!profile.viewer?.followedBy : existing?.followedBy,
        lastUpdatedAt: profile ? clientNow() : existing?.lastUpdatedAt,
      }

      // Preserve periodic post tracking and other fields
      if (existing) {
        if (existing.lastWeeklyPostId) {
          followInfo.lastWeeklyPostId = existing.lastWeeklyPostId
        }
        // Preserve displayName if we didn't fetch a new one
        if (!followInfo.displayName && existing.displayName) {
          followInfo.displayName = existing.displayName
        }
      }

      await saveFollow(followInfo)
      existingMap.delete(username)
    }

    // Save refresh time
    await saveLastFollowRefreshTime()
    
    // Unfollowed accounts are handled by the daily sweep (sweepFollowCache)

  } catch (error) {
    log.error('Follows', 'Failed to refresh follows:', error)
    throw error
  }
}

/**
 * Get last sweep time from cache
 */
async function getLastSweepTime(): Promise<number> {
  try {
    const { getSettings } = await import('./skylimitCache')
    const settings = await getSettings()
    return (settings as any)?.lastSweepTime || 0
  } catch {
    return 0
  }
}

/**
 * Save last sweep time
 */
async function saveLastSweepTime(): Promise<void> {
  try {
    const { getSettings, saveSettings } = await import('./skylimitCache')
    const settings = await getSettings() || {}
    await saveSettings({ ...settings, lastSweepTime: clientNow() })
  } catch (err) {
    log.warn('Follows', 'Failed to save last sweep time:', err)
  }
}

/**
 * Daily sweep of follow cache to keep entries fresh.
 * - Removes unfollowed users from cache
 * - Adds newly followed users not yet in cache
 * - Updates stale entries (lastUpdatedAt > 24 hours or missing)
 * Skips if last sweep was < 24 hours ago. Failures are logged, not thrown.
 */
export async function sweepFollowCache(agent: BskyAgent, myDid: string): Promise<void> {
  try {
    const lastSweepTime = await getLastSweepTime()
    const oneDay = 24 * 60 * 60 * 1000
    if (clientNow() - lastSweepTime < oneDay) {
      return
    }

    // Save sweep time immediately to prevent concurrent sweeps
    await saveLastSweepTime()
    log.info('Follows', 'Starting daily follow cache sweep')

    // Fetch current follows from API
    const apiFollows: AppBskyGraphGetFollows.OutputSchema['follows'] = []
    let cursor: string | undefined
    do {
      const response = await retryWithBackoff(
        async () => agent.getFollows({ actor: myDid, limit: 100, cursor }),
        3, 2000,
        (rateLimitInfo) => log.warn('Follows', 'Rate limit in sweep getFollows:', rateLimitInfo)
      ).catch(error => {
        if (isRateLimitError(error)) {
          const info = getRateLimitInfo(error)
          throw new Error(info.message || `Rate limit exceeded during sweep.`)
        }
        throw error
      })
      apiFollows.push(...response.data.follows)
      cursor = response.data.cursor
      if (cursor) await new Promise(resolve => setTimeout(resolve, 100))
    } while (cursor)

    const apiHandleSet = new Set(apiFollows.map(f => f.handle))
    const apiByHandle = new Map(apiFollows.map(f => [f.handle, f]))

    // Get cached follows
    const cachedFollows = await getAllFollows()
    const cachedMap = new Map(cachedFollows.map(f => [f.username, f]))

    let deletedCount = 0
    let addedCount = 0
    let updatedCount = 0

    // Delete unfollowed users from cache
    for (const cached of cachedFollows) {
      if (!apiHandleSet.has(cached.username)) {
        await deleteFollow(cached.username)
        deletedCount++
      }
    }

    // Collect DIDs needing profile fetch: new follows + stale entries
    const didsNeedingProfiles: string[] = []
    const now = clientNow()

    // New follows not in cache
    for (const [handle, apiFollow] of apiByHandle) {
      if (!cachedMap.has(handle)) {
        didsNeedingProfiles.push(apiFollow.did)
      }
    }

    // Stale entries (lastUpdatedAt missing or > 24h)
    for (const cached of cachedFollows) {
      if (apiHandleSet.has(cached.username)) {
        if (!cached.lastUpdatedAt || (now - cached.lastUpdatedAt) > oneDay) {
          didsNeedingProfiles.push(cached.accountDid)
        }
      }
    }

    // Fetch profiles in batches of 25
    const BATCH_SIZE = 25
    const profileMap = new Map<string, AppBskyActorDefs.ProfileViewDetailed>()

    for (let i = 0; i < didsNeedingProfiles.length; i += BATCH_SIZE) {
      const batch = didsNeedingProfiles.slice(i, i + BATCH_SIZE)
      try {
        const response = await getProfiles(agent, batch)
        for (const profile of response.profiles) {
          profileMap.set(profile.did, profile)
        }
      } catch (err) {
        log.warn('Follows', `Sweep profile batch failed:`, err)
      }
      if (i + BATCH_SIZE < didsNeedingProfiles.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Add newly followed users
    for (const [handle, apiFollow] of apiByHandle) {
      if (!cachedMap.has(handle)) {
        const profile = profileMap.get(apiFollow.did)
        const priorityPatterns = profile ? extractPriorityPatternsFromProfile(profile) : ''
        const timezone = profile ? extractTimezone(profile) : 'UTC'
        await saveFollow({
          accountDid: apiFollow.did,
          username: handle,
          followed_at: clientDate().toISOString(),
          amp_factor: 1.0,
          priorityPatterns: priorityPatterns || undefined,
          timezone,
          displayName: profile?.displayName || undefined,
          followedBy: profile ? !!profile.viewer?.followedBy : undefined,
          lastUpdatedAt: profile ? clientNow() : undefined,
        })
        addedCount++
      }
    }

    // Update stale entries
    for (const cached of cachedFollows) {
      if (!apiHandleSet.has(cached.username)) continue  // already deleted
      if (cached.lastUpdatedAt && (now - cached.lastUpdatedAt) <= oneDay) continue  // fresh

      const profile = profileMap.get(cached.accountDid)
      if (!profile) continue  // fetch failed, skip

      const livePatterns = extractPriorityPatternsFromProfile(profile)
      const liveTimezone = extractTimezone(profile)
      await saveFollow({
        ...cached,
        displayName: profile.displayName || cached.displayName,
        priorityPatterns: livePatterns || cached.priorityPatterns,
        timezone: liveTimezone !== 'UTC' ? liveTimezone : cached.timezone,
        followedBy: !!profile.viewer?.followedBy,
        lastUpdatedAt: clientNow(),
      })
      updatedCount++
    }

    log.info('Follows', `Sweep complete: ${deletedCount} removed, ${addedCount} added, ${updatedCount} updated`)
  } catch (error) {
    log.error('Follows', 'Follow cache sweep failed:', error)
    // Don't rethrow — next day's sweep will catch misses
  }
}

/**
 * Snap an amp factor to the nearest integral power of √2,
 * fixing floating-point precision drift from repeated √2 multiplications.
 * For factor >= 1: square it, round to nearest integer, take sqrt.
 *   This works because (√2)^n squared is 2^n, always an integer.
 * For factor < 1: snap the reciprocal, then invert.
 * Even powers of √2 (i.e. powers of 2) come out as exact integers.
 */
function snapAmpFactor(factor: number): number {
  if (factor >= 1) {
    const squared = factor * factor
    return Math.sqrt(Math.round(squared))
  } else {
    const reciprocal = 1 / factor
    const squared = reciprocal * reciprocal
    return 1 / Math.sqrt(Math.round(squared))
  }
}

/**
 * Update amplification factor for a follow
 */
export async function updateAmplificationFactor(
  username: string,
  factor: number
): Promise<void> {
  const follows = await getAllFollows()
  const follow = follows.find(f => f.username === username)

  if (follow) {
    follow.amp_factor = Math.max(MIN_AMP_FACTOR, Math.min(MAX_AMP_FACTOR, snapAmpFactor(factor)))
    follow.amp_factor_changed_at = clientNow()
    await saveFollow(follow)
  }
}

/**
 * Recompute probabilities after an amp factor change.
 * Loads the current filter and settings, then recomputes all probabilities.
 */
async function recomputeAfterAmpChange(myUsername: string): Promise<void> {
  const filterResult = await getFilter()
  if (!filterResult) return
  const [globalStats, userFilter] = filterResult
  const settings = await getSettings()
  await recomputeProbabilities(userFilter, globalStats, settings.viewsPerDay, myUsername)
}

/**
 * Amp up a follow (×2 when below 1, ×√2 otherwise)
 */
export async function ampUp(username: string, myUsername: string): Promise<void> {
  const follows = await getAllFollows()
  const follow = follows.find(f => f.username === username)

  if (follow) {
    const multiplier = follow.amp_factor < 1 ? 2 : Math.SQRT2
    await updateAmplificationFactor(username, follow.amp_factor * multiplier)
    await recomputeAfterAmpChange(myUsername)
  }
}

/**
 * Amp down a follow (÷2 when at or below 1, ÷√2 otherwise)
 */
export async function ampDown(username: string, myUsername: string): Promise<void> {
  const follows = await getAllFollows()
  const follow = follows.find(f => f.username === username)

  if (follow) {
    const divisor = follow.amp_factor <= 1 ? 2 : Math.SQRT2
    await updateAmplificationFactor(username, follow.amp_factor / divisor)
    await recomputeAfterAmpChange(myUsername)
  }
}

