import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import Navigation from './Navigation'
import { useSession } from '../auth/SessionContext'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { session } = useSession()

  const showBackButton = location.pathname !== '/' && location.pathname !== '/search' && location.pathname !== '/settings' && location.pathname !== '/notifications'

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1)
    } else {
      navigate('/')
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900">
      <div className="max-w-4xl mx-auto">
        <header className="sticky top-0 z-40 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between px-4 py-2">
            <div className="w-10">
              {showBackButton && (
                <button
                  onClick={handleBack}
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                  aria-label="Go back"
                >
                  ←
                </button>
              )}
            </div>
            <div className="flex-1 flex justify-center items-center gap-2">
              <button
                onClick={() => navigate('/')}
                className="p-1 hover:opacity-80 transition-opacity"
                aria-label="Go to home"
              >
                <img
                  src="/SkylimitLogo.png"
                  alt="Skylimit"
                  className="h-9 w-9 object-contain"
                />
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">Alpha version</span>
            </div>
            <div className="w-10 flex justify-end">
              {session && (
                <button
                  onClick={() => navigate(`/profile/${session.handle}`)}
                  className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors"
                  aria-label="View profile"
                >
                  @{session.handle}
                </button>
              )}
            </div>
          </div>
        </header>

        <div className="flex">
          <aside className="hidden md:block w-64 border-r border-gray-200 dark:border-gray-700 min-h-screen">
            <Navigation />
          </aside>

          <main className="flex-1 min-h-screen">
            {children}
          </main>
        </div>

        {/* Mobile bottom navigation */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700">
          <Navigation />
        </nav>
      </div>
    </div>
  )
}




