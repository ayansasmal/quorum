/**
 * AuthContext — JWT authentication with sessionStorage persistence.
 *
 * Token lifecycle:
 *   login()  → POST /auth/token → store JWT in React state + sessionStorage
 *   refresh  → hydrate token/user from sessionStorage on mount; re-arm expiry timer
 *   logout() → clear React state + sessionStorage
 *   expiry   → auto-logout via setTimeout scheduled at login (and re-armed on hydrate)
 *
 * sessionStorage is used (not localStorage) because:
 *   - Survives page refreshes (primary pain point)
 *   - Cleared when the browser tab/window closes (token lifetime bounded)
 *   - Inherited by tabs opened via Ctrl+Click from an existing session
 *   - Not shared across independently opened browser tabs (isolation)
 *
 * XSS note: sessionStorage is readable by JS on the same origin. The risk
 * is the same as localStorage but the blast radius is smaller (tab-scoped).
 * For production, consider Secure httpOnly cookies instead.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { decodeJwt } from '../lib/utils.js'

const AuthContext  = createContext(null)
const STORAGE_KEY  = 'quorum_session'

// ── Session persistence helpers ────────────────────────────────────────────────

/**
 * Read and validate a stored session from sessionStorage.
 * Returns null if missing, malformed, or already expired.
 *
 * @returns {{ token: string, user: object } | null}
 */
function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const { token, user } = JSON.parse(raw)
    if (!token || !user) return null

    // Discard if token has already expired
    if ((user.exp ?? 0) * 1000 < Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }

    return { token, user }
  } catch {
    return null
  }
}

/**
 * Persist a session to sessionStorage.
 * @param {string} token
 * @param {object} user
 */
function writeStoredSession(token, user) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }))
  } catch {
    // sessionStorage quota exceeded or private browsing restrictions — degrade gracefully
  }
}

/** Remove the stored session. */
function clearStoredSession() {
  sessionStorage.removeItem(STORAGE_KEY)
}

// ── Provider ───────────────────────────────────────────────────────────────────

/**
 * AuthProvider — wrap the app root to enable authentication.
 *
 * Provides:
 *   token     — raw JWT string (null when logged out)
 *   user      — decoded JWT payload { sub, project, role, team, base_confidence, exp }
 *   login()   — POST /auth/token → store JWT, start expiry timer
 *   logout()  — clear state + sessionStorage
 *   error     — auth error message for display
 *   isExpired — true when the JWT exp has passed
 *
 * @param {{ children: React.ReactNode }} props
 */
export function AuthProvider({ children }) {
  // Hydrate initial state from sessionStorage so refreshes don't log users out
  const [token, setToken] = useState(() => readStoredSession()?.token ?? null)
  const [user,  setUser]  = useState(() => readStoredSession()?.user  ?? null)
  const [error, setError] = useState(null)
  const expiryTimer       = useRef(null)

  /**
   * Schedule an automatic logout when the JWT expires.
   * @param {number} expEpochSec — JWT `exp` claim (Unix seconds)
   */
  const scheduleExpiry = useCallback((expEpochSec) => {
    clearTimeout(expiryTimer.current)
    const msRemaining = expEpochSec * 1000 - Date.now()
    if (msRemaining > 0) {
      expiryTimer.current = setTimeout(() => {
        setToken(null)
        setUser(null)
        clearStoredSession()
        setError('Your session has expired. Please sign in again.')
      }, msRemaining)
    }
  }, [])

  /**
   * Silently renew the Quorum JWT without re-authenticating with GitHub.
   * Calls POST /auth/refresh (Bearer current JWT → new JWT).
   * Updates React state, sessionStorage, and re-arms the expiry timer.
   *
   * Registered with the API client so apiFetch can call it proactively
   * when the token is within REFRESH_BUFFER_MS of expiry.
   *
   * @returns {Promise<string>} the new JWT
   */
  const refresh = useCallback(async () => {
    const currentToken = token
    if (!currentToken) throw new Error('No token to refresh')

    const res = await fetch('/auth/refresh', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${currentToken}`,
      },
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
  }, [token, scheduleExpiry])

  /** Clear all auth state and storage. */
  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    clearStoredSession()
    clearTimeout(expiryTimer.current)
  }, [])

  /**
   * Exchange a GitHub OAuth token + project ID for a Quorum JWT.
   * Persists the JWT to sessionStorage and arms the expiry timer.
   *
   * @param {string} githubToken — OAuth access token from the OAuth flow
   * @param {string} projectId   — team/project identifier
   * @returns {Promise<object>}  decoded JWT payload
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
    const payload        = decodeJwt(jwt)
    if (!payload) throw new Error('Invalid token received from server')

    setToken(jwt)
    setUser(payload)
    writeStoredSession(jwt, payload)

    if (payload.exp) scheduleExpiry(payload.exp)

    return payload
  }, [scheduleExpiry])

  // Re-arm the expiry timer when the app loads with a restored session.
  // The setTimeout from the original login is gone — recalculate from user.exp.
  useEffect(() => {
    if (token && user?.exp) {
      scheduleExpiry(user.exp)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — intentionally runs once on mount

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(expiryTimer.current), [])

  const isExpired = token ? (decodeJwt(token)?.exp ?? 0) * 1000 < Date.now() : false

  return (
    <AuthContext.Provider value={{ token, user, login, logout, refresh, error, setError, isExpired }}>
      {children}
    </AuthContext.Provider>
  )
}

/**
 * useAuth — access auth state and actions.
 * @returns {{ token: string|null, user: object|null, login: Function, logout: Function, refresh: Function, error: string|null, isExpired: boolean }}
 */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
