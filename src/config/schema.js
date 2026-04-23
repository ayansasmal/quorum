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

/** Root config schema. */
export const QuorumConfigSchema = z.object({
  project: z.string().min(1),
  group_id: z.string().min(1).optional(),
  members: z.array(MemberSchema).default([]),
  roles: z.record(z.string(), RoleSchema).default({}),
  domains: z.record(z.string(), DomainConfigSchema).default({}),
  thresholds: ThresholdsSchema.default({}),
  notifications: NotificationsSchema.optional(),
})

/** @typedef {import('zod').infer<typeof QuorumConfigSchema>} QuorumConfig */
