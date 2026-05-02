/**
 * AuthContext — JWT authentication + project selection state machine.
 *
 * Auth phases:
 *   'unauthenticated' → user has no token and no pending OAuth flow
 *   'discovering'     → GitHub OAuth complete; fetching project list from gateway
 *   'selecting'       → project list loaded; user must pick one (or auto-selected)
 *   'authenticated'   → project-scoped JWT active; dashboard is usable
 *
 * Login flow (first time):
 *   1. User clicks "Login with GitHub" → OAuth popup → gho_ token returned
 *   2. discoverProjects(gho_token) → POST /auth/projects → project list
 *      - 1 project  → auto-select → login() → 'authenticated'
 *      - n projects → phase = 'selecting' (ProjectSelector shown)
 *   3. selectProject(slug) → login(pendingOauthToken, slug) → 'authenticated'
 *
 * Project switching (already authenticated):
 *   switchProject() → POST /auth/switch { project_id } → new project-scoped JWT
 *   No GitHub re-auth needed — the existing JWT proves identity.
 *   The project list is reloaded from /auth/projects (requires fresh gho_ token via popup).
 *   OR if the cached project list covers the switch: just call POST /auth/switch directly.
 *
 * Token storage:
 *   JWT           → React state + sessionStorage (survives refresh, cleared on tab close)
 *   gho_ token    → useRef only — NEVER sessionStorage, never written to disk
 *   Project list  → React state + sessionStorage (metadata only, not credentials)
 *
 * XSS note: sessionStorage is readable by JS on the same origin. The risk
 * is the same as localStorage but the blast radius is smaller (tab-scoped).
 * For production, consider Secure httpOnly cookies instead.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { decodeJwt } from '../lib/utils.js'

const AuthContext       = createContext(null)
const SESSION_KEY       = 'quorum_session'
const PROJECTS_KEY      = 'quorum_projects'

// ── Session persistence helpers ────────────────────────────────────────────────

/**
 * Read and validate a stored session from sessionStorage.
 * Returns null if missing, malformed, or already expired.
 * @returns {{ token: string, user: object } | null}
 */
function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const { token, user } = JSON.parse(raw)
    if (!token || !user) return null
    if ((user.exp ?? 0) * 1000 < Date.now()) {
      sessionStorage.removeItem(SESSION_KEY)
      return null
    }
    return { token, user }
  } catch {
    return null
  }
}

/** @param {string} token @param {object} user */
function writeStoredSession(token, user) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, user })) } catch { /* quota */ }
}

function clearStoredSession() {
  sessionStorage.removeItem(SESSION_KEY)
}

/**
 * Read the cached project list from sessionStorage.
 * @returns {object[] | null}
 */
function readStoredProjects() {
  try {
    const raw = sessionStorage.getItem(PROJECTS_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** @param {object[]} projects */
function writeStoredProjects(projects) {
  try { sessionStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)) } catch { /* quota */ }
}

function clearStoredProjects() {
  sessionStorage.removeItem(PROJECTS_KEY)
}

// ── Provider ───────────────────────────────────────────────────────────────────

/**
 * AuthProvider — wraps the app root to provide authentication and project selection.
 *
 * Provides via useAuth():
 *   authPhase          — 'unauthenticated' | 'discovering' | 'selecting' | 'authenticated'
 *   token              — raw JWT string (null when not authenticated)
 *   user               — decoded JWT payload { sub, project, role, team, exp }
 *   availableProjects  — project list fetched after OAuth (empty until discovered)
 *   discoverProjects() — call with gho_ token after GitHub OAuth; handles auto-select
 *   selectProject()    — call with project slug to complete login from selector
 *   switchProject()    — re-discover projects and return to selector (requires re-OAuth popup)
 *   switchTo()         — switch to a different project using existing JWT (no re-OAuth)
 *   login()            — low-level: POST /auth/token → store JWT (used by discoverProjects)
 *   logout()           — clear all state and sessionStorage
 *   refresh()          — silently renew JWT via POST /auth/refresh
 *   completeReauth()   — called by SessionExpiredModal after OAuth popup
 *   error              — current auth error message
 *   reauthNeeded       — true when JWT expired and re-auth modal should show
 *
 * @param {{ children: React.ReactNode }} props
 */
export function AuthProvider({ children }) {
  // Hydrate from sessionStorage on mount so page refreshes don't log users out
  const storedSession  = readStoredSession()
  const storedProjects = readStoredProjects()

  const [token,             setToken]             = useState(storedSession?.token ?? null)
  const [user,              setUser]              = useState(storedSession?.user  ?? null)
  const [availableProjects, setAvailableProjects] = useState(storedProjects ?? [])
  const [error,             setError]             = useState(null)
  const [reauthNeeded,      setReauthNeeded]      = useState(false)

  /**
   * Current auth phase — derived from state rather than stored separately to
   * avoid the risk of state + phase getting out of sync.
   *
   * @type {'unauthenticated' | 'discovering' | 'selecting' | 'authenticated'}
   */
  const [authPhase, setAuthPhase] = useState(
    storedSession ? 'authenticated' : 'unauthenticated',
  )

  /**
   * The GitHub OAuth token (gho_...) held in memory between discoverProjects()
   * and selectProject(). Never written to sessionStorage or disk.
   * @type {React.MutableRefObject<string | null>}
   */
  const pendingOauthTokenRef = useRef(null)

  /** @type {React.MutableRefObject<ReturnType<typeof setTimeout>|null>} */
  const expiryTimerRef              = useRef(null)
  /** @type {React.MutableRefObject<ReturnType<typeof setTimeout>|null>} */
  const backgroundRefreshTimerRef   = useRef(null)
  /** @type {React.MutableRefObject<Function|null>} */
  const refreshRef                  = useRef(null)
  /** @type {React.MutableRefObject<string|null>} */
  const tokenRef                    = useRef(token)
  /** @type {React.MutableRefObject<boolean>} */
  const reauthNeededRef             = useRef(false)

  /**
   * Schedule a silent background refresh and expiry modal trigger.
   * @param {number} expEpochSec — JWT `exp` claim (Unix seconds)
   */
  const scheduleExpiry = useCallback((expEpochSec) => {
    clearTimeout(expiryTimerRef.current)
    clearTimeout(backgroundRefreshTimerRef.current)

    const msRemaining = expEpochSec * 1000 - Date.now()
    if (msRemaining <= 0) return

    const refreshAt = msRemaining - 10 * 60 * 1000
    if (refreshAt > 0) {
      backgroundRefreshTimerRef.current = setTimeout(async () => {
        try { await refreshRef.current?.() } catch { /* expiry timer handles it */ }
      }, refreshAt)
    }

    expiryTimerRef.current = setTimeout(() => {
      setReauthNeeded(true)
      clearStoredSession()
    }, msRemaining)
  }, [])

  /**
   * Silently renew the Quorum JWT without re-authenticating with GitHub.
   * @returns {Promise<string>} the new JWT
   */
  const refresh = useCallback(async () => {
    const currentToken = tokenRef.current
    if (!currentToken) throw new Error('No token to refresh')

    const res = await fetch('/auth/refresh', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.message ?? 'Token refresh failed')
    }

    const { token: newJwt } = await res.json()
    const payload           = decodeJwt(newJwt)
    if (!payload) throw new Error('Invalid token received from refresh')

    setToken(newJwt)
    setUser(payload)
    writeStoredSession(newJwt, payload)
    if (payload.exp) scheduleExpiry(payload.exp)

    return newJwt
  }, [scheduleExpiry])

  // Keep refs up-to-date for use in async callbacks / timers
  useEffect(() => { refreshRef.current      = refresh     }, [refresh])
  useEffect(() => { tokenRef.current        = token       }, [token])
  useEffect(() => { reauthNeededRef.current = reauthNeeded }, [reauthNeeded])

  /** Store JWT, update phase, arm expiry. Internal — used by login/selectProject/switchTo. */
  const _applyJwt = useCallback((jwt) => {
    const payload = decodeJwt(jwt)
    if (!payload) throw new Error('Invalid token received from server')
    setToken(jwt)
    setUser(payload)
    setAuthPhase('authenticated')
    writeStoredSession(jwt, payload)
    if (payload.exp) scheduleExpiry(payload.exp)
    return payload
  }, [scheduleExpiry])

  /** Clear all auth state and storage. */
  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    setAvailableProjects([])
    setAuthPhase('unauthenticated')
    setReauthNeeded(false)
    pendingOauthTokenRef.current = null
    clearStoredSession()
    clearStoredProjects()
    clearTimeout(expiryTimerRef.current)
    clearTimeout(backgroundRefreshTimerRef.current)
  }, [])

  /**
   * Low-level login — exchange GitHub OAuth token + project_id for a Quorum JWT.
   * Prefer discoverProjects() + selectProject() for normal login flow.
   * @param {string} githubToken
   * @param {string} projectId
   * @returns {Promise<object>} decoded JWT payload
   */
  const login = useCallback(async (githubToken, projectId) => {
    setError(null)
    const res = await fetch('/auth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ github_token: githubToken, project_id: projectId }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.message ?? `Auth failed: ${res.status}`)
    }

    const { token: jwt } = await res.json()
    return _applyJwt(jwt)
  }, [_applyJwt])

  /**
   * Discover all projects the engineer belongs to using their GitHub OAuth token.
   * The gho_ token is kept in memory (pendingOauthTokenRef) — never stored.
   * Auto-selects if only one project; shows selector if multiple.
   *
   * @param {string} githubOauthToken — gho_ token from the OAuth flow
   * @returns {Promise<void>}
   */
  const discoverProjects = useCallback(async (githubOauthToken) => {
    setError(null)
    setAuthPhase('discovering')
    pendingOauthTokenRef.current = githubOauthToken

    let projects
    try {
      const res = await fetch('/auth/projects', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ github_token: githubOauthToken }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message ?? `Discovery failed: ${res.status}`)
      }

      const data = await res.json()
      projects = data.projects ?? []
    } catch (err) {
      setError(err.message)
      setAuthPhase('unauthenticated')
      pendingOauthTokenRef.current = null
      return
    }

    setAvailableProjects(projects)
    writeStoredProjects(projects)

    if (projects.length === 0) {
      setError('No projects found. Ask a principal architect to add your GitHub username to a project config.')
      setAuthPhase('unauthenticated')
      pendingOauthTokenRef.current = null
      return
    }

    // Auto-select if only one project — skip the selector entirely
    if (projects.length === 1) {
      try {
        await login(githubOauthToken, projects[0].slug)
        pendingOauthTokenRef.current = null
      } catch (err) {
        setError(err.message)
        setAuthPhase('unauthenticated')
        pendingOauthTokenRef.current = null
      }
      return
    }

    // Multiple projects — show the selector
    setAuthPhase('selecting')
  }, [login])

  /**
   * Complete project selection from the ProjectSelector page.
   * Uses the pending gho_ token stored in memory from discoverProjects().
   *
   * @param {string} projectSlug
   * @returns {Promise<void>}
   */
  const selectProject = useCallback(async (projectSlug) => {
    const oauthToken = pendingOauthTokenRef.current
    if (!oauthToken) {
      setError('Session expired — please sign in again.')
      setAuthPhase('unauthenticated')
      return
    }
    setError(null)
    try {
      await login(oauthToken, projectSlug)
      pendingOauthTokenRef.current = null
    } catch (err) {
      setError(err.message)
    }
  }, [login])

  /**
   * Switch to a different project using the existing JWT.
   * No GitHub re-auth needed — the current JWT proves identity.
   * The gateway verifies membership in the target project before issuing.
   *
   * @param {string} projectSlug
   * @returns {Promise<void>}
   */
  const switchTo = useCallback(async (projectSlug) => {
    const currentToken = tokenRef.current
    if (!currentToken) return

    setError(null)
    const res = await fetch('/auth/switch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentToken}` },
      body:    JSON.stringify({ project_id: projectSlug }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.message ?? `Switch failed: ${res.status}`)
    }

    const { token: jwt } = await res.json()
    _applyJwt(jwt)
  }, [_applyJwt])

  /**
   * Return to the project selector without re-doing GitHub OAuth.
   * Uses the cached project list from sessionStorage.
   *
   * Intentionally keeps the current JWT in state — the token is still valid and
   * switchTo() needs it to call POST /auth/switch. Clearing it here would route
   * ProjectSelector into the selectProject() path which requires the original
   * gho_ OAuth token (long gone after first login) → "session expired" error.
   *
   * ProtectedRoute redirects to /select-project on authPhase === 'selecting'
   * regardless of whether a token is present.
   */
  const switchProject = useCallback(async () => {
    setReauthNeeded(false)
    setAuthPhase('selecting')

    // Refresh the project list using the current JWT so the selector always
    // shows live data rather than the potentially-stale sessionStorage cache.
    const currentToken = tokenRef.current
    if (!currentToken) return
    try {
      const res = await fetch('/auth/projects', {
        headers: { Authorization: `Bearer ${currentToken}` },
      })
      if (res.ok) {
        const { projects } = await res.json()
        setAvailableProjects(projects)
        writeStoredProjects(projects)
      }
    } catch {
      // Non-fatal — selector will render with whatever is in state
    }
  }, [])

  /**
   * Cancel a project switch and return to the current project.
   * Only valid when authPhase === 'selecting' and a JWT is still in state
   * (i.e. the user triggered a switch but hasn't picked a new project yet).
   * No-op if there is no active session to return to.
   */
  const cancelSwitch = useCallback(() => {
    if (tokenRef.current) {
      setAuthPhase('authenticated')
    }
  }, [])

  /**
   * Complete re-authentication after session expiry (called by SessionExpiredModal).
   * Uses the existing user's project so the engineer lands back where they were.
   * @param {string} githubOauthToken
   */
  const completeReauth = useCallback(async (githubOauthToken) => {
    if (!user?.project) {
      setReauthNeeded(false)
      throw new Error('No active session to re-authenticate')
    }
    await login(githubOauthToken, user.project)
    setReauthNeeded(false)
  }, [user, login])

  // Re-arm expiry timers after page refresh with a restored session
  useEffect(() => {
    if (token && user?.exp) scheduleExpiry(user.exp)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Proactive refresh + expiry check on tab focus
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return
      const t = token
      if (!t) return
      const remaining = (decodeJwt(t)?.exp ?? 0) * 1000 - Date.now()
      if (remaining <= 0) {
        if (!reauthNeededRef.current) { setReauthNeeded(true); clearStoredSession() }
      } else if (remaining < 5 * 60 * 1000) {
        refreshRef.current?.().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [token])

  // Cleanup timers on unmount
  useEffect(() => () => {
    clearTimeout(expiryTimerRef.current)
    clearTimeout(backgroundRefreshTimerRef.current)
  }, [])

  const isExpired = token ? (decodeJwt(token)?.exp ?? 0) * 1000 < Date.now() : false
  // Guest = authenticated but role is null (not a member of the current project,
  // or authenticated user with no project membership at all).
  const isGuest   = user ? user.role === null : false

  return (
    <AuthContext.Provider value={{
      authPhase,
      token,
      user,
      availableProjects,
      discoverProjects,
      selectProject,
      switchProject,
      switchTo,
      cancelSwitch,
      login,
      logout,
      refresh,
      error,
      setError,
      isExpired,
      isGuest,
      reauthNeeded,
      completeReauth,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

/**
 * useAuth — access auth state and actions from any component.
 * @returns {ReturnType<typeof AuthProvider> extends { value: infer V } ? V : never}
 */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
