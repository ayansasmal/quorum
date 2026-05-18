/**
 * Gateway: GET /.well-known/jwks.json
 *
 * Verifies the public JWKS endpoint returns a well-formed ES256 key set with
 * the expected cache header.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import express from 'express'

import { loadKeys }    from '../../gateway/src/keys.js'
import jwksRoutes      from '../../gateway/src/routes/jwks.js'

/** @type {http.Server} */
let server
/** @type {number} */
let port

const app = express()
app.use('/.well-known', jwksRoutes)

beforeAll(async () => {
  await loadKeys()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(() => {
  server.close()
})

/**
 * GET helper using Node http module.
 * @param {string} path
 * @returns {Promise<{ status: number, body: object | string, headers: http.IncomingHttpHeaders }>}
 */
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }) }
        catch { resolve({ status: res.statusCode, body: raw,             headers: res.headers }) }
      })
    }).on('error', reject)
  })
}

describe('GET /.well-known/jwks.json', () => {
  it('returns 200 with a keys array', async () => {
    const { status, body } = await get('/.well-known/')

    expect(status).toBe(200)
    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys.length).toBeGreaterThan(0)
  })

  it('each key contains the required JWK fields for ES256', async () => {
    const { body } = await get('/.well-known/')

    for (const key of body.keys) {
      expect(key.kty).toBeDefined()
      expect(key.crv).toBeDefined()
      expect(key.kid).toBeDefined()
      expect(key.x).toBeDefined()
      expect(key.y).toBeDefined()
      expect(key.use).toBeDefined()
      expect(key.alg).toBeDefined()
    }
  })

  it('alg is ES256', async () => {
    const { body } = await get('/.well-known/')
    for (const key of body.keys) {
      expect(key.alg).toBe('ES256')
    }
  })

  it('use is sig', async () => {
    const { body } = await get('/.well-known/')
    for (const key of body.keys) {
      expect(key.use).toBe('sig')
    }
  })

  it('sets Cache-Control: public, max-age=300', async () => {
    const { headers } = await get('/.well-known/')
    expect(headers['cache-control']).toBe('public, max-age=300')
  })
})
