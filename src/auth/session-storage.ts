/**
 * Session storage utilities
 * 
 * Handles persisting session data to localStorage or sessionStorage
 * based on "Remember me" preference
 */

import type { Session } from '../types'
import log from '../utils/logger'

const SESSION_STORAGE_KEY = 'websky_session'
const REMEMBER_ME_KEY = 'websky_remember_me'

/**
 * Saves session to storage
 */
export function saveSession(session: Session, rememberMe: boolean): void {
  const storage = rememberMe ? localStorage : sessionStorage
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  
  // Store remember me preference in localStorage so we know which storage to check
  if (rememberMe) {
    localStorage.setItem(REMEMBER_ME_KEY, 'true')
  } else {
    localStorage.removeItem(REMEMBER_ME_KEY)
  }
}

/**
 * Loads session from storage
 */
export function loadSession(): Session | null {
  const rememberMe = localStorage.getItem(REMEMBER_ME_KEY) === 'true'
  const storage = rememberMe ? localStorage : sessionStorage
  
  try {
    const data = storage.getItem(SESSION_STORAGE_KEY)
    if (!data) return null
    
    return JSON.parse(data) as Session
  } catch (error) {
    log.error('Session', 'Failed to load session:', error)
    return null
  }
}

/**
 * Updates the session tokens in whichever storage is currently being used.
 * Called by the persistSession callback when tokens are refreshed.
 */
export function updateSession(session: Session): void {
  const rememberMe = localStorage.getItem(REMEMBER_ME_KEY) === 'true'
  const storage = rememberMe ? localStorage : sessionStorage
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
}

/**
 * Clears session from both storages
 */
export function clearSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY)
  sessionStorage.removeItem(SESSION_STORAGE_KEY)
  localStorage.removeItem(REMEMBER_ME_KEY)
  // Note: websky_remembered_username is intentionally NOT cleared on logout,
  // so the username is pre-filled on the next login. It is only cleared
  // when the user logs in with "Remember me" unchecked.
}




