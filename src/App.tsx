import { Routes, Route, Navigate } from 'react-router-dom'
import { useSession } from './auth/SessionContext'
import { RateLimitProvider } from './contexts/RateLimitContext'
import Layout from './components/Layout'
import Spinner from './components/Spinner'
import ScrollToTop from './components/ScrollToTop'
import DormantOverlay from './components/DormantOverlay'
import { useTabGuard } from './utils/tabGuard'
import LoginPage from './routes/LoginPage'
import HomePage from './routes/HomePage'
import SearchPage from './routes/SearchPage'
import ProfilePage from './routes/ProfilePage'
import SettingsPage from './routes/SettingsPage'
import ThreadPage from './routes/ThreadPage'
import NotificationsPage from './routes/NotificationsPage'
import SavedPage from './routes/SavedPage'
import FeedPage from './routes/FeedPage'
import ChatPage from './routes/ChatPage'
import FollowListPage from './routes/FollowListPage'

function App() {
  const { status: tabStatus, claimActive } = useTabGuard()
  const { session, isLoading } = useSession()

  // Another tab is already active — show standalone takeover page
  if (tabStatus === 'blocked') {
    return <DormantOverlay mode="blocked" onAction={claimActive} />
  }

  if (isLoading || tabStatus === 'initializing') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <RateLimitProvider>
      {tabStatus === 'dormant' && <DormantOverlay mode="dormant" onAction={claimActive} />}
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
                  <Route path="/profile/:actor/followers" element={<FollowListPage />} />
                  <Route path="/profile/:actor/following" element={<FollowListPage />} />
                  <Route path="/profile/:actor" element={<ProfilePage />} />
                  <Route path="/post/:uri" element={<ThreadPage />} />
                  <Route path="/feed/:feedUri" element={<FeedPage />} />
                  <Route path="/chat" element={<ChatPage />} />
                  <Route path="/chat/:convoId" element={<ChatPage />} />
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




