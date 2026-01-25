import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { SessionProvider } from './auth/SessionContext'
import { ThemeProvider } from './contexts/ThemeContext'
import './styles/index.css'

// Check for reset flag BEFORE React mounts - this runs synchronously
// and handles the reset before any IndexedDB connections are opened
const urlParams = new URLSearchParams(window.location.search)
if (urlParams.get('reset') === '1') {
  console.log('[Reset] Reset flag detected in main.tsx, showing confirm dialog')
  if (confirm('Reset ALL curation settings and cached data? This will also log you out.')) {
    console.log('[Reset] User confirmed, clearing all data')
    sessionStorage.clear()
    localStorage.clear()
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




