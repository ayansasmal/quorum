import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { registerTokenGetter, registerLogout, registerRefresher } from './api/client.js'
import Layout from './components/layout/Layout.jsx'
import SessionExpiredModal from './components/session/SessionExpiredModal.jsx'

// Pages
import Login           from './pages/Login.jsx'
import ProjectSelector from './pages/ProjectSelector.jsx'
import Stats           from './pages/Stats.jsx'
import Graph           from './pages/Graph.jsx'
import Pending         from './pages/Pending.jsx'
import Knowledge       from './pages/Knowledge.jsx'
import Audit           from './pages/Audit.jsx'
import Config          from './pages/Config.jsx'
import Status          from './pages/Status.jsx'

/**
 * Registers the current JWT with the API client and sets up:
 *   - 401 interceptor (logout on expired token)
 *   - Browser notification polling (pending count change)
 */
function AppSetup({ children }) {
  const { token, logout, refresh } = useAuth()
  const qc                         = useQueryClient()

  useEffect(() => {
    registerTokenGetter(() => token)
    registerRefresher(refresh)
  }, [token, refresh])

  useEffect(() => {
    registerLogout(logout)
  }, [logout])

  // Clear all cached queries on logout or project switch
  useEffect(() => {
    if (!token) qc.clear()
  }, [token, qc])

  // Browser notification: request permission once on login
  useEffect(() => {
    if (token && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [token])

  return (
    <>
      {children}
      <SessionExpiredModal />
    </>
  )
}

/**
 * Redirect unauthenticated users to /login.
 * Redirect users in 'selecting' phase to /select-project.
 */
function ProtectedRoute() {
  const { token, authPhase } = useAuth()
  const location             = useLocation()

  if (authPhase === 'selecting') {
    return <Navigate to="/select-project" replace />
  }
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return (
    <Layout>
      <Outlet />
    </Layout>
  )
}

/**
 * Guard for /select-project — redirect away if already authenticated
 * or not yet through OAuth.
 */
function SelectorRoute() {
  const { authPhase } = useAuth()
  if (authPhase === 'authenticated') return <Navigate to="/" replace />
  if (authPhase === 'unauthenticated') return <Navigate to="/login" replace />
  return <ProjectSelector />
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <AppSetup>
            <Routes>
              <Route path="/login"          element={<Login />} />
              <Route path="/select-project" element={<SelectorRoute />} />
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
