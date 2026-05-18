/**
 * Quorum Gateway — JWKS endpoint.
 *
 * GET /.well-known/jwks.json
 *   Returns the gateway's public key set in JWKS format.
 *   Local Quorum instances can verify JWTs locally without a round-trip to the
 *   gateway on every request — they fetch the JWKS once and cache it.
 *
 *   The kid field lets clients handle key rotation: a new key can be added to
 *   the JWKS before the old one is retired, with no service downtime.
 */

import { Router } from 'express'
import { getKeys } from '../keys.js'

const router = Router()

// GET /.well-known/jwks.json
router.get('/', (_req, res) => {
  const { jwks } = getKeys()
  res.set('Cache-Control', 'public, max-age=300') // 5-minute cache — safe since we rotate with kid
  res.json(jwks)
})

export default router
