/**
 * Follow management for Skylimit curation
 */

import { BskyAgent, AppBskyGraphGetFollows } from '@atproto/api'
import { FollowInfo } from './types'
import { getAllFollows, saveFollow } from './skylimitCache'
import { extractTopicsFromProfile, extractTimezone } from './skylimitGeneral'
import { getProfile } from '../api/profile'
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
    
    // Update or create follow entries
    for (const follow of follows) {
      const username = follow.handle
      const existing = existingMap.get(username)
      
      // Only fetch profile if:
      // 1. This is a new follow (no existing entry)
      // 2. Topics, timezone, or displayName are missing
      let topics = existing?.topics || ''
      let timezone = existing?.timezone || 'UTC'
      let displayName = existing?.displayName || ''
      
      if (!existing || !topics || timezone === 'UTC' || !displayName) {
        try {
          const profile = await getProfile(agent, follow.did)
          if (profile) {
            const extractedTopics = extractTopicsFromProfile(profile).join(' ')
            const extractedTimezone = extractTimezone(profile)
            if (extractedTopics) topics = extractedTopics
            if (extractedTimezone !== 'UTC') timezone = extractedTimezone
            // Extract displayName from profile
            if (profile.displayName) displayName = profile.displayName
          }
        } catch (err) {
          console.warn('Failed to get profile for', username, err)
          // Use defaults if profile fetch fails
          if (!topics) topics = ''
          if (timezone === 'UTC') timezone = 'UTC'
          if (!displayName) displayName = ''
        }
      }
      
      const followInfo: FollowInfo = {
        accountDid: follow.did,
        username,
        followed_at: existing?.followed_at || new Date().toISOString(),
        amp_factor: existing?.amp_factor || 1.0,
        topics,
        timezone,
        displayName: displayName || undefined, // Only set if not empty
      }
      
      // Preserve periodic post tracking and displayName if not updated
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

