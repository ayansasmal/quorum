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
import Admin           from './pages/Admin.jsx'

/**
 * Registers the current JWT with the API client and sets up:
 *   - 401 interceptor (logout on expired token)
 *   - Browser notification polling (pending count change)
 */
function AppSetup({ children }) {
  const { token, authPhase, logout, refresh } = useAuth()
  const qc                                   = useQueryClient()

  // Register synchronously in the render body — not in useEffect — so these
  // callbacks are available before any child component's query effect fires.
  // React effects run children-before-parents, so an AppSetup useEffect would
  // run *after* Stats/Config/etc. have already made their first API call.
  registerTokenGetter(() => token)
  registerRefresher(refresh)

  useEffect(() => {
    registerLogout(logout)
  }, [logout])

  // Clear all cached queries on logout or project switch
  // authPhase 'selecting' means a switch is in progress — clear so the
  // next project loads fresh data even if the token didn't change.
  useEffect(() => {
    if (!token || authPhase === 'selecting') qc.clear()
  }, [token, authPhase, qc])

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
 * Guard for member-only routes (/pending, /audit, /config, /status).
 * Guests (role === null) are redirected to / rather than shown a blank or 403.
 */
function MemberRoute() {
  const { isGuest } = useAuth()
  if (isGuest) return <Navigate to="/" replace />
  return <Outlet />
}

/**
 * Guard for admin-only routes (/admin).
 * Non-admins are redirected to / — the Admin page itself shows an access-denied message
 * as a second layer, but this prevents the route from rendering at all.
 */
function AdminRoute() {
  const { user } = useAuth()
  if (!user?.is_admin) return <Navigate to="/" replace />
  return <Outlet />
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
                <Route path="/knowledge" element={<Knowledge />} />
                <Route element={<MemberRoute />}>
                  <Route path="/pending" element={<Pending />} />
                  <Route path="/audit"   element={<Audit />} />
                  <Route path="/config"  element={<Config />} />
                  <Route path="/status"  element={<Status />} />
                </Route>
                <Route element={<AdminRoute />}>
                  <Route path="/admin" element={<Admin />} />
                </Route>
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppSetup>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
