import { useState } from 'react'
import { TrendingUp } from 'lucide-react'
import { useBump } from '../../api/bump.js'
import { fmtDate } from '../../lib/utils.js'

/**
 * Role-weighted endorsement button with 7-day cooldown.
 * On success: shows "Bumped — next available [date]" and optimistically disables.
 */
export default function BumpButton({ topic, key: key_, lastBumpDate }) {
  const bump  = useBump()
  const [result, setResult]   = useState(null)
  const [bumpErr, setBumpErr] = useState(null)

  // Cooldown already active before any client-side bump
  const cooldownUntil = lastBumpDate
    ? new Date(new Date(lastBumpDate).getTime() + 7 * 24 * 3600 * 1000)
    : null
  const inCooldown = cooldownUntil && cooldownUntil > new Date()

  // After a successful bump this session
  const nextAllowed = result?.next_bump_allowed ? new Date(result.next_bump_allowed) : null

  const disabled  = bump.isPending || !!nextAllowed || inCooldown

  async function handleBump() {
    setBumpErr(null)
    try {
      const res = await bump.mutateAsync({ topic, key: key_ })
      setResult(res)
    } catch (err) {
      setBumpErr(err.status === 429 ? 'Cooldown active' : err.message)
    }
  }

  if (nextAllowed || inCooldown) {
    const until = nextAllowed ?? cooldownUntil
    return (
      <span className="text-[10px] text-gray-600 whitespace-nowrap">
        Bumped · next {fmtDate(until)}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleBump}
        disabled={disabled}
        title={`Bump confidence for ${topic}:${key_}`}
        className="inline-flex items-center gap-1 rounded border border-gray-300 dark:border-gray-700 hover:border-blue-600 px-2 py-0.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:text-blue-400 transition-colors disabled:opacity-40"
      >
        <TrendingUp className="h-3 w-3" />
        Bump
      </button>
      {bumpErr && <span className="text-[10px] text-red-400">{bumpErr}</span>}
    </div>
  )
}
