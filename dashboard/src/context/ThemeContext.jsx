/**
 * ThemeContext — light / dark mode persistence.
 *
 * Applies the `dark` class directly to `<html>` so Tailwind's `dark:`
 * variants cascade to every element including `<body>`.
 *
 * Preference is stored in `localStorage` under `quorum-theme`.
 * Default is 'dark' (preserves the existing look for returning users).
 *
 * Usage:
 *   const { theme, toggle } = useTheme()
 *   theme === 'dark' | 'light'
 *   toggle()  — flips and persists
 */

import { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext(null)

/**
 * ThemeProvider — wrap the app root to enable theme toggling.
 * @param {{ children: React.ReactNode }} props
 */
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(
    () => localStorage.getItem('quorum-theme') ?? 'dark',
  )

  // Sync `dark` class on <html> whenever theme changes
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    localStorage.setItem('quorum-theme', theme)
  }, [theme])

  /** Toggle between 'light' and 'dark'. */
  function toggle() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

/**
 * useTheme — access current theme and toggle function.
 * @returns {{ theme: 'light' | 'dark', toggle: () => void }}
 */
export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
