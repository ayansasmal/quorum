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
  const { user, availableProjects, switchProject } = useAuth()
  const { theme, toggle }                          = useTheme()

  // Only show the switcher if the user belongs to more than one project
  const canSwitch = availableProjects.length > 1

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-950/90 backdrop-blur-sm px-6">
      <h1 className="text-sm font-medium text-gray-800 dark:text-gray-200">{title}</h1>

      <div className="flex items-center gap-3">

        {/* Theme toggle */}
        <button
          onClick={toggle}
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

            {/* Project badge — doubles as the switch trigger when multi-project */}
            {canSwitch ? (
              <button
                type="button"
                onClick={switchProject}
                title="Switch project"
                className="group flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                {user.project}
                <ArrowLeftRight className="h-3 w-3 text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors" />
              </button>
            ) : (
              <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-gray-700 dark:text-gray-300">
                {user.project}
              </span>
            )}

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
