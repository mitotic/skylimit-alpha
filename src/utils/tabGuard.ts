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
const SESSION_ID_KEY = 'websky_tab_id'
const HEARTBEAT_MS = 2000   // active tab writes every 2 s
const STALE_MS = 6000       // consider heartbeat stale after 6 s

/**
 * Get or create a stable tab ID using sessionStorage.
 * sessionStorage survives page reloads but is NOT shared across tabs,
 * so a pull-to-refresh keeps the same ID while a new tab gets a fresh one.
 */
function getStableTabId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY)
    if (existing) return existing
  } catch { /* sessionStorage unavailable — fall through */ }
  const newId = Math.random().toString(36).slice(2)
  try { sessionStorage.setItem(SESSION_ID_KEY, newId) } catch { /* ignore */ }
  return newId
}

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

// --- React hook ---

export function useTabGuard(): {
  status: TabStatus
  claimActive: () => void
} {
  const [status, setStatus] = useState<TabStatus>('initializing')
  const idRef = useRef(getStableTabId())
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
    if (isAlive(active) && active!.id !== id) {
      // A genuinely different tab is active — block
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

    // --- Cleanup on tab close/refresh ---
    // Don't remove the heartbeat — just stop writing. On refresh, the
    // reloaded page reclaims via matching sessionStorage ID. On true
    // close, the heartbeat goes stale and a dormant tab reactivates.
    // Removing the key would cause a race: the dormant tab's storage
    // event fires instantly and claims active before the refreshed
    // page can mount.
    const onUnload = () => {
      if (!_dormant) {
        stopHeartbeat()
      }
    }
    window.addEventListener('beforeunload', onUnload)

    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('beforeunload', onUnload)
      clearInterval(staleCheck)
      stopHeartbeat()
      // Don't clear the heartbeat here. Removing the key from localStorage
      // fires a storage event in dormant tabs, causing them to reactivate
      // instantly. This races with React StrictMode's double-mount (cleanup
      // between the two mounts clears the key, dormant tab claims active,
      // second mount sees the dormant tab's heartbeat and blocks).
      // Instead, let the heartbeat go stale naturally (6s). On refresh or
      // HMR, the new mount matches via sessionStorage ID and reclaims.
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
