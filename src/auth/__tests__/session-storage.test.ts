import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveSession, loadSession, clearSession } from '../session-storage'
import type { Session } from '../../types'

describe('session-storage', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  const mockSession: Session = {
    did: 'did:plc:test123',
    handle: 'test.bsky.social',
    accessJwt: 'access-token',
    refreshJwt: 'refresh-token',
  }

  describe('saveSession', () => {
    it('should save session to localStorage when rememberMe is true', () => {
      saveSession(mockSession, true)
      
      const stored = localStorage.getItem('websky_session')
      expect(stored).toBeTruthy()
      expect(JSON.parse(stored!)).toEqual(mockSession)
      expect(localStorage.getItem('websky_remember_me')).toBe('true')
    })

    it('should save session to sessionStorage when rememberMe is false', () => {
      saveSession(mockSession, false)
      
      const stored = sessionStorage.getItem('websky_session')
      expect(stored).toBeTruthy()
      expect(JSON.parse(stored!)).toEqual(mockSession)
      expect(localStorage.getItem('websky_remember_me')).toBeNull()
    })
  })

  describe('loadSession', () => {
    it('should load session from localStorage when rememberMe is true', () => {
      localStorage.setItem('websky_session', JSON.stringify(mockSession))
      localStorage.setItem('websky_remember_me', 'true')
      
      const loaded = loadSession()
      expect(loaded).toEqual(mockSession)
    })

    it('should load session from sessionStorage when rememberMe is false', () => {
      sessionStorage.setItem('websky_session', JSON.stringify(mockSession))
      
      const loaded = loadSession()
      expect(loaded).toEqual(mockSession)
    })

    it('should return null when no session exists', () => {
      const loaded = loadSession()
      expect(loaded).toBeNull()
    })

    it('should return null when session is invalid JSON', () => {
      localStorage.setItem('websky_session', 'invalid-json')
      localStorage.setItem('websky_remember_me', 'true')
      
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const loaded = loadSession()
      expect(loaded).toBeNull()
      consoleSpy.mockRestore()
    })
  })

  describe('clearSession', () => {
    it('should clear session from both storages', () => {
      localStorage.setItem('websky_session', JSON.stringify(mockSession))
      sessionStorage.setItem('websky_session', JSON.stringify(mockSession))
      localStorage.setItem('websky_remember_me', 'true')
      
      clearSession()
      
      expect(localStorage.getItem('websky_session')).toBeNull()
      expect(sessionStorage.getItem('websky_session')).toBeNull()
      expect(localStorage.getItem('websky_remember_me')).toBeNull()
    })
  })
})




