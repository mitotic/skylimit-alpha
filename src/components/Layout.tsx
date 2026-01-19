import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import Navigation from './Navigation'
import BurgerMenu from './BurgerMenu'
import Avatar from './Avatar'
import { useSession } from '../auth/SessionContext'
import { getProfile } from '../api/profile'
import { getSettings } from '../curation/skylimitStore'

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { session, agent } = useSession()
  const [userAvatar, setUserAvatar] = useState<string | undefined>()
  const [clickToBlueSky, setClickToBlueSky] = useState(false)

  const showBackButton = location.pathname !== '/' && location.pathname !== '/search' && location.pathname !== '/settings' && location.pathname !== '/notifications'

  // Fetch user avatar
  useEffect(() => {
    if (!agent || !session) {
      setUserAvatar(undefined)
      return
    }

    const fetchUserAvatar = async () => {
      try {
        const profile = await getProfile(agent, session.handle)
        setUserAvatar(profile.avatar)
      } catch (error) {
        console.warn('Failed to fetch user profile for avatar:', error)
      }
    }

    fetchUserAvatar()
  }, [agent, session])

  // Load click to Bluesky setting (reload on navigation to pick up changes from settings page)
  useEffect(() => {
    const loadClickToBlueskySetting = async () => {
      try {
        const settings = await getSettings()
        setClickToBlueSky(settings?.clickToBlueSky || false)
      } catch (error) {
        console.error('Error loading click to Bluesky setting:', error)
      }
    }
    loadClickToBlueskySetting()
  }, [location.pathname])

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1)
    } else {
      navigate('/')
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 w-full max-w-full overflow-x-hidden">
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
              {session && (
                <button
                  onClick={() => navigate(`/profile/${session.handle}`)}
                  className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline transition-colors min-w-0"
                  aria-label="View profile"
                >
                  <Avatar
                    src={userAvatar}
                    alt={session.handle}
                    size="sm"
                  />
                  <span className="truncate hidden sm:inline">@{session.handle}</span>
                </button>
              )}
            </div>
          </div>
        </header>

        <div className="flex overflow-x-hidden">
          <aside className="hidden md:block w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 min-h-screen">
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




