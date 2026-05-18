/**
 * @file SessionWarningBanner.jsx
 * @description Sticky warning banner that appears when the user's JWT is within
 * 5 minutes of expiry. Displays a live countdown and a "Renew session" button
 * that silently refreshes the token via `refresh()` from AuthContext.
 *
 * Lifecycle:
 * - Shows when: `token` is set, `reauthNeeded` is false, and remaining time
 *   is between 0 and 5 minutes (exclusive).
 * - Hides automatically once the token is renewed (remaining resets to ~60 min)
 *   or when `reauthNeeded` becomes true (at which point `SessionExpiredModal`
 *   takes over at z-50, above this banner's z-40).
 *
 * Complements `SessionExpiredModal` — the two components are mutually exclusive:
 * this banner handles the warning window; the modal handles post-expiry reauth.
 */

import { useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { decodeJwt } from '../../lib/utils.js'

/**
 * @constant {number} WARN_THRESHOLD_MS
 * @description Time window (in milliseconds) before expiry during which the
 * warning banner is shown. Default: 5 minutes.
 */
const WARN_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Formats a millisecond duration into a `m:ss` countdown string.
 *
 * @param {number} ms - Remaining milliseconds (clamped to 0 if negative).
 * @returns {string} Formatted string, e.g. `"4:59"` or `"0:30"`.
 */
function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * SessionWarningBanner — sticky amber banner warning the user that their
 * session is about to expire, with a live countdown and a one-click renew action.
 *
 * Renders `null` outside the 0–5 minute warning window or when `reauthNeeded`
 * is true (modal takes over at that point).
 *
 * @component
 * @returns {JSX.Element|null} The warning banner, or null when not applicable.
 *
 * @example
 * // Place near the top of the app layout, above page content but below nav:
 * <SessionWarningBanner />
 */
export default function SessionWarningBanner() {
  const { token, reauthNeeded, refresh } = useAuth()

  /** @type {[number, Function]} Milliseconds remaining until JWT expiry. */
  const [msRemaining, setMsRemaining] = useState(0)

  /** @type {[boolean, Function]} Whether a token renewal request is in-flight. */
  const [renewing, setRenewing] = useState(false)

  /** @type {[string|null, Function]} Inline error message from a failed renewal. */
  const [renewError, setRenewError] = useState(null)

  /**
   * Interval effect — recomputes `msRemaining` every second from the JWT `exp`
   * claim. Clears itself when the token expires or when `token`/`reauthNeeded`
   * changes (e.g. after a successful renewal).
   */
  useEffect(() => {
    if (!token || reauthNeeded) return

    /** @returns {number} Milliseconds remaining until the JWT expires. */
    const compute = () => (decodeJwt(token)?.exp ?? 0) * 1000 - Date.now()

    // Compute immediately so there is no 1-second blank on mount.
    setMsRemaining(compute())

    const id = setInterval(() => {
      const remaining = compute()
      setMsRemaining(remaining)
      if (remaining <= 0) clearInterval(id)
    }, 1000)

    return () => clearInterval(id)
  }, [token, reauthNeeded])

  /**
   * Attempts a silent token renewal via AuthContext `refresh()`.
   * Shows "Renewing…" while in-flight and displays an inline error on failure.
   * On success, the banner disappears automatically as `msRemaining` resets.
   *
   * @async
   * @returns {Promise<void>}
   */
  async function handleRenew() {
    setRenewing(true)
    setRenewError(null)
    try {
      await refresh()
    } catch (err) {
      setRenewError(err?.message ?? 'Renewal failed')
    } finally {
      setRenewing(false)
    }
  }

  // Only render within the 0–5 minute warning window, and never when the
  // expired modal is already showing.
  if (!token || reauthNeeded || msRemaining <= 0 || msRemaining > WARN_THRESHOLD_MS) {
    return null
  }

  return (
    <div
      className="sticky top-0 z-40 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/40 px-4 py-2 flex items-center justify-between gap-4"
      role="alert"
      aria-label="Session expiry warning"
    >
      {/* Left side — countdown message.
          role="alert" on the container fires once when the banner mounts, which is
          the correct AT behaviour. The countdown span uses aria-live="off" so
          screen readers are not re-interrupted every second as the timer ticks. */}
      <span className="text-sm text-amber-800 dark:text-amber-300 font-medium">
        ⚠ Session expires in{' '}
        <span aria-live="off">{formatCountdown(msRemaining)}</span>
      </span>

      {/* Right side — error + renew button */}
      <div className="flex items-center gap-3">
        {renewError && (
          <span className="text-xs text-red-600 dark:text-red-400" role="alert">
            {renewError}
          </span>
        )}

        <button
          type="button"
          onClick={handleRenew}
          disabled={renewing}
          className="text-sm font-medium px-3 py-1 rounded-md transition-colors bg-amber-100 hover:bg-amber-200 dark:bg-amber-800/40 dark:hover:bg-amber-700/40 text-amber-900 dark:text-amber-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {renewing ? 'Renewing…' : 'Renew session'}
        </button>
      </div>
    </div>
  )
}
