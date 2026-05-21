/**
 * Zod schema for quorum.config.json.
 *
 * Teams upload this file to their S3 bucket. The schema validates it at
 * load time — an invalid config is a hard startup failure.
 *
 * Keys:
 *   project     — human-readable name for this team/project
 *   group_id    — Graphiti namespace (overrides QUORUM_GROUP_ID env var)
 *   members     — team roster with role and identity signals
 *   roles       — role definitions with base_confidence floors
 *   domains     — per-domain governance overrides
 *   thresholds  — global conflict/authority thresholds (domain overrides take precedence)
 */

import { z } from 'zod'

/** A single team member record — maps identity signals to a role. */
export const MemberSchema = z.object({
  name: z.string().min(1),
  team: z.string().min(1),
  role: z.string().min(1),
  /** GitHub username — used when QUORUM_GITHUB_TOKEN is provided for verification. */
  github_username: z.string().optional(),
  /** Git committer email — used as fallback identity signal. */
  git_email: z.string().email().optional(),
})

/** Role definition — sets the base_confidence floor for that role. */
export const RoleSchema = z.object({
  /** Confidence floor: 0–1. Author-provided confidence below this is raised to the floor. */
  base_confidence: z.number().min(0).max(1),
})

/** Per-domain governance overrides. */
export const DomainConfigSchema = z.object({
  /**
   * Semantic similarity threshold to trigger conflict detection in this domain.
   * Override the global thresholds.conflict_threshold for stricter domains (e.g. auth, infra).
   */
  conflict_threshold: z.number().min(0).max(1).optional(),
  /**
   * Teams whose members are permitted to review knowledge in this domain.
   * Empty array = any team member may review.
   */
  required_reviewer_teams: z.array(z.string()).optional(),
})

/** Global threshold defaults — each domain may override conflict_threshold. */
export const ThresholdsSchema = z.object({
  conflict_threshold: z.number().min(0).max(1).default(0.85),
  authority_threshold: z.number().min(0).max(1).default(0.20),
})

/**
 * Webhook notification config (GAP-17).
 * Teams wire webhook_url to Slack, email relay, or PagerDuty.
 * Quorum fires POST with a structured JSON payload when a conflict
 * lands in the human review queue.
 */
export const NotificationsSchema = z.object({
  /** HTTP(S) URL to POST when a conflict.pending_review event fires. */
  webhook_url: z.string().url().optional(),
  /** QUORUM_DASHBOARD_URL override (used to build the dashboard deep-link in the payload). */
  dashboard_url: z.string().url().optional(),
})

// ── v0.4: Federation hierarchy schemas ───────────────────────────────────────

/**
 * Project position in the organisational hierarchy.
 * Hierarchy levels are defined in the platform config — no hard-coded values here.
 * Used for rollup conformance scoring and scoped portfolio visibility.
 */
export const HierarchySchema = z.object({
  /**
   * Hierarchy level name (must match a level in the platform config's hierarchy.levels array).
   * Examples: 'service', 'application', 'department', 'division', 'group'.
   */
  level: z.string().min(1),
  /**
   * group_id of the parent node in the hierarchy tree.
   * Null or absent for root nodes (top-level groups).
   */
  parent: z.string().optional(),
  /**
   * Human-readable label for this project's position (e.g. 'Payments Processing Service').
   */
  display_name: z.string().optional(),
  /**
   * Criticality weight 1–5 used in rollup score formula:
   *   node_score = Σ(child_score × child_criticality) / Σ(child_criticality)
   * Higher criticality = larger influence on parent node's score.
   * Defaults to 1 if absent (equal weight).
   */
  criticality: z.number().int().min(1).max(5).optional(),
})

// ── Root config schema ────────────────────────────────────────────────────────

/** Root config schema. */
export const QuorumConfigSchema = z.object({
  /**
   * GitHub username of the project owner.
   * The owner can transfer ownership and update member roles.
   * Separate from principal_architect (knowledge authority) — they may be the same person.
   */
  owner: z.string().min(1),
  /**
   * Canonical identifier for this project.
   * Must be lowercase letters, numbers, and hyphens only.
   * Used as:
   *   - S3 key prefix: s3://<bucket>/<group_id>/config.json
   *   - DynamoDB primary key in quorum-configs and quorum-user-projects
   *   - JWT 'project' claim (scopes all graph and audit operations)
   *   - Graphiti group_id (knowledge graph namespace)
   * Must match the filename: configs/<group_id>.json
   */
  group_id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'group_id must be lowercase letters, numbers, and hyphens only'),
  /**
   * Human-readable display name shown in the dashboard project picker.
   * Optional — falls back to group_id if not provided.
   * Unlike group_id, this may contain spaces and mixed case.
   */
  project: z.string().min(1).optional(),
  members: z.array(MemberSchema).default([]),
  roles: z.record(z.string(), RoleSchema).default({}),
  domains: z.record(z.string(), DomainConfigSchema).default({}),
  thresholds: ThresholdsSchema.default({}),
  notifications: NotificationsSchema.optional(),
  /**
   * Allow any GitHub-authenticated user to read this project's knowledge as a guest.
   * Guests have role: null — read-only dashboard, all writes forced to DRAFT.
   */
  guest_access: z.boolean().default(false),

  // ── v0.4 federation fields ──────────────────────────────────────────────────

  /**
   * Position of this project in the organisational hierarchy.
   * Used for rollup conformance scoring in GET /api/portfolio.
   */
  hierarchy: HierarchySchema.optional(),

  /**
   * Marks this project as a global knowledge catalog.
   *
   * When true:
   *   - Architect-tier roles can write to this project (enforceGlobalWriteAuthority).
   *   - All writes enter DRAFT regardless of author role.
   *   - The project appears in GET /api/globals for catalog discovery.
   *   - Setting this flag requires multi-party approval (enforceMultiPartyConfig).
   */
  is_global: z.boolean().optional(),

  /**
   * Scope of visibility for a global catalog.
   * Only meaningful when is_global is true.
   *
   * Format: 'org' | 'division:<group_id>' | 'department:<group_id>'
   *   - 'org' (default): visible to all projects
   *   - 'division:<group_id>': visible only to projects whose hierarchy ancestry includes the given division
   *   - 'department:<group_id>': same, narrower
   */
  global_scope: z
    .string()
    .regex(
      /^(org|division:[a-z0-9-]+|department:[a-z0-9-]+)$/,
      "global_scope must be 'org', 'division:<group_id>', or 'department:<group_id>'",
    )
    .optional(),

  /**
   * Marks this project's knowledge as freely readable without authentication.
   * Defined now for schema completeness; enforcement is a v0.5 feature.
   */
  is_public: z.boolean().optional(),

  /**
   * List of group_ids of global catalog projects this project links to.
   * A project is only scored against the global catalogs it has explicitly opted into.
   *
   * Validation: each entry must resolve to a project with is_global: true.
   * This is validated at POST /sync/configs time (DDB lookup), not by this Zod schema.
   *
   * A project may also list other global projects in its own globals list to create
   * catalog inheritance (e.g. a division-level catalog inheriting from an org-level one).
   */
  globals: z.array(z.string().min(1)).optional(),
})

/** @typedef {import('zod').infer<typeof QuorumConfigSchema>} QuorumConfig */
/** @typedef {import('zod').infer<typeof HierarchySchema>} HierarchyConfig */
