/**
 * Single-tab enforcement using localStorage.
 *
 * Only one Websky tab is "active" at a time. Additional tabs are either
 * "blocked" (never activated, waiting for user to claim) or "dormant"
 * (was active, then another tab claimed the role).
 *
 * The active tab writes a heartbeat to localStorage every 2 seconds.
 * New tabs check this heartbeat on mount — if it's fresh, another tab
 * is active. Cross-tab notifications use the `storage` event (fires in
 * all tabs except the one that wrote).
 *
 * If the active tab crashes without firing `beforeunload`, the stale
 * heartbeat is detected and a dormant tab auto-reactivates.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import log from './logger'

const STORAGE_KEY = 'websky_active_tab'
const HEARTBEAT_MS = 2000   // active tab writes every 2 s
const STALE_MS = 6000       // consider heartbeat stale after 6 s

// Module-level flag readable by timer callbacks without React context
let _dormant = false

/** Check whether this tab is dormant (for use in timer callbacks). */
export function isTabDormant(): boolean {
  return _dormant
}

export type TabStatus = 'initializing' | 'active' | 'blocked' | 'dormant'

// --- localStorage helpers ---

interface TabInfo {
  id: string
  t: number   // Date.now() of last heartbeat
}

function readActive(): TabInfo | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

function isAlive(info: TabInfo | null): boolean {
  return !!info && (Date.now() - info.t < STALE_MS)
}

function writeHeartbeat(id: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, t: Date.now() }))
}

function clearIfOurs(id: string): void {
  const info = readActive()
  if (info && info.id === id) {
    localStorage.removeItem(STORAGE_KEY)
  }
}

// --- React hook ---

export function useTabGuard(): {
  status: TabStatus
  claimActive: () => void
} {
  const [status, setStatus] = useState<TabStatus>('initializing')
  const idRef = useRef(Math.random().toString(36).slice(2))
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
  }, [])

  useEffect(() => {
    const id = idRef.current

    // --- Synchronous check on mount ---
    const active = readActive()
    if (isAlive(active)) {
      _dormant = true
      setStatus('blocked')
      log.info('TabGuard', `Another tab is active (${active!.id}), blocked`)
    } else {
      _dormant = false
      writeHeartbeat(id)
      heartbeatRef.current = setInterval(() => writeHeartbeat(id), HEARTBEAT_MS)
      setStatus('active')
      log.info('TabGuard', 'No active tab found, claiming active')
    }

    // --- Cross-tab notifications via storage event ---
    // (fires in every tab EXCEPT the one that wrote)
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return

      if (e.newValue === null) {
        // Active tab removed its key (closing/releasing)
        if (_dormant) {
          _dormant = false
          writeHeartbeat(id)
          if (heartbeatRef.current) clearInterval(heartbeatRef.current)
          heartbeatRef.current = setInterval(() => writeHeartbeat(id), HEARTBEAT_MS)
          setStatus('active')
          log.info('TabGuard', 'Active tab released, reactivating')
        }
      } else {
        // Someone wrote a new heartbeat
        try {
          const info: TabInfo = JSON.parse(e.newValue)
          if (info.id !== id && !_dormant) {
            // Another tab claimed active — we go dormant
            _dormant = true
            stopHeartbeat()
            setStatus('dormant')
            log.info('TabGuard', `Another tab (${info.id}) claimed active, going dormant`)
          }
        } catch { /* ignore malformed */ }
      }
    }
    window.addEventListener('storage', onStorage)

    // --- Stale-lock recovery for dormant tabs ---
    // If the active tab crashes (no beforeunload), the heartbeat goes stale.
    const staleCheck = setInterval(() => {
      if (_dormant && !isAlive(readActive())) {
        _dormant = false
        writeHeartbeat(id)
        if (heartbeatRef.current) clearInterval(heartbeatRef.current)
        heartbeatRef.current = setInterval(() => writeHeartbeat(id), HEARTBEAT_MS)
        setStatus('active')
        log.info('TabGuard', 'Active tab stale, reactivating')
      }
    }, STALE_MS)

    // --- Cleanup on tab close ---
    const onUnload = () => {
      if (!_dormant) {
        clearIfOurs(id)
      }
    }
    window.addEventListener('beforeunload', onUnload)

    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('beforeunload', onUnload)
      clearInterval(staleCheck)
      stopHeartbeat()
      if (!_dormant) {
        clearIfOurs(id)
      }
    }
  }, [stopHeartbeat])

  const claimActive = useCallback(() => {
    const id = idRef.current
    _dormant = false
    writeHeartbeat(id)
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    heartbeatRef.current = setInterval(() => writeHeartbeat(id), HEARTBEAT_MS)
    setStatus('active')
    log.info('TabGuard', 'Claimed active role')
  }, [])

  return { status, claimActive }
}
