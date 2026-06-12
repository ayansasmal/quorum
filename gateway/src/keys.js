/**
 * Quorum Gateway — Key management for ES256 JWT signing.
 *
 * Keys are loaded from environment variables (base64-encoded PEM).
 * In development (NODE_ENV !== 'production'), a fresh ephemeral key pair is
 * generated if env vars are absent — useful for local testing without setup.
 *
 * In production, QUORUM_JWT_PRIVATE_KEY and QUORUM_JWT_PUBLIC_KEY MUST be set.
 * Generate a key pair once and store securely (AWS Secrets Manager, Vault, etc.):
 *
 *   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out private.pem
 *   openssl pkey -in private.pem -pubout -out public.pem
 *   # Base64-encode for env vars:
 *   base64 -i private.pem   → QUORUM_JWT_PRIVATE_KEY
 *   base64 -i public.pem    → QUORUM_JWT_PUBLIC_KEY
 *
 * The kid (key ID) is a stable SHA256 fingerprint of the public key JWK.
 * It lets clients cache public keys from /.well-known/jwks.json and rotate
 * without service restarts — just add new key to JWKS before retiring old one.
 */

import { createHash } from 'node:crypto'
import {
  generateKeyPair,
  importPKCS8,
  importSPKI,
  exportJWK,
} from 'jose'

/** @type {{ privateKey: import('jose').KeyLike, publicKey: import('jose').KeyLike, kid: string, jwks: object } | null} */
let _keys = null

/**
 * Load or generate the EC P-256 key pair used for ES256 JWT signing.
 * Called once at gateway startup; result is cached for the process lifetime.
 * @returns {Promise<{ privateKey: import('jose').KeyLike, publicKey: import('jose').KeyLike, kid: string, jwks: object }>}
 */
export async function loadKeys() {
  if (_keys) return _keys

  const privateKeyB64 = process.env.QUORUM_JWT_PRIVATE_KEY
  const publicKeyB64 = process.env.QUORUM_JWT_PUBLIC_KEY

  let privateKey, publicKey

  if (privateKeyB64 && publicKeyB64) {
    // Production: load from env vars (base64-encoded PKCS8/SPKI PEM)
    const privatePem = Buffer.from(privateKeyB64, 'base64').toString('utf8')
    const publicPem  = Buffer.from(publicKeyB64, 'base64').toString('utf8')
    privateKey = await importPKCS8(privatePem, 'ES256')
    publicKey  = await importSPKI(publicPem, 'ES256')
    console.error('[Gateway] Loaded ES256 key pair from environment variables')
  } else if (process.env.NODE_ENV !== 'production') {
    // Development: generate an ephemeral key pair — NOT for production use
    ;({ privateKey, publicKey } = await generateKeyPair('ES256'))
    console.error('[Gateway] WARNING: Generated ephemeral ES256 key pair (development only)')
    console.error('[Gateway] Set QUORUM_JWT_PRIVATE_KEY + QUORUM_JWT_PUBLIC_KEY for production')
  } else {
    throw new Error(
      'QUORUM_JWT_PRIVATE_KEY and QUORUM_JWT_PUBLIC_KEY must be set in production. ' +
      'See src/gateway/keys.js for key generation instructions.',
    )
  }

  const jwk = await exportJWK(publicKey)
  // kid: stable fingerprint of the public key — clients use this to look up the right key
  const kid = createHash('sha256')
    .update(JSON.stringify(jwk))
    .digest('hex')
    .slice(0, 16)

  const jwks = {
    keys: [
      {
        ...jwk,
        kid,
        use: 'sig',
        alg: 'ES256',
      },
    ],
  }

  _keys = { privateKey, publicKey, kid, jwks }
  return _keys
}

/**
 * Return the cached key set. Throws if loadKeys() has not been called yet.
 * @returns {{ privateKey: import('jose').KeyLike, publicKey: import('jose').KeyLike, kid: string, jwks: object }}
 */
export function getKeys() {
  if (!_keys) throw new Error('Keys not loaded — call loadKeys() at gateway startup')
  return _keys
}

/** Reset cached keys (for testing). */
export function _resetKeys() {
  _keys = null
}
