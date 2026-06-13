/**
 * Unit tests for the public-project write-membership guard.
 */

import { describe, expect, it, vi } from 'vitest'
import { requireMembership } from '../../gateway/src/middleware/require-membership.js'

/**
 * Create the minimal Express response surface used by the middleware.
 * @returns {{ statusCode: number, body: object | null, status: Function, json: Function }}
 */
function mockResponse() {
  return {
    statusCode: 200,
    body:       null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

describe('requireMembership', () => {
  it('allows read-only methods for a non-member', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      /** @type {object} */
      const request = { method, user: { role: null, is_admin: false } }
      /** @type {ReturnType<typeof mockResponse>} */
      const response = mockResponse()
      /** @type {ReturnType<typeof vi.fn>} */
      const next = vi.fn()

      requireMembership(request, response, next)

      expect(next).toHaveBeenCalledOnce()
      expect(response.statusCode).toBe(200)
    }
  })

  it('rejects mutating methods for a non-member', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      /** @type {object} */
      const request = { method, user: { role: null, is_admin: false } }
      /** @type {ReturnType<typeof mockResponse>} */
      const response = mockResponse()
      /** @type {ReturnType<typeof vi.fn>} */
      const next = vi.fn()

      requireMembership(request, response, next)

      expect(next).not.toHaveBeenCalled()
      expect(response.statusCode).toBe(403)
      expect(response.body.error).toBe('not_a_member')
    }
  })

  it('allows writes from a project member', () => {
    /** @type {object} */
    const request = { method: 'POST', user: { role: 'engineer', is_admin: false } }
    /** @type {ReturnType<typeof mockResponse>} */
    const response = mockResponse()
    /** @type {ReturnType<typeof vi.fn>} */
    const next = vi.fn()

    requireMembership(request, response, next)

    expect(next).toHaveBeenCalledOnce()
  })

  it('allows writes from a platform admin without a project role', () => {
    /** @type {object} */
    const request = { method: 'POST', user: { role: null, is_admin: true } }
    /** @type {ReturnType<typeof mockResponse>} */
    const response = mockResponse()
    /** @type {ReturnType<typeof vi.fn>} */
    const next = vi.fn()

    requireMembership(request, response, next)

    expect(next).toHaveBeenCalledOnce()
  })
})
