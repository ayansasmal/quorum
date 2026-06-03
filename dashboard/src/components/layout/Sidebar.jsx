/**
 * Sidebar — fixed left navigation panel.
 *
 * Active nav item uses `bg-gray-200 dark:bg-gray-800` to remain
 * visually distinct in both light and dark modes.
 */

import { NavLink } from 'react-router-dom'
import {
  BarChart2, GitBranch, Clock, BookOpen,
  List, Settings, Activity, LogOut, Shield, AlertTriangle, TrendingUp,
} from 'lucide-react'
import { cn }       from '../../lib/utils.js'
import { useAuth }  from '../../context/AuthContext.jsx'
import { useStats } from '../../api/stats.js'

const NAV = [
  { to: '/',          icon: BarChart2, label: 'Stats',     guestOk: true  },
  { to: '/graph',     icon: GitBranch, label: 'Graph',     guestOk: true  },
  { to: '/pending',    icon: List,          label: 'Pending',    badge: true    },
  { to: '/deviations', icon: AlertTriangle, label: 'Deviations'                 },
  { to: '/portfolio',  icon: TrendingUp,   label: 'Portfolio'                  },
  { to: '/knowledge', icon: BookOpen,  label: 'Knowledge', guestOk: true  },
  { to: '/audit',     icon: Clock,     label: 'Audit'                     },
  { to: '/config',    icon: Settings,  label: 'Config'                    },
  { to: '/status',    icon: Activity,  label: 'Status'                    },
]

export default function Sidebar() {
  const { logout, isGuest, user } = useAuth()
  const { data: stats } = useStats()
  const pendingCount = stats?.pending?.total ?? 0

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[var(--sidebar-width)] flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800">
      {/* Brand */}
      <div className="flex h-14 items-center px-5 border-b border-gray-200 dark:border-gray-800">
        <span className="text-sm font-semibold tracking-widest text-gray-900 dark:text-white uppercase">Quorum</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
        {NAV.filter((item) => !isGuest || item.guestOk).map(({ to, icon: Icon, label, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus:outline-none',
                isActive
                  ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200',
              )
            }
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1">{label}</span>
            {badge && pendingCount > 0 && (
              <span className="min-w-[20px] rounded-full bg-blue-600 px-1.5 py-0.5 text-center text-[10px] font-bold text-white leading-none">
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
          </NavLink>
        ))}

        {/* Admin link — platform admins only */}
        {user?.is_admin && (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus:outline-none',
                isActive
                  ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200',
              )
            }
          >
            <Shield className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1">Admin</span>
          </NavLink>
        )}
      </nav>

      {/* Logout */}
      <div className="border-t border-gray-200 dark:border-gray-800 p-2">
        <button
          onClick={logout}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-500 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800/60 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
