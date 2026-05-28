/**
 * Governance audit helpers — thin wrappers around writeAuditEntry.
 *
 * All governance events share the same PostgreSQL audit table as knowledge events,
 * giving a single unified timeline in the dashboard.
 *
 * Governance action names:
 *   ownership_transfer   — project owner changed
 *   role_update          — a member's role was changed
 *   admin_add            — a user was added to the platform admin list
 *   admin_remove         — a user was removed from the platform admin list
 */

import { writeAuditEntry } from './secondary.js'

/**
 * Write a governance event to the audit log.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   actor:      string,
 *   actor_type: 'admin' | 'owner',
 *   action:     'ownership_transfer' | 'role_update' | 'admin_add' | 'admin_remove',
 *   project:    string | null,
 *   from?:      string,
 *   to?:        string,
 *   reason:     string,
 *   extra?:     Record<string, unknown>
 * }} entry
 * @returns {Promise<Record<string, unknown>>}
 */
export async function writeGovernanceAudit(pool, entry) {
  return writeAuditEntry(pool, {
    operation:    'GOVERNANCE',
    tool:         entry.action,
    author:       entry.actor,
    author_role:  entry.actor_type ?? 'admin',
    topic:        '_governance',
    key:          entry.action,
    actor:        entry.actor,
    actor_type:   entry.actor_type,
    action:       entry.action,
    project:      entry.project ?? null,
    from:         entry.from    ?? null,
    to:           entry.to      ?? null,
    reason:       entry.reason,
    timestamp:    new Date().toISOString(),
    triggered_by: 'governance_endpoint',
    outcome_json: { action: entry.action, to: entry.to ?? null, from: entry.from ?? null },
    ...entry.extra,
  })
}
