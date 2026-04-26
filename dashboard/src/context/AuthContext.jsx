/**
 * AuthContext — JWT authentication with sessionStorage persistence.
 *
 * Token lifecycle:
 *   login()       → POST /auth/token → store JWT in React state + sessionStorage
 *   refresh       → hydrate token/user from sessionStorage on mount; re-arm expiry timer
 *   logout()      → clear React state + sessionStorage
 *   expiry        → shows re-auth modal via setTimeout scheduled at login (and re-armed on hydrate)
 *   completeReauth → called by the re-auth modal after GitHub OAuth popup completes
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
 *   token          — raw JWT string (null when logged out)
 *   user           — decoded JWT payload { sub, project, role, team, base_confidence, exp }
 *   login()        — POST /auth/token → store JWT, start expiry timer
 *   logout()       — clear state + sessionStorage
 *   refresh()      — silently renew JWT via POST /auth/refresh
 *   completeReauth — called by re-auth modal after GitHub OAuth popup completes
 *   error          — auth error message for display
 *   isExpired      — true when the JWT exp has passed
 *   reauthNeeded   — true when the JWT has expired and a re-auth modal should be shown
 *
 * @param {{ children: React.ReactNode }} props
 */
export function AuthProvider({ children }) {
  // Hydrate initial state from sessionStorage so refreshes don't log users out
  const [token, setToken]               = useState(() => readStoredSession()?.token ?? null)
  const [user,  setUser]                = useState(() => readStoredSession()?.user  ?? null)
  const [error, setError]               = useState(null)
  /** @type {React.MutableRefObject<ReturnType<typeof setTimeout>|null>} */
  const expiryTimer                     = useRef(null)
  /** @type {React.MutableRefObject<ReturnType<typeof setTimeout>|null>} Fires at exp-10min for silent background refresh. */
  const backgroundRefreshTimerRef       = useRef(null)
  /** @type {React.MutableRefObject<Function|null>} Stale-closure-safe pointer to the latest refresh fn. */
  const refreshRef                      = useRef(null)
  /** @type {React.MutableRefObject<string|null>} Always holds the latest token value. */
  const tokenRef                        = useRef(token)
  /** @type {boolean} True when the JWT has expired and the re-auth modal should be shown. */
  const [reauthNeeded, setReauthNeeded] = useState(false)
  /** @type {React.MutableRefObject<boolean>} Mirror of reauthNeeded state for use in event handlers. */
  const reauthNeededRef                 = useRef(false)

  /**
   * Schedule a silent background refresh and an expiry modal trigger when the JWT expires.
   *
   * Two timers are armed:
   *   1. Background refresh at `exp - 10 min` — silently calls refresh(). If it succeeds,
   *      both timers are re-armed by refresh() → scheduleExpiry(newExp). If it fails, the
   *      expiry timer handles the deadline.
   *   2. Expiry timer at `exp` — sets reauthNeeded(true) and clears storage. Does NOT clear
   *      token/user from React state so completeReauth() knows which project to re-auth against.
   *
   * @param {number} expEpochSec — JWT `exp` claim (Unix seconds)
   */
  const scheduleExpiry = useCallback((expEpochSec) => {
    clearTimeout(expiryTimer.current)
    clearTimeout(backgroundRefreshTimerRef.current)

    const msRemaining = expEpochSec * 1000 - Date.now()
    if (msRemaining <= 0) return

    // Silent background refresh at exp - 10 min
    const refreshAt = msRemaining - 10 * 60 * 1000
    if (refreshAt > 0) {
      backgroundRefreshTimerRef.current = setTimeout(async () => {
        try { await refreshRef.current?.() } catch { /* expiry timer will handle it */ }
      }, refreshAt)
    }

    // Expiry: show re-auth modal, clear storage (keep token/user in state for completeReauth)
    expiryTimer.current = setTimeout(() => {
      setReauthNeeded(true)
      clearStoredSession()
    }, msRemaining)
  }, [])

  /**
   * Silently renew the Quorum JWT without re-authenticating with GitHub.
   * Calls POST /auth/refresh (Bearer current JWT → new JWT).
   * Updates React state, sessionStorage, and re-arms both expiry timers.
   *
   * Registered with the API client so apiFetch can call it proactively
   * when the token is within REFRESH_BUFFER_MS of expiry.
   *
   * Uses tokenRef (not token state) to avoid stale closures when called
   * from background timers — no longer requires token in dependency array.
   *
   * @returns {Promise<string>} the new JWT
   */
  const refresh = useCallback(async () => {
    const currentToken = tokenRef.current
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
  }, [scheduleExpiry])

  // Keep refreshRef pointing to the latest refresh function to avoid stale closures
  // inside the background refresh timer callback.
  useEffect(() => { refreshRef.current = refresh }, [refresh])

  // Keep tokenRef in sync with the latest token state so background timers
  // always read the current token without closing over stale state.
  useEffect(() => { tokenRef.current = token }, [token])

  // Keep reauthNeededRef in sync with reauthNeeded state for use in event handlers.
  useEffect(() => { reauthNeededRef.current = reauthNeeded }, [reauthNeeded])

  /** Clear all auth state and storage. */
  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    setReauthNeeded(false)
    clearStoredSession()
    clearTimeout(expiryTimer.current)
    clearTimeout(backgroundRefreshTimerRef.current)
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

  /**
   * Complete a re-authentication flow after the GitHub OAuth popup returns.
   * Silently exchanges the new OAuth token for a fresh Quorum JWT using the
   * existing user's project, then clears the reauthNeeded flag so the modal hides.
   *
   * @param {string} githubOauthToken — OAuth access token returned from the popup flow
   * @returns {Promise<void>}
   * @throws {Error} if there is no active session to re-authenticate against
   */
  const completeReauth = useCallback(async (githubOauthToken) => {
    if (!user?.project) {
      setReauthNeeded(false)
      throw new Error('No active session to re-authenticate')
    }
    await login(githubOauthToken, user.project)
    setReauthNeeded(false)
  }, [user, login])

  // Re-arm the expiry timers when the app loads with a restored session.
  // The setTimeout from the original login is gone — recalculate from user.exp.
  useEffect(() => {
    if (token && user?.exp) {
      scheduleExpiry(user.exp)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — intentionally runs once on mount

  // When the tab regains focus, browser timers may have been throttled.
  // Re-check token state immediately so expiry is caught without waiting for the timer.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return
      const t = token
      if (!t) return
      const remaining = (decodeJwt(t)?.exp ?? 0) * 1000 - Date.now()
      if (remaining <= 0) {
        if (!reauthNeededRef.current) {
          setReauthNeeded(true)
          clearStoredSession()
        }
      } else if (remaining < 5 * 60 * 1000) {
        // Within 5-min buffer — trigger proactive refresh
        refreshRef.current?.().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [token])

  // Clean up both timers on unmount
  useEffect(() => () => {
    clearTimeout(expiryTimer.current)
    clearTimeout(backgroundRefreshTimerRef.current)
  }, [])

  const isExpired = token ? (decodeJwt(token)?.exp ?? 0) * 1000 < Date.now() : false

  return (
    <AuthContext.Provider value={{ token, user, login, logout, refresh, error, setError, isExpired, reauthNeeded, completeReauth }}>
      {children}
    </AuthContext.Provider>
  )
}

/**
 * useAuth — access auth state and actions.
 * @returns {{ token: string|null, user: object|null, login: Function, logout: Function, refresh: Function, error: string|null, isExpired: boolean, reauthNeeded: boolean, completeReauth: Function }}
 */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
