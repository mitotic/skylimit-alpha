/**
 * AT Protocol / BlueSky API Client
 * 
 * This module provides a typed wrapper around the @atproto/api client
 * with error handling and type safety for common operations.
 */

import { BskyAgent } from '@atproto/api'
import type { AtpSessionEvent, AtpSessionData } from '@atproto/api'
import type { Session } from '../types'
import log from '../utils/logger'

// Default BlueSky service URL
const DEFAULT_BSKY_SERVICE = 'https://bsky.social'

// localStorage key for non-standard server (must match main.tsx)
const SERVER_STORAGE_KEY = 'skylimit_server'

/**
 * Get the AT Protocol service URL.
 * Returns the non-standard server URL from localStorage if configured,
 * otherwise returns the default bsky.social URL.
 * For localhost servers, uses http:// (no TLS). For all others, uses https://.
 */
export function getServiceUrl(): string {
  const serverParam = localStorage.getItem(SERVER_STORAGE_KEY)
  if (!serverParam) return DEFAULT_BSKY_SERVICE

  // Parse hostname and optional port
  const parts = serverParam.split(':')
  const hostname = parts[0]
  const port = parts[1]

  // Use http:// for localhost (skip TLS), https:// for everything else
  const protocol = hostname === 'localhost' ? 'http' : 'https'
  return port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`
}

/**
 * Get the non-standard server display name, or null if using default.
 */
export function getNonStandardServerName(): string | null {
  return localStorage.getItem(SERVER_STORAGE_KEY)
}

/**
 * Creates and configures a BskyAgent instance
 */
export function createAgent(
  persistSession?: (evt: AtpSessionEvent, sess?: AtpSessionData) => void
): BskyAgent {
  return new BskyAgent({
    service: getServiceUrl(),
    persistSession,
  })
}

/**
 * Creates an agent and restores an existing session
 */
export async function createAgentWithSession(
  session: Session,
  persistSession?: (evt: AtpSessionEvent, sess?: AtpSessionData) => void
): Promise<BskyAgent> {
  const agent = createAgent(persistSession)
  
  try {
    const sessionData: any = {
      did: session.did,
      handle: session.handle,
      refreshJwt: session.refreshJwt,
      accessJwt: session.accessJwt,
      active: true,
    }
    if (session.email) {
      sessionData.email = session.email
    }
    
    await agent.resumeSession(sessionData)
  } catch (error) {
    log.warn('Session', 'Failed to restore session:', error)
    throw new Error('Session expired or invalid')
  }
  
  return agent
}

/**
 * Authenticates a user with BlueSky
 * 
 * @param identifier - Username or email
 * @param password - Account password or app password
 * @returns Object with both session data and the authenticated agent
 */
export async function login(
  identifier: string,
  password: string,
  persistSession?: (evt: AtpSessionEvent, sess?: AtpSessionData) => void
): Promise<{ session: Session; agent: BskyAgent }> {
  const agent = createAgent(persistSession)
  
  try {
    const response = await agent.login({
      identifier,
      password,
    })

    if (!response.data) {
      throw new Error('Login failed: No data returned from server')
    }

    const session: Session = {
      did: response.data.did,
      handle: response.data.handle,
      email: response.data.email,
      accessJwt: response.data.accessJwt,
      refreshJwt: response.data.refreshJwt,
    }

    return { session, agent }
  } catch (error: any) {
    // Handle specific error types
    if (error?.status === 401 || error?.message?.includes('Invalid identifier or password')) {
      throw new Error('Invalid username or password. Please check your credentials and try again.')
    }
    
    if (error?.status === 400) {
      throw new Error('Invalid request. Please check your username format (e.g., you.bsky.social).')
    }
    
    if (error?.message) {
      throw new Error(`Authentication failed: ${error.message}`)
    }
    
    throw new Error('Authentication failed: Unable to connect to BlueSky. Please check your internet connection and try again.')
  }
}


