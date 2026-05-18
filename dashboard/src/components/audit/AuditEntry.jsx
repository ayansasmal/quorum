import { fmtDate } from '../../lib/utils.js'

const TOOL_COLOR = {
  remember:   'text-blue-400',
  recall:     'text-green-400',
  search:     'text-cyan-400',
  review:     'text-amber-400',
  forget:     'text-red-400',
  reflect:    'text-purple-400',
  bump:       'text-teal-400',
}

/** Format a versions_created/superseded item — handles both string and object shapes. */
function fmtVersionItem(item) {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') {
    const parts = [item.version != null ? `v${item.version}` : null, item.status ?? null]
    return parts.filter(Boolean).join(' ')
  }
  return String(item)
}

export default function AuditEntry({ entry }) {
  const toolColor = TOOL_COLOR[entry.tool] ?? 'text-gray-400'
  const impact    = entry.version_impact ?? {}

  return (
    <div className="flex gap-3 py-3 border-b border-gray-200/50 dark:border-gray-800/50 last:border-0 group">
      {/* Timeline dot */}
      <div className="flex flex-col items-center pt-0.5">
        <span className="h-2 w-2 rounded-full bg-gray-200 dark:bg-gray-700 group-hover:bg-blue-600 transition-colors flex-shrink-0" />
        <span className="flex-1 w-px bg-gray-200/50 dark:bg-gray-800/50" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-0.5 pb-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`text-xs font-medium ${toolColor}`}>{entry.tool}</span>
          <span className="text-[10px] text-gray-600">{entry.operation}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{entry.author}</span>
          {entry.author_role && (
            <span className="text-[10px] text-gray-600">· {entry.author_role.replace(/_/g, ' ')}</span>
          )}
          <span className="ml-auto text-[10px] text-gray-600 flex-shrink-0">{fmtDate(entry.timestamp)}</span>
        </div>

        {/* Governance context */}
        {entry.governance_json?.topic && (
          <p className="text-xs text-gray-500 font-mono">
            {entry.governance_json.topic}:{entry.governance_json.key}
          </p>
        )}

        {/* Version impact */}
        {impact.versions_created?.length > 0 && (
          <p className="text-[10px] text-green-600">
            Created: {impact.versions_created.map(fmtVersionItem).join(', ')}
          </p>
        )}
        {impact.versions_superseded?.length > 0 && (
          <p className="text-[10px] text-gray-600">
            Superseded: {impact.versions_superseded.map(fmtVersionItem).join(', ')}
          </p>
        )}
      </div>
    </div>
  )
}
