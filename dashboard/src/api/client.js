/**
 * Base fetch wrapper that attaches the JWT from AuthContext.
 * All API modules import `apiFetch` rather than calling fetch directly.
 */

let _getToken = () => null

/** Called once by AuthProvider to register the token getter. */
export function registerTokenGetter(fn) {
  _getToken = fn
}

/**
 * Authenticated fetch. Throws on non-2xx responses.
 * @param {string} path
 * @param {RequestInit} [options]
 */
export async function apiFetch(path, options = {}) {
  const token = _getToken()
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  }

  const res = await fetch(path, { ...options, headers })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err  = new Error(body.message ?? `Request failed: ${res.status} ${res.statusText}`)
    err.status = res.status
    err.body   = body
    throw err
  }

  return res.json()
}
