/**
 * AT Protocol / BlueSky API Client
 * 
 * This module provides a typed wrapper around the @atproto/api client
 * with error handling and type safety for common operations.
 */

import { BskyAgent } from '@atproto/api'
import type { AtpSessionEvent, AtpSessionData } from '@atproto/api'
import type { Session } from '../types'

// BlueSky service URL - using the public instance
const BSKY_SERVICE = 'https://bsky.social'

/**
 * Creates and configures a BskyAgent instance
 */
export function createAgent(
  persistSession?: (evt: AtpSessionEvent, sess?: AtpSessionData) => void
): BskyAgent {
  return new BskyAgent({
    service: BSKY_SERVICE,
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
    console.warn('Failed to restore session:', error)
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


