/**
 * Session Context
 * 
 * Manages authentication state and provides BskyAgent instance
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { BskyAgent } from '@atproto/api'
import type { AtpSessionEvent, AtpSessionData } from '@atproto/api'
import { createAgentWithSession, login as loginAPI, getServiceUrl } from '../api/atproto-client'
import { saveSession, loadSession, clearSession, updateSession } from './session-storage'
import { detectSkyspeed, configureClientClock, hasSkyspeedConfigChanged, saveSkyspeedConfig, clearSkyspeedConfig, resetClientClock } from '../utils/clientClock'
import type { Session } from '../types'

interface SessionContextType {
  session: Session | null
  agent: BskyAgent | null
  isLoading: boolean
  login: (identifier: string, password: string, rememberMe: boolean) => Promise<void>
  logout: () => void
}

const SessionContext = createContext<SessionContextType | undefined>(undefined)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [agent, setAgent] = useState<BskyAgent | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  // Callback for BskyAgent to persist refreshed tokens
  const handlePersistSession = useCallback((evt: AtpSessionEvent, sess?: AtpSessionData) => {
    if (evt === 'update' && sess) {
      const updatedSession: Session = {
        did: sess.did,
        handle: sess.handle,
        email: sess.email,
        accessJwt: sess.accessJwt,
        refreshJwt: sess.refreshJwt,
      }
      setSession(updatedSession)
      updateSession(updatedSession)
    } else if (evt === 'expired') {
      console.warn('Session expired, logging out')
      setSession(null)
      setAgent(null)
      clearSession()
      navigateRef.current('/login')
    }
  }, [])

  // Attempt to restore session on mount
  useEffect(() => {
    async function restoreSession() {
      try {
        const savedSession = loadSession()
        if (!savedSession) {
          setIsLoading(false)
          return
        }

        const restoredAgent = await createAgentWithSession(savedSession, handlePersistSession)
        setSession(savedSession)
        setAgent(restoredAgent)

        // Re-detect Skyspeed on session restore to reconfigure the client clock
        try {
          const skyspeedConfig = await detectSkyspeed(getServiceUrl(), savedSession.accessJwt)
          if (skyspeedConfig) {
            configureClientClock(skyspeedConfig)
            saveSkyspeedConfig(skyspeedConfig)
            console.log(`[Skyspeed] Session restored — handshake complete:`)
            console.log(`  Server: ${getServiceUrl()}`)
            console.log(`  Clock factor: ${skyspeedConfig.skyspeedClockFactor}x`)
            console.log(`  Sync time: ${skyspeedConfig.skyspeedSyncTime}`)
          } else {
            resetClientClock()
            clearSkyspeedConfig()
          }
        } catch {
          // Continue with normal clock on error
        }
      } catch (error) {
        console.error('Failed to restore session:', error)
        clearSession()
      } finally {
        setIsLoading(false)
      }
    }

    restoreSession()
  }, [handlePersistSession])

  const login = useCallback(async (identifier: string, password: string, rememberMe: boolean) => {
    const { session: newSession, agent: newAgent } = await loginAPI(identifier, password, handlePersistSession)
    setSession(newSession)
    setAgent(newAgent)
    saveSession(newSession, rememberMe)

    // Skyspeed handshake: detect accelerated test server and configure client clock
    try {
      const skyspeedConfig = await detectSkyspeed(getServiceUrl(), newSession.accessJwt)
      if (skyspeedConfig) {
        console.log('[Skyspeed] Connected to Skyspeed test server')

        // Check if server config has changed (server restarted/reconfigured)
        if (hasSkyspeedConfigChanged(skyspeedConfig)) {
          console.warn('[Skyspeed] Server config changed - reset may be needed')
          // TODO: Show confirmation modal to user, trigger "Reset all" if confirmed
          // For now, just log a warning and proceed with the new config
        }

        configureClientClock(skyspeedConfig)
        saveSkyspeedConfig(skyspeedConfig)
        console.log(`[Skyspeed] Handshake complete:`)
        console.log(`  Server: ${getServiceUrl()}`)
        console.log(`  Clock factor: ${skyspeedConfig.skyspeedClockFactor}x`)
        console.log(`  Sync time: ${skyspeedConfig.skyspeedSyncTime}`)
      } else {
        // Not a Skyspeed server - ensure clock is normal
        resetClientClock()
        clearSkyspeedConfig()
      }
    } catch (error) {
      console.warn('[Skyspeed] Failed to detect Skyspeed server:', error)
      // Continue with normal clock on error
    }
  }, [handlePersistSession])

  const logout = useCallback(() => {
    setSession(null)
    setAgent(null)
    clearSession()
    navigate('/login')
  }, [navigate])

  return (
    <SessionContext.Provider value={{ session, agent, isLoading, login, logout }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const context = useContext(SessionContext)
  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  return context
}

