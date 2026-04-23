import { useState } from 'react'
import { ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react'
import ConflictDiff from './ConflictDiff.jsx'
import ReviewForm from './ReviewForm.jsx'
import { fmtAge } from '../../lib/utils.js'

export default function DecisionCard({ decision }) {
  const [expanded,     setExpanded]     = useState(false)
  const [showReview,   setShowReview]   = useState(false)

  const ageHours = (Date.now() - new Date(decision.created_at).getTime()) / 3_600_000
  const isStale  = !!decision.stale_warning

  return (
    <div className={`rounded-lg border ${isStale ? 'border-amber-800/50' : 'border-gray-800'} bg-gray-900 overflow-hidden`}>

      {/* Card header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-800/40 select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          {isStale && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />}
          <span className="text-sm font-mono text-blue-400 truncate">
            {decision.conflict_topic}:{decision.conflict_key}
          </span>
          <span className="text-xs text-gray-600 flex-shrink-0">{fmtAge(ageHours)} ago</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-gray-600 capitalize">{decision.decision_type?.replace('_', ' ')}</span>
          {expanded ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-4 space-y-4">

          {/* Stale warning */}
          {isStale && (
            <div className="rounded-md bg-amber-900/20 border border-amber-800/50 px-3 py-2 text-xs text-amber-400">
              <strong>Stale warning:</strong> {decision.stale_warning}
            </div>
          )}

          {/* Conflict reason */}
          {decision.conflict_reason && (
            <p className="text-xs text-gray-500">
              <span className="text-gray-400 font-medium">Conflict reason: </span>
              {decision.conflict_reason}
            </p>
          )}

          {/* Side-by-side diff */}
          <ConflictDiff existing={decision.existing_content} incoming={decision.incoming_content} />

          {/* LLM enrichment */}
          {decision.enrichment?.analysis && (
            <div className="rounded-md bg-gray-800/50 border border-gray-700 px-3 py-2 space-y-1">
              <p className="text-xs font-medium text-gray-400">AI analysis</p>
              <p className="text-xs text-gray-400 leading-relaxed">{decision.enrichment.analysis}</p>
              {decision.enrichment.possible_split && (
                <p className="text-xs text-blue-400 mt-1">Split suggestion: {decision.enrichment.split_suggestion}</p>
              )}
            </div>
          )}

          {/* Review form */}
          {!showReview ? (
            <button
              onClick={() => setShowReview(true)}
              className="rounded-md bg-gray-800 hover:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-200 transition-colors"
            >
              Review this decision
            </button>
          ) : (
            <ReviewForm
              decision={decision}
              draftAuthor={decision.incoming_author}
              onClose={() => setShowReview(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
