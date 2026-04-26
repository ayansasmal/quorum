# Quorum Tool Reference

Full parameter schemas, return shapes, and edge cases for all 9 MCP tools.

---

## `remember(topic, key, content, options?)`

Store or update a knowledge node. Always creates a new version — never edits in place.

**Parameters:**
- `topic` — domain namespace (`auth`, `api`, `db`, `infra`, `testing`, `payments`, `security`, ...)
- `key` — unique identifier within topic (kebab-case, e.g. `token-strategy`)
- `content` — the knowledge to store; include rationale, not just conclusions
- `options.confidence` — `0.0–1.0` (role floor applied automatically; see knowledge-guidelines.md)
- `options.tags` — string array for cross-domain searchability
- `options.conflict_id` — from `pending()` response; required when resolving a pending conflict
- `options.resolution` — `"supersede" | "coexist_split" | "coexist_merge" | "reject" | "escalate"`
- `options.reason` — required when `resolution` is set (≥10 meaningful characters)
- `options.split_existing_key` — new key for the existing entry (required for `coexist_split`)
- `options.split_incoming_key` — new key for the incoming entry (required for `coexist_split`)
- `options.split_existing_content` — optional refined content for split A
- `options.split_incoming_content` — optional refined content for split B
- `options.merged_content` — combined entry content (required for `coexist_merge`)

**Do not pass `author`** — injected server-side from identity (GitHub token → git email → `QUORUM_AUTHOR`).

**Returns:**
```json
{ "status": "stored", "version": 1, "topic": "auth", "key": "token-strategy" }
{ "status": "superseded", "version": 2, "previous_version": 1 }
{ "status": "conflict_detected", "conflict_id": "cfl_abc123", "brief": "...",
  "message": "Human decision required. Call remember() again with conflict_id + resolution." }
{ "status": "stored_pending_conflict_check", "warning": "Graphiti unavailable — conflict check deferred" }
```

---

## `recall(topic, key, options?)`

Retrieve knowledge by topic:key.

**Parameters:**
- `topic`, `key` — target node
- `options.history` — `true` → full version chain v1 → vN
- `options.at` — ISO date string → version ACTIVE on that date
- `options.version` — integer → specific version

**Default** (no options) → latest ACTIVE version only.

**Returns:** XML-wrapped context block. Pay attention to:
- `confidence < 0.60` — stale or unverified; cross-check before using
- `triggered_by: reflect` — Claude-authored, may still be DRAFT
- `status: SUPERSEDED` — use ACTIVE version instead
- `status: PENDING_CONFLICT_CHECK` — conflict check deferred (Graphiti was unavailable); treat as tentative
- `source: global` — company-wide policy; **do not supersede from this project**

---

## `search(query, domain?, limit?)`

Semantic + BM25 + graph traversal search across all ACTIVE knowledge.

**Parameters:**
- `query` — natural language search string
- `domain` — optional topic filter
- `limit` — default 10, max 50

**Returns:** ranked results with author, confidence, version, and topic:key for each hit.

Frequent recall of an entry signals trust in that author's domain knowledge — the
authority formula rewards knowledge that gets used.

---

## `pending(topic?)`

Returns all unresolved conflicts and DRAFT entries awaiting review.

**Parameters:**
- `topic` — optional filter

**Returns:**
```json
{
  "summary": { "total_pending": 3, "conflicts": 1, "drafts": 2 },
  "conflict_briefs": [
    {
      "conflict_id": "cfl_abc123",
      "topic": "auth", "key": "token-strategy",
      "existing": { "content": "...", "author": "senior-architect", "confidence": 0.85 },
      "incoming": { "content": "...", "author": "junior-dev", "confidence": 0.60 },
      "analysis": "LLM-generated contradiction analysis",
      "stale_warning": false,
      "more_pending_same_key": 0
    }
  ],
  "draft_reviews": [
    {
      "topic": "api", "key": "error-standards",
      "content": "...", "author": "claude", "triggered_by": "reflect"
    }
  ]
}
```

---

## `review(action, topic, key, note)`

Resolve a DRAFT knowledge entry.

**Parameters:**
- `action` — `"approve" | "reject" | "request_changes"`
- `topic`, `key` — target entry
- `note` — mandatory reason (≥10 meaningful characters)

**Constitutional constraint:** You cannot review knowledge you authored. If you wrote it
via `reflect()`, surface it to the human and relay their decision.

---

## `reflect(task_summary, decisions_made, patterns_used)`

Post-task knowledge extraction. Call once per completed task — not mid-task, not on
abandoned tasks.

**Parameters:**
- `task_summary` — 1–3 sentences: what was done and why
- `decisions_made` — array of decision strings with rationale
- `patterns_used` — array of pattern strings

**Behaviour:**
- Extracts individual learnable entries via LLM
- Deduplicates against existing DRAFT entries via content hash
- Calls `remember()` for each novel entry
- All entries enter as `DRAFT` with `triggered_by: reflect`
- Returns list of stored, skipped, and any conflicts detected
- Fires webhook notification if `notifications.webhook_url` is configured

---

## `history(topic, key)`

Full version timeline — v1 → vN with authored reasons, `triggered_by` values, and
audit entry references.

Use before superseding existing knowledge to understand why prior versions were written.

---

## `forget(topic, key, reason)`

Deprecate knowledge permanently. Never hard-deletes — creates a `DEPRECATED` marker
version. Requires `reason` (≥10 meaningful characters).

Use when knowledge is definitively obsolete, not just superseded by a newer entry.

---

## `export(topic?, format)`

Export knowledge to human-readable format.

**Parameters:**
- `format` — `"markdown" | "confluence"`
- `topic` — optional; omit for full export across all domains
