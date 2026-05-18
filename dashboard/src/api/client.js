/**
 * API client — authenticated fetch with proactive token refresh.
 *
 * Before every request:
 *   1. Token expired  → logout immediately, throw.
 *   2. Token expires within REFRESH_BUFFER_MS (5 min) → silent refresh first.
 *   3. 401 from server (e.g. key rotation) → retry once after refresh.
 *
 * Concurrent requests that all need a refresh share a single in-flight
 * refresh Promise (promise mutex) — exactly one HTTP call is made.
 *
 * Registration (called by App.jsx / AuthContext):
 *   registerTokenGetter(fn)  — () => currentJwt
 *   registerLogout(fn)       — () => void  (clears auth state + sessionStorage)
 *   registerRefresher(fn)    — async () => newJwt  (calls POST /auth/refresh)
 */

import { decodeJwt } from '../lib/utils.js'

// ── Registered callbacks ───────────────────────────────────────────────────────

/** @type {() => string | null} */
let _getToken = () => null
/** @type {() => void} */
let _logout = () => {}
/** @type {(() => Promise<string>) | null} */
let _refresh = null
/** @type {(() => string | null) | null} */
let _getProject = null

/** @param {() => string | null} fn */
export function registerTokenGetter(fn)   { _getToken = fn }
/** @param {() => void} fn */
export function registerLogout(fn)        { _logout = fn }
/** @param {() => Promise<string>} fn */
export function registerRefresher(fn)     { _refresh = fn }
/**
 * Register a function that returns the currently active project ID.
 * apiFetch injects this as X-Quorum-Project on every request (v0.3: project
 * context travels via header, not JWT claim).
 * @param {() => string | null} fn
 */
export function registerProjectGetter(fn) { _getProject = fn }

// ── Token validation ───────────────────────────────────────────────────────────

/** Milliseconds until the token expires. Returns 0 if no token or already expired. */
function msUntilExpiry(token) {
  if (!token) return 0
  const payload = decodeJwt(token)
  if (!payload?.exp) return 0
  return Math.max(0, payload.exp * 1000 - Date.now())
}

// ── Refresh mutex ──────────────────────────────────────────────────────────────

/** 5-minute window — refresh proactively before token actually expires. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000

/** Single in-flight refresh Promise — prevents concurrent refresh calls. */
let _refreshInFlight = null

/**
 * Trigger a token refresh, coalescing concurrent callers into one HTTP call.
 * Returns the new JWT string on success.
 * Calls _logout() and re-throws on failure.
 *
 * @returns {Promise<string>} new JWT
 */
async function doRefresh() {
  if (_refreshInFlight) return _refreshInFlight
  if (!_refresh) {
    _logout()
    throw new Error('Session expired. Please sign in again.')
  }

  _refreshInFlight = _refresh()
    .catch((err) => {
      _logout()
      throw err
    })
    .finally(() => {
      _refreshInFlight = null
    })

  return _refreshInFlight
}

// ── Authenticated fetch ────────────────────────────────────────────────────────

/**
 * Authenticated fetch wrapper. Validates and optionally refreshes the JWT
 * before every call. Throws on non-2xx responses.
 *
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<unknown>}
 */
export async function apiFetch(path, options = {}) {
  let token = _getToken()

  // ── Pre-flight token check ─────────────────────────────────────────────────
  if (token) {
    const remaining = msUntilExpiry(token)

    if (remaining === 0) {
      // Already expired — don't bother making the request
      _logout()
      throw Object.assign(
        new Error('Session expired. Please sign in again.'),
        { status: 401 },
      )
    }

    if (remaining < REFRESH_BUFFER_MS) {
      // Proactively refresh before the call — avoids a mid-flight expiry
      token = await doRefresh()
    }
  }

  // ── Make the request ───────────────────────────────────────────────────────
  const activeProject = _getProject?.()
  const makeRequest = (jwt) => fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt            ? { Authorization: `Bearer ${jwt}` }         : {}),
      ...(activeProject  ? { 'X-Quorum-Project': activeProject }      : {}),
      ...options.headers,
    },
  })

  let res = await makeRequest(token)

  // ── 401 reactive recovery — one retry after fresh token ───────────────────
  // Handles rare cases like gateway key rotation between calls.
  if (res.status === 401) {
    try {
      token = await doRefresh()
      res   = await makeRequest(token)
    } catch {
      // doRefresh already called _logout() — just surface the error
      throw Object.assign(
        new Error('Session expired. Please sign in again.'),
        { status: 401 },
      )
    }
  }

  // ── Parse response ─────────────────────────────────────────────────────────
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err  = new Error(body.message ?? `Request failed: ${res.status} ${res.statusText}`)
    err.status = res.status
    err.body   = body
    throw err
  }

  return res.json()
}
