/**
 * Header — sticky top bar with page title, project switcher, user info, and theme toggle.
 *
 * The "Switch Project" button calls switchProject() from AuthContext, which clears
 * the current JWT and sets authPhase = 'selecting'. App.jsx's ProtectedRoute then
 * redirects to /select-project where the user picks a new workspace via switchTo().
 * No GitHub re-OAuth is needed for switching — POST /auth/switch handles it.
 */

import { ArrowLeftRight, Sun, Moon } from 'lucide-react'
import { useAuth }                   from '../../context/AuthContext.jsx'
import { useTheme }                  from '../../context/ThemeContext.jsx'

/**
 * @param {{ title: string }} props
 */
export default function Header({ title }) {
  const { user, availableProjects, selectedProject, currentProjectData, switchProject } = useAuth()
  const { theme, toggle } = useTheme()

  const canSwitch   = availableProjects.length > 1
  // Prefer display name from project metadata; fall back to group_id
  const projectLabel = currentProjectData?.name ?? selectedProject ?? user?.project ?? null

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-950/90 backdrop-blur-sm px-6">
      <h1 className="text-sm font-medium text-gray-800 dark:text-gray-200">{title}</h1>

      <div className="flex items-center gap-3">

        {/* Theme toggle */}
        <button
          onClick={toggle}
          data-testid="theme-toggle"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          {theme === 'dark'
            ? <Sun  className="h-4 w-4" />
            : <Moon className="h-4 w-4" />
          }
        </button>

        {/* User + project info */}
        {user && (
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-500">

            {/* Project badge — reads selectedProject so it survives refresh */}
            {projectLabel && (canSwitch ? (
              <button
                type="button"
                onClick={switchProject}
                title="Switch project"
                className="group flex items-center gap-1.5 rounded-full border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/60 px-2.5 py-1 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-colors font-medium"
              >
                {projectLabel}
                <ArrowLeftRight className="h-3 w-3 opacity-60 group-hover:opacity-100 transition-opacity" />
              </button>
            ) : (
              <span className="rounded-full border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/60 px-2.5 py-1 text-blue-700 dark:text-blue-300 font-medium">
                {projectLabel}
              </span>
            ))}

            {/* User identity */}
            <span>
              <span className="text-gray-600 dark:text-gray-400">{user.sub}</span>
              {user.role && (
                <span className="ml-1.5 text-gray-400 dark:text-gray-600">
                  · {user.role.replace(/_/g, ' ')}
                </span>
              )}
            </span>

          </div>
        )}
      </div>
    </header>
  )
}
