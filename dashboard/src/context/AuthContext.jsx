/**
 * AuthContext — JWT authentication + project selection state machine.
 *
 * Auth phases:
 *   'unauthenticated' → user has no token and no pending OAuth flow
 *   'discovering'     → pre-auth JWT held; fetching project list from gateway
 *   'selecting'       → project list loaded; user must pick one
 *   'authenticated'   → project-scoped JWT active; dashboard is usable
 *
 * Login flow (first time):
 *   1. User clicks "Login with GitHub" → /auth/github → GitHub OAuth
 *   2. Gateway callback exchanges code server-side → issues Quorum JWT directly:
 *        1 project  → scoped JWT  → #token=<jwt> in fragment
 *        n projects → pre-auth JWT (5 min, no project claim) → #token=<jwt> in fragment
 *   3. Login.jsx reads #token= → calls completeOAuth(jwt)
 *      - scoped JWT  → _applyJwt() → 'authenticated'
 *      - pre-auth JWT → GET /auth/projects → 'discovering' → 'selecting'
 *   4. selectProject(slug) → POST /auth/switch with pre-auth JWT → scoped JWT → 'authenticated'
 *
 * Project switching (already authenticated):
 *   switchProject() → 'selecting'; switchTo(slug) → POST /auth/switch with existing JWT
 *
 * Token storage:
 *   Scoped JWT      → React state + sessionStorage (survives refresh, cleared on tab close)
 *   Pre-auth JWT    → useRef only — never sessionStorage, never disk
 *   Project list    → React state + sessionStorage (metadata only, not credentials)
 *
 * XSS note: sessionStorage is readable by JS on the same origin. The risk
 * is the same as localStorage but the blast radius is smaller (tab-scoped).
 * For production, consider Secure httpOnly cookies instead.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { decodeJwt } from '../lib/utils.js'
import { registerProjectGetter } from '../api/client.js'

const AuthContext       = createContext(null)
const SESSION_KEY       = 'quorum_session'
const PROJECTS_KEY      = 'quorum_projects'
const PROJECT_KEY       = 'quorum_active_project'

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

function readStoredProject() {
  return sessionStorage.getItem(PROJECT_KEY) ?? null
}

function writeStoredProject(slug) {
  try { sessionStorage.setItem(PROJECT_KEY, slug) } catch { /* quota */ }
}

function clearStoredProject() {
  sessionStorage.removeItem(PROJECT_KEY)
}

/**
 * Fetch the user profile from the gateway. Returns null on failure.
 * @param {string} sub
 * @param {string} jwt
 * @returns {Promise<object | null>}
 */
async function fetchProfile(sub, jwt) {
  try {
    const res = await fetch(`/user/profile/${encodeURIComponent(sub)}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
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
 *   completeOAuth()    — call with Quorum JWT from URL fragment after GitHub OAuth
 *   selectProject()    — call with project slug to complete login from selector
 *   switchProject()    — return to selector using cached project list (no re-OAuth)
 *   switchTo()         — switch to a different project using existing JWT (no re-OAuth)
 *   logout()           — clear all state and sessionStorage
 *   refresh()          — silently renew JWT via POST /auth/refresh
 *   completeReauth()   — called by SessionExpiredModal with fresh Quorum JWT from popup
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
  const [selectedProject,   setSelectedProject]   = useState(readStoredProject)
  const [error,             setError]             = useState(null)
  const [reauthNeeded,      setReauthNeeded]      = useState(false)

  // Register selectedProject with the API client so X-Quorum-Project header is sent.
  // Called synchronously in the render body (not in useEffect) so the getter is
  // always up-to-date before any TanStack Query fires — avoids the post-paint timing
  // gap that would cause the first request after a page refresh to miss the header.
  registerProjectGetter(() => selectedProject)

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
   * The pre-auth JWT held in memory between completeOAuth() and selectProject().
   * Issued by the gateway when the user has N > 1 projects; has no project claim
   * and a 5-minute TTL. Never written to sessionStorage or disk.
   * @type {React.MutableRefObject<string | null>}
   */
  const pendingPreAuthRef = useRef(null)

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

  /**
   * Store JWT, update phase, arm expiry. Internal — used by completeOAuth/selectProject/switchTo/completeReauth.
   *
   * @param {string} jwt - ES256 JWT from the gateway
   * @param {object} [profile] - Response body fields that supplement the JWT claims.
   *   In v0.3 the JWT is slim (only sub + is_admin). Pass the response body here so
   *   project/role/team/base_confidence are preserved in user state even when absent
   *   from the token itself.
   */
  const _applyJwt = useCallback((jwt, profile = {}) => {
    const payload = decodeJwt(jwt)
    if (!payload) throw new Error('Invalid token received from server')
    const user = {
      ...payload,
      project:         profile.project         ?? payload.project         ?? null,
      role:            profile.role            ?? payload.role            ?? null,
      team:            profile.team            ?? payload.team            ?? null,
      base_confidence: profile.base_confidence ?? payload.base_confidence ?? null,
    }
    setToken(jwt)
    setUser(user)
    setAuthPhase('authenticated')
    writeStoredSession(jwt, user)
    if (payload.exp) scheduleExpiry(payload.exp)
    return user
  }, [scheduleExpiry])

  /** Clear all auth state and storage. */
  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    setAvailableProjects([])
    setSelectedProject(null)
    setAuthPhase('unauthenticated')
    setReauthNeeded(false)
    pendingPreAuthRef.current = null
    clearStoredSession()
    clearStoredProjects()
    clearStoredProject()
    clearTimeout(expiryTimerRef.current)
    clearTimeout(backgroundRefreshTimerRef.current)
  }, [])

  /**
   * Complete the OAuth flow after the gateway redirects to /login#token=<jwt>.
   *
   * v0.3: the gateway always issues a slim JWT { sub, is_admin }. Project context
   * is resolved by fetching GET /user/profile/{sub} rather than reading a JWT claim.
   *   - 1 project  → auto-selects, applies JWT → 'authenticated'
   *   - n projects → stores project list, transitions to 'selecting'
   *
   * @param {string} jwt — Quorum JWT from #token= URL fragment
   * @returns {Promise<void>}
   */
  const completeOAuth = useCallback(async (jwt) => {
    setError(null)
    const payload = decodeJwt(jwt)
    if (!payload) {
      setError('Invalid token received from server.')
      return
    }

    pendingPreAuthRef.current = jwt
    setAuthPhase('discovering')

    let userProfile
    try {
      userProfile = await fetchProfile(payload.sub, jwt)
      if (!userProfile) throw new Error('Profile fetch failed')
    } catch (err) {
      setError(err.message)
      setAuthPhase('unauthenticated')
      pendingPreAuthRef.current = null
      return
    }

    const projects = userProfile.projects ?? []
    if (projects.length === 0) {
      setError('No projects found. Ask a principal architect to add your GitHub username to a project config.')
      setAuthPhase('unauthenticated')
      pendingPreAuthRef.current = null
      return
    }

    setAvailableProjects(projects)
    writeStoredProjects(projects)

    if (projects.length === 1) {
      // Auto-select the only project — skip selector entirely
      const proj = projects[0]
      setSelectedProject(proj.group_id)
      writeStoredProject(proj.group_id)
      _applyJwt(jwt)
      pendingPreAuthRef.current = null
      return
    }

    setAuthPhase('selecting')
  }, [_applyJwt])

  /**
   * Complete project selection from the ProjectSelector page.
   *
   * v0.3: no HTTP call needed — the JWT already in pendingPreAuthRef is valid for
   * all projects. We just record the selected project in state so the
   * X-Quorum-Project header is sent on subsequent API calls.
   *
   * @param {string} projectSlug
   * @returns {void}
   */
  const selectProject = useCallback((projectSlug) => {
    const preAuthJwt = pendingPreAuthRef.current
    if (!preAuthJwt) {
      setError('Session expired — please sign in again.')
      setAuthPhase('unauthenticated')
      return
    }
    setError(null)
    setSelectedProject(projectSlug)
    writeStoredProject(projectSlug)
    _applyJwt(preAuthJwt, { project: projectSlug })
    pendingPreAuthRef.current = null
  }, [_applyJwt])

  /**
   * Switch to a different project using the existing JWT.
   *
   * v0.3: no HTTP call — setting selectedProject updates the X-Quorum-Project
   * header sent by the API client; verify-jwt middleware resolves the new role
   * from the Redis profile cache on the next request.
   *
   * @param {string} projectSlug
   * @returns {void}
   */
  const switchTo = useCallback((projectSlug) => {
    setSelectedProject(projectSlug)
    writeStoredProject(projectSlug)
    setAuthPhase('authenticated')
  }, [])

  /**
   * Return to the project selector without re-doing GitHub OAuth.
   * Refreshes the project list via GET /user/profile/{sub} so the selector
   * always shows live data (role changes, new projects) rather than the
   * potentially-stale sessionStorage cache.
   *
   * ProtectedRoute redirects to /select-project on authPhase === 'selecting'.
   */
  const switchProject = useCallback(async () => {
    setReauthNeeded(false)
    setAuthPhase('selecting')

    const currentToken = tokenRef.current
    if (!currentToken || !user?.sub) return
    try {
      const userProfile = await fetchProfile(user.sub, currentToken)
      if (userProfile?.projects?.length) {
        setAvailableProjects(userProfile.projects)
        writeStoredProjects(userProfile.projects)
      }
    } catch {
      // Non-fatal — selector will render with whatever is in state
    }
  }, [user])

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
   *
   * v0.3: the popup returns a slim JWT { sub, is_admin }. The active project is
   * preserved in selectedProject state (was set before expiry), so no /auth/switch
   * call is needed — just apply the fresh token and the X-Quorum-Project header
   * will resume sending the correct project on subsequent requests.
   *
   * @param {string} jwt — fresh Quorum JWT from the re-auth popup
   */
  const completeReauth = useCallback((jwt) => {
    const payload = decodeJwt(jwt)
    if (!payload) {
      setReauthNeeded(false)
      throw new Error('Invalid token received from re-auth popup')
    }
    _applyJwt(jwt)
    setReauthNeeded(false)
  }, [_applyJwt])

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
  // Guest = authenticated but the current project entry has no role (not a member).
  // v0.3: role is no longer in the JWT; derive from the availableProjects profile list.
  const currentProjectData = availableProjects.find(p => p.group_id === selectedProject) ?? null
  const isGuest   = token ? !currentProjectData || currentProjectData.role === null : false

  return (
    <AuthContext.Provider value={{
      authPhase,
      token,
      user,
      /** Currently active project group_id (null when no project selected). */
      selectedProject,
      /** Profile entry for the active project — includes role, base_confidence, is_owner, team. */
      currentProjectData,
      availableProjects,
      completeOAuth,
      selectProject,
      switchProject,
      switchTo,
      cancelSwitch,
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
