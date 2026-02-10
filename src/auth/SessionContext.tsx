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
import { detectSkyspeed, acknowledgeSkyspeed, configureClientClock, hasSkyspeedConfigChanged, saveSkyspeedConfig, clearSkyspeedConfig, resetClientClock } from '../utils/clientClock'
import type { SkyspeedConfig } from '../utils/clientClock'
import { resetEverything } from '../curation/skylimitCache'
import ConfirmModal from '../components/ConfirmModal'
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
  const [showConfigChangedModal, setShowConfigChangedModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  // Pending session/agent/config held back when Skyspeed config change detected.
  // Session is not exposed to children until the user resolves the config change dialog,
  // preventing premature feed fetching that would trigger Skyspeed's script CONNECT.
  // The Skyspeed handshake (ackConfig) is also deferred — only getConfig (read-only) is
  // called during detection. ackConfig commits the sync time and is only sent when the
  // user chooses "Continue Anyway", not when they choose "Reset All Data".
  const pendingSessionRef = useRef<Session | null>(null)
  const pendingAgentRef = useRef<BskyAgent | null>(null)
  const pendingSkyspeedConfigRef = useRef<SkyspeedConfig | null>(null)

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

        // Skyspeed detection (phase 1: read-only getConfig, no ackConfig).
        // If the server config changed, hold back the session AND the handshake
        // acknowledgment so that neither feed fetching nor script CONNECT is triggered.
        let skyspeedConfig: SkyspeedConfig | null = null
        let configChanged = false
        try {
          skyspeedConfig = await detectSkyspeed(getServiceUrl(), savedSession.accessJwt)
          if (skyspeedConfig) {
            configChanged = hasSkyspeedConfigChanged(skyspeedConfig)
          }
        } catch {
          // Continue with normal clock on error
        }

        if (skyspeedConfig && configChanged) {
          // Config changed — hold everything pending user decision.
          // Do NOT ack, configure clock, or expose session to children.
          console.warn('[Skyspeed] Server config changed — holding session pending user decision')
          pendingSessionRef.current = savedSession
          pendingAgentRef.current = restoredAgent
          pendingSkyspeedConfigRef.current = skyspeedConfig
          setShowConfigChangedModal(true)
        } else if (skyspeedConfig) {
          // Config matches (or no previous config) — complete handshake and activate
          await acknowledgeSkyspeed(getServiceUrl(), savedSession.accessJwt, skyspeedConfig)
          configureClientClock(skyspeedConfig)
          saveSkyspeedConfig(skyspeedConfig)
          console.log(`[Skyspeed] Session restored — handshake complete:`)
          console.log(`  Server: ${getServiceUrl()}`)
          console.log(`  Clock factor: ${skyspeedConfig.skyspeedClockFactor}x`)
          console.log(`  Sync time: ${skyspeedConfig.skyspeedSyncTime}`)
          setSession(savedSession)
          setAgent(restoredAgent)
        } else {
          // Not a Skyspeed server
          resetClientClock()
          clearSkyspeedConfig()
          setSession(savedSession)
          setAgent(restoredAgent)
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
    saveSession(newSession, rememberMe)

    // Skyspeed detection + handshake.
    // On fresh login, always accept the new server config (no stale cached posts to protect).
    let skyspeedConfig: SkyspeedConfig | null = null
    let configChanged = false
    try {
      skyspeedConfig = await detectSkyspeed(getServiceUrl(), newSession.accessJwt)
      if (skyspeedConfig) {
        console.log('[Skyspeed] Connected to Skyspeed test server')
        configChanged = hasSkyspeedConfigChanged(skyspeedConfig)
      }
    } catch (error) {
      console.warn('[Skyspeed] Failed to detect Skyspeed server:', error)
      // Continue with normal clock on error
    }

    if (skyspeedConfig) {
      // On fresh login, always accept the new config — there are no stale cached
      // posts to worry about (unlike session restore). If the server was restarted,
      // just save the new config and proceed.
      if (configChanged) {
        console.log('[Skyspeed] Server config changed since last session — accepting new config')
      }
      await acknowledgeSkyspeed(getServiceUrl(), newSession.accessJwt, skyspeedConfig)
      configureClientClock(skyspeedConfig)
      saveSkyspeedConfig(skyspeedConfig)
      console.log(`[Skyspeed] Handshake complete:`)
      console.log(`  Server: ${getServiceUrl()}`)
      console.log(`  Clock factor: ${skyspeedConfig.skyspeedClockFactor}x`)
      console.log(`  Sync time: ${skyspeedConfig.skyspeedSyncTime}`)
      setSession(newSession)
      setAgent(newAgent)
    } else {
      // Not a Skyspeed server - ensure clock is normal
      resetClientClock()
      clearSkyspeedConfig()
      setSession(newSession)
      setAgent(newAgent)
    }
  }, [handlePersistSession])

  const logout = useCallback(() => {
    setSession(null)
    setAgent(null)
    clearSession()
    navigate('/login')
  }, [navigate])

  const handleConfigChangeReset = useCallback(() => {
    // Discard pending state without acknowledging — server sync time is NOT committed
    pendingSessionRef.current = null
    pendingAgentRef.current = null
    pendingSkyspeedConfigRef.current = null
    setIsResettingAll(true)
    resetEverything()  // Redirects to /?reset=1
  }, [])

  const handleConfigChangeDismiss = useCallback(async () => {
    setShowConfigChangedModal(false)
    // Complete the handshake, then promote pending session
    if (pendingSessionRef.current && pendingAgentRef.current && pendingSkyspeedConfigRef.current) {
      // Now complete the handshake — ack commits the sync time on the server
      await acknowledgeSkyspeed(getServiceUrl(), pendingSessionRef.current.accessJwt, pendingSkyspeedConfigRef.current)
      configureClientClock(pendingSkyspeedConfigRef.current)
      saveSkyspeedConfig(pendingSkyspeedConfigRef.current)
      // Promote session — children will mount and fetch feed, triggering CONNECT
      setSession(pendingSessionRef.current)
      setAgent(pendingAgentRef.current)
      pendingSessionRef.current = null
      pendingAgentRef.current = null
      pendingSkyspeedConfigRef.current = null
    }
  }, [])

  return (
    <SessionContext.Provider value={{ session, agent, isLoading, login, logout }}>
      {children}
      <ConfirmModal
        isOpen={showConfigChangedModal}
        onClose={handleConfigChangeDismiss}
        onConfirm={handleConfigChangeReset}
        title="Skyspeed Server Changed"
        message={'The Skyspeed test server has been restarted or reconfigured since your last session.\n\nCached posts have timestamps from the previous server configuration and will not display correctly.\n\nReset all data to start fresh with the new server configuration?'}
        confirmText={isResettingAll ? 'Resetting...' : 'Reset All Data'}
        cancelText="Continue Anyway"
        isDangerous={true}
        isLoading={isResettingAll}
      />
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

