/**
 * Session Context
 * 
 * Manages authentication state and provides BskyAgent instance
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { BskyAgent } from '@atproto/api'
import { createAgentWithSession, login as loginAPI } from '../api/atproto-client'
import { saveSession, loadSession, clearSession } from './session-storage'
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

  // Attempt to restore session on mount
  useEffect(() => {
    async function restoreSession() {
      try {
        const savedSession = loadSession()
        if (!savedSession) {
          setIsLoading(false)
          return
        }

        const restoredAgent = await createAgentWithSession(savedSession)
        setSession(savedSession)
        setAgent(restoredAgent)
      } catch (error) {
        console.error('Failed to restore session:', error)
        clearSession()
      } finally {
        setIsLoading(false)
      }
    }

    restoreSession()
  }, [])

  const login = useCallback(async (identifier: string, password: string, rememberMe: boolean) => {
    try {
      const { session: newSession, agent: newAgent } = await loginAPI(identifier, password)
      setSession(newSession)
      setAgent(newAgent)
      saveSession(newSession, rememberMe)
    } catch (error) {
      throw error
    }
  }, [])

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

