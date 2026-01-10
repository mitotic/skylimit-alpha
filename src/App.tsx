import { Routes, Route, Navigate } from 'react-router-dom'
import { useSession } from './auth/SessionContext'
import { RateLimitProvider } from './contexts/RateLimitContext'
import Layout from './components/Layout'
import ScrollToTop from './components/ScrollToTop'
import LoginPage from './routes/LoginPage'
import HomePage from './routes/HomePage'
import SearchPage from './routes/SearchPage'
import ProfilePage from './routes/ProfilePage'
import SettingsPage from './routes/SettingsPage'
import SkylimitSettingsPage from './routes/SkylimitSettingsPage'
import ThreadPage from './routes/ThreadPage'
import NotificationsPage from './routes/NotificationsPage'

function App() {
  const { session } = useSession()

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
                  <Route path="/profile/:actor" element={<ProfilePage />} />
                  <Route path="/post/:uri" element={<ThreadPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/settings/skylimit" element={<SkylimitSettingsPage />} />
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




