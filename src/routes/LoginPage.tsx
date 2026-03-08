import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import { getNonStandardServerName } from '../api/atproto-client'
import { updateSettings } from '../curation/skylimitStore'
import Button from '../components/Button'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

export default function LoginPage() {
  const navigate = useNavigate()
  const { login } = useSession()
  const [identifier, setIdentifier] = useState(
    getNonStandardServerName() ? 'testuser' : (localStorage.getItem('websky_remembered_username') || '')
  )
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [debugMode, setDebugMode] = useState(() =>
    getNonStandardServerName() ? localStorage.getItem('websky_login_debug_mode') === 'true' : false
  )
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!identifier.trim()) {
      setError('Please enter a username')
      return
    }

    setIsLoading(true)

    try {
      await login(identifier.trim(), password, rememberMe)
      if (rememberMe) {
        localStorage.setItem('websky_remembered_username', identifier.trim())
      } else {
        localStorage.removeItem('websky_remembered_username')
      }
      await updateSettings({ debugMode })
      addToast('Login successful!', 'success')
      navigate('/')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Login failed. Please try again.'
      setError(errorMessage)
      addToast(errorMessage, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/SkylimitLogo.png"
            alt="Skylimit Logo"
            className="w-[80px] h-[80px] mx-auto mb-4"
          />
          <h1 className="text-3xl font-bold mb-2">
            <a
              href="https://github.com/mitotic/skylimit-alpha#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
            >
              Skylimit
            </a>
          </h1>
          <p className="text-gray-600 dark:text-gray-400">A curating <a href="https://bsky.app" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">Bluesky</a> client (alpha version)</p>
          {getNonStandardServerName() && (
            <p className="text-orange-500 dark:text-orange-400 text-sm mt-1 font-medium">
              Server: {getNonStandardServerName()}
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-red-700 dark:text-red-400 text-sm">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="identifier" className="block text-sm font-medium mb-2">
              Username or Email
            </label>
            <input
              id="identifier"
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="you.bsky.social"
              className="input"
              disabled={isLoading}
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-2">
              App Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your app password"
                className="input pr-10"
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Use a Bluesky app password, not your account password.
              {' '}If you don't have an app password,{' '}
              <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">create one in Bluesky settings</a>.
            </p>
          </div>

          <div className="flex items-center">
            <input
              id="rememberMe"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
              disabled={isLoading}
            />
            <label htmlFor="rememberMe" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
              Remember me
            </label>
          </div>

          {getNonStandardServerName() && (
            <div className="flex items-center">
              <input
                id="debugMode"
                type="checkbox"
                checked={debugMode}
                onChange={(e) => {
                  const checked = e.target.checked
                  setDebugMode(checked)
                  localStorage.setItem('websky_login_debug_mode', String(checked))
                }}
                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                disabled={isLoading}
              />
              <label htmlFor="debugMode" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                Debug mode
              </label>
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full bg-blue-500 hover:bg-blue-600 text-white py-3 rounded-lg"
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner size="sm" />
                Signing in...
              </span>
            ) : (
              'Sign In'
            )}
          </Button>
        </form>

        <div className="text-center mt-6">
          <a
            href="https://github.com/mitotic/skylimit-alpha#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block px-4 py-2 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 font-semibold rounded-lg hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
          >
            About Skylimit
          </a>
        </div>
      </div>

      <ToastContainer toasts={toasts} onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  )
}




