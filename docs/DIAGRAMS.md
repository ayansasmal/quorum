# Quorum System Diagrams

Architecture, data flows, and common use-case sequences for Quorum v0.3.

---

## Component Diagram

```mermaid
graph TB
    subgraph engineer["Engineer Workstation"]
        CC["Claude Code\n(IDE / CLI)"]
        MCP["@as-quorum/mcp\nNode.js MCP Server\n:8000 stdio"]
        SKILL["~/.claude/skills/quorum/\nSKILL.md + references/\n(Claude guidance)"]
    end

    subgraph browser_tier["Browser"]
        DB["Quorum Dashboard\nnginx :3002\n(React SPA)"]
    end

    subgraph gateway_tier["Quorum Gateway  :3001"]
        GW["Express Server\nsrc/server.js"]
        VJ["verify-jwt\n(async, two-step)"]
        PJ["project-scope\n(X-Quorum-Project)"]
        subgraph routes["Route Modules"]
            AUTH["auth.js\n/auth/*"]
            PG["pg.js\n/pg/*"]
            DASH["dashboard.js\n/api/*"]
            CFG["config.js\n/config/*"]
            GOV["governance.js\n/governance/*"]
            USR["user.js\n/user/*"]
            ADMIN["admin.js\n/admin/*"]
            SYNC["sync.js\n/sync/*"]
            GRAPHITI_R["graphiti.js\n/graphiti/*"]
            OAUTH["mcp-oauth.js\n/oauth/*"]
        end
    end

    subgraph persistence["Persistence Layer"]
        REDIS["Redis :6380\nconfig:{id} TTL 300s\nprofile:{user} TTL 300s\nadmin:platform TTL 300s\nquorum:invalidate pub/sub"]
        PG_DB[("PostgreSQL :5432\nquorum_audit DB\nknowledge_versions\naudit_entries\npending_decisions\nbumps")]
        S3["S3 / LocalStack\nquorum-configs bucket\n{group_id}.quorum.json"]
        DDB[("DynamoDB / LocalStack\nquorum-user-projects\n(membership index GSI)")]
    end

    subgraph graph_tier["Knowledge Graph"]
        GRAPHITI_SVC["Graphiti MCP\nPython FastAPI :8001"]
        FALKORDB[("FalkorDB\n:6379\nGraph store")]
    end

    CC -->|"stdio (MCP protocol)"| MCP
    SKILL -.->|"loaded by Claude\nat session start"| CC
    MCP -->|"HTTP Bearer JWT\nX-Quorum-Project: {id}"| GW
    DB -->|"nginx proxy\nHTTP Bearer JWT\nX-Quorum-Project: {id}"| GW

    GW --> VJ
    VJ -->|"loadUserProfile(sub)"| REDIS
    VJ -->|"Redis miss"| DDB
    VJ --> PJ

    AUTH -->|"loadProjectConfig"| REDIS
    AUTH -->|"Redis miss"| S3
    CFG -->|"saveProjectConfig\ninvalidateProject"| REDIS
    CFG -->|"PutObject"| S3
    SYNC -->|"HeadObject/GetObject"| S3
    SYNC -->|"syncProjectMembers"| DDB

    PG -->|"SQL queries"| PG_DB
    DASH -->|"SQL queries"| PG_DB
    DASH -->|"searchNodes"| GRAPHITI_SVC
    GOV -->|"LLM calls\n(OPENAI_API_KEY)"| GOV

    GRAPHITI_R -->|"inject group_id\nHTTP proxy"| GRAPHITI_SVC
    GRAPHITI_SVC --> FALKORDB

    USR -->|"loadUserProfile"| REDIS
    USR -->|"Redis miss"| DDB
    ADMIN -->|"admin:platform"| REDIS
    ADMIN -->|"configs/.quorum"| S3
```

---

## v0.3 JWT + Header Identity Flow

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant MCP as quorum-mcp
    participant GW as Gateway
    participant VJ as verify-jwt
    participant REDIS as Redis
    participant DDB as DynamoDB

    Note over CC,MCP: Session start — Quorum skill loaded
    CC->>MCP: remember("auth","token-strategy","Use ES256...")
    MCP->>MCP: resolveCtx() → ctx.projectId = "amethyst-munchkin"
    MCP->>GW: POST /pg/versions<br/>Authorization: Bearer {slim_JWT}<br/>X-Quorum-Project: amethyst-munchkin

    GW->>VJ: middleware chain

    VJ->>VJ: jwtVerify(token, publicKey)<br/>→ { sub: "ayansasmal", is_admin: false }
    VJ->>VJ: Read X-Quorum-Project header<br/>→ project = "amethyst-munchkin"
    VJ->>REDIS: GET profile:ayansasmal

    alt Cache hit
        REDIS-->>VJ: { projects: [{group_id:"amethyst-munchkin", role:"principal_architect"...}] }
    else Cache miss
        VJ->>DDB: getUserProjects("ayansasmal")
        DDB-->>VJ: membership rows
        VJ->>REDIS: SET profile:ayansasmal TTL 300s
    end

    VJ->>VJ: find project "amethyst-munchkin" in profile<br/>→ role="principal_architect", base_confidence=0.9, is_owner=true
    VJ-->>GW: req.user = { sub, is_admin, project, role, base_confidence, is_owner }

    GW->>GW: route handler executes
    GW-->>MCP: 200 { status: "stored", version: 1 }
    MCP-->>CC: { status: "stored", version: 1 }
```

---

## Full Knowledge Write Flow (remember → conflict check → review)

```mermaid
sequenceDiagram
    participant ENG as Engineer / Claude
    participant MCP as quorum-mcp
    participant GW as Gateway
    participant GOV as governance.js
    participant PG as PostgreSQL
    participant GRAPHITI as Graphiti MCP
    participant FALKOR as FalkorDB

    ENG->>MCP: remember("auth","token-strategy","Use JWT for Lambda")

    MCP->>GW: POST /pg/versions/latest-draft<br/>(check existing DRAFT)
    GW->>PG: getLatestDraftVersion(topic, key, projectId)
    PG-->>GW: null (no draft)
    GW-->>MCP: null

    MCP->>GW: GET /pg/versions/auth/token-strategy<br/>(get current ACTIVE)
    GW->>PG: getCurrentVersion(topic, key, projectId)
    PG-->>GW: { content:"Use session tokens...", confidence:0.85, author:"alice" }
    GW-->>MCP: existing version

    MCP->>GW: POST /governance/detect-conflict<br/>{ existing, incoming }
    GW->>GOV: detect-conflict handler
    GOV->>GOV: OpenAI call: "do these contradict?"

    alt Conflict detected
        GOV-->>GW: { contradicts: true, reason: "...", possible_split: true }
        GW-->>MCP: conflict response
        MCP->>GW: POST /pg/versions (insert DRAFT)
        GW->>PG: INSERT knowledge_versions (status=DRAFT)
        MCP->>GW: POST /pg/pending (insert conflict)
        GW->>PG: INSERT pending_decisions
        GW-->>MCP: { status: "conflict_detected", conflict_id: "cfl_abc" }
        MCP-->>ENG: conflict_detected → show to human

        Note over ENG,MCP: Human reviews and decides
        ENG->>MCP: remember("auth","token-strategy","...", {conflict_id, resolution:"coexist_split"})
        MCP->>GW: POST /api/review/cfl_abc<br/>{ action:"approve", note:"ECS vs Lambda split" }
        GW->>PG: ACTIVE transition (DRAFT→ACTIVE, old→SUPERSEDED) in transaction
        GW->>PG: INSERT audit_entries × 2 (bidirectional)
        GW-->>MCP: { status:"approved" }

    else No conflict
        GOV-->>GW: { contradicts: false }
        GW-->>MCP: safe to write
        MCP->>GW: POST /pg/versions (insert ACTIVE directly if high-authority)
        GW->>PG: INSERT knowledge_versions (status=ACTIVE)
        GW->>PG: INSERT audit_entry
        MCP->>GW: POST /graphiti/mcp (Graphiti episode)
        GW->>GRAPHITI: add_episode({ group_id, content })
        GRAPHITI->>FALKOR: graph write
        GW-->>MCP: { status: "stored", version: 2 }
    end
```

---

## GitHub OAuth → JWT Flow (dashboard login)

```mermaid
sequenceDiagram
    participant BROWSER as Browser (:3002)
    participant NGINX as nginx (dashboard container)
    participant GW as Gateway (:3001)
    participant GITHUB as github.com
    participant REDIS as Redis
    participant S3 as S3

    BROWSER->>NGINX: GET /auth/github
    NGINX->>GW: proxy_pass → GET /auth/github
    GW-->>NGINX: 302 → github.com/login/oauth/authorize
    NGINX-->>BROWSER: 302 redirect

    BROWSER->>GITHUB: GET /login/oauth/authorize?client_id=...&state=...
    GITHUB-->>BROWSER: GitHub login page
    BROWSER->>GITHUB: user approves
    GITHUB-->>BROWSER: 302 → /oauth/callback?code=...&state=...

    BROWSER->>NGINX: GET /oauth/callback?code=...&state=...
    NGINX->>GW: proxy_pass → GET /oauth/callback

    GW->>GITHUB: POST /login/oauth/access_token (exchange code)
    GITHUB-->>GW: { access_token: "gho_..." }
    GW->>GITHUB: GET /user (verify token)
    GITHUB-->>GW: { login: "ayansasmal" }

    GW->>REDIS: GET profile:ayansasmal
    REDIS-->>GW: profile with projects list

    GW->>GW: signJwt({ sub:"ayansasmal", is_admin:false })<br/>⚠️  v0.3: NO project/role/team in JWT

    Note over BROWSER,GW: Response carries profile alongside token
    GW-->>BROWSER: 302 → /project-select?<br/>token=eyJ...&project=...&role=...&team=...

    BROWSER->>BROWSER: AuthContext._applyJwt(jwt, profile)<br/>selectedProject = "amethyst-munchkin"
    BROWSER->>BROWSER: registerProjectGetter → sends X-Quorum-Project header on all API calls
```

---

## MCP OAuth 2.1 PKCE Flow (Claude Code → Gateway)

```mermaid
sequenceDiagram
    participant CC as Claude Code (MCP client)
    participant MCP as quorum-mcp server
    participant GW as Gateway /oauth/*
    participant GITHUB as github.com
    participant BROWSER as Local Browser

    Note over CC,MCP: First tool use triggers auth check
    CC->>MCP: remember("auth", "key", "content")
    MCP->>MCP: no JWT in memory → trigger auth

    MCP->>GW: GET /.well-known/oauth-authorization-server
    GW-->>MCP: { authorization_endpoint, token_endpoint, ... }

    MCP->>MCP: generate PKCE code_verifier + code_challenge

    MCP->>BROWSER: open authorization_endpoint?<br/>response_type=code<br/>code_challenge=...&code_challenge_method=S256<br/>client_id=quorum-mcp

    BROWSER->>GW: GET /oauth/authorize
    GW->>GITHUB: redirect → GitHub OAuth
    GITHUB-->>BROWSER: GitHub login page
    BROWSER->>GITHUB: user approves
    GITHUB-->>GW: callback with code
    GW->>GITHUB: exchange code → GitHub token
    GW->>GW: generate auth_code, store in memory
    GW-->>BROWSER: "Quorum authenticated ✓" + redirect to localhost callback

    BROWSER->>MCP: GET localhost/callback?code=auth_code
    MCP->>GW: POST /oauth/token<br/>{ code, code_verifier, grant_type:authorization_code }
    GW->>GW: verify PKCE code_challenge matches code_verifier
    GW->>GW: signJwt({ sub, is_admin }) → slim JWT
    GW-->>MCP: { access_token: "eyJ...", project, role, team }

    MCP->>MCP: store JWT in memory
    MCP->>CC: auth complete — retry original tool call
```

---

## Flowchart: Session-Start Knowledge Load

```mermaid
flowchart TD
    START([New Claude Code session]) --> CHECK_QUORUM{ls .quorum}
    CHECK_QUORUM -->|Not found| ASK_ONBOARD[Ask: onboard to Quorum?]
    CHECK_QUORUM -->|Found| CHECK_AUTH{QUORUM_GATEWAY_URL set?}

    CHECK_AUTH -->|Yes — gateway mode| AUTHENTICATE[authenticate()]
    CHECK_AUTH -->|No — direct mode| PENDING

    AUTHENTICATE -->|already_authenticated| PENDING
    AUTHENTICATE -->|browser flow| BROWSER_OAUTH[Open browser → GitHub login]
    BROWSER_OAUTH --> PENDING

    PENDING[pending()]
    PENDING -->|conflict_briefs exist| BLOCK_ON_CONFLICT[🚫 Block: Present conflicts\nGet human decision before writing code]
    PENDING -->|draft_reviews only| NOTE_DRAFTS[📝 Note: N DRAFTs await review\nat :3002/pending]
    PENDING -->|empty| LOAD_CONTEXT

    BLOCK_ON_CONFLICT --> RESOLVE[resolve via remember + conflict_id]
    RESOLVE --> LOAD_CONTEXT

    NOTE_DRAFTS --> LOAD_CONTEXT

    LOAD_CONTEXT[search relevant domains\nbased on task] --> IMPLEMENT

    IMPLEMENT[Execute task] --> MID_CONSTRAINT{Discover constraint\nmid-task?}
    MID_CONSTRAINT -->|Yes| REMEMBER_NOW[remember() immediately\ndo not wait for reflect]
    MID_CONSTRAINT -->|No| COMPLETE

    REMEMBER_NOW --> COMPLETE
    COMPLETE{Task finished?} -->|Abandoned| SKIP_REFLECT[Skip reflect]
    COMPLETE -->|Completed| REFLECT[reflect() once]
    REFLECT --> REVIEW_PENDING[Tell human: N entries\npending at :3002/pending]
```

---

## Flowchart: Confidence + Authority System

```mermaid
flowchart TD
    WRITE[Engineer writes knowledge\nconfidence C] --> FLOOR{C < role base_confidence?}
    FLOOR -->|Yes — raise to floor| ADJUST[confidence = base_confidence]
    FLOOR -->|No| CHECK_EXISTING

    ADJUST --> CHECK_EXISTING

    CHECK_EXISTING{ACTIVE entry\nexists for topic:key?} -->|No| STORE_ACTIVE[Store ACTIVE]
    CHECK_EXISTING -->|Yes| CONFLICT_CHECK[POST /governance/detect-conflict]

    CONFLICT_CHECK -->|contradicts: false| AUTH_CHECK{authority_delta >\nauthority_threshold?}
    CONFLICT_CHECK -->|contradicts: true| PENDING_QUEUE[Store DRAFT\nInsert pending_decision\n→ human review required]

    AUTH_CHECK -->|Yes — high authority| AUTO_SUPERSEDE[Auto-supersede existing\nNo human needed]
    AUTH_CHECK -->|No — low delta| DRAFT_QUEUE[Store DRAFT\n→ human review]

    STORE_ACTIVE --> GRAPHITI[Write Graphiti episode\n+ FalkorDB graph]
    AUTO_SUPERSEDE --> GRAPHITI
    GRAPHITI --> AUDIT[Write audit_entry\nSHA256 tamper-evident chain]

    PENDING_QUEUE --> DASHBOARD[Dashboard /pending\nconflict_briefs]
    DRAFT_QUEUE --> DASHBOARD

    BUMP[POST /api/bump/:topic/:key\n(engineer signals trust)] --> DECAY_UP[confidence += delta × role_weight\ncapped at starting_confidence]
    DECAY_UP --> AUDIT

    DECAY[Scheduled decay script\nscripts/decay-confidence.js] --> DECAY_DOWN[confidence -= decay_rate\nper day since last_accessed_at]
    DECAY_DOWN --> LOW_CONF{confidence < 0.60?}
    LOW_CONF -->|Yes| FLAG[Mark stale_warning\nin dashboard]
```

---

## Component Interaction Matrix

| From | To | Channel | Auth | Notes |
|------|-----|---------|------|-------|
| Claude Code | quorum-mcp | stdio (MCP) | None | Same process tree |
| quorum-mcp | Gateway | HTTP Bearer JWT + X-Quorum-Project | ES256 JWT | All 10 tools route here |
| Dashboard (nginx) | Gateway | HTTP Bearer JWT + X-Quorum-Project | ES256 JWT | nginx resolver 127.0.0.11 re-resolves after rebuilds |
| Gateway verify-jwt | Redis | TCP | None | profile:{sub} cache, 300s TTL |
| Gateway config routes | S3 | HTTPS (LocalStack in dev) | AWS IAM | Primary config store |
| Gateway auth.js | DynamoDB | HTTPS (LocalStack in dev) | AWS IAM | Membership index (GSI) |
| Gateway graphiti.js | Graphiti MCP | HTTP (Docker network) | None (internal) | group_id injected; bearer stripped |
| Graphiti MCP | FalkorDB | Redis protocol | None (internal) | Graph + vector store |
| quorum-mcp | Gateway PKCE | HTTP (MCP OAuth 2.1) | PKCE + GitHub OAuth | auth_code → slim JWT |
| EventBridge / CI | Gateway /sync | HTTP Bearer sync token | Static `QUORUM_SYNC_SECRET` | S3→DDB full config sync |

---

## Sequence: recall() — Knowledge Read Path

The most frequent gateway operation. Every Claude Code session issues multiple `recall()` calls
before making implementation decisions. Note the global namespace fallback — this is what enables
company-wide policies to be visible across all project graphs.

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant MCP as quorum-mcp
    participant GW as Gateway
    participant PG as PostgreSQL
    participant GRAPHITI as Graphiti MCP

    CC->>MCP: recall("auth", "token-strategy")
    MCP->>MCP: resolveCtx() → ctx.projectId = "amethyst-munchkin"

    MCP->>GW: GET /pg/versions/auth/token-strategy<br/>Authorization: Bearer {jwt}<br/>X-Quorum-Project: amethyst-munchkin
    Note over GW: verify-jwt → req.user.project = "amethyst-munchkin"

    GW->>PG: getCurrentVersion("auth","token-strategy","amethyst-munchkin")
    PG-->>GW: row (or null if not in project)

    alt Not found in project — global fallback
        GW->>PG: getCurrentVersion("auth","token-strategy","global")
        PG-->>GW: row (company-wide policy) or null
    end

    alt Row found — has summary
        GW-->>MCP: { topic, key, version, summary, confidence, author, status, ... }
        Note over GW,MCP: summary column IS the content (PG-durable)
    else Row found — summary empty (legacy entry written before v0.3 fix)
        GW->>GRAPHITI: search_nodes({ query: "auth:token-strategy", max_nodes: 5 })
        Note over GRAPHITI: ⚠️  group_ids intentionally omitted — FalkorDB treats hyphens as NOT operator
        GRAPHITI-->>GW: { nodes: [...] }
        GW->>GW: find node matching key → node.summary
        GW-->>MCP: { ..., content: node.summary | null }
    else Not found anywhere
        GW-->>MCP: 404
    end

    MCP->>GW: POST /api/bump/auth/token-strategy (fire-and-forget access signal)
    Note over MCP,GW: incrementDomainStat — does not block response

    MCP-->>CC: XML-wrapped content<br/><knowledge topic="auth" key="token-strategy"<br/>  version="2" confidence="0.9"<br/>  author="ayansasmal" status="ACTIVE">...<br/></knowledge>
```

---

## Sequence: search() — Semantic + Fallback Read Path

`search()` is the entry point when the exact key is unknown. It tries Graphiti semantic search
first; if that returns empty (Graphiti down, FalkorDB wiped, or hyphenated group_id issues),
it falls back to PostgreSQL ILIKE against the `summary` column.

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant MCP as quorum-mcp
    participant GW as Gateway
    participant GRAPHITI as Graphiti MCP
    participant FALKOR as FalkorDB
    participant PG as PostgreSQL

    CC->>MCP: search("auth token strategy")
    MCP->>GW: GET /api/search?q=auth+token+strategy<br/>X-Quorum-Project: amethyst-munchkin

    GW->>GRAPHITI: search_nodes({ query: "auth token strategy", max_nodes: 10 })
    Note over GW,GRAPHITI: No group_ids — project isolation handled by PG query below
    GRAPHITI->>FALKOR: RediSearch HNSW vector query
    FALKOR-->>GRAPHITI: matching nodes

    alt Graphiti returns results
        GRAPHITI-->>GW: { nodes: [ { name, summary, ... }, ... ] }
        GW->>PG: SELECT * FROM knowledge_versions<br/>WHERE project_id=$1 AND key IN (matched names)<br/>AND status != 'DEPRECATED'
        PG-->>GW: enriched rows (confidence, author, version, etc.)
        GW-->>MCP: { results: [...], source: "graphiti" }
    else Graphiti returns empty (down / FalkorDB wiped / no match)
        GRAPHITI-->>GW: { nodes: [] }
        GW->>PG: SELECT topic, key, summary, status, confidence,<br/>  author, updated_at<br/>FROM knowledge_versions<br/>WHERE project_id=$1<br/>  AND (summary ILIKE $2 OR key ILIKE $2 OR topic ILIKE $2)<br/>  AND status != 'DEPRECATED'<br/>ORDER BY confidence DESC, updated_at DESC<br/>LIMIT 20
        PG-->>GW: text-matched rows
        GW-->>MCP: { results: [...], source: "postgres" }
        Note over GW,MCP: Dashboard shows subtle "PG fallback" indicator when source=postgres
    end

    MCP-->>CC: formatted search results
    CC->>CC: surface candidates → recall() on specific keys
```

---

## Sequence: GET /api/knowledge/:topic/:key — Dashboard Detail Panel

The dashboard Knowledge Browser calls this when a user clicks a row. This is also the same
path the MCP recall tool uses under the hood.

```mermaid
sequenceDiagram
    participant BROWSER as Dashboard (React)
    participant GW as Gateway /api/*
    participant PG as PostgreSQL
    participant GRAPHITI as Graphiti MCP

    BROWSER->>GW: GET /api/knowledge/auth/token-strategy<br/>X-Quorum-Project: amethyst-munchkin

    GW->>PG: SELECT * FROM knowledge_versions<br/>WHERE project_id=$1 AND topic=$2 AND key=$3<br/>AND status='ACTIVE' ORDER BY version DESC LIMIT 1
    PG-->>GW: row { topic, key, version, summary, confidence, status, author, ... }

    alt summary column populated (v0.3+ writes)
        GW-->>BROWSER: { topic, key, version, content: row.summary, confidence, ... }
    else summary empty — legacy entry
        GW->>GRAPHITI: search_nodes({ query: "auth:token-strategy", max_nodes: 5 })
        GRAPHITI-->>GW: { nodes: [...] }
        GW->>GW: nodes.find(n => n.name.includes("token-strategy"))
        alt Matching node found
            GW-->>BROWSER: { ..., content: node.summary }
        else No match
            GW-->>BROWSER: { ..., content: null }
            Note over BROWSER: Shows: "Content stored in Graphiti —<br/>try semantic search to retrieve it."
        end
    end

    BROWSER->>GW: GET /pg/versions/auth/token-strategy/history
    GW->>PG: SELECT * FROM knowledge_versions<br/>WHERE project_id=$1 AND topic=$2 AND key=$3<br/>ORDER BY version DESC
    PG-->>GW: [ {v2, ACTIVE}, {v1, SUPERSEDED} ]
    GW-->>BROWSER: [ ...version array ]

    BROWSER->>BROWSER: KnowledgeDetail renders content + VersionTimeline
```

---

## Sequence: POST /api/bump/:topic/:key — Confidence Endorsement

The bump endpoint is how engineers signal trust in a knowledge entry without superseding it.
It applies a role-weighted delta capped at `starting_confidence`, enforces a 7-day cooldown
per author, and feeds the same audit pipeline as writes.

```mermaid
sequenceDiagram
    participant ENG as Engineer (Dashboard)
    participant GW as Gateway
    participant PG as PostgreSQL
    participant AUDIT as Audit Pipeline

    ENG->>GW: POST /api/bump/auth/token-strategy<br/>X-Quorum-Project: amethyst-munchkin<br/>Authorization: Bearer {jwt}
    Note over GW: verify-jwt → req.user = { sub:"alice", role:"principal_architect", base_confidence:0.9 }

    GW->>PG: SELECT * FROM bump_log<br/>WHERE topic=$1 AND key=$2 AND author=$3<br/>AND project_id=$4<br/>AND created_at > NOW() - INTERVAL '7 days'

    alt Cooldown active (bumped within 7 days)
        PG-->>GW: existing bump_log row
        GW-->>ENG: 429 { error: "already_bumped", next_eligible_at: "..." }
    else Cooldown clear
        PG-->>GW: empty

        GW->>PG: SELECT confidence, starting_confidence<br/>FROM knowledge_versions WHERE ...
        PG-->>GW: { confidence: 0.72, starting_confidence: 0.85 }

        GW->>GW: delta = base_confidence × role_weight_factor<br/>new_confidence = min(confidence + delta, starting_confidence)
        Note over GW: principal_architect weight > senior_engineer > engineer > anonymous<br/>Capped at starting_confidence — bumps restore, not inflate

        GW->>PG: UPDATE knowledge_versions<br/>SET confidence=$1, last_accessed_at=NOW()<br/>WHERE topic=$2 AND key=$3 AND project_id=$4
        PG-->>GW: updated

        GW->>PG: INSERT INTO bump_log<br/>(topic, key, author, project_id, delta, created_at)

        GW->>AUDIT: writeAuditEntry({ action:"bump", actor:sub, confidence_delta:delta })
        AUDIT->>PG: INSERT audit_entries (append-only, SHA256 chain)

        GW-->>ENG: 200 { confidence: 0.81, delta: 0.09 }
    end
```

---

## Flowchart: Redis Cache Hit/Miss — verify-jwt Profile Resolution

Every authenticated request passes through `verify-jwt`. Redis is the primary store for
user profiles; DynamoDB is the source of truth on a cache miss. This diagram shows why
cold-start latency (first request after Redis TTL expires) is higher than steady state.

```mermaid
flowchart TD
    REQ([Incoming request with Bearer JWT]) --> VERIFY[jwtVerify token\nwith ES256 public key]
    VERIFY -->|invalid / expired| REJECT[401 Unauthorized]
    VERIFY -->|valid| DECODE[Extract sub, is_admin\nRead X-Quorum-Project header]

    DECODE --> REDIS_GET["GET profile:{sub} from Redis"]

    REDIS_GET -->|HIT| PROFILE_FOUND[profile = cached value]
    REDIS_GET -->|MISS| DDB_QUERY["getUserProjects(sub) from DynamoDB"]
    DDB_QUERY -->|found| REDIS_WRITE["SET profile:{sub} TTL 300s\n(write-back)"]
    DDB_QUERY -->|not found| NO_PROJECTS[profile = { projects: [] }]
    REDIS_WRITE --> PROFILE_FOUND
    NO_PROJECTS --> PROFILE_FOUND

    PROFILE_FOUND --> FIND_PROJECT{project header set?\nAND project in profile?}
    FIND_PROJECT -->|Yes| ATTACH_FULL["req.user = { sub, is_admin,\n  project, role, base_confidence, is_owner }"]
    FIND_PROJECT -->|Header missing| ATTACH_NULL["req.user = { sub, is_admin,\n  project: null, role: null }"]
    FIND_PROJECT -->|Header set but not member| ATTACH_NULL

    ATTACH_FULL --> ROUTE[Route handler executes]
    ATTACH_NULL --> GUARD{Route requires project?}
    GUARD -->|Yes| FOUR_HUNDRED[400 X-Quorum-Project header required]
    GUARD -->|No — auth/well-known routes| ROUTE

    ROUTE -->|Config change or role update| INVALIDATE["invalidateProfile(sub)\nDEL profile:{sub} from Redis\nPublish quorum:invalidate"]
    INVALIDATE -->|Next request| REDIS_GET
```

---

## Flowchart: Dual-Store Audit Write Pipeline

Every knowledge write — `remember()`, `review()`, `forget()` — goes through `withAuditPipeline`.
This wrapper guarantees that PostgreSQL audit entries and knowledge_version records are written
atomically and with bidirectional references before any Graphiti call is made.

```mermaid
flowchart TD
    WRITE_CALL([remember / review / forget\ncalled in quorum-mcp]) --> GATEWAY["POST /pg/versions or /api/review\nvia gateway HTTP"]

    GATEWAY --> AUDIT_PIPELINE["withAuditPipeline(pg, ctx, operation)"]

    AUDIT_PIPELINE --> CONSTITUTION[Constitutional check\nenforceReason ≥ 10 chars\nenforceNoSelfApproval\nverify triggered_by set]
    CONSTITUTION -->|Violation| THROW[Throw ConstitutionalViolation\n→ 422 to caller]
    CONSTITUTION -->|Pass| BEGIN_TX[BEGIN TRANSACTION]

    BEGIN_TX --> INSERT_AUDIT["INSERT audit_entries\n(append-only)\ncreated_by: sub\naction: store / supersede / deprecate\nversion_impact: { versions_created, versions_superseded }"]
    INSERT_AUDIT --> INSERT_VERSION["INSERT knowledge_versions\n(summary = content text)\n(content_hash = SHA256)\n(created_by_audit = audit_entry.id)"]

    INSERT_VERSION -->|Superseding| TRANSITION["UPDATE knowledge_versions\nSET status='SUPERSEDED'\nsuperseded_by_version=$newV\nsuperseded_by_author=$author\nsuperseded_at=NOW()\nWHERE topic=$t AND key=$k AND version=$oldV"]

    INSERT_VERSION --> COMMIT_TX[COMMIT TRANSACTION\nbidirectional refs guaranteed]
    TRANSITION --> COMMIT_TX

    COMMIT_TX -->|Async, non-blocking| GRAPHITI_WRITE["addEpisode / addSupersedingEpisode\n(Graphiti MCP via /graphiti/* proxy)\ngroup_id injected from req.user.project"]
    GRAPHITI_WRITE -->|Success| DONE([Return to caller])
    GRAPHITI_WRITE -->|Graphiti down — ignored| DONE
    Note right of GRAPHITI_WRITE: Graphiti failure never rolls back PG.\nPG summary is the durable content store.
```

---

## Updated Component Diagram — v0.3 Data Flows

This diagram extends the top-level component diagram to show v0.3-specific data paths:
the `summary` column as durable content store, `group_ids` omitted from all Graphiti searches,
and the slim JWT + `X-Quorum-Project` identity split.

```mermaid
graph TB
    subgraph identity["Identity (v0.3 split)"]
        JWT_SLIM["Slim JWT\n{ sub, is_admin }\nNO project/role/team"]
        PROJ_HDR["X-Quorum-Project: {group_id}\nper-request project context"]
    end

    subgraph knowledge_store["Knowledge Content — Durability Tiers"]
        PG_SUMMARY[("PostgreSQL\nknowledge_versions.summary\n✅ Durable — survives Docker wipes\nWritten on every remember() call")]
        GRAPHITI_GRAPH[("FalkorDB via Graphiti\nVector embeddings + entity graph\n⚠️  Volatile — wiped on docker volume clear\nNo group_ids in search calls\n(hyphen RediSearch bug)")]
    end

    subgraph cache_tier["Cache Tier (Redis v0.3)"]
        R_CONFIG["config:{group_id}\nTTL: QUORUM_CONFIG_CACHE_TTL\nSource: S3"]
        R_PROFILE["profile:{sub}\nTTL: QUORUM_PROFILE_CACHE_TTL\nSource: DynamoDB"]
        R_ADMIN["admin:platform\nTTL: QUORUM_ADMIN_CACHE_TTL\nSource: S3 configs/.quorum"]
        R_PUBSUB["quorum:invalidate channel\nPub/Sub for cache busting\nacross gateway replicas"]
    end

    subgraph read_paths["High-Traffic Read Paths"]
        RECALL["recall() → GET /pg/versions/:t/:k\n1. PG query (project scope)\n2. Global namespace fallback\n3. incrementDomainStat fire-and-forget"]
        SEARCH["search() → GET /api/search\n1. Graphiti searchNodes (no group_ids)\n2. PG ILIKE fallback if empty\nReturns source: graphiti|postgres"]
        KD["GET /api/knowledge/:t/:k\n1. PG summary column\n2. searchNodes fallback if null\n3. Returns content: null for wiped entries"]
    end

    subgraph write_path["Write Path"]
        WRITE["remember() → POST /pg/versions\nwithAuditPipeline wraps all writes\nPG transaction → then Graphiti async"]
        BUMP["POST /api/bump/:t/:k\n7-day cooldown per author\nrole-weighted delta\ncapped at starting_confidence"]
    end

    JWT_SLIM --> R_PROFILE
    PROJ_HDR --> RECALL
    PROJ_HDR --> SEARCH
    PROJ_HDR --> KD
    PROJ_HDR --> WRITE

    RECALL --> PG_SUMMARY
    SEARCH --> GRAPHITI_GRAPH
    SEARCH --> PG_SUMMARY
    KD --> PG_SUMMARY
    KD --> GRAPHITI_GRAPH

    WRITE --> PG_SUMMARY
    WRITE -.->|async| GRAPHITI_GRAPH
    BUMP --> PG_SUMMARY

    R_PUBSUB -.->|invalidate on config change| R_CONFIG
    R_PUBSUB -.->|invalidate on role change| R_PROFILE
```
