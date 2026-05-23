/**
 * Graphiti write-settle helper.
 *
 * Only call this in the 5 scenarios that test our code's write-then-read pipeline
 * through Graphiti/FalkorDB:
 *
 *   S-01, S-02.1, S-17 Part C — call graphitiSettle() directly
 *   S-02.2, S-06            — via seed.conflict(), which calls it internally
 *
 * All other scenarios are pure HTTP/PostgreSQL tests and must NOT call this.
 * Calling it unnecessarily adds 5 seconds to every test that uses it.
 *
 * @module graphiti
 */

/** Settle timeout in milliseconds. Conservative — revisit once mock-openai timing is known. */
const SETTLE_MS = 5_000

/**
 * Waits for Graphiti/FalkorDB to finish indexing a freshly written node
 * before issuing a read (recall, search, or conflict detection).
 *
 * Do NOT call after seed.conflict() — it calls this internally.
 *
 * @returns {Promise<void>}
 */
export async function graphitiSettle() {
  await new Promise(r => setTimeout(r, SETTLE_MS))
}
