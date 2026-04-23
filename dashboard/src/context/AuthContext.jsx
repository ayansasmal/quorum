import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { decodeJwt } from '../lib/utils.js'

const AuthContext = createContext(null)

/**
 * Stores JWT in React state only — never localStorage.
 * On page refresh the user must re-authenticate. This is intentional:
 * it prevents XSS token theft at the cost of one extra login per session.
 *
 * Provides:
 *   token     — raw JWT string (null when logged out)
 *   user      — decoded JWT payload { sub, project, role, team, base_confidence }
 *   login()   — POST /auth/token → store JWT, start expiry timer
 *   logout()  — clear state
 *   isExpired — true when the JWT exp has passed
 */
export function AuthProvider({ children }) {
  const [token, setToken]   = useState(null)
  const [user,  setUser]    = useState(null)
  const [error, setError]   = useState(null)
  const expiryTimer         = useRef(null)

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    clearTimeout(expiryTimer.current)
  }, [])

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

    // Schedule automatic logout at JWT expiry
    const expiresIn = (payload.exp * 1000) - Date.now()
    if (expiresIn > 0) {
      expiryTimer.current = setTimeout(() => {
        logout()
        setError('Your session has expired. Please sign in again.')
      }, expiresIn)
    }

    return payload
  }, [logout])

  // Clean up expiry timer on unmount
  useEffect(() => () => clearTimeout(expiryTimer.current), [])

  const isExpired = token ? (decodeJwt(token)?.exp ?? 0) * 1000 < Date.now() : false

  return (
    <AuthContext.Provider value={{ token, user, login, logout, error, setError, isExpired }}>
      {children}
    </AuthContext.Provider>
  )
}

/** @returns {{ token: string|null, user: object|null, login: Function, logout: Function, error: string|null, isExpired: boolean }} */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
