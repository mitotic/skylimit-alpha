import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { SessionProvider } from './auth/SessionContext'
import { ThemeProvider } from './contexts/ThemeContext'
import './utils/logBuffer' // Start capturing console output early for bug reports
import './styles/index.css'
import log from './utils/logger'
import { initAppAccountHandle } from './curation/skylimitGeneral'

// Migrate old larger-text boolean to new text-size setting
if (localStorage.getItem('websky_larger_text') !== null) {
  if (localStorage.getItem('websky_larger_text') === 'true') {
    localStorage.setItem('websky_text_size', 'medium')
  }
  localStorage.removeItem('websky_larger_text')
}

// Apply text size setting from localStorage (default: small on desktop, medium on mobile)
const storedTextSize = localStorage.getItem('websky_text_size')
const textSize = storedTextSize || (window.matchMedia('(max-width: 768px)').matches ? 'medium' : 'small')
if (textSize === 'medium') {
  document.documentElement.classList.add('font-size-medium')
} else if (textSize === 'large') {
  document.documentElement.classList.add('font-size-large')
}

// localStorage keys
const SERVER_STORAGE_KEY = 'skylimit_server'
const AUTO_LOGIN_STORAGE_KEY = 'skylimit_auto_login'

/**
 * Perform a full reset: clear all caches and reload.
 * Optionally preserves specific localStorage keys (e.g., new server info).
 */
function performFullReset(preserveKeys: Record<string, string> = {}): never {
  sessionStorage.clear()

  // Save keys to preserve, clear localStorage, then restore them
  const preserved: Record<string, string> = {}
  for (const key of Object.keys(preserveKeys)) {
    preserved[key] = preserveKeys[key]
  }
  localStorage.clear()
  for (const [key, value] of Object.entries(preserved)) {
    localStorage.setItem(key, value)
  }

  const redirectToHome = () => { window.location.href = '/' }

  // Clear all object stores instead of deleting the database.
  // deleteDatabase causes persistent blocking issues: the open() call on the
  // next page load gets blocked indefinitely if the deletion hasn't fully completed.
  const DB_NAME = 'skylimit_db'
  const request = indexedDB.open(DB_NAME)
  request.onsuccess = () => {
    const database = request.result
    const storeNames = Array.from(database.objectStoreNames)
    if (storeNames.length === 0) {
      log.debug('Reset', 'No stores to clear, redirecting')
      database.close()
      redirectToHome()
      return
    }
    const tx = database.transaction(storeNames, 'readwrite')
    let cleared = 0
    for (const name of storeNames) {
      const clearReq = tx.objectStore(name).clear()
      clearReq.onsuccess = () => {
        cleared++
        if (cleared === storeNames.length) {
          log.debug('Reset', `Cleared ${cleared} object stores`)
        }
      }
    }
    tx.oncomplete = () => {
      log.debug('Reset', 'All stores cleared successfully')
      database.close()
      redirectToHome()
    }
    tx.onerror = () => {
      log.error('Reset', 'Failed to clear stores, redirecting anyway')
      database.close()
      redirectToHome()
    }
  }
  request.onerror = () => {
    log.error('Reset', 'Failed to open database for clearing, redirecting anyway')
    redirectToHome()
  }

  // Safety net: if none of the callbacks fire within 3 seconds, redirect anyway
  setTimeout(() => {
    log.warn('Reset', 'Timeout waiting for store clearing, redirecting')
    redirectToHome()
  }, 3000)

  // Don't render React - wait for redirect
  throw new Error('Reset in progress - halting React render')
}

// --- Handle URL parameters BEFORE React mounts ---
// This runs synchronously and handles resets before any IndexedDB connections are opened
const urlParams = new URLSearchParams(window.location.search)

// Parse auto-login and settings parameters
const usernameParam = urlParams.get('username')
const passwordParam = urlParams.get('password')
const viewsPerDayParam = urlParams.get('viewsperday')
const debugParam = urlParams.get('debug')
// Auto-login requires username AND password param present (empty password is valid for Skyspeed)
const hasAutoLoginParams = !!(usernameParam && urlParams.has('password'))

function buildAutoLoginPayload(): Record<string, string> {
  const hasSettings = viewsPerDayParam || debugParam
  if (!hasAutoLoginParams && !hasSettings) return {}
  const payload: Record<string, any> = {}
  if (hasAutoLoginParams) {
    payload.username = usernameParam
    payload.password = passwordParam || ''
  }
  if (viewsPerDayParam) {
    const parsed = parseInt(viewsPerDayParam, 10)
    if (!isNaN(parsed) && parsed > 0) payload.viewsPerDay = parsed
  }
  if (debugParam === '1') payload.debugMode = true
  else if (debugParam === '0') payload.debugMode = false
  return Object.keys(payload).length > 0
    ? { [AUTO_LOGIN_STORAGE_KEY]: JSON.stringify(payload) }
    : {}
}

// Handle ?server= parameter for non-standard test server
if (urlParams.has('server')) {
  const serverParam = urlParams.get('server') || ''
  const previousServer = localStorage.getItem(SERVER_STORAGE_KEY)

  if (serverParam === '') {
    // Empty ?server= resets to default (bsky.social)
    localStorage.removeItem('websky_login_debug_mode')
    log.info('Server', 'Resetting to default server (bsky.social)')
    if (previousServer) {
      // Server is changing from non-standard back to default - need reset
      if (hasAutoLoginParams || confirm('Switching back to bsky.social. All caches will be reset. Continue?')) {
        performFullReset({ ...buildAutoLoginPayload() })  // Don't preserve server key = reverts to default
      } else {
        // User cancelled - strip param and continue with previous server
        window.history.replaceState({}, '', window.location.pathname)
      }
    } else {
      // Already on default, just strip the param
      window.history.replaceState({}, '', window.location.pathname)
    }
  } else {
    // Non-empty ?server= sets a test server
    log.debug('Server', `Server parameter: ${serverParam}`)

    if (previousServer !== serverParam) {
      // Server is changing
      if (previousServer) {
        // Switching between servers - need reset
        if (hasAutoLoginParams || confirm(`Switching server to ${serverParam}. All caches will be reset. Continue?`)) {
          log.debug('Server', `Non-standard server configured: ${serverParam}`)
          performFullReset({ [SERVER_STORAGE_KEY]: serverParam, ...buildAutoLoginPayload() })
        } else {
          log.debug('Server', 'User cancelled server switch')
          window.history.replaceState({}, '', window.location.pathname)
        }
      } else {
        // First time setting a non-standard server - need reset
        if (hasAutoLoginParams || confirm(`Connecting to test server ${serverParam}. All caches will be reset. Continue?`)) {
          const hostname = serverParam.split(':')[0]
          const port = serverParam.split(':')[1]
          const protocol = hostname === 'localhost' ? 'http' : 'https'
          const url = port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`
          log.debug('Server', `Non-standard server configured: ${serverParam}`)
          log.debug('Server', `Service URL: ${url}`)
          performFullReset({ [SERVER_STORAGE_KEY]: serverParam, ...buildAutoLoginPayload() })
        } else {
          log.debug('Server', 'User cancelled server connection')
          window.history.replaceState({}, '', window.location.pathname)
        }
      }
    } else {
      // Same server as before, just strip the param
      log.info('Server', `Using non-standard server: ${serverParam}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }
}

// Log non-standard server on every page load (even without ?server= param)
if (!urlParams.has('server')) {
  const storedServer = localStorage.getItem(SERVER_STORAGE_KEY)
  if (storedServer) {
    const hostname = storedServer.split(':')[0]
    const port = storedServer.split(':')[1]
    const protocol = hostname === 'localhost' ? 'http' : 'https'
    const url = port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`
    log.info('Server', `Using non-standard server: ${storedServer}`)
    log.debug('Server', `Service URL: ${url}`)
  }
}

// Set app account handle based on server configuration
initAppAccountHandle()

// Handle ?clobber=1 - equivalent to browser "Clear storage": wipe everything and start fresh
if (urlParams.get('clobber') === '1') {
  if (!confirm('Delete ALL site data (storage + database) and start fresh?')) {
    window.history.replaceState({}, '', '/')
  } else {
    log.info('Clobber', 'Wiping all site data')
    localStorage.clear()
    sessionStorage.clear()
    const redirect = () => { window.location.href = '/' }
    if (indexedDB.databases) {
      indexedDB.databases().then(dbs => {
        if (dbs.length === 0) { redirect(); return }
        let remaining = dbs.length
        for (const db of dbs) {
          const req = indexedDB.deleteDatabase(db.name!)
          req.onsuccess = req.onerror = req.onblocked = () => {
            log.debug('Clobber', `Deleted database: ${db.name}`)
            if (--remaining === 0) redirect()
          }
        }
      }).catch(() => redirect())
    } else {
      // Fallback for browsers without databases() API
      const req = indexedDB.deleteDatabase('skylimit_db')
      req.onsuccess = req.onerror = req.onblocked = () => redirect()
    }
    setTimeout(() => {
      log.warn('Clobber', 'Timeout, redirecting')
      window.location.href = '/'
    }, 3000)
    throw new Error('Clobber in progress - halting React render')
  }
}

// Handle ?reset=1 parameter
if (urlParams.get('reset') === '1') {
  log.info('Reset', 'Reset flag detected in main.tsx')
  if (hasAutoLoginParams || confirm('Reset ALL curation settings and cached data? This will also log you out.')) {
    log.debug('Reset', 'Clearing all data')
    const serverToPreserve = localStorage.getItem(SERVER_STORAGE_KEY)
    performFullReset({
      ...(serverToPreserve ? { [SERVER_STORAGE_KEY]: serverToPreserve } : {}),
      ...buildAutoLoginPayload(),
    })
  } else {
    log.debug('Reset', 'User cancelled reset')
    window.history.replaceState({}, '', '/')
  }
}

// Build auto-login params and expose on window for SessionContext to read.
// We use a window global instead of localStorage to avoid timing issues with
// React StrictMode double-mounting and Vite HMR re-mounts.
const autoLoginPayload = buildAutoLoginPayload()
if (Object.keys(autoLoginPayload).length > 0) {
  ;(window as any).__SKYLIMIT_AUTO_LOGIN__ = JSON.parse(autoLoginPayload[AUTO_LOGIN_STORAGE_KEY])
  log.info('AutoLogin', 'Auto-login params set')
} else {
  // Check if params were preserved through a reset (stored in localStorage by performFullReset)
  const stored = localStorage.getItem(AUTO_LOGIN_STORAGE_KEY)
  if (stored) {
    localStorage.removeItem(AUTO_LOGIN_STORAGE_KEY)
    try {
      ;(window as any).__SKYLIMIT_AUTO_LOGIN__ = JSON.parse(stored)
      log.debug('AutoLogin', 'Auto-login params restored from reset')
    } catch { /* ignore */ }
  }
}

// Strip all query params from URL after processing
if (window.location.search) {
  window.history.replaceState({}, '', window.location.pathname)
}

// Force reload when restored from back-forward cache (bfcache).
// SPAs with React context can break when the browser restores a frozen
// page snapshot, since context object references may no longer match.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload()
  }
})

// Initialize logger level from stored settings
log.refreshLevel()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ThemeProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
)




