import { useAuth } from '../../context/AuthContext.jsx'

export default function Header({ title }) {
  const { user } = useAuth()

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-gray-800 bg-gray-950/90 backdrop-blur-sm px-6">
      <h1 className="text-sm font-medium text-gray-200">{title}</h1>
      {user && (
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="rounded-full bg-gray-800 px-2.5 py-1 text-gray-300">
            {user.project}
          </span>
          <span>
            <span className="text-gray-400">{user.sub}</span>
            {user.role && (
              <span className="ml-1.5 text-gray-600">· {user.role.replace(/_/g, ' ')}</span>
            )}
          </span>
        </div>
      )}
    </header>
  )
}
