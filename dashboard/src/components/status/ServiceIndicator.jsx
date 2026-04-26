import { cn } from '../../lib/utils.js'

/**
 * Single service health row.
 *
 * @param {{ name: string, status: string | boolean | undefined, detail?: string }} props
 *   status: 'connected' | 'healthy' | true → green
 *           'unavailable' | false           → red
 *           anything else (null/undefined)  → gray (loading/unknown)
 */
export default function ServiceIndicator({ name, status, detail }) {
  const isUp      = status === 'connected' || status === 'healthy' || status === true
  const isDown    = status === 'unavailable' || status === false
  const isUnknown = !isUp && !isDown

  const badgeClass = isUp
    ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border border-green-300 dark:border-green-800'
    : isDown
      ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 border border-red-300 dark:border-red-800'
      : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-700'

  const dotClass = isUp
    ? 'bg-green-500 dark:bg-green-400'
    : isDown
      ? 'bg-red-500 dark:bg-red-400'
      : 'bg-gray-400 dark:bg-gray-500'

  const label = isUp ? 'Healthy' : isDown ? 'Unavailable' : 'Checking…'

  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-200 dark:border-gray-800 last:border-0">
      <span className="text-sm text-gray-600 dark:text-gray-300">{name}</span>
      <div className="flex items-center gap-2">
        {detail && <span className="text-xs text-gray-500">{detail}</span>}
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', badgeClass)}>
          <span className={cn('h-1.5 w-1.5 rounded-full', dotClass, isUnknown && 'animate-pulse')} />
          {label}
        </span>
      </div>
    </div>
  )
}
