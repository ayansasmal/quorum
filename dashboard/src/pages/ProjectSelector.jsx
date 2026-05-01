/**
 * ProjectSelector — Netflix-style project picker shown after GitHub OAuth
 * when the engineer belongs to more than one project.
 *
 * Flow:
 *   1. AuthContext.discoverProjects() fetches the project list and sets
 *      authPhase = 'selecting'.
 *   2. App.jsx routes to /select-project when authPhase === 'selecting'.
 *   3. User clicks a card → selectProject(slug) → AuthContext issues a
 *      project-scoped JWT → authPhase = 'authenticated' → App redirects to /.
 *
 * Project switching (already authenticated):
 *   switchProject() in the Header clears the JWT and sets authPhase = 'selecting',
 *   bringing the user back here. They pick a different card → switchTo(slug)
 *   issues a new JWT via POST /auth/switch (no GitHub re-auth needed).
 */

import { useState }    from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth }     from '../context/AuthContext.jsx'

// ── Color palette ──────────────────────────────────────────────────────────────

const CARD_ACCENTS = [
  { bg: 'from-violet-600 to-violet-800',  ring: 'ring-violet-500'  },
  { bg: 'from-blue-600   to-blue-800',    ring: 'ring-blue-500'    },
  { bg: 'from-emerald-600 to-emerald-800',ring: 'ring-emerald-500' },
  { bg: 'from-amber-500  to-amber-700',   ring: 'ring-amber-400'   },
  { bg: 'from-rose-600   to-rose-800',    ring: 'ring-rose-500'    },
  { bg: 'from-cyan-600   to-cyan-800',    ring: 'ring-cyan-500'    },
  { bg: 'from-pink-600   to-pink-800',    ring: 'ring-pink-500'    },
  { bg: 'from-teal-600   to-teal-800',    ring: 'ring-teal-500'    },
]

/**
 * Deterministically pick an accent based on the project slug.
 * Same slug always yields the same color across sessions and users.
 *
 * @param {string} slug
 * @returns {{ bg: string, ring: string }}
 */
function accentFor(slug) {
  let hash = 5381
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 33) ^ slug.charCodeAt(i)
  }
  return CARD_ACCENTS[Math.abs(hash) % CARD_ACCENTS.length]
}

// ── Role badge ─────────────────────────────────────────────────────────────────

const ROLE_STYLES = {
  principal_architect: 'bg-yellow-400/20 text-yellow-300 border-yellow-400/30',
  senior_engineer:     'bg-blue-400/20   text-blue-300   border-blue-400/30',
  engineer:            'bg-green-400/20  text-green-300  border-green-400/30',
  junior:              'bg-gray-400/20   text-gray-300   border-gray-400/30',
}

/**
 * @param {{ role: string | null }} props
 */
function RoleBadge({ role }) {
  if (!role) return null
  const label  = role.replace(/_/g, ' ')
  const styles = ROLE_STYLES[role] ?? 'bg-gray-400/20 text-gray-300 border-gray-400/30'
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}>
      {label}
    </span>
  )
}

// ── Project card ───────────────────────────────────────────────────────────────

/**
 * @param {{ project: object, onSelect: (slug: string) => void, loading: boolean }} props
 */
function ProjectCard({ project, onSelect, loading }) {
  const accent    = accentFor(project.slug)
  const initials  = project.name
    .split(/[\s-_]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => onSelect(project.slug)}
      className={`
        group relative flex flex-col overflow-hidden rounded-xl
        bg-gray-900 border border-gray-800
        ring-2 ring-transparent hover:ring-2 ${accent.ring}
        transition-all duration-200 hover:scale-[1.03] hover:shadow-xl hover:shadow-black/40
        disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100
        text-left w-full
      `}
    >
      {/* Coloured header band */}
      <div className={`h-24 w-full bg-gradient-to-br ${accent.bg} flex items-center justify-center`}>
        <span className="text-3xl font-bold text-white/90 tracking-tight select-none">
          {initials}
        </span>
      </div>

      {/* Card body */}
      <div className="flex flex-col gap-2 p-4">
        <p className="text-sm font-semibold text-white leading-snug truncate">
          {project.name}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          <RoleBadge role={project.role} />
          {project.team && (
            <span className="text-xs text-gray-500">{project.team}</span>
          )}
        </div>

        <p className="text-xs text-gray-600 mt-1">
          {project.member_count} member{project.member_count !== 1 ? 's' : ''}
        </p>
      </div>
    </button>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

/**
 * ProjectSelector — full-page project picker, dark background.
 *
 * Handles two entry points:
 *   - First login (authPhase = 'selecting', pendingOauthToken in memory)
 *     → calls selectProject(slug)
 *   - Project switch (authPhase = 'selecting', token still valid)
 *     → calls switchTo(slug)
 */
export default function ProjectSelector() {
  const { availableProjects, selectProject, switchTo, token, error, setError, logout } = useAuth()
  const navigate = useNavigate()

  const [loading,      setLoading]      = useState(false)
  const [selectingSlug, setSelectingSlug] = useState(null)

  /**
   * Handle card click — switches between selectProject and switchTo depending
   * on whether a JWT is already present (switching) or not (first login).
   * @param {string} slug
   */
  async function handleSelect(slug) {
    setError(null)
    setLoading(true)
    setSelectingSlug(slug)
    try {
      if (token) {
        // Already authenticated — switch project without re-OAuth
        await switchTo(slug)
      } else {
        // First login — use pending gho_ token
        await selectProject(slug)
      }
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setSelectingSlug(null)
    }
  }

  // Show a friendly message while projects are still loading
  if (!availableProjects.length) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <p className="text-sm text-gray-500">Loading projects…</p>
      </div>
    )
  }

  const columns = availableProjects.length <= 2
    ? 'grid-cols-1 sm:grid-cols-2'
    : availableProjects.length <= 4
      ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
      : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950 px-4 py-12">

      {/* Header */}
      <div className="mb-10 text-center space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-white">
          Who&apos;s working?
        </h1>
        <p className="text-sm text-gray-500">
          Select a project workspace to continue
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="mb-6 w-full max-w-2xl rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {/* Project grid */}
      <div className={`grid ${columns} gap-4 w-full max-w-4xl`}>
        {availableProjects.map((project) => (
          <ProjectCard
            key={project.id ?? project.slug}
            project={project}
            onSelect={handleSelect}
            loading={loading && selectingSlug !== project.slug}
          />
        ))}
      </div>

      {/* Sign out */}
      <button
        type="button"
        onClick={logout}
        className="mt-10 text-xs text-gray-600 hover:text-gray-400 transition-colors"
      >
        Sign out
      </button>
    </div>
  )
}
