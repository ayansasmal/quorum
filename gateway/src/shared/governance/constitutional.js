/**
 * Constitutional Layer — The 5 Invariants.
 *
 * These are not policies. They are functions that throw on violation.
 * They cannot be disabled by environment variables or configuration.
 * 100% line, branch, and function coverage is required by the test suite.
 *
 * Rule 1: No hard deletes — knowledge is deprecated, never deleted.
 * Rule 2: Append-only audit — audit entries can never be edited or deleted.
 * Rule 3: Reason required — deprecations, supersessions, and conflict
 *          resolutions must carry a human-written reason (min 10 meaningful chars).
 * Rule 4: No self-approval — the author of a knowledge entry cannot approve
 *          or resolve conflicts for their own entry.
 * Rule 5: Multi-party config change — governance configuration requires
 *          approval from 2+ people on different teams, plus a 48h cooling period.
 */

/** Reason strings that look like placeholders and are not acceptable. */
const PLACEHOLDER_PATTERNS = [
  /^todo$/i,
  /^fixme$/i,
  /^reason here$/i,
  /^add reason$/i,
  /^n\/a$/i,
  /^na$/i,
  /^tbd$/i,
  /^placeholder$/i,
  /^test$/i,
  /^\.+$/,
  /^!+$/,
  /^ok$/i,
  /^yes$/i,
]

// ── Error class ───────────────────────────────────────────────────────────────

export class ConstitutionalViolation extends Error {
  /**
   * @param {'NO_HARD_DELETE'|'APPEND_ONLY_AUDIT'|'REASON_REQUIRED'|'NO_SELF_APPROVAL'|'MULTI_PARTY_CONFIG'|'GLOBAL_WRITE_AUTHORITY'|'DEVIATION_ACTION_AUTHORITY'|'DEFER_DEADLINE'} rule
   * @param {string} message
   * @param {unknown} [context]
   */
  constructor(rule, message, context) {
    super(`ConstitutionalViolation[${rule}]: ${message}`)
    this.name = 'ConstitutionalViolation'
    this.rule = rule
    this.context = context
  }
}

// ── Rule 1: No hard deletes ───────────────────────────────────────────────────

/**
 * Throws if the given operation name or action string contains a hard-delete keyword.
 * Call this before any operation that touches knowledge — forget(), bulk ops, etc.
 * @param {string} operationName
 */
export function enforceNoHardDelete(operationName) {
  const deleteKeywords = ['delete', 'purge', 'remove', 'wipe', 'drop', 'truncate', 'erase', 'destroy']
  const lower = operationName.toLowerCase()
  for (const kw of deleteKeywords) {
    if (lower.includes(kw)) {
      throw new ConstitutionalViolation(
        'NO_HARD_DELETE',
        `Operation '${operationName}' contains a hard-delete keyword ('${kw}'). Use forget() to deprecate.`,
        { operationName, keyword: kw },
      )
    }
  }
}

/**
 * Validates the MCP tool manifest contains no delete-capable tools.
 * Called at server startup.
 * @param {Array<{ name: string }>} tools
 */
export function validateManifestHasNoDeleteTools(tools) {
  const forbidden = ['hard_delete', 'delete', 'purge', 'remove', 'wipe', 'erase', 'destroy']
  for (const tool of tools) {
    for (const kw of forbidden) {
      if (tool.name.toLowerCase().includes(kw)) {
        throw new ConstitutionalViolation(
          'NO_HARD_DELETE',
          `MCP tool manifest contains a delete-capable tool: '${tool.name}'`,
          { toolName: tool.name },
        )
      }
    }
  }
}

// ── Rule 2: Append-only audit ─────────────────────────────────────────────────

/**
 * Always throws. Called by secondary.updateEntry() and secondary.deleteEntry()
 * to ensure the audit log can never be mutated regardless of caller.
 */
export function enforceAppendOnlyAudit() {
  throw new ConstitutionalViolation(
    'APPEND_ONLY_AUDIT',
    'The audit log is immutable. Entries cannot be edited or deleted.',
  )
}

// ── Rule 3: Reason required ───────────────────────────────────────────────────

/**
 * Throws if the provided reason is absent, too short, or looks like a placeholder.
 * Enforced on: forget(), supersede, conflict resolution, review rejection.
 * @param {string | null | undefined} reason
 * @param {string} operation
 */
export function enforceReasonRequired(reason, operation) {
  if (reason == null || typeof reason !== 'string') {
    throw new ConstitutionalViolation(
      'REASON_REQUIRED',
      `Operation '${operation}' requires a reason string.`,
      { operation, reason },
    )
  }

  const trimmed = reason.trim()

  if (trimmed.length === 0) {
    throw new ConstitutionalViolation(
      'REASON_REQUIRED',
      `Operation '${operation}' requires a non-empty reason.`,
      { operation },
    )
  }

  if (trimmed.length < 10) {
    throw new ConstitutionalViolation(
      'REASON_REQUIRED',
      `Operation '${operation}' reason is too short (${trimmed.length} chars). Provide at least 10 meaningful characters.`,
      { operation, reason: trimmed },
    )
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new ConstitutionalViolation(
        'REASON_REQUIRED',
        `Operation '${operation}' reason appears to be a placeholder: '${trimmed}'`,
        { operation, reason: trimmed },
      )
    }
  }
}

// ── Rule 4: No self-approval ──────────────────────────────────────────────────

/**
 * Normalise an identity string for comparison.
 * Trim whitespace and lowercase so "AYAN", "ayan", "ayan " all resolve equally.
 * @param {string} identity
 * @returns {string}
 */
function normalizeIdentity(identity) {
  return String(identity).trim().toLowerCase()
}

/**
 * Throws if author and reviewer are the same person (case/whitespace-insensitive).
 * @param {string} author
 * @param {string} reviewer
 * @param {string} [operation]
 */
export function enforceNoSelfApproval(author, reviewer, operation = 'review') {
  if (normalizeIdentity(author) === normalizeIdentity(reviewer)) {
    throw new ConstitutionalViolation(
      'NO_SELF_APPROVAL',
      `Self-approval not permitted: '${reviewer}' cannot approve or resolve their own knowledge entry.`,
      { author, reviewer, operation },
    )
  }
}

/**
 * Throws if any party in the conflict is also the resolver.
 * @param {string[]} conflictParties
 * @param {string} resolver
 */
export function enforceConflictPartyCannotSelfResolve(conflictParties, resolver) {
  const normResolver = normalizeIdentity(resolver)
  for (const party of conflictParties) {
    if (normalizeIdentity(party) === normResolver) {
      throw new ConstitutionalViolation(
        'NO_SELF_APPROVAL',
        `Conflict party '${resolver}' cannot resolve their own conflict.`,
        { conflictParties, resolver },
      )
    }
  }
}

// ── Rule 5: Multi-party config change ────────────────────────────────────────

const CONFIG_COOLING_PERIOD_HOURS = 48

/**
 * Throws if a governance config change does not meet the multi-party + cooling-period requirement.
 * @param {Array<{ name: string, team: string }>} approvers
 * @param {string | Date} proposedAt - ISO timestamp of when the change was proposed
 */
export function enforceMultiPartyConfig(approvers, proposedAt) {
  if (!Array.isArray(approvers) || approvers.length < 2) {
    throw new ConstitutionalViolation(
      'MULTI_PARTY_CONFIG',
      `Config changes require at least 2 approvers. Got ${approvers?.length ?? 0}.`,
      { approverCount: approvers?.length ?? 0 },
    )
  }

  const teams = new Set(approvers.map((a) => String(a.team).trim().toLowerCase()))
  if (teams.size < 2) {
    throw new ConstitutionalViolation(
      'MULTI_PARTY_CONFIG',
      'Config change approvers must be from at least 2 different teams.',
      { teams: [...teams] },
    )
  }

  const proposedMs = new Date(proposedAt).getTime()
  const hoursSince = (Date.now() - proposedMs) / (1000 * 60 * 60)
  if (hoursSince < CONFIG_COOLING_PERIOD_HOURS) {
    const remaining = Math.ceil(CONFIG_COOLING_PERIOD_HOURS - hoursSince)
    throw new ConstitutionalViolation(
      'MULTI_PARTY_CONFIG',
      `Config change cooling period not elapsed. ${remaining}h remaining.`,
      { hoursSince, requiredHours: CONFIG_COOLING_PERIOD_HOURS },
    )
  }
}

/**
 * Throws if an attempt is made to change a constitutional rule itself via config.
 * Constitutional rules are immutable via config — no number of approvers can change them.
 * @param {string} configKey
 */
export function enforceConstitutionalRulesAreImmutable(configKey) {
  const constitutionalKeys = [
    'constitutional_rules',
    'no_hard_delete',
    'append_only_audit',
    'reason_required',
    'no_self_approval',
    'multi_party_config',
  ]
  const lower = configKey.toLowerCase()
  if (constitutionalKeys.some((k) => lower.includes(k))) {
    throw new ConstitutionalViolation(
      'MULTI_PARTY_CONFIG',
      `Constitutional rules cannot be changed via config: '${configKey}'`,
      { configKey },
    )
  }
}

// ── v0.4: Federation + Deviation governance ───────────────────────────────────

/**
 * Throws if a role below architect-tier attempts to write to a global catalog.
 *
 * Lifted from the application-level soft-return in remember.js (GAP-27) into
 * the constitutional layer. Widened from principal_architect-only to all
 * architect-tier and business-authority roles because POs and compliance officers
 * need to maintain standards in their domain catalogs.
 *
 * isGlobalProject is resolved by the caller from the target project's config:
 *   - MCP:     getConfig()?.is_global === true  (loaded from .quorum file)
 *   - Gateway: projectConfig.is_global === true (from Redis config cache)
 *
 * Non-global projects are unaffected — every role can write to their own project.
 *
 * @param {{ role?: string }} identity
 * @param {string} projectId - group_id of the target project
 * @param {boolean} isGlobalProject - true when the target project has is_global: true
 */
// E2E: tests/e2e/scenarios/01-global-catalog-onboarding.spec.js — S-01 step 8 (architect→DRAFT, engineer blocked)
export function enforceGlobalWriteAuthority(identity, projectId, isGlobalProject) {
  // Non-global projects: no restriction on write role.
  if (!isGlobalProject) return

  const GLOBAL_WRITE_ROLES = [
    'architect',
    'principal_architect',
    'product_owner',       // owns product standards catalog
    'compliance_officer',  // owns compliance standards catalog
  ]

  if (!GLOBAL_WRITE_ROLES.includes(identity?.role)) {
    throw new ConstitutionalViolation(
      'GLOBAL_WRITE_AUTHORITY',
      `Role '${identity?.role ?? 'unknown'}' cannot write to global catalog '${projectId}'. ` +
        `Minimum role required: architect.`,
      { role: identity?.role, projectId },
    )
  }
}

/**
 * Throws if the actor lacks authority to action (accept/deny/defer) a deviation.
 *
 * Architect-tier roles and business-authority roles can govern deviations.
 * Executive roles (director, vp_engineering, group_executive) are READ-ONLY —
 * they see portfolio data but cannot change governance state. Enforced here at
 * the constitutional layer (not just the UI) so API calls are also rejected.
 *
 * @param {string} actorRole
 * @param {'accept'|'deny'|'defer'} operation
 */
// E2E: tests/e2e/scenarios/04-deviation-governance.spec.js — S-04.3 (authority guard), S-04.4 (deny), S-04.5 (defer)
export function enforceDeviationActionAuthority(actorRole, operation) {
  const ALLOWED_ROLES = [
    'architect',
    'principal_architect',
    'product_owner',
    'compliance_officer',
  ]

  if (!ALLOWED_ROLES.includes(actorRole)) {
    throw new ConstitutionalViolation(
      'DEVIATION_ACTION_AUTHORITY',
      `Role '${actorRole}' cannot ${operation} deviations. Minimum role required: architect.`,
      { actorRole, operation },
    )
  }
}

/**
 * Throws if the defer deadline is not exactly 30, 45, 60, or 90 days from now.
 *
 * Fixed options create accountability checkpoints and prevent indefinite deferrals.
 * A PE who chooses 90 days is making a visible, recorded commitment to revisit.
 * Arbitrary dates would make the commitment ambiguous and harder to surface in
 * the portfolio view.
 *
 * Tolerance: ±rounding via Math.round to absorb clock skew between client and
 * server when the deadline is computed client-side.
 *
 * @param {string | Date} deferUntil - ISO timestamp or Date object
 */
// E2E: tests/e2e/scenarios/04-deviation-governance.spec.js — S-04.5 step 1 (invalid days) + step 3 (valid 30d)
export function enforceValidDeferDeadline(deferUntil) {
  const days = Math.round(
    (new Date(deferUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  )
  if (![30, 45, 60, 90].includes(days)) {
    throw new ConstitutionalViolation(
      'DEFER_DEADLINE',
      `Defer deadline must be exactly 30, 45, 60, or 90 days from now. Got: ${days} days.`,
      { days, deferUntil },
    )
  }
}
