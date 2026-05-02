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
 *
 * Search + pagination:
 *   - Search filters by project name or team (case-insensitive substring).
 *   - Page size is PAGE_SIZE (10). Pagination controls are hidden when all
 *     filtered results fit on one page; search is always visible.
 */

import { useState, useMemo } from 'react'
import { useNavigate }       from 'react-router-dom'
import { useAuth }           from '../context/AuthContext.jsx'

const PAGE_SIZE = 10

// ── Color palette ──────────────────────────────────────────────────────────────

const CARD_ACCENTS = [
  { bg: 'from-violet-600 to-violet-800',   ring: 'ring-violet-500'  },
  { bg: 'from-blue-600   to-blue-800',     ring: 'ring-blue-500'    },
  { bg: 'from-emerald-600 to-emerald-800', ring: 'ring-emerald-500' },
  { bg: 'from-amber-500  to-amber-700',    ring: 'ring-amber-400'   },
  { bg: 'from-rose-600   to-rose-800',     ring: 'ring-rose-500'    },
  { bg: 'from-cyan-600   to-cyan-800',     ring: 'ring-cyan-500'    },
  { bg: 'from-pink-600   to-pink-800',     ring: 'ring-pink-500'    },
  { bg: 'from-teal-600   to-teal-800',     ring: 'ring-teal-500'    },
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
  principal_architect: 'bg-yellow-400/20 text-yellow-700 dark:text-yellow-300 border-yellow-400/30',
  senior_engineer:     'bg-blue-400/20   text-blue-700   dark:text-blue-300   border-blue-400/30',
  engineer:            'bg-green-400/20  text-green-700  dark:text-green-300  border-green-400/30',
  junior:              'bg-gray-400/20   text-gray-600   dark:text-gray-300   border-gray-400/30',
}

/**
 * @param {{ role: string | null }} props
 */
function RoleBadge({ role }) {
  if (!role) return null
  const label  = role.replace(/_/g, ' ')
  const styles = ROLE_STYLES[role] ?? 'bg-gray-400/20 text-gray-600 dark:text-gray-300 border-gray-400/30'
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}>
      {label}
    </span>
  )
}

/**
 * Shown when the user has read-only guest access to a project.
 * Rendered instead of RoleBadge when project.is_guest === true.
 */
function GuestBadge() {
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-gray-400/20 text-gray-500 dark:text-gray-400 border-gray-400/30">
      guest
    </span>
  )
}

// ── Project card ───────────────────────────────────────────────────────────────

/**
 * @param {{ project: object, onSelect: (slug: string) => void, loading: boolean }} props
 */
function ProjectCard({ project, onSelect, loading }) {
  const accent   = accentFor(project.slug)
  const initials = project.name
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
        bg-white dark:bg-gray-900
        border border-gray-200 dark:border-gray-800
        ring-2 ring-transparent hover:ring-2 ${accent.ring}
        transition-all duration-200 hover:scale-[1.03] hover:shadow-xl hover:shadow-black/20 dark:hover:shadow-black/40
        disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100
        text-left w-full
      `}
    >
      {/* Coloured header band — intentionally vivid in both themes */}
      <div className={`h-24 w-full bg-gradient-to-br ${accent.bg} flex items-center justify-center`}>
        <span className="text-3xl font-bold text-white/90 tracking-tight select-none">
          {initials}
        </span>
      </div>

      {/* Card body */}
      <div className="flex flex-col gap-2 p-4">
        <p className="text-sm font-semibold text-gray-900 dark:text-white leading-snug truncate">
          {project.name}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          {project.is_guest ? <GuestBadge /> : <RoleBadge role={project.role} />}
          {!project.is_guest && project.team && (
            <span className="text-xs text-gray-500 dark:text-gray-500">{project.team}</span>
          )}
        </div>

        {project.member_count != null && (
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">
            {project.member_count} member{project.member_count !== 1 ? 's' : ''}
          </p>
        )}
      </div>
    </button>
  )
}

// ── Search bar ─────────────────────────────────────────────────────────────────

/**
 * @param {{ value: string, onChange: (v: string) => void, total: number, filtered: number }} props
 */
function SearchBar({ value, onChange, total, filtered }) {
  return (
    <div className="w-full max-w-4xl mb-6">
      <div className="relative">
        {/* Search icon */}
        <svg
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0Z" />
        </svg>

        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search by project name or team…"
          className="
            w-full rounded-lg
            border border-gray-300 dark:border-gray-700
            bg-white dark:bg-gray-900
            pl-9 pr-4 py-2.5 text-sm
            text-gray-900 dark:text-white
            placeholder-gray-400 dark:placeholder-gray-500
            focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
            transition-colors
          "
        />

        {/* Clear button */}
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            aria-label="Clear search"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Result count — only shown when filtering */}
      {value && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-500">
          {filtered === 0
            ? 'No projects match your search'
            : `${filtered} of ${total} project${total !== 1 ? 's' : ''}`}
        </p>
      )}
    </div>
  )
}

// ── Pagination ─────────────────────────────────────────────────────────────────

/**
 * @param {{ page: number, totalPages: number, onPrev: () => void, onNext: () => void }} props
 */
function Pagination({ page, totalPages, onPrev, onNext }) {
  return (
    <div className="mt-8 flex items-center gap-4">
      <button
        type="button"
        onClick={onPrev}
        disabled={page === 0}
        className="
          flex items-center gap-1.5 rounded-lg
          border border-gray-300 dark:border-gray-700
          bg-white dark:bg-gray-900
          px-3 py-1.5 text-xs
          text-gray-600 dark:text-gray-400
          hover:border-gray-400 dark:hover:border-gray-500
          hover:text-gray-900 dark:hover:text-white
          disabled:opacity-30 disabled:cursor-not-allowed
          transition-colors
        "
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Prev
      </button>

      <span className="text-xs text-gray-500 dark:text-gray-500 tabular-nums">
        Page {page + 1} of {totalPages}
      </span>

      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages - 1}
        className="
          flex items-center gap-1.5 rounded-lg
          border border-gray-300 dark:border-gray-700
          bg-white dark:bg-gray-900
          px-3 py-1.5 text-xs
          text-gray-600 dark:text-gray-400
          hover:border-gray-400 dark:hover:border-gray-500
          hover:text-gray-900 dark:hover:text-white
          disabled:opacity-30 disabled:cursor-not-allowed
          transition-colors
        "
      >
        Next
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

/**
 * ProjectSelector — full-page project picker.
 *
 * Handles two entry points:
 *   - First login (authPhase = 'selecting', pendingOauthToken in memory)
 *     → calls selectProject(slug)
 *   - Project switch (authPhase = 'selecting', token still valid)
 *     → calls switchTo(slug)
 */
export default function ProjectSelector() {
  const { availableProjects, selectProject, switchTo, cancelSwitch, token, error, setError, logout } = useAuth()
  const navigate = useNavigate()

  const [loading,       setLoading]       = useState(false)
  const [selectingSlug, setSelectingSlug] = useState(null)
  const [query,         setQuery]         = useState('')
  const [page,          setPage]          = useState(0)

  /**
   * Filter projects by name or team (case-insensitive substring match).
   * Resets to page 0 whenever the query changes.
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return availableProjects
    return availableProjects.filter((p) => {
      const nameMatch = p.name?.toLowerCase().includes(q)
      const teamMatch = p.team?.toLowerCase().includes(q)
      return nameMatch || teamMatch
    })
  }, [availableProjects, query])

  /** Reset page whenever the search query changes. */
  function handleQueryChange(value) {
    setQuery(value)
    setPage(0)
  }

  const totalPages     = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visiblePage    = Math.min(page, totalPages - 1)
  const pageProjects   = filtered.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE)
  const showPagination = filtered.length > PAGE_SIZE

  const columns = pageProjects.length <= 2
    ? 'grid-cols-1 sm:grid-cols-2'
    : pageProjects.length <= 4
      ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
      : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'

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
        await switchTo(slug)
      } else {
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <p className="text-sm text-gray-500">Loading projects…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-950 px-4 py-12">

      {/* Header */}
      <div className="mb-8 text-center space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          Who&apos;s working?
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Select a project workspace to continue
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="mb-6 w-full max-w-4xl rounded-md bg-red-50 dark:bg-red-900/40 border border-red-300 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Search */}
      <SearchBar
        value={query}
        onChange={handleQueryChange}
        total={availableProjects.length}
        filtered={filtered.length}
      />

      {/* Project grid or empty state */}
      {pageProjects.length > 0 ? (
        <div className={`grid ${columns} gap-4 w-full max-w-4xl`}>
          {pageProjects.map((project) => (
            <ProjectCard
              key={project.id ?? project.slug}
              project={project}
              onSelect={handleSelect}
              loading={loading && selectingSlug !== project.slug}
            />
          ))}
        </div>
      ) : (
        <div className="w-full max-w-4xl flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">No projects match &ldquo;{query}&rdquo;</p>
          <button
            type="button"
            onClick={() => handleQueryChange('')}
            className="mt-3 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-500 dark:hover:text-violet-300 transition-colors"
          >
            Clear search
          </button>
        </div>
      )}

      {/* Pagination — hidden when all results fit on one page */}
      {showPagination && (
        <Pagination
          page={visiblePage}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        />
      )}

      {/* Footer actions */}
      <div className="mt-10 flex items-center gap-6">
        {/* Cancel switch — only shown when switching (token still valid) */}
        {token && (
          <button
            type="button"
            onClick={cancelSwitch}
            className="text-xs text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            ← Back to current project
          </button>
        )}
        <button
          type="button"
          onClick={logout}
          className="text-xs text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
