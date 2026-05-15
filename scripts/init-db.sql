-- Quorum Audit Database Schema (greenfield — q_* ID hierarchy)
--
-- ID hierarchy:
--   q_p{n}        Quorum project   e.g. q_p1   (q_p0 reserved for the 'global' namespace)
--   q_k{n}        Knowledge entry  e.g. q_k198 (one per project+topic+key)
--   q_k{n}_v{m}   Version ID       e.g. q_k198_v3
--   q_c{n}        Conflict ID      e.g. q_c7
--
-- group_id (e.g. amethyst_munchkin) is display-only and lives ONLY on q_projects.
-- It is never a foreign key anywhere else.
--
-- All write tables are append-only. No UPDATE or DELETE is permitted by the
-- application except a narrow set of UPDATE grants (status transitions, etc.).
-- Row-level security enforces INSERT-only for the quorum_app role.

-- ── Sequences for Quorum-owned IDs ─────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS q_project_seq;
CREATE SEQUENCE IF NOT EXISTS q_key_seq;
CREATE SEQUENCE IF NOT EXISTS q_conflict_seq;

-- ── Project registry ──────────────────────────────────────────────────────────
-- q_project_id is the canonical Quorum-owned identifier.
-- group_id is display-only — never a foreign key.
CREATE TABLE IF NOT EXISTS q_projects (
  q_project_id    TEXT PRIMARY KEY,            -- 'q_p1'
  group_id        TEXT NOT NULL UNIQUE,        -- 'amethyst_munchkin' — display only
  display_name    TEXT,
  owner           TEXT NOT NULL,               -- GitHub username
  members         JSONB NOT NULL DEFAULT '[]',
  -- [{ github_username, role, team, base_confidence }]
  domains         JSONB NOT NULL DEFAULT '[]',
  -- [{ name, conflict_threshold }]
  governance      JSONB NOT NULL DEFAULT '{}',
  -- { conflict_threshold, authority_threshold, notifications: { webhook_url } }
  config_version  INTEGER NOT NULL DEFAULT 0,  -- optimistic lock for config PATCH
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qp_group_id ON q_projects (group_id);
CREATE INDEX IF NOT EXISTS idx_qp_members  ON q_projects USING GIN (members);

-- ── Knowledge entry registry ──────────────────────────────────────────────────
-- One row per (project, topic, key) triple. Replaces the scattered triple
-- everywhere else — versions, pending decisions, bumps, audit links all
-- reference q_key_id instead of (topic, key, project_id).
CREATE TABLE IF NOT EXISTS q_keys (
  q_key_id      TEXT PRIMARY KEY,              -- 'q_k198'
  q_project_id  TEXT NOT NULL REFERENCES q_projects(q_project_id),
  topic         TEXT NOT NULL,
  key           TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (q_project_id, topic, key)
);

CREATE INDEX IF NOT EXISTS idx_qk_project       ON q_keys (q_project_id);
CREATE INDEX IF NOT EXISTS idx_qk_project_topic ON q_keys (q_project_id, topic);

-- ── Knowledge versions ────────────────────────────────────────────────────────
-- Immutable once written. Only `status`, `forward_link`, `confidence`,
-- `last_accessed_at`, and `tags` may be updated via narrow grants below.
--
-- The version_id (q_k{n}_v{m}) is the PRIMARY KEY and is set by application
-- code on INSERT.
--
-- q_project_id, topic, and key are denormalised from q_keys so that the most
-- common read paths (project-scoped scans, display) do not require a join.
CREATE TABLE IF NOT EXISTS knowledge_versions (
  version_id           TEXT PRIMARY KEY,         -- 'q_k198_v3'
  q_key_id             TEXT NOT NULL REFERENCES q_keys(q_key_id),
  q_project_id         TEXT NOT NULL REFERENCES q_projects(q_project_id),
  version              INTEGER NOT NULL,
  topic                TEXT NOT NULL,            -- denorm for display
  key                  TEXT NOT NULL,            -- denorm for display
  summary              TEXT NOT NULL DEFAULT '', -- durable content store
  status               TEXT NOT NULL CHECK (status IN (
                         'ACTIVE','DRAFT','SUPERSEDED','DEPRECATED','REJECTED','PENDING_CONFLICT_CHECK'
                       )),
  confidence           FLOAT NOT NULL DEFAULT 0.7,
  starting_confidence  FLOAT NOT NULL DEFAULT 0.7,
  entity_type          TEXT NOT NULL DEFAULT 'unknown',
  author               TEXT NOT NULL,
  author_role          TEXT NOT NULL DEFAULT 'unknown',
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  triggered_by         TEXT NOT NULL,           -- engineer_decision | conflict_resolution | pr_merge | atlassian_sync | confidence_decay | reflect
  content_hash         TEXT NOT NULL,
  graphiti_episode_id  TEXT,
  -- Backward link (set at creation — this version supersedes a previous one)
  supersedes_version   INTEGER,
  supersedes_reason    TEXT,
  -- Forward link (JSONB set when next version arrives)
  -- Shape: { version, author, at }
  forward_link         JSONB,
  -- Audit
  created_by_audit     TEXT,                    -- soft ref to audit_log.entry_id
  last_accessed_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (q_key_id, version)
);

CREATE INDEX IF NOT EXISTS idx_kv_q_key_status   ON knowledge_versions (q_key_id, status);
CREATE INDEX IF NOT EXISTS idx_kv_project_status ON knowledge_versions (q_project_id, status);
CREATE INDEX IF NOT EXISTS idx_kv_project_topic  ON knowledge_versions (q_project_id, topic, status);
CREATE INDEX IF NOT EXISTS idx_kv_tags           ON knowledge_versions USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_kv_confidence     ON knowledge_versions (confidence)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_kv_last_accessed  ON knowledge_versions (last_accessed_at)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_kv_entity_type    ON knowledge_versions (entity_type)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_kv_graphiti_episode ON knowledge_versions (graphiti_episode_id);
CREATE INDEX IF NOT EXISTS idx_kv_created_at     ON knowledge_versions (created_at);
CREATE INDEX IF NOT EXISTS idx_kv_summary_search ON knowledge_versions
  USING GIN (to_tsvector('english', summary))
  WHERE status NOT IN ('DRAFT','DEPRECATED','REJECTED');

-- ── Audit log (SHA256 tamper-evident chain) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  entry_id        TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  tool            TEXT NOT NULL,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  author          TEXT NOT NULL,
  author_role     TEXT NOT NULL DEFAULT 'unknown',
  session_id      TEXT,
  q_project_id    TEXT REFERENCES q_projects(q_project_id),
  version_id      TEXT,                          -- soft ref to knowledge_versions.version_id
  content_hash    TEXT,
  governance_json JSONB NOT NULL DEFAULT '{}',
  outcome_json    JSONB NOT NULL DEFAULT '{}',
  version_impact  JSONB NOT NULL DEFAULT '{"versions_created":[],"versions_superseded":[]}',
  entry_hash      TEXT NOT NULL,
  previous_hash   TEXT,
  chain_position  BIGINT NOT NULL UNIQUE,
  archived_at     TIMESTAMPTZ,
  archive_s3_key  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_chain_position ON audit_log (chain_position);
CREATE INDEX IF NOT EXISTS idx_audit_project       ON audit_log (q_project_id);
CREATE INDEX IF NOT EXISTS idx_audit_author        ON audit_log (author);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp     ON audit_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_tool          ON audit_log (tool);
CREATE INDEX IF NOT EXISTS idx_audit_archived      ON audit_log (archived_at)
  WHERE archived_at IS NULL;

-- Single-row counter for gap-free chain position allocation.
CREATE TABLE IF NOT EXISTS audit_chain_counter (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_position BIGINT NOT NULL DEFAULT 1
);
INSERT INTO audit_chain_counter (id, next_position)
SELECT 1, COALESCE(MAX(chain_position), 0) + 1 FROM audit_log
ON CONFLICT (id) DO NOTHING;

-- ── Version ↔ audit bidirectional cross-reference ────────────────────────────
-- Walk from any audit entry → versions it touched, or from any version → the
-- audit entry that created/superseded it. version_id is a soft reference because
-- the audit entry is written before the version row is committed.
CREATE TABLE IF NOT EXISTS version_audit_links (
  id              BIGSERIAL PRIMARY KEY,
  audit_entry_id  TEXT NOT NULL REFERENCES audit_log (entry_id),
  version_id      TEXT NOT NULL,                 -- soft ref to knowledge_versions.version_id
  q_key_id        TEXT NOT NULL REFERENCES q_keys(q_key_id),
  link_type       TEXT NOT NULL CHECK (link_type IN ('created', 'superseded')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_val_audit_entry ON version_audit_links (audit_entry_id);
CREATE INDEX IF NOT EXISTS idx_val_q_key       ON version_audit_links (q_key_id);
CREATE INDEX IF NOT EXISTS idx_val_version_id  ON version_audit_links (version_id);

-- ── Pending conflict decisions ───────────────────────────────────────────────
-- conflict_id (q_c{n}) is the primary key and is globally unique.
-- q_key_id replaces the (conflict_topic, conflict_key) pair.
-- q_project_id is denorm for fast project-scoped scans.
CREATE TABLE IF NOT EXISTS pending_decisions (
  conflict_id                TEXT PRIMARY KEY,    -- 'q_c7'
  q_key_id                   TEXT NOT NULL REFERENCES q_keys(q_key_id),
  q_project_id               TEXT NOT NULL REFERENCES q_projects(q_project_id),
  decision_type              TEXT NOT NULL CHECK (decision_type IN ('conflict', 'draft_review')),
  status                     TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'resolved', 'stale')),

  -- Snapshot at creation time
  active_version_at_creation INTEGER,
  existing_content           TEXT,
  incoming_content           TEXT,
  conflict_reason            TEXT,

  -- Resolution
  resolution                 TEXT CHECK (resolution IN ('supersede', 'coexist_split', 'coexist_merge', 'reject', 'escalate')),
  resolution_note            TEXT,
  resolved_by                TEXT,
  resolved_at                TIMESTAMPTZ,

  -- coexist_split fields
  split_existing_key         TEXT,
  split_incoming_key         TEXT,
  split_existing_content     TEXT,
  split_incoming_content     TEXT,

  -- coexist_merge field
  merged_content             TEXT,

  -- Staleness tracking
  stale_warning              TEXT,
  current_active_version     INTEGER,

  -- LLM-generated reviewer enrichment
  enrichment                 JSONB,

  more_pending_same_key      INTEGER NOT NULL DEFAULT 0,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pd_q_key_id   ON pending_decisions (q_key_id);
CREATE INDEX IF NOT EXISTS idx_pd_project    ON pending_decisions (q_project_id, status);
CREATE INDEX IF NOT EXISTS idx_pd_status     ON pending_decisions (status);
CREATE INDEX IF NOT EXISTS idx_pd_created_at ON pending_decisions (created_at DESC);

-- ── Bump log (confidence endorsement audit trail, 7-day cooldown) ────────────
CREATE TABLE IF NOT EXISTS bump_log (
  id            BIGSERIAL PRIMARY KEY,
  q_key_id      TEXT NOT NULL REFERENCES q_keys(q_key_id),
  author        TEXT NOT NULL,
  role          TEXT NOT NULL,
  delta_applied NUMERIC NOT NULL,
  bumped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bump_cooldown ON bump_log (author, q_key_id, bumped_at DESC);

-- ── Author domain stats (expertise signals for authority scoring) ────────────
CREATE TABLE IF NOT EXISTS author_domain_stats (
  author           TEXT NOT NULL,
  q_project_id     TEXT NOT NULL REFERENCES q_projects(q_project_id),
  domain           TEXT NOT NULL,
  approved_count   INTEGER NOT NULL DEFAULT 0,
  recalled_count   INTEGER NOT NULL DEFAULT 0,
  superseded_count INTEGER NOT NULL DEFAULT 0,
  last_updated     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (author, q_project_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_ads_author_domain
  ON author_domain_stats (author, domain, q_project_id);

-- ── Config snapshots (S3 load log / fallback) ────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_config (
  id           BIGSERIAL PRIMARY KEY,
  q_project_id TEXT REFERENCES q_projects(q_project_id),
  config_json  JSONB NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('s3', 'file', 'db', 'env')),
  s3_etag      TEXT,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gc_loaded_at ON governance_config (loaded_at DESC);

-- ── Seed: global namespace project (q_p0) ────────────────────────────────────
-- Company-wide policy namespace. Readable by all projects.
-- Writable by principal_architect role only. All writes enter DRAFT.
INSERT INTO q_projects (q_project_id, group_id, display_name, owner, members, governance, created_by)
VALUES (
  'q_p0',
  'global',
  'Global Shared Knowledge',
  'system',
  '[{"github_username":"system","role":"principal_architect","team":"platform","base_confidence":1.0}]',
  '{"description":"Company-wide policy namespace. Readable by all projects. Writable by principal_architect only. All writes enter DRAFT."}',
  'system'
) ON CONFLICT (q_project_id) DO NOTHING;

-- ── Row-level security ───────────────────────────────────────────────────────
-- quorum_app role may only INSERT (plus narrow UPDATE grants for status,
-- confidence, tags, archival, and pending-decision resolution).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'quorum_app') THEN
    CREATE ROLE quorum_app;
  END IF;
END
$$;

ALTER TABLE q_projects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE q_keys              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE version_audit_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_decisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bump_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE author_domain_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_config   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS q_projects_insert_only          ON q_projects;
DROP POLICY IF EXISTS q_keys_insert_only              ON q_keys;
DROP POLICY IF EXISTS audit_log_insert_only           ON audit_log;
DROP POLICY IF EXISTS knowledge_versions_insert_only  ON knowledge_versions;
DROP POLICY IF EXISTS version_audit_links_insert_only ON version_audit_links;
DROP POLICY IF EXISTS pending_decisions_insert_only   ON pending_decisions;
DROP POLICY IF EXISTS bump_log_insert_only            ON bump_log;
DROP POLICY IF EXISTS author_domain_stats_insert_only ON author_domain_stats;
DROP POLICY IF EXISTS governance_config_insert_only   ON governance_config;

CREATE POLICY q_projects_insert_only
  ON q_projects FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY q_keys_insert_only
  ON q_keys FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY audit_log_insert_only
  ON audit_log FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY knowledge_versions_insert_only
  ON knowledge_versions FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY version_audit_links_insert_only
  ON version_audit_links FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY pending_decisions_insert_only
  ON pending_decisions FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY bump_log_insert_only
  ON bump_log FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY author_domain_stats_insert_only
  ON author_domain_stats FOR INSERT TO quorum_app WITH CHECK (true);
CREATE POLICY governance_config_insert_only
  ON governance_config FOR INSERT TO quorum_app WITH CHECK (true);

-- ── Grants ────────────────────────────────────────────────────────────────────
-- SELECT on every table (needed for chain verification, recall, history).
GRANT SELECT ON q_projects          TO quorum_app;
GRANT SELECT ON q_keys              TO quorum_app;
GRANT SELECT ON audit_log           TO quorum_app;
GRANT SELECT ON knowledge_versions  TO quorum_app;
GRANT SELECT ON version_audit_links TO quorum_app;
GRANT SELECT ON pending_decisions   TO quorum_app;
GRANT SELECT ON bump_log            TO quorum_app;
GRANT SELECT ON author_domain_stats TO quorum_app;
GRANT SELECT ON governance_config   TO quorum_app;

-- INSERT grants.
GRANT INSERT ON q_projects          TO quorum_app;
GRANT INSERT ON q_keys              TO quorum_app;
GRANT INSERT ON audit_log           TO quorum_app;
GRANT INSERT ON knowledge_versions  TO quorum_app;
GRANT INSERT ON version_audit_links TO quorum_app;
GRANT INSERT ON pending_decisions   TO quorum_app;
GRANT INSERT ON bump_log            TO quorum_app;
GRANT INSERT ON author_domain_stats TO quorum_app;
GRANT INSERT ON governance_config   TO quorum_app;

-- Narrow UPDATE grants (enforced at app layer via transitionVersionStatus etc.).
GRANT SELECT, UPDATE ON audit_chain_counter TO quorum_app;

-- q_projects: config updates (governance, members, domains) + config_version optimistic lock.
GRANT UPDATE (members, domains, governance, display_name, owner, config_version)
  ON q_projects TO quorum_app;

-- knowledge_versions: status transitions + forward link + confidence + last_accessed + tags + entity/summary.
GRANT UPDATE (status, forward_link, confidence, last_accessed_at, tags,
              entity_type, summary, updated_at)
  ON knowledge_versions TO quorum_app;

-- audit_log: archival columns only.
GRANT UPDATE (archived_at, archive_s3_key) ON audit_log TO quorum_app;

-- pending_decisions: resolution path.
GRANT UPDATE (status, resolution, resolution_note, resolved_by, resolved_at,
              split_existing_key, split_incoming_key, split_existing_content,
              split_incoming_content, merged_content, stale_warning,
              current_active_version, more_pending_same_key, updated_at)
  ON pending_decisions TO quorum_app;

-- author_domain_stats: counter increments.
GRANT UPDATE (approved_count, recalled_count, superseded_count, last_updated)
  ON author_domain_stats TO quorum_app;

-- ── Sequence grants ──────────────────────────────────────────────────────────
GRANT USAGE, SELECT ON SEQUENCE q_project_seq                  TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE q_key_seq                      TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE q_conflict_seq                 TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE version_audit_links_id_seq     TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE bump_log_id_seq                TO quorum_app;
GRANT USAGE, SELECT ON SEQUENCE governance_config_id_seq       TO quorum_app;
