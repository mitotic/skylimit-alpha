import { Routes, Route, Navigate } from 'react-router-dom'
import { useSession } from './auth/SessionContext'
import { RateLimitProvider } from './contexts/RateLimitContext'
import Layout from './components/Layout'
import Spinner from './components/Spinner'
import ScrollToTop from './components/ScrollToTop'
import LoginPage from './routes/LoginPage'
import HomePage from './routes/HomePage'
import SearchPage from './routes/SearchPage'
import ProfilePage from './routes/ProfilePage'
import SettingsPage from './routes/SettingsPage'
import ThreadPage from './routes/ThreadPage'
import NotificationsPage from './routes/NotificationsPage'
import SavedPage from './routes/SavedPage'

function App() {
  const { session, isLoading } = useSession()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <RateLimitProvider>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={session ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route
          path="/*"
          element={
            session ? (
              <Layout>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/notifications" element={<NotificationsPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/saved" element={<SavedPage />} />
                  <Route path="/profile/:actor" element={<ProfilePage />} />
                  <Route path="/post/:uri" element={<ThreadPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
      </Routes>
    </RateLimitProvider>
  )
}

export default App




