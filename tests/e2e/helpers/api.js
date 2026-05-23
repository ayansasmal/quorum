/**
 * E2E test HTTP client helpers.
 *
 * Every scenario makes HTTP calls that need Authorization and X-Quorum-Project
 * headers. This helper eliminates that boilerplate at every callsite.
 *
 * Usage:
 *   import { api, catalogApi, assertConstitutionalViolation } from '../helpers/api.js'
 *   import { tokens } from '../helpers/jwt.js'
 *
 *   const client = api(tokens.pe)
 *   const res = await client.post('/api/knowledge', { topic, key, content })
 */

import axios from 'axios'
import { expect } from '@playwright/test'

/** Gateway base URL — override via QUORUM_GATEWAY_URL env var. */
const BASE = process.env.QUORUM_GATEWAY_URL || 'http://localhost:3001'

/**
 * Returns a pre-configured axios instance for the given bearer token and project.
 *
 * validateStatus: () => true prevents axios from throwing on 4xx/5xx responses —
 * tests frequently assert on those status codes and need the response body.
 *
 * @param {string} bearerToken - Signed JWT for the test user
 * @param {string} [project='quorum-test-project'] - X-Quorum-Project header value
 * @returns {import('axios').AxiosInstance}
 */
export function api(bearerToken, project = 'quorum-test-project') {
  return axios.create({
    baseURL: BASE,
    headers: {
      Authorization:      `Bearer ${bearerToken}`,
      'X-Quorum-Project': project,
    },
    validateStatus: () => true,
  })
}

/**
 * Convenience: catalog-scoped client for federation scenarios (J01, S-02.x globals).
 *
 * @param {string} bearerToken
 * @param {string} [catalogId='quorum-test-catalog']
 * @returns {import('axios').AxiosInstance}
 */
export const catalogApi = (bearerToken, catalogId = 'quorum-test-catalog') =>
  api(bearerToken, catalogId)

/**
 * Asserts that a response is a constitutional violation for the given rule.
 *
 * Used wherever REASON_REQUIRED, NO_SELF_APPROVAL, GLOBAL_WRITE_AUTHORITY,
 * DEVIATION_ACTION_AUTHORITY, etc. fire. Saves repeating the same two-line
 * assertion across every constitutional callsite.
 *
 * Note: requires G-2 to be fixed (ConstitutionalViolation error handler in
 * gateway/src/server.js must return 400 + rule field).
 *
 * @param {import('axios').AxiosResponse} res
 * @param {string} rule - e.g. 'REASON_REQUIRED', 'NO_SELF_APPROVAL'
 */
export function assertConstitutionalViolation(res, rule) {
  expect(res.status).toBe(400)
  expect(res.data.rule).toBe(rule)
}
