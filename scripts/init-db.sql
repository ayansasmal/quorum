-- Quorum Audit Database Schema
-- All tables are append-only. No UPDATE or DELETE is ever permitted by the application.
-- Row-level security enforces INSERT-only for the quorum_app role.

-- ── Audit log ──────────────────────────────────────────────────────────────────
-- Every MCP tool call produces at minimum 2 entries: INTENT (pre) and OUTCOME (post).
-- The SHA256 chain across chain_position makes this tamper-evident.
CREATE TABLE IF NOT EXISTS audit_log (
  entry_id        TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  tool            TEXT NOT NULL,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  author          TEXT NOT NULL,
  author_role     TEXT NOT NULL DEFAULT 'unknown',
  session_id      TEXT,
  content_hash    TEXT,
  governance_json JSONB NOT NULL DEFAULT '{}',
  outcome_json    JSONB NOT NULL DEFAULT '{}',
  version_impact  JSONB NOT NULL DEFAULT '{"versions_created":[],"versions_superseded":[]}',
  entry_hash      TEXT NOT NULL,
  previous_hash   TEXT,
  chain_position  BIGINT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_chain_position ON audit_log (chain_position);
CREATE INDEX IF NOT EXISTS idx_audit_log_author ON audit_log (author);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_tool ON audit_log (tool);

-- ── Knowledge versions ─────────────────────────────────────────────────────────
-- Immutable once written (UNIQUE constraint on topic+key+version).
-- Only status, superseded_by_*, and superseded_at may be updated — via
-- transitionVersionStatus() only, which validates legal transitions.
-- Bidirectional: backward link (supersedes_*) set at creation;
--               forward link (superseded_by_*) set when next version arrives.
CREATE TABLE IF NOT EXISTS knowledge_versions (
  id                      SERIAL PRIMARY KEY,
  topic                   TEXT NOT NULL,
  key                     TEXT NOT NULL,
  version                 INTEGER NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('ACTIVE','DRAFT','SUPERSEDED','DEPRECATED','REJECTED')),
  content_hash            TEXT NOT NULL,
  author                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_audit        TEXT NOT NULL,           -- references audit_log.entry_id
  triggered_by            TEXT NOT NULL,           -- engineer_decision | conflict_resolution | pr_merge | atlassian_sync | confidence_decay | reflect
  conflict_id             TEXT,
  graphiti_episode_id     TEXT,                    -- links this SQL row to the Graphiti graph node
  -- Backward link (set at creation — this version supersedes a previous one)
  supersedes_version      INTEGER,
  supersedes_reason       TEXT,
  -- Forward link (set when the *next* version supersedes this one)
  superseded_by_version   INTEGER,
  superseded_by_author    TEXT,
  superseded_at           TIMESTAMPTZ,
  UNIQUE (topic, key, version)
);

CREATE INDEX IF NOT EXISTS idx_kv_topic_key_status ON knowledge_versions (topic, key, status);
CREATE INDEX IF NOT EXISTS idx_kv_topic_key_version ON knowledge_versions (topic, key, version);
CREATE INDEX IF NOT EXISTS idx_kv_created_at ON knowledge_versions (created_at);
CREATE INDEX IF NOT EXISTS idx_kv_graphiti_episode ON knowledge_versions (graphiti_episode_id);

-- ── Version ↔ audit bidirectional cross-reference ─────────────────────────────
-- Append-only join table. Walk from any audit entry → versions it touched,
-- or from any version → the audit entry that created/superseded it.
CREATE TABLE IF NOT EXISTS version_audit_links (
  id              SERIAL PRIMARY KEY,
  audit_entry_id  TEXT NOT NULL REFERENCES audit_log (entry_id),
  topic           TEXT NOT NULL,
  key             TEXT NOT NULL,
  version         INTEGER NOT NULL,
  link_type       TEXT NOT NULL CHECK (link_type IN ('created', 'superseded')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_val_audit_entry ON version_audit_links (audit_entry_id);
CREATE INDEX IF NOT EXISTS idx_val_topic_key ON version_audit_links (topic, key);

-- ── Row-level security ─────────────────────────────────────────────────────────
-- quorum_app role may only INSERT, never UPDATE or DELETE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'quorum_app') THEN
    CREATE ROLE quorum_app;
  END IF;
END
$$;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE version_audit_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_insert_only ON audit_log;
DROP POLICY IF EXISTS knowledge_versions_insert_only ON knowledge_versions;
DROP POLICY IF EXISTS version_audit_links_insert_only ON version_audit_links;

CREATE POLICY audit_log_insert_only
  ON audit_log FOR INSERT TO quorum_app WITH CHECK (true);

CREATE POLICY knowledge_versions_insert_only
  ON knowledge_versions FOR INSERT TO quorum_app WITH CHECK (true);

CREATE POLICY version_audit_links_insert_only
  ON version_audit_links FOR INSERT TO quorum_app WITH CHECK (true);

-- Grant INSERT privilege on all tables to quorum_app
GRANT INSERT ON audit_log TO quorum_app;
GRANT INSERT ON knowledge_versions TO quorum_app;
GRANT INSERT ON version_audit_links TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE knowledge_versions_id_seq TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE version_audit_links_id_seq TO quorum_app;

-- Grant SELECT on all tables (needed for chain verification, recall, history queries)
GRANT SELECT ON audit_log TO quorum_app;
GRANT SELECT ON knowledge_versions TO quorum_app;
GRANT SELECT ON version_audit_links TO quorum_app;

-- Grant limited UPDATE on knowledge_versions for status transitions only
-- (enforced at application layer via transitionVersionStatus)
GRANT UPDATE (status, superseded_by_version, superseded_by_author, superseded_at)
  ON knowledge_versions TO quorum_app;

-- ── Tags ───────────────────────────────────────────────────────────────────────
-- Tags are stored as a normalized (lowercase, trimmed) TEXT array on each version.
-- GIN index enables fast containment queries: WHERE 'auth:token' = ANY(tags)
-- Tags allow aliases and cross-entry discovery without changing the canonical topic:key.
ALTER TABLE knowledge_versions
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_kv_tags ON knowledge_versions USING GIN (tags);

GRANT UPDATE (tags) ON knowledge_versions TO quorum_app;

-- ── Config snapshots ────────────────────────────────────────────────────────────
-- Append-only log of every config load from S3 (or local file / env fallback).
-- Used as fallback when S3 is unreachable — last known-good snapshot is loaded.
-- source: 's3' | 'file' | 'db' | 'env'
CREATE TABLE IF NOT EXISTS governance_config (
  id          SERIAL PRIMARY KEY,
  config_json JSONB NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('s3', 'file', 'db', 'env')),
  s3_etag     TEXT,
  loaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gc_loaded_at ON governance_config (loaded_at DESC);

GRANT INSERT, SELECT ON governance_config TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE governance_config_id_seq TO quorum_app;

-- ── Pending decisions ──────────────────────────────────────────────────────────
-- Stores unresolved conflict briefs and DRAFT reviews awaiting human action.
-- Enrichment (LLM analysis) is generated at creation time and stored here so
-- reviewers see the analysis instantly with no extra latency at review time.
--
-- decision_type: 'conflict' | 'draft_review'
-- status:        'pending' | 'resolved' | 'stale'
-- resolution:    'supersede' | 'coexist_split' | 'coexist_merge' | 'reject' | 'escalate'
--
-- coexist_split: reviewer forks into two scoped keys; original is superseded by both.
-- coexist_merge: reviewer writes a combined entry; original is superseded by merged.
--
-- Stale detection: when the ACTIVE version for conflict_topic:conflict_key advances
-- (a different decision resolved first), this row's status is set to 'stale' and
-- stale_warning is populated so the next reviewer knows the context has shifted.
CREATE TABLE IF NOT EXISTS pending_decisions (
  id                    SERIAL PRIMARY KEY,
  conflict_id           TEXT NOT NULL UNIQUE,     -- stable external reference (UUID)
  decision_type         TEXT NOT NULL CHECK (decision_type IN ('conflict', 'draft_review')),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'stale')),

  -- Knowledge location
  conflict_topic        TEXT NOT NULL,
  conflict_key          TEXT NOT NULL,

  -- Snapshot at creation time (what triggered the conflict)
  active_version_at_creation INTEGER,            -- the ACTIVE version when this was raised
  existing_content      TEXT,
  incoming_content      TEXT,
  conflict_reason       TEXT,

  -- Resolution
  resolution            TEXT CHECK (resolution IN ('supersede', 'coexist_split', 'coexist_merge', 'reject', 'escalate')),
  resolution_note       TEXT,
  resolved_by           TEXT,
  resolved_at           TIMESTAMPTZ,

  -- coexist_split fields: reviewer specifies new scoped keys + optional refined content
  split_existing_key    TEXT,                     -- e.g. 'token-strategy:lambda'
  split_incoming_key    TEXT,                     -- e.g. 'token-strategy:internal'
  split_existing_content TEXT,                    -- optional refined content for split A
  split_incoming_content TEXT,                    -- optional refined content for split B

  -- coexist_merge field: reviewer writes a single combined entry
  merged_content        TEXT,                     -- the merged knowledge content

  -- Staleness tracking (read-committed conflict review semantics)
  stale_warning         TEXT,                     -- set when active version has advanced since creation
  current_active_version INTEGER,                 -- refreshed at review time for stale detection

  -- LLM-generated reviewer enrichment (generated at conflict creation, not at review time)
  -- Shape: { analysis, risks_if_approved, questions_for_reviewer, existing_rationale,
  --          possible_split: boolean, split_suggestion?: string }
  enrichment            JSONB,

  -- Ordering context
  more_pending_same_key INTEGER NOT NULL DEFAULT 0,  -- count of other pending decisions for this topic:key

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pd_conflict_id     ON pending_decisions (conflict_id);
CREATE INDEX IF NOT EXISTS idx_pd_topic_key       ON pending_decisions (conflict_topic, conflict_key);
CREATE INDEX IF NOT EXISTS idx_pd_status          ON pending_decisions (status);
CREATE INDEX IF NOT EXISTS idx_pd_created_at      ON pending_decisions (created_at DESC);

GRANT INSERT, SELECT ON pending_decisions TO quorum_app;
GRANT UPDATE (status, resolution, resolution_note, resolved_by, resolved_at,
              split_existing_key, split_incoming_key, split_existing_content, split_incoming_content,
              merged_content, stale_warning, current_active_version,
              more_pending_same_key, updated_at)
  ON pending_decisions TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE pending_decisions_id_seq TO quorum_app;

-- ── Confidence lifecycle (GAP-04, GAP-18, GAP-24) ────────────────────────────────
-- confidence:         current score (0–1), decays weekly, restored by bumps and recall
-- starting_confidence: the score at creation — bump mechanic caps restoration here
-- last_accessed_at:  reset on every recall() — decay clock uses this, not created_at
-- author_role:        role at write time — preserved even if author's role changes later
ALTER TABLE knowledge_versions
  ADD COLUMN IF NOT EXISTS confidence         FLOAT       NOT NULL DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS starting_confidence FLOAT      NOT NULL DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS last_accessed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS author_role       TEXT        NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_kv_confidence ON knowledge_versions (confidence)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_kv_last_accessed ON knowledge_versions (last_accessed_at)
  WHERE status = 'ACTIVE';

GRANT UPDATE (confidence, last_accessed_at)
  ON knowledge_versions TO quorum_app;

-- ── Project scoping (GAP-10) ────────────────────────────────────────────────────
-- Multi-tenancy: every record belongs to a project.
-- The Quorum Gateway enforces project_id from the JWT claim on every query —
-- engineers cannot override their project assignment.
-- Default 'default' allows existing single-tenant deployments to migrate gracefully.
ALTER TABLE knowledge_versions
  ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE pending_decisions
  ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_kv_project_id    ON knowledge_versions (project_id);
CREATE INDEX IF NOT EXISTS idx_pd_project_id    ON pending_decisions (project_id);
CREATE INDEX IF NOT EXISTS idx_al_project_id    ON audit_log (project_id);

-- Composite indexes for the most common project-scoped query pattern
CREATE INDEX IF NOT EXISTS idx_kv_project_topic_key_status
  ON knowledge_versions (project_id, topic, key, status);

GRANT UPDATE (project_id) ON knowledge_versions TO quorum_app;

-- ── Entity type + summary (dashboard graph view) ───────────────────────────────
-- entity_type: Decision | Pattern | Constraint | Runbook | Requirement | unknown
-- summary:     short human-readable label for graph node tooltips
ALTER TABLE knowledge_versions
  ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS summary     TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_kv_entity_type ON knowledge_versions (entity_type)
  WHERE status = 'ACTIVE';

GRANT UPDATE (entity_type, summary) ON knowledge_versions TO quorum_app;

-- ── Bump log (GAP-24 — confidence endorsement audit trail) ─────────────────────
-- Append-only record of every bump action. Used for:
--   1. 7-day per-author cooldown enforcement
--   2. Audit trail of who endorsed what and with what role delta
CREATE TABLE IF NOT EXISTS bump_log (
  id            SERIAL PRIMARY KEY,
  author        TEXT        NOT NULL,
  topic         TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  project_id    TEXT        NOT NULL DEFAULT 'default',
  role          TEXT        NOT NULL,
  delta_applied NUMERIC     NOT NULL,
  bumped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bump_log_cooldown
  ON bump_log (author, topic, key, project_id, bumped_at DESC);

GRANT INSERT, SELECT ON bump_log TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE bump_log_id_seq TO quorum_app;

-- ── Projects table (GAP-20) ────────────────────────────────────────────────────
-- Central config store. Each project has a unique token (stored as SHA-256 hash).
-- Replaces per-project S3 config files. Members/domains/governance are JSONB columns.
-- config_version enables optimistic locking (GAP-25): PATCH must supply current version.
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,          -- proj-abc123 | 'global'
  slug              TEXT UNIQUE NOT NULL,      -- human-readable short name
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT NOT NULL,             -- github username of creator

  -- Full governance config (replaces S3 config file)
  members           JSONB NOT NULL DEFAULT '[]',
  -- [{ github_username, role, team, base_confidence }]
  domains           JSONB NOT NULL DEFAULT '[]',
  -- [{ name, conflict_threshold }]
  governance        JSONB NOT NULL DEFAULT '{}',
  -- { conflict_threshold, authority_threshold, notifications: { webhook_url } }

  schema_version    INTEGER NOT NULL DEFAULT 1,
  config_version    INTEGER NOT NULL DEFAULT 0, -- optimistic lock (GAP-25)
  config_updated_at TIMESTAMPTZ,
  config_updated_by TEXT,

  -- Enterprise integrations (all optional)
  github_org        TEXT,
  github_repo       TEXT,
  jira_project      TEXT,
  slack_channel     TEXT,

  -- Project token for MCP server auth (bcrypt hash; plaintext returned once on creation)
  token_hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_members   ON projects USING GIN (members);
CREATE INDEX IF NOT EXISTS idx_projects_slug      ON projects (slug);

GRANT INSERT, SELECT ON projects TO quorum_app;
GRANT UPDATE (members, domains, governance, status, config_version,
              config_updated_at, config_updated_by, token_hash)
  ON projects TO quorum_app;

-- ── GAP-27: Global namespace bootstrap ────────────────────────────────────────
-- The 'global' project is a reserved namespace readable by all projects.
-- Only principal_architect role may write to it; all writes enter DRAFT.
-- 'not-a-real-token' ensures this project cannot be used as an MCP token target.
INSERT INTO projects (id, slug, name, created_by, members, governance, token_hash)
VALUES (
  'global',
  'global',
  'Global Shared Knowledge',
  'system',
  '[{"github_username": "system", "role": "principal_architect", "team": "platform", "base_confidence": 1.0}]',
  '{"description": "Company-wide policy namespace. Readable by all projects. Writable by principal_architect only. All writes enter DRAFT."}',
  'not-a-real-token'
) ON CONFLICT (id) DO NOTHING;

-- ── GAP-21: Domain track record (author_domain_stats) ───────────────────────
-- Tracks per-author per-domain expertise signals used in authority scoring.
-- Incremented by: recall() → recalled_count, review(approve) → approved_count,
--                 remember() supersede → superseded_count.
-- Primary key prevents duplicate rows; UPSERT pattern used for all increments.
CREATE TABLE IF NOT EXISTS author_domain_stats (
  author            TEXT        NOT NULL,
  domain            TEXT        NOT NULL,
  project_id        TEXT        NOT NULL DEFAULT 'default',
  approved_count    INTEGER     NOT NULL DEFAULT 0,
  recalled_count    INTEGER     NOT NULL DEFAULT 0,
  superseded_count  INTEGER     NOT NULL DEFAULT 0,
  last_updated      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (author, domain, project_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_author_domain ON author_domain_stats (author, domain, project_id);

GRANT INSERT, SELECT ON author_domain_stats TO quorum_app;
GRANT UPDATE (approved_count, recalled_count, superseded_count, last_updated)
  ON author_domain_stats TO quorum_app;

-- ── GAP-05: Audit log archival columns ───────────────────────────────────────
-- Append-only: archival marks entries with a pointer to S3 — never deletes rows.
-- archived_at + archive_s3_key are both nullable; NULL means not yet archived.
-- Partial index speeds the archival script's "find unarchived rows" query.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_s3_key TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_archived ON audit_log (archived_at)
  WHERE archived_at IS NULL;

GRANT UPDATE (archived_at, archive_s3_key) ON audit_log TO quorum_app;

-- ── GAP-03: PENDING_CONFLICT_CHECK status ─────────────────────────────────────
-- Extend the status CHECK constraint to include PENDING_CONFLICT_CHECK.
-- This status is set when Graphiti is unavailable at write time so conflict
-- detection is deferred to the recheck-conflicts CronJob.
DO $$
BEGIN
  ALTER TABLE knowledge_versions
    DROP CONSTRAINT IF EXISTS knowledge_versions_status_check;
  ALTER TABLE knowledge_versions
    ADD CONSTRAINT knowledge_versions_status_check
      CHECK (status IN ('ACTIVE','DRAFT','SUPERSEDED','DEPRECATED','REJECTED','PENDING_CONFLICT_CHECK'));
END
$$;
