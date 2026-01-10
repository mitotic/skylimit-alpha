import { useSession } from '../auth/SessionContext'
import { useTheme } from '../contexts/ThemeContext'
import { useNavigate } from 'react-router-dom'
import Button from '../components/Button'

export default function SettingsPage() {
  const { session, logout } = useSession()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()

  const handleClearCache = () => {
    if (window.confirm('This will clear all cached data and log you out. Continue?')) {
      localStorage.clear()
      sessionStorage.clear()
      logout()
    }
  }

  return (
    <div className="pb-20 md:pb-0 p-4 space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Appearance</h2>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Theme</div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {theme === 'dark' ? 'Dark mode' : 'Light mode'}
            </div>
          </div>
          <button
            onClick={toggleTheme}
            className="btn btn-secondary"
          >
            Switch to {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Content Curation</h2>
        <div>
          <div className="font-medium mb-2">Skylimit Protocol</div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Configure how you consume content with fine-grained control over your feed.
          </div>
          <Button variant="primary" onClick={() => navigate('/settings/skylimit')}>
            Open Skylimit Settings
          </Button>
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Account</h2>
        <div>
          <div className="font-medium">Logged in as</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            @{session?.handle}
          </div>
        </div>
        <Button variant="danger" onClick={logout}>
          Logout
        </Button>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">Data</h2>
        <div>
          <div className="font-medium mb-2">Clear Cached Data</div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            This will clear all stored data including your session and preferences.
          </div>
          <Button variant="danger" onClick={handleClearCache}>
            Clear Cache
          </Button>
        </div>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">About</h2>
        <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2">
          <p>Websky - A Bluesky web client</p>
          <p>Version 1.0.0</p>
          <p>
            Built with Vite, React, TypeScript, and Tailwind CSS
          </p>
        </div>
      </div>
    </div>
  )
}

