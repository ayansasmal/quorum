import { confidenceBg, fmtConfidence } from '../../lib/utils.js'

/**
 * Thin horizontal progress bar showing a confidence score.
 * @param {{ value: number, showLabel?: boolean, className?: string }} props
 */
export default function ConfidenceBar({ value, showLabel = false, className = '' }) {
  const pct = Math.round((value ?? 0) * 100)
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-1.5 flex-1 rounded-full bg-gray-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${confidenceBg(value)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className="w-9 text-right text-xs tabular-nums text-gray-400">
          {fmtConfidence(value)}
        </span>
      )}
    </div>
  )
}
