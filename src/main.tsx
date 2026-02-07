import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { SessionProvider } from './auth/SessionContext'
import { ThemeProvider } from './contexts/ThemeContext'
import './styles/index.css'

// localStorage key for non-standard server info
const SERVER_STORAGE_KEY = 'skylimit_server'

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

  const request = indexedDB.deleteDatabase('skylimit_db')
  request.onsuccess = () => {
    console.log('[Reset] Database deleted successfully')
    window.location.href = '/'
  }
  request.onerror = () => {
    console.error('[Reset] Database deletion failed')
    window.location.href = '/'
  }
  // Don't render React - wait for redirect
  throw new Error('Reset in progress - halting React render')
}

// --- Handle URL parameters BEFORE React mounts ---
// This runs synchronously and handles resets before any IndexedDB connections are opened
const urlParams = new URLSearchParams(window.location.search)

// Handle ?server= parameter for non-standard test server
if (urlParams.has('server')) {
  const serverParam = urlParams.get('server') || ''
  const previousServer = localStorage.getItem(SERVER_STORAGE_KEY)

  if (serverParam === '') {
    // Empty ?server= resets to default (bsky.social)
    console.log('[Server] Resetting to default server (bsky.social)')
    if (previousServer) {
      // Server is changing from non-standard back to default - need reset
      if (confirm('Switching back to bsky.social. All caches will be reset. Continue?')) {
        performFullReset()  // Don't preserve server key = reverts to default
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
    console.log(`[Server] Server parameter: ${serverParam}`)

    if (previousServer !== serverParam) {
      // Server is changing
      if (previousServer) {
        // Switching between servers - need reset
        if (confirm(`Switching server to ${serverParam}. All caches will be reset. Continue?`)) {
          console.log(`[Server] Non-standard server configured: ${serverParam}`)
          performFullReset({ [SERVER_STORAGE_KEY]: serverParam })
        } else {
          console.log('[Server] User cancelled server switch')
          window.history.replaceState({}, '', window.location.pathname)
        }
      } else {
        // First time setting a non-standard server - need reset
        if (confirm(`Connecting to test server ${serverParam}. All caches will be reset. Continue?`)) {
          const hostname = serverParam.split(':')[0]
          const port = serverParam.split(':')[1]
          const protocol = hostname === 'localhost' ? 'http' : 'https'
          const url = port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`
          console.log(`[Server] Non-standard server configured: ${serverParam}`)
          console.log(`[Server] Service URL: ${url}`)
          performFullReset({ [SERVER_STORAGE_KEY]: serverParam })
        } else {
          console.log('[Server] User cancelled server connection')
          window.history.replaceState({}, '', window.location.pathname)
        }
      }
    } else {
      // Same server as before, just strip the param
      console.log(`[Server] Using non-standard server: ${serverParam}`)
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
    console.log(`[Server] Using non-standard server: ${storedServer}`)
    console.log(`[Server] Service URL: ${url}`)
  }
}

// Handle ?reset=1 parameter
if (urlParams.get('reset') === '1') {
  console.log('[Reset] Reset flag detected in main.tsx, showing confirm dialog')
  if (confirm('Reset ALL curation settings and cached data? This will also log you out.')) {
    console.log('[Reset] User confirmed, clearing all data')
    const serverToPreserve = localStorage.getItem(SERVER_STORAGE_KEY)
    performFullReset(serverToPreserve ? { [SERVER_STORAGE_KEY]: serverToPreserve } : {})
  } else {
    console.log('[Reset] User cancelled reset')
    window.history.replaceState({}, '', '/')
  }
}

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




