/**
 * authenticate() — Runtime OAuth token injection for the MCP server.
 *
 * Called by Claude Code (via the Quorum skill) after completing the GitHub
 * OAuth flow using mcp-playwright. Injects the OAuth access token into the
 * gateway client singleton in-memory — no files are written.
 *
 * Token lifetime is scoped to the MCP process: restarting the server clears
 * the token and requires re-authentication. This is intentional — it bounds
 * the blast radius of a compromised token to a single session.
 *
 * Flow:
 *   1. mcp-playwright opens {GATEWAY_URL}/auth/github?project_id={id}
 *   2. Engineer approves GitHub OAuth
 *   3. Gateway redirects to dashboard with #oauth=gho_<token> in the fragment
 *   4. Claude extracts the token from window.location.hash
 *   5. Claude calls authenticate({ github_token: "gho_...", project_id: "..." })
 *   6. Token is injected in-memory; gateway client is recreated
 *   7. Claude retries the original failed operation
 */

import { z } from 'zod'
import { setRuntimeToken, getGatewayClient } from '../gateway/client.js'

export const schema = z.object({
  github_token: z.string().min(1).describe(
    'GitHub OAuth access token obtained from the /auth/github OAuth flow (gho_...)',
  ),
  project_id: z.string().optional().describe(
    'Project ID to authenticate against (defaults to QUORUM_PROJECT_ID env var or "default")',
  ),
})

/**
 * Inject a GitHub OAuth token into the running MCP process.
 * Does not write to any file — token lives only in memory.
 *
 * @param {import('pg').Pool} _pg - Unused; authenticate does not need a DB connection
 * @param {z.infer<typeof schema>} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function handler(_pg, input) {
  const { github_token, project_id } = input

  if (!process.env.QUORUM_GATEWAY_URL) {
    return {
      status: 'not_applicable',
      message: 'Running in direct mode (QUORUM_GATEWAY_URL not set). Authentication is not required — identity comes from git config.',
    }
  }

  // Inject token into the in-memory singleton.
  // Any existing client is discarded; the next getGatewayClient() call creates a fresh one.
  setRuntimeToken(github_token, project_id ?? null)

  // Immediately verify the token by exchanging it for a JWT at the gateway.
  // This surfaces auth errors (wrong project, member not found, invalid token) right away
  // rather than on the next real tool call.
  const client = getGatewayClient()
  if (!client) {
    // setRuntimeToken was called but getGatewayClient still returned null — shouldn't happen
    setRuntimeToken(null)
    return {
      status: 'error',
      message: 'Gateway client could not be created. Check QUORUM_GATEWAY_URL.',
    }
  }

  try {
    const auth = await client.verifyAuth()
    return {
      status:     'authenticated',
      user:       auth.sub,
      project:    auth.project,
      role:       auth.role ?? 'none',
      team:       auth.team ?? 'none',
      expires_in: auth.expiresIn,
      note:       'Token stored in-memory only. Re-auth required if the MCP server restarts.',
    }
  } catch (err) {
    // Auth failed — clear the injected token so subsequent calls fail with a clear error
    setRuntimeToken(null)
    return {
      status:  'error',
      message: `Authentication failed: ${err.message}`,
      hint:    'Check that your project_id is correct and your GitHub username is listed in the project config.',
    }
  }
}
