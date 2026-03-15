import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import Navigation from './Navigation'
import BurgerMenu from './BurgerMenu'
import FeedSelector from './FeedSelector'
import { useSession } from '../auth/SessionContext'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { session } = useSession()
  const [clickToBlueSky, setClickToBlueSky] = useState(() =>
    localStorage.getItem('websky_click_to_bluesky') === 'true'
  )

  const showBackButton = location.pathname !== '/' && location.pathname !== '/search' && location.pathname !== '/settings' && location.pathname !== '/notifications' && location.pathname !== '/saved' && location.pathname !== '/chat'

  // Load click to Bluesky setting (reload on navigation to pick up changes from settings page)
  useEffect(() => {
    setClickToBlueSky(localStorage.getItem('websky_click_to_bluesky') === 'true')
  }, [location.pathname])

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1)
    } else {
      navigate('/')
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 w-full max-w-full [overflow-x:clip]">
      <div className="max-w-4xl mx-auto w-full px-0 sm:px-0">
        <header className="sticky top-0 z-40 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between px-2 py-0.5">
            <div className="w-10 flex items-center">
              {/* Burger menu - mobile only */}
              <div className="md:hidden">
                <BurgerMenu />
              </div>
              {/* Back button - shown on subpages, desktop only when burger is visible */}
              {showBackButton && (
                <button
                  onClick={handleBack}
                  className="hidden md:block p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
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
                  className={`h-11 w-11 object-contain ${clickToBlueSky ? 'border-2 border-blue-500 rounded-full' : ''}`}
                />
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">Alpha version</span>
            </div>
            <div className="flex justify-end min-w-0 flex-shrink">
              {session && <FeedSelector />}
            </div>
          </div>
        </header>

        <div className="flex">
          <aside className="hidden md:block w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 sticky top-[45px] h-[calc(100vh-45px)] overflow-y-auto">
            <Navigation />
          </aside>

          <main className="flex-1 min-w-0 min-h-screen overflow-x-hidden">
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
