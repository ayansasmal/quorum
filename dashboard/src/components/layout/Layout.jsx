import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import Header from './Header.jsx'
import SessionWarningBanner from '../session/SessionWarningBanner.jsx'

const PAGE_TITLES = {
  '/':          'Stats',
  '/graph':     'Knowledge Graph',
  '/pending':   'Pending Decisions',
  '/knowledge': 'Knowledge Browser',
  '/audit':     'Audit Timeline',
  '/config':    'Config Editor',
  '/status':    'System Status',
}

export default function Layout({ children }) {
  const { pathname } = useLocation()
  const title = PAGE_TITLES[pathname] ?? 'Quorum'

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-950">
      <Sidebar />
      <div className="flex flex-1 flex-col pl-[var(--sidebar-width)]">
        <Header title={title} />
        <SessionWarningBanner />
        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
