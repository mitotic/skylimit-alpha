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
import { getProfile } from '../api/profile'
import { saveSession, loadSession, clearSession, updateSession } from './session-storage'
import { detectSkyspeed, acknowledgeSkyspeed, configureClientClock, hasSkyspeedConfigChanged, saveSkyspeedConfig, clearSkyspeedConfig, resetClientClock } from '../utils/clientClock'
import type { SkyspeedConfig } from '../utils/clientClock'
import { resetEverything } from '../curation/skylimitCache'
import { updateSettings } from '../curation/skylimitStore'
import ConfirmModal from '../components/ConfirmModal'
import type { Session, AutoLoginParams } from '../types'
import log from '../utils/logger'


interface SessionContextType {
  session: Session | null
  agent: BskyAgent | null
  avatarUrl: string | null
  isLoading: boolean
  login: (identifier: string, password: string, rememberMe: boolean) => Promise<void>
  logout: () => void
}

const SessionContext = createContext<SessionContextType | undefined>(undefined)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [agent, setAgent] = useState<BskyAgent | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [showConfigChangedModal, setShowConfigChangedModal] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  // Read auto-login params from window global (set by main.tsx before React mounts).
  // Window global survives React StrictMode double-mounting and Vite HMR re-mounts.
  const autoLoginParamsRef = useRef<AutoLoginParams | null>(
    (window as any).__SKYLIMIT_AUTO_LOGIN__ || null
  );

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
      log.warn('Session', 'Session expired, logging out')
      setSession(null)
      setAgent(null)
      clearSession()
      navigateRef.current('/login')
    }
  }, [])

  // Apply viewsPerDay and debugMode settings from auto-login params
  async function applyAutoSettings(params: AutoLoginParams): Promise<void> {
    const updates: Partial<{ viewsPerDay: number; debugMode: boolean }> = {}
    if (params.viewsPerDay !== undefined) {
      updates.viewsPerDay = params.viewsPerDay
      log.debug('AutoLogin', `Setting viewsPerDay=${params.viewsPerDay}`)
    }
    if (params.debugMode !== undefined) {
      updates.debugMode = params.debugMode
      log.debug('AutoLogin', `Setting debugMode=${params.debugMode}`)
    }
    if (Object.keys(updates).length > 0) {
      await updateSettings(updates)
    }
  }

  // Perform Skyspeed handshake for a fresh login (used by both manual login and auto-login)
  async function freshLoginSkyspeedHandshake(accessJwt: string): Promise<void> {
    let skyspeedConfig: SkyspeedConfig | null = null
    try {
      skyspeedConfig = await detectSkyspeed(getServiceUrl(), accessJwt)
      if (skyspeedConfig) {
        log.info('Skyspeed', 'Connected to Skyspeed test server')
        if (hasSkyspeedConfigChanged(skyspeedConfig)) {
          log.debug('Skyspeed', 'Server config changed since last session — accepting new config')
        }
      }
    } catch (error) {
      log.warn('Skyspeed', 'Failed to detect Skyspeed server:', error)
      return
    }

    if (skyspeedConfig) {
      await acknowledgeSkyspeed(getServiceUrl(), accessJwt, skyspeedConfig)
      configureClientClock(skyspeedConfig)
      saveSkyspeedConfig(skyspeedConfig)
      log.info('Skyspeed', `Handshake complete:`)
      log.debug('Session', `  Server: ${getServiceUrl()}`)
      log.debug('Session', `  Clock factor: ${skyspeedConfig.skyspeedClockFactor}x`)
      log.debug('Session', `  Sync time: ${skyspeedConfig.skyspeedSyncTime}`)
    } else {
      resetClientClock()
      clearSkyspeedConfig()
    }
  }

  // Fetch the user's avatar URL from their profile
  const fetchAvatar = useCallback(async (agentInstance: BskyAgent, handle: string) => {
    try {
      const profile = await getProfile(agentInstance, handle)
      setAvatarUrl(profile.avatar || null)
    } catch (error) {
      log.warn('Session', 'Failed to fetch avatar:', error)
    }
  }, [])

  // Attempt to restore session on mount (or auto-login if params are present)
  useEffect(() => {
    async function restoreSession() {
      try {
        // Consume the auto-login params (clear window global now that we're using them)
        delete (window as any).__SKYLIMIT_AUTO_LOGIN__
        const autoLogin = autoLoginParamsRef.current
        if (autoLogin?.username !== undefined && autoLogin?.password !== undefined) {
          log.info('AutoLogin', `Auto-login initiated for ${autoLogin.username}`)
          try {
            const { session: newSession, agent: newAgent } = await loginAPI(
              autoLogin.username, autoLogin.password, handlePersistSession
            )
            saveSession(newSession, true)

            await freshLoginSkyspeedHandshake(newSession.accessJwt)
            await applyAutoSettings(autoLogin)

            setSession(newSession)
            setAgent(newAgent)
            fetchAvatar(newAgent, newSession.handle)
            log.info('AutoLogin', 'Auto-login complete')
          } catch (error) {
            log.error('AutoLogin', 'Auto-login failed:', error)
            // Fall through to show login page
          }
          setIsLoading(false)
          return
        }

        // Normal session restore (with optional settings-only auto-config)
        const savedSession = loadSession()
        if (!savedSession) {
          if (autoLogin) await applyAutoSettings(autoLogin)
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
          log.warn('Skyspeed', 'Server config changed — holding session pending user decision')
          pendingSessionRef.current = savedSession
          pendingAgentRef.current = restoredAgent
          pendingSkyspeedConfigRef.current = skyspeedConfig
          setShowConfigChangedModal(true)
        } else if (skyspeedConfig) {
          // Config matches (or no previous config) — complete handshake and activate
          await acknowledgeSkyspeed(getServiceUrl(), savedSession.accessJwt, skyspeedConfig)
          configureClientClock(skyspeedConfig)
          saveSkyspeedConfig(skyspeedConfig)
          log.info('Skyspeed', `Session restored — handshake complete:`)
          log.debug('Session', `  Server: ${getServiceUrl()}`)
          log.debug('Session', `  Clock factor: ${skyspeedConfig.skyspeedClockFactor}x`)
          log.debug('Session', `  Sync time: ${skyspeedConfig.skyspeedSyncTime}`)
          setSession(savedSession)
          setAgent(restoredAgent)
          fetchAvatar(restoredAgent, savedSession.handle)
        } else {
          // Not a Skyspeed server
          resetClientClock()
          clearSkyspeedConfig()
          setSession(savedSession)
          setAgent(restoredAgent)
          fetchAvatar(restoredAgent, savedSession.handle)
        }

        if (autoLogin) await applyAutoSettings(autoLogin)
      } catch (error) {
        log.error('Session', 'Failed to restore session:', error)
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

    await freshLoginSkyspeedHandshake(newSession.accessJwt)

    setSession(newSession)
    setAgent(newAgent)
    fetchAvatar(newAgent, newSession.handle)
  }, [handlePersistSession, fetchAvatar])

  const logout = useCallback(() => {
    setSession(null)
    setAgent(null)
    setAvatarUrl(null)
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
      fetchAvatar(pendingAgentRef.current, pendingSessionRef.current.handle)
      pendingSessionRef.current = null
      pendingAgentRef.current = null
      pendingSkyspeedConfigRef.current = null
    }
  }, [])

  return (
    <SessionContext.Provider value={{ session, agent, avatarUrl, isLoading, login, logout }}>
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
    // This can happen when the browser restores the page from bfcache
    // (back-forward cache) after navigating to an external site.
    // The frozen React tree has stale context references. Force a
    // clean reload instead of crashing.
    window.location.reload()
    // Return a dummy value so React doesn't throw before reload kicks in
    return { session: null, agent: null, avatarUrl: null, isLoading: true, login: async () => {}, logout: () => {} } as SessionContextType
  }
  return context
}

