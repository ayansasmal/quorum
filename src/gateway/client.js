/**
 * Quorum Gateway Client — used by the local Quorum MCP server.
 *
 * When QUORUM_GATEWAY_URL is set, the local Quorum replaces direct PostgreSQL
 * and Graphiti connections with this client. All operations are forwarded to
 * the gateway via HTTP using a short-lived ES256 JWT.
 *
 * The JWT is obtained at startup by exchanging QUORUM_GITHUB_TOKEN at
 * POST /auth/token. It is automatically refreshed when it expires.
 *
 * Tool handlers receive a `pg`-compatible interface: they call query() and
 * the client transparently routes to the gateway's /pg/* REST API.
 * The original pg.Pool is never created when gateway mode is active.
 */

const REFRESH_BUFFER_S = 60 // Refresh JWT 60s before expiry

/**
 * @typedef {Object} GatewayToken
 * @property {string} token - Raw JWT
 * @property {number} expiresAt - Unix timestamp (ms) when the token expires
 * @property {string} sub - GitHub login
 * @property {string} project - Project ID
 * @property {string | null} role
 * @property {string | null} team
 * @property {number} base_confidence
 */

/**
 * Lightweight HTTP client that wraps the Quorum Gateway REST API.
 * Implements a subset of the pg.Pool interface so it can be passed to all
 * existing tool handlers without modification.
 */
export class GatewayClient {
  /**
   * @param {string} gatewayUrl - Base URL of the Quorum Gateway
   * @param {string} githubToken - Engineer's GitHub PAT
   * @param {string} projectId - Project to authenticate against
   */
  constructor(gatewayUrl, githubToken, projectId) {
    this._gatewayUrl  = gatewayUrl.replace(/\/$/, '')
    this._githubToken = githubToken
    this._projectId   = projectId
    /** @type {GatewayToken | null} */
    this._token = null
  }

  // ── Token management ───────────────────────────────────────────────────────

  /**
   * Fetch or refresh the JWT. Returns the current token, refreshing if needed.
   * @returns {Promise<GatewayToken>}
   */
  async _getToken() {
    if (this._token && Date.now() < this._token.expiresAt - REFRESH_BUFFER_S * 1000) {
      return this._token
    }

    const response = await fetch(`${this._gatewayUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_token: this._githubToken,
        project_id:   this._projectId,
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(`Gateway auth failed: ${err.message ?? response.statusText}`)
    }

    const data = await response.json()
    this._token = {
      token:           data.token,
      expiresAt:       Date.now() + data.expires_in * 1000,
      sub:             data.sub,
      project:         data.project,
      role:            data.role,
      team:            data.team,
      base_confidence: data.base_confidence,
    }
    return this._token
  }

  /**
   * Return the resolved identity from the current JWT.
   * Used by server.js to build the session identity without re-calling GitHub.
   * @returns {Promise<import('../identity/resolver.js').ResolvedIdentity>}
   */
  async getIdentity() {
    const t = await this._getToken()
    return {
      name:            t.sub,
      team:            t.team,
      role:            t.role,
      base_confidence: t.base_confidence,
      method:          'github_token',
    }
  }

  // ── pg.Pool-compatible interface ───────────────────────────────────────────

  /**
   * Execute a query via the gateway's /pg REST API.
   * This mimics the pg.Pool.query() interface so tool handlers work unchanged.
   *
   * NOTE: This method is NOT used directly by tool handlers — they call the
   * functions in graph/queries.js which now accept an optional projectId param.
   * This method is kept for audit/secondary.js calls that use pool.query() directly.
   *
   * @param {string} _sql - SQL text (ignored — gateway uses typed endpoints)
   * @param {unknown[]} [_params] - Parameters (ignored)
   * @returns {Promise<{ rows: unknown[] }>}
   */
  async query(_sql, _params) {
    throw new Error(
      'GatewayClient.query() called with raw SQL — use the typed gateway endpoints instead. ' +
      'Ensure all pg.query() calls in tool handlers go through graph/queries.js functions.',
    )
  }

  /**
   * Connect-compatible stub (satisfies pg.Pool interface for chain verification).
   * @returns {{ query: Function, release: Function }}
   */
  async connect() {
    return {
      query:   (_sql, _params) => { throw new Error('GatewayClient: use typed endpoints') },
      release: () => {},
    }
  }

  /**
   * Pool end — no-op for gateway client (no persistent connection to close).
   */
  async end() {}

  // ── Gateway-specific HTTP helpers ──────────────────────────────────────────

  /**
   * Make an authenticated HTTP request to the gateway.
   * @param {string} method - HTTP method
   * @param {string} path - Path relative to gateway base URL (e.g. '/pg/versions/...')
   * @param {object} [body] - JSON body for POST/PATCH requests
   * @returns {Promise<unknown>}
   */
  async _request(method, path, body) {
    const { token } = await this._getToken()

    const response = await fetch(`${this._gatewayUrl}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(`Gateway ${method} ${path} failed (${response.status}): ${err.message ?? response.statusText}`)
    }

    // 204 No Content — return null
    if (response.status === 204) return null
    return response.json()
  }

  /** @param {string} path @param {Record<string, string>} [query] */
  async _get(path, query) {
    const url = query
      ? `${path}?${new URLSearchParams(query).toString()}`
      : path
    return this._request('GET', url)
  }

  /** @param {string} path @param {object} body */
  async _post(path, body) { return this._request('POST', path, body) }

  /** @param {string} path @param {object} body */
  async _patch(path, body) { return this._request('PATCH', path, body) }

  // ── Knowledge version operations ───────────────────────────────────────────

  /** @param {string} topic @param {string} key */
  async getCurrentVersion(topic, key) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}`)
  }

  /** @param {string} topic @param {string} key */
  async getVersionHistory(topic, key) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}/history`)
  }

  /** @param {string} topic @param {string} key @param {string} date */
  async getVersionAtDate(topic, key, date) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}/at`, { date })
  }

  /** @param {string} topic @param {string} key */
  async getNextVersionNumber(topic, key) {
    const data = await this._get(`/pg/versions/${enc(topic)}/${enc(key)}/next-number`)
    return data.next_version
  }

  /** @param {string} topic @param {string} key @param {number} version */
  async getSpecificVersion(topic, key, version) {
    return this._get(`/pg/versions/${enc(topic)}/${enc(key)}/${version}`)
  }

  /** @param {object} record */
  async insertVersion(record) {
    return this._post('/pg/versions', record)
  }

  /** @param {string} topic @param {string} key @param {number} version @param {string} newStatus @param {object|null} forwardLink */
  async transitionVersionStatus(topic, key, version, newStatus, forwardLink = null) {
    return this._patch(`/pg/versions/${enc(topic)}/${enc(key)}/${version}`, { newStatus, forwardLink })
  }

  /** @param {string} tag */
  async getVersionsByTag(tag) {
    return this._get(`/pg/versions/by-tag/${enc(tag)}`)
  }

  // ── Audit operations ───────────────────────────────────────────────────────

  /** @param {object} record */
  async insertVersionAuditLink(record) {
    return this._post('/pg/audit-links', record)
  }

  /** @param {object} entry */
  async writeAuditEntry(entry) {
    return this._post('/pg/audit', entry)
  }

  /** @param {string} id */
  async getAuditEntry(id) {
    return this._get(`/pg/audit/${enc(id)}`)
  }

  /** @param {object} opts */
  async getAllEntries(opts = {}) {
    const query = {}
    if (opts.from) query.from = opts.from
    if (opts.to) query.to = opts.to
    if (opts.tool) query.tool = opts.tool
    return this._get('/pg/audit', Object.keys(query).length ? query : undefined)
  }

  async countEntries() {
    const data = await this._get('/pg/audit/count')
    return data.count
  }

  // ── Pending decisions ──────────────────────────────────────────────────────

  /** @param {{ topic?: string, include_stale?: boolean }} opts */
  async getPendingDecisions(opts = {}) {
    const query = {}
    if (opts.topic) query.topic = opts.topic
    if (opts.include_stale) query.include_stale = 'true'
    return this._get('/pg/pending', Object.keys(query).length ? query : undefined)
  }

  /** @param {object} decision */
  async insertPendingDecision(decision) {
    return this._post('/pg/pending', decision)
  }

  /** @param {string} conflictId @param {object} updates */
  async updatePendingDecision(conflictId, updates) {
    return this._patch(`/pg/pending/${enc(conflictId)}`, updates)
  }

  /** @param {string} topic @param {string} key */
  async countPendingForKey(topic, key) {
    const data = await this._get(`/pg/pending/count/${enc(topic)}/${enc(key)}`)
    return data.count
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  /** @param {string} projectId */
  async getConfig(projectId) {
    return this._get(`/config/${enc(projectId)}`)
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async ping() {
    try {
      const data = await this._get('/health')
      return data.status === 'healthy'
    } catch {
      return false
    }
  }
}

/**
 * Singleton gateway client — created once at MCP startup if QUORUM_GATEWAY_URL is set.
 * @type {GatewayClient | null}
 */
let _client = null

/**
 * Create and return the gateway client singleton.
 * Returns null if QUORUM_GATEWAY_URL is not set (direct mode).
 * @returns {GatewayClient | null}
 */
export function getGatewayClient() {
  if (_client) return _client

  const url = process.env.QUORUM_GATEWAY_URL
  if (!url) return null

  // TODO(v0.3/GAP-28): Replace PAT exchange with OAuth-issued JWT stored locally
  // after dashboard login (e.g. ~/.quorum/token). For now QUORUM_GITHUB_TOKEN is
  // still accepted as a transitional mechanism — it works because /auth/token accepts
  // any valid GitHub token (PAT or OAuth access token) with read:user scope.
  const token     = process.env.QUORUM_GITHUB_TOKEN
  const projectId = process.env.QUORUM_PROJECT_ID ?? 'default'

  if (!token) {
    throw new Error(
      'QUORUM_GATEWAY_URL is set but no auth token found. ' +
      'Set QUORUM_GITHUB_TOKEN temporarily, or log in via the dashboard and ' +
      'export the JWT as QUORUM_GITHUB_TOKEN until OAuth-based MCP auth lands in v0.3.'
    )
  }

  _client = new GatewayClient(url, token, projectId)
  return _client
}

/** Reset singleton (for testing). */
export function _resetGatewayClient() { _client = null }

/** URL-encode a path segment. */
function enc(s) { return encodeURIComponent(s) }
