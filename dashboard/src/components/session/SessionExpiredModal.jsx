/**
 * SessionExpiredModal — full-screen overlay shown when the Quorum JWT has expired.
 *
 * Flow:
 *   1. `reauthNeeded` becomes `true` in AuthContext (set by the expiry timer or
 *      the visibility-change handler in AuthContext).
 *   2. This component renders a semi-transparent backdrop + centred card.
 *   3. The user clicks "Sign in with GitHub" which opens
 *      `/auth/github?project_id=<current>` in a small popup window.
 *   4. The gateway completes the OAuth flow server-side and redirects the popup
 *      to `/login#token=<quorum_jwt>`. Login.jsx detects `window.opener`, sends
 *        `postMessage({ type: 'QUORUM_OAUTH', token }, origin)`
 *      back to this window, then calls `window.close()`.
 *   5. The `message` event listener receives the Quorum JWT, calls
 *      `completeReauth(jwt)` from AuthContext, which applies the JWT and clears
 *      `reauthNeeded`. If the JWT is a pre-auth variant (N-project user), AuthContext
 *      calls POST /auth/switch with the user's current project automatically.
 *   6. The modal unmounts — the user is back on the same page they were on.
 *
 * Error handling:
 *   - If `completeReauth` throws, an inline error banner is shown with a retry
 *     option (the user can click "Sign in with GitHub" again).
 *   - The "Sign out" button is always available and calls `logout()`.
 *
 * @module SessionExpiredModal
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'

/**
 * GitHubIcon — the GitHub mark SVG, reused from Login.jsx.
 *
 * @returns {JSX.Element}
 */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 flex-shrink-0">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
               0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
               -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
               .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
               -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
               .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
               .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
               0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/**
 * SessionExpiredModal — renders only when `reauthNeeded === true`.
 *
 * Reads `reauthNeeded`, `completeReauth`, and `logout` from `useAuth()`.
 * Returns `null` when `reauthNeeded` is false so there is zero DOM overhead
 * during normal operation.
 *
 * @returns {JSX.Element|null}
 */
export default function SessionExpiredModal() {
  const { reauthNeeded, completeReauth, logout, user } = useAuth()

  /** @type {[boolean, React.Dispatch<React.SetStateAction<boolean>>]} */
  const [loading, setLoading] = useState(false)

  /** @type {[string|null, React.Dispatch<React.SetStateAction<string|null>>]} */
  const [error, setError]     = useState(null)

  /**
   * Reference to the popup window opened by `openPopup`.
   * Stored so callers can focus the existing popup if the user clicks the
   * button a second time while it is still open.
   *
   * @type {React.MutableRefObject<Window|null>}
   */
  const popupRef = useRef(null)

  /**
   * Tracks whether the OAuth popup has sent a QUORUM_OAUTH postMessage back
   * to this window. Set to `true` inside `handleMessage` (the effect listener)
   * and reset to `false` each time `openPopup` is called.
   * Used by the popup-closed polling interval to distinguish "user dismissed
   * the popup" from "OAuth completed successfully".
   *
   * @type {React.MutableRefObject<boolean>}
   */
  const messageReceivedRef = useRef(false)

  /**
   * Ref to the dialog card `<div>` used for focus management.
   * Focus is moved into the dialog on mount and restored to the previously
   * focused element on unmount. Also used by the Tab-trap effect to query
   * focusable descendants.
   *
   * @type {React.MutableRefObject<HTMLDivElement|null>}
   */
  const dialogRef = useRef(null)

  /**
   * Open the GitHub OAuth flow in a small popup window.
   * - Guards against double-clicks: focuses the existing popup if still open.
   * - Starts the loading spinner immediately (before the message arrives).
   * - Polls for popup closure so loading resets if the user dismisses without
   *   completing auth.
   */
  const openPopup = useCallback(() => {
    // If the popup is still open, focus it instead of opening a new one
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus()
      return
    }

    messageReceivedRef.current = false
    setLoading(true)
    setError(null)
    // Pass the current project so the gateway can issue a scoped JWT directly
    // when the user has only 1 project (avoids a round-trip POST /auth/switch).
    const qs = user?.project ? `?project_id=${encodeURIComponent(user.project)}` : ''
    popupRef.current = window.open(
      `/auth/github${qs}`,
      'quorum_reauth',
      'width=520,height=620,left=200,top=100',
    )

    // Poll for popup closure so we can reset loading if the user dismisses without auth
    const timer = setInterval(() => {
      if (popupRef.current?.closed) {
        clearInterval(timer)
        if (!messageReceivedRef.current) {
          // Popup closed before message arrived — reset loading so button is usable
          setLoading(false)
          setError('Sign-in window was closed. Please try again.')
        }
      }
    }, 500)
  }, [])

  // ── postMessage listener ────────────────────────────────────────────────────
  useEffect(() => {
    if (!reauthNeeded) return
    let active = true

    /**
     * Handle an incoming message from the OAuth popup.
     * Validates origin and message type before calling `completeReauth`.
     * Guards `setError` / `setLoading` with the `active` flag to prevent
     * state updates after the component has unmounted (which happens when
     * `completeReauth` succeeds and clears `reauthNeeded`).
     *
     * @param {MessageEvent} event
     */
    function handleMessage(event) {
      if (event.origin !== window.location.origin) return
      if (event.data?.type !== 'QUORUM_OAUTH') return
      const { token } = event.data
      if (!token) return

      messageReceivedRef.current = true   // mark message received before async work
      completeReauth(token)
        .catch((err) => { if (active) setError(err.message ?? 'Re-authentication failed') })
        .finally(() => { if (active) setLoading(false) })
    }

    window.addEventListener('message', handleMessage)
    return () => {
      active = false
      window.removeEventListener('message', handleMessage)
    }
  }, [reauthNeeded, completeReauth])

  // ── Focus trap ──────────────────────────────────────────────────────────────
  // Focus management: move focus into the dialog when it mounts, restore on unmount.
  // Also traps Tab/Shift+Tab within the dialog's focusable elements.
  useEffect(() => {
    if (!reauthNeeded) return
    const previouslyFocused = document.activeElement

    // Focusable elements selector
    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

    /**
     * Returns all currently focusable, non-disabled elements within the dialog.
     *
     * @returns {HTMLElement[]}
     */
    function getFocusable() {
      return dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll(FOCUSABLE)).filter(
            (el) => !el.disabled,
          )
        : []
    }

    // Move focus into the dialog
    const focusable = getFocusable()
    if (focusable.length) focusable[0].focus()

    /**
     * Trap Tab / Shift+Tab within the dialog's focusable elements.
     *
     * @param {KeyboardEvent} e
     */
    function handleKeyDown(e) {
      if (e.key !== 'Tab') return
      const elements = getFocusable()
      if (!elements.length) return
      const first = elements[0]
      const last  = elements[elements.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [reauthNeeded])

  // Nothing to show while the session is valid
  if (!reauthNeeded) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-8 w-full max-w-sm mx-4 space-y-5"
      >

        {/* ── Title ─────────────────────────────────────────────────────────── */}
        <h2
          id="session-expired-title"
          className="text-lg font-semibold text-gray-900 dark:text-white"
        >
          Session expired
        </h2>

        {/* ── Body ──────────────────────────────────────────────────────────── */}
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Your session has timed out. Sign in with GitHub to continue where you left off.
        </p>

        {/* ── Error banner ─────────────────────────────────────────────────── */}
        {error && (
          <div
            role="alert"
            className="rounded-md bg-red-50 dark:bg-red-900/40 border border-red-300 dark:border-red-700 px-4 py-3 text-sm text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {/* ── Actions ───────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">

          {/* Primary: Sign in with GitHub */}
          <button
            type="button"
            onClick={openPopup}
            disabled={loading}
            className="flex items-center justify-center gap-3 w-full rounded-md bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 text-sm font-medium text-white transition-colors"
          >
            {loading ? (
              'Signing in\u2026'
            ) : (
              <>
                <GitHubIcon />
                Sign in with GitHub
              </>
            )}
          </button>

          {/* Secondary: Sign out — always enabled */}
          <button
            type="button"
            onClick={logout}
            className="w-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors py-1"
          >
            Sign out
          </button>

        </div>
      </div>
    </div>
  )
}
