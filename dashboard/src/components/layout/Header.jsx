/**
 * Header — sticky top bar with page title, user info, and theme toggle.
 *
 * The Sun/Moon icon button calls useTheme().toggle() to flip the `dark`
 * class on `<html>`, which activates all Tailwind `dark:` variants.
 */

import { Sun, Moon } from 'lucide-react'
import { useAuth }   from '../../context/AuthContext.jsx'
import { useTheme }  from '../../context/ThemeContext.jsx'

/**
 * @param {{ title: string }} props
 */
export default function Header({ title }) {
  const { user }         = useAuth()
  const { theme, toggle } = useTheme()

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

        {/* User info */}
        {user && (
          <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-500">
            <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-1 text-gray-700 dark:text-gray-300">
              {user.project}
            </span>
            <span>
              <span className="text-gray-600 dark:text-gray-400">{user.sub}</span>
              {user.role && (
                <span className="ml-1.5 text-gray-400 dark:text-gray-600">· {user.role.replace(/_/g, ' ')}</span>
              )}
            </span>
          </div>
        )}
      </div>
    </header>
  )
}
