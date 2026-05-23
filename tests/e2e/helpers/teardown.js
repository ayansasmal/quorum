/**
 * Playwright globalTeardown — no-op.
 *
 * Quorum E2E tests do not require explicit cleanup because:
 *
 *   1. All knowledge writes use uid() keys — each run produces unique keys that
 *      never collide with previous or parallel runs. No state isolation via
 *      deletion is needed.
 *
 *   2. The constitutional no-hard-delete rule means API teardown is impossible
 *      even if we wanted it — BLOCKED_METHODS enforces this at the client layer.
 *
 *   3. S-01 creates fresh timestamp-suffixed project configs (`j01-catalog-${ts}`)
 *      so POST /config/upload always returns 201. Leftover configs in DDB from
 *      prior runs do not interfere.
 *
 * If future scenarios require state reset (e.g. clearing deviation records for a
 * specific project), add it here as a targeted gateway API call — never via
 * direct DB access, which would bypass the constitutional audit chain.
 *
 * @param {import('@playwright/test').FullConfig} _config
 */
export default async function teardown(_config) {
  // No-op — uid() isolation is stateless; no cleanup required.
  console.log('[teardown] Suite complete. No cleanup required — uid() key isolation in effect.')
}
