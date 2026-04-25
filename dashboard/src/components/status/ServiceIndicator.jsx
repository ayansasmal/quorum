import { cn } from '../../lib/utils.js'

/** Single service health row. */
export default function ServiceIndicator({ name, status, detail }) {
  const isUp = status === 'connected' || status === 'healthy' || status === true
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-200 dark:border-gray-800 last:border-0">
      <span className="text-sm text-gray-600 dark:text-gray-300">{name}</span>
      <div className="flex items-center gap-2">
        {detail && <span className="text-xs text-gray-500">{detail}</span>}
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
            isUp
              ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border border-green-300 dark:border-green-800'
              : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 border border-red-300 dark:border-red-800',
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', isUp ? 'bg-green-500 dark:bg-green-400' : 'bg-red-500 dark:bg-red-400')} />
          {isUp ? 'Healthy' : 'Unavailable'}
        </span>
      </div>
    </div>
  )
}
