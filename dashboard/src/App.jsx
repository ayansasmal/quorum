import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { registerTokenGetter } from './api/client.js'
import Layout from './components/layout/Layout.jsx'

// Pages — lazy-loaded to keep initial bundle small
import Login     from './pages/Login.jsx'
import Stats     from './pages/Stats.jsx'
import Graph     from './pages/Graph.jsx'
import Pending   from './pages/Pending.jsx'
import Knowledge from './pages/Knowledge.jsx'
import Audit     from './pages/Audit.jsx'
import Config    from './pages/Config.jsx'
import Status    from './pages/Status.jsx'

/**
 * Registers the current JWT with the API client and sets up:
 *   - 401 interceptor (logout on expired token)
 *   - Browser notification polling (pending count change)
 */
function AppSetup({ children }) {
  const { token, logout, user } = useAuth()
  const qc                      = useQueryClient()
  const prevPendingRef          = useRef(null)

  // Register token getter so apiFetch always has the latest JWT
  useEffect(() => {
    registerTokenGetter(() => token)
  }, [token])

  // Clear all cached queries on logout
  useEffect(() => {
    if (!token) qc.clear()
  }, [token, qc])

  // Browser notification: request permission once on login
  useEffect(() => {
    if (token && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [token])

  return children
}

/** Redirect unauthenticated users to /login. */
function ProtectedRoute() {
  const { token } = useAuth()
  const location  = useLocation()
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />
  return (
    <Layout>
      <Outlet />
    </Layout>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
      <AuthProvider>
        <AppSetup>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/"          element={<Stats />} />
              <Route path="/graph"     element={<Graph />} />
              <Route path="/pending"   element={<Pending />} />
              <Route path="/knowledge" element={<Knowledge />} />
              <Route path="/audit"     element={<Audit />} />
              <Route path="/config"    element={<Config />} />
              <Route path="/status"    element={<Status />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppSetup>
      </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
