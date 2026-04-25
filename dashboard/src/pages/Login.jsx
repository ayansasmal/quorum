/**
 * Login page — GitHub OAuth flow.
 *
 * Step 1: User clicks "Login with GitHub"
 *         → browser navigates to GET /auth/github
 *         → gateway redirects to github.com/login/oauth/authorize
 *
 * Step 2: GitHub redirects back to GET /auth/callback (Nginx → gateway)
 *         → gateway exchanges code for OAuth token
 *         → gateway redirects here with #oauth=<token>&project_id=<id>
 *
 * Step 3: This component reads the fragment, clears it from the URL,
 *         shows the project selector, and calls POST /auth/token to
 *         exchange the OAuth token for a Quorum JWT.
 */
import { useEffect, useState } from 'react'
import { useNavigate }         from 'react-router-dom'
import { useAuth }             from '../context/AuthContext.jsx'

export default function Login() {
  const { login, error: authError } = useAuth()
  const navigate                    = useNavigate()

  const [oauthToken,  setOauthToken]  = useState('')   // from URL fragment after OAuth
  const [projectId,   setProjectId]   = useState('')
  const [loading,     setLoading]     = useState(false)
  const [formError,   setFormError]   = useState(null)

  // ── Step 2: Read OAuth token from URL fragment ─────────────────────────────
  // The gateway redirects here with #oauth=<token>&project_id=<id>
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const oauth    = fragment.get('oauth')
    const project  = fragment.get('project_id')

    // Check for error passed as a query param (e.g. user denied access on GitHub)
    const params = new URLSearchParams(window.location.search)
    const err    = params.get('error')
    if (err) setFormError(err)

    if (oauth) {
      setOauthToken(oauth)
      if (project) setProjectId(project)
      // Clear the fragment — tokens should not live in the browser history
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [])

  // ── Step 3: Exchange OAuth token + project_id for Quorum JWT ──────────────
  async function handleSubmit(e) {
    e.preventDefault()
    if (!projectId.trim()) {
      setFormError('Project ID is required.')
      return
    }
    setFormError(null)
    setLoading(true)
    try {
      await login(oauthToken.trim(), projectId.trim())
      navigate('/', { replace: true })
    } catch (err) {
      setFormError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const displayError = formError ?? authError

  // ── Step 1: Not yet authenticated via GitHub ───────────────────────────────
  if (!oauthToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="w-full max-w-sm space-y-6 px-4">

          <div className="text-center space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Quorum</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Persistent engineering memory</p>
          </div>

          {displayError && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/40 border border-red-300 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {displayError}
            </div>
          )}

          <a
            href="/auth/github"
            className="flex items-center justify-center gap-3 w-full rounded-md bg-gray-800 hover:bg-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-600 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-white transition-colors"
          >
            {/* GitHub mark */}
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
            Login with GitHub
          </a>

          <p className="text-center text-xs text-gray-400 dark:text-gray-600">
            Requires a GitHub account. Only <code className="text-gray-500 dark:text-gray-500">read:user</code> scope is requested.
          </p>
        </div>
      </div>
    )
  }

  // ── Step 3: OAuth done — select project ────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-sm space-y-6 px-4">

        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Quorum</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">GitHub verified — select your project</p>
        </div>

        {displayError && (
          <div className="rounded-md bg-red-50 dark:bg-red-900/40 border border-red-300 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {displayError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="project-id" className="block text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wider">
              Project ID
            </label>
            <input
              id="project-id"
              type="text"
              autoComplete="off"
              autoFocus
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="platform-team"
              className="w-full rounded-md bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 dark:text-gray-500">
              The project ID from your <code>.quorum</code> file or S3 bucket prefix.
            </p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {loading ? 'Signing in…' : 'Continue'}
          </button>
        </form>

        <button
          onClick={() => { setOauthToken(''); setFormError(null) }}
          className="w-full text-center text-xs text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
        >
          ← Back to login
        </button>
      </div>
    </div>
  )
}
