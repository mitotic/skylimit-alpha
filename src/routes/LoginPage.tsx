import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/SessionContext'
import Button from '../components/Button'
import Spinner from '../components/Spinner'
import ToastContainer, { ToastMessage } from '../components/ToastContainer'

export default function LoginPage() {
  const navigate = useNavigate()
  const { login } = useSession()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
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

    if (!identifier.trim() || !password.trim()) {
      setError('Please enter both username and password')
      return
    }

    setIsLoading(true)

    try {
      await login(identifier.trim(), password, rememberMe)
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
          <p className="text-gray-600 dark:text-gray-400">A curating <a href="https://bsky.app" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">Bluesky</a> client</p>
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
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your app password"
              className="input"
              disabled={isLoading}
              required
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Use an app password from your Bluesky settings, not your account password.
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

        <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
          Don't have an app password?{' '}
          <a
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:underline"
          >
            Create one in Bluesky settings
          </a>
        </p>

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




