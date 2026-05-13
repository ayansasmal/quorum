/**
 * Login page — GitHub OAuth flow.
 *
 * Step 1: User clicks "Login with GitHub"
 *         → browser navigates to GET /auth/github
 *         → gateway redirects to github.com/login/oauth/authorize
 *
 * Step 2: GitHub redirects to GET /oauth/callback (single registered callback)
 *         → gateway exchanges code server-side; GitHub token never leaves gateway
 *         → 1 project  → issues scoped Quorum JWT → redirects here with #token=<jwt>
 *         → n projects → issues pre-auth JWT (5 min) → redirects here with #token=<jwt>
 *
 * Step 3: This component reads the Quorum JWT from the fragment, clears it
 *         from the URL, then calls completeOAuth(jwt) in AuthContext.
 *         AuthContext handles:
 *           - scoped JWT → authenticated → App navigates to /
 *           - pre-auth JWT → fetches project list → 'selecting' → App navigates to /select-project
 */

import { useEffect, useState } from 'react'
import { useNavigate }         from 'react-router-dom'
import { useAuth }             from '../context/AuthContext.jsx'

/** GitHub mark icon — shared between login button and re-auth modal. */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 flex-shrink-0">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
               0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
               -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
               .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
               -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
               .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
               .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
               0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  )
}

export default function Login() {
  const { authPhase, completeOAuth, error: authError, setError } = useAuth()
  const navigate = useNavigate()

  const [discovering, setDiscovering] = useState(false)
  const [formError,   setFormError]   = useState(null)

  // ── Step 2: read Quorum JWT from URL fragment ──────────────────────────────
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const token    = fragment.get('token')

    // OAuth error passed as query param (e.g. user denied on GitHub)
    const params = new URLSearchParams(window.location.search)
    const err    = params.get('error')
    if (err) setFormError(decodeURIComponent(err))

    if (!token) return

    // Re-auth popup: send Quorum JWT back to opener and close
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(
          { type: 'QUORUM_OAUTH', token },
          window.location.origin,
        )
      } catch {
        // Opener navigated cross-origin — fall through to normal flow
      }
      window.close()
      return
    }

    // Clear fragment — tokens should not live in browser history
    window.history.replaceState(null, '', window.location.pathname)

    // Complete the OAuth flow — AuthContext handles scoped vs. pre-auth JWT
    setFormError(null)
    setDiscovering(true)
    completeOAuth(token).finally(() => setDiscovering(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — run once on mount

  // ── Navigate once phase changes ────────────────────────────────────────────
  useEffect(() => {
    if (authPhase === 'authenticated') navigate('/', { replace: true })
    if (authPhase === 'selecting')     navigate('/select-project', { replace: true })
  }, [authPhase, navigate])

  const displayError = formError ?? authError

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-sm space-y-6 px-4">

        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Quorum</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Persistent engineering memory</p>
        </div>

        {displayError && (
          <div
            role="alert"
            className="rounded-md bg-red-50 dark:bg-red-900/40 border border-red-300 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300"
          >
            {displayError}
          </div>
        )}

        {discovering ? (
          <div className="flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-4">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
            Finding your projects…
          </div>
        ) : (
          <a
            href="/auth/github"
            className="flex items-center justify-center gap-3 w-full rounded-md bg-gray-800 hover:bg-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-600 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-white transition-colors"
          >
            <GitHubIcon />
            Login with GitHub
          </a>
        )}

        <p className="text-center text-xs text-gray-400 dark:text-gray-600">
          Requires a GitHub account. Only <code className="text-gray-500 dark:text-gray-500">read:user</code> scope is requested.
        </p>

      </div>
    </div>
  )
}
