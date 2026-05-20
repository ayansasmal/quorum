import { useState } from 'react'
import { useGraph } from '../api/graph.js'
import { useStats } from '../api/stats.js'
import GraphControls from '../components/graph/GraphControls.jsx'
import KnowledgeGraph from '../components/graph/KnowledgeGraph.jsx'

export default function Graph() {
  const [domain, setDomain] = useState('')

  const { data, isLoading, error } = useGraph(domain || undefined)
  const { data: statsData } = useStats()
  const domains = (statsData?.domains ?? []).map((d) => d.domain)

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-7rem)]">
      <GraphControls domain={domain} onDomainChange={setDomain} domains={domains} />

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-gray-600 text-sm">
          Loading graph…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">
          {error.status === 400
            ? `Graph too large — select a domain to filter. (${error.body?.message ?? error.message})`
            : error.message}
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <KnowledgeGraph elements={data} />
        </div>
      )}

      {/* Legend */}
      {data && (
        <div className="flex flex-wrap gap-4 text-[11px] text-gray-500">
          {[
            { label: 'Decision',    color: 'bg-blue-500'   },
            { label: 'Pattern',     color: 'bg-green-500'  },
            { label: 'Constraint',  color: 'bg-amber-500'  },
            { label: 'Runbook',     color: 'bg-purple-500' },
            { label: 'Requirement', color: 'bg-gray-500'   },
          ].map(({ label, color }) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${color}`} />
              {label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-blue-500" />
            BELONGS TO
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 border-dashed border-t-2 border-green-500" />
            SHARED TAG
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 border-dashed border-t-2 border-amber-500" />
            SUPERSEDES
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-red-500" />
            CONFLICTS
          </span>
        </div>
      )}
    </div>
  )
}
