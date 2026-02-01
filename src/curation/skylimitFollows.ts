/**
 * Follow management for Skylimit curation
 */

import { BskyAgent, AppBskyGraphGetFollows } from '@atproto/api'
import { FollowInfo } from './types'
import { getAllFollows, saveFollow } from './skylimitCache'
import { extractTopicsFromProfile, extractTimezone } from './skylimitGeneral'
import { getProfiles } from '../api/profile'
import { AppBskyActorDefs } from '@atproto/api'
import { MOTD_TAG, MOTW_TAG, MOTM_TAG } from './types'
import { retryWithBackoff, isRateLimitError, getRateLimitInfo } from '../utils/rateLimit'

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
    await saveSettings({ ...settings, lastFollowRefreshTime: Date.now() })
  } catch (err) {
    console.warn('Failed to save last follow refresh time:', err)
  }
}

/**
 * Refresh follows from Bluesky
 * Only refreshes if force=true or if it's been more than 1 hour since last refresh
 * Only fetches profiles for new follows or when topics/timezone are missing
 */
export async function refreshFollows(agent: BskyAgent, myDid: string, force: boolean = false): Promise<void> {
  try {
    // Check if we need to refresh (unless forced)
    if (!force) {
      const lastRefreshTime = await getLastFollowRefreshTime()
      const oneHour = 60 * 60 * 1000
      if (Date.now() - lastRefreshTime < oneHour) {
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
          console.warn('Rate limit in getFollows:', rateLimitInfo)
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
      console.log(`[Follows] Fetching ${didsNeedingProfiles.length} profiles in ${numBatches} batches of ${BATCH_SIZE}`)

      for (let i = 0; i < didsNeedingProfiles.length; i += BATCH_SIZE) {
        const batch = didsNeedingProfiles.slice(i, i + BATCH_SIZE)
        const batchNum = Math.floor(i / BATCH_SIZE) + 1

        try {
          const response = await getProfiles(agent, batch)
          for (const profile of response.profiles) {
            profileMap.set(profile.did, profile)
          }
          console.log(`[Follows] Batch ${batchNum}/${numBatches}: fetched ${response.profiles.length} profiles`)
        } catch (err) {
          console.warn(`[Follows] Batch ${batchNum}/${numBatches} failed:`, err)
        }

        // Small delay between batches to avoid rate limits
        if (i + BATCH_SIZE < didsNeedingProfiles.length) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }

      console.log(`[Follows] Completed batch fetching: ${profileMap.size} profiles retrieved`)
    }

    // Update or create follow entries using the fetched profiles
    for (const follow of follows) {
      const username = follow.handle
      const existing = existingMap.get(username)
      const profile = profileMap.get(follow.did)

      // Extract data from profile if we fetched one
      let topics = existing?.topics || ''
      let timezone = existing?.timezone || 'UTC'
      let displayName = existing?.displayName || ''

      if (profile) {
        const extractedTopics = extractTopicsFromProfile(profile).join(' ')
        const extractedTimezone = extractTimezone(profile)
        if (extractedTopics) topics = extractedTopics
        if (extractedTimezone !== 'UTC') timezone = extractedTimezone
        if (profile.displayName) displayName = profile.displayName
      }

      const followInfo: FollowInfo = {
        accountDid: follow.did,
        username,
        followed_at: existing?.followed_at || new Date().toISOString(),
        amp_factor: existing?.amp_factor || 1.0,
        topics,
        timezone,
        displayName: displayName || undefined,
      }

      // Preserve periodic post tracking
      if (existing) {
        const motd = existing[MOTD_TAG as keyof FollowInfo]
        const motw = existing[MOTW_TAG as keyof FollowInfo]
        const motm = existing[MOTM_TAG as keyof FollowInfo]
        if (motd) followInfo[MOTD_TAG] = motd as string
        if (motw) followInfo[MOTW_TAG] = motw as string
        if (motm) followInfo[MOTM_TAG] = motm as string
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
    
    // Remove unfollowed accounts (optional - you might want to keep historical data)
    // for (const [username] of existingMap) {
    //   await deleteFollow(username)
    // }
    
  } catch (error) {
    console.error('Failed to refresh follows:', error)
    throw error
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
    follow.amp_factor = Math.max(0.125, Math.min(8.0, factor))
    await saveFollow(follow)
  }
}

/**
 * Amp up a follow (multiply by 2)
 */
export async function ampUp(username: string): Promise<void> {
  const follows = await getAllFollows()
  const follow = follows.find(f => f.username === username)
  
  if (follow) {
    await updateAmplificationFactor(username, follow.amp_factor * 2)
  }
}

/**
 * Amp down a follow (divide by 2)
 */
export async function ampDown(username: string): Promise<void> {
  const follows = await getAllFollows()
  const follow = follows.find(f => f.username === username)
  
  if (follow) {
    await updateAmplificationFactor(username, follow.amp_factor / 2)
  }
}

