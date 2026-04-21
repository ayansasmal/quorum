import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

export default function Login() {
  const { login, error: authError } = useAuth()
  const navigate = useNavigate()

  const [githubToken, setGithubToken] = useState('')
  const [projectId,   setProjectId]   = useState('')
  const [loading,     setLoading]     = useState(false)
  const [formError,   setFormError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!githubToken.trim() || !projectId.trim()) {
      setFormError('Both fields are required.')
      return
    }
    setFormError(null)
    setLoading(true)
    try {
      await login(githubToken.trim(), projectId.trim())
      navigate('/', { replace: true })
    } catch (err) {
      setFormError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const displayError = formError ?? authError

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm space-y-6 px-4">

        {/* Logo / title */}
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-white">Quorum</h1>
          <p className="text-sm text-gray-400">Persistent engineering memory</p>
        </div>

        {/* Error banner */}
        {displayError && (
          <div className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
            {displayError}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="github-token" className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
              GitHub Personal Access Token
            </label>
            <input
              id="github-token"
              type="password"
              autoComplete="off"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder="ghp_..."
              className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="project-id" className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
              Project ID
            </label>
            <input
              id="project-id"
              type="text"
              autoComplete="off"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="platform-team"
              className="w-full rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-600">
          Token is stored in memory only — never persisted to disk.
        </p>
      </div>
    </div>
  )
}
