# Quorum — Product Feature Diagrams

> **Derived from the E2E test suite.** Every diagram below reflects only what the tests assert — not aspirational features. When a journey changes, update the corresponding diagram.

---

## Diagram Index

| Diagram | Source journey(s) |
|---------|------------------|
| [1. MCP Tool Coverage Map](#1-mcp-tool-coverage-map) | All journeys |
| [2. Knowledge Status State Machine](#2-knowledge-status-state-machine) | S-12, S-02.x |
| [3. Conflict Detection & Resolution Flow](#3-conflict-detection--resolution-flow) | S-02.2 – S-02.8, S-06, S-17 |
| [4. Deprecation Workflow](#4-deprecation-workflow) | S-03, S-05.3, S-05.5 |
| [5. Deviation Governance Lifecycle](#5-deviation-governance-lifecycle) | S-04, S-05.5, S-07 |
| [6. Conformance Scoring Model](#6-conformance-scoring-model) | S-07, S-04 |
| [7. RBAC Authority Boundaries](#7-rbac-authority-boundaries) | S-05.1 – S-05.6 |
| [8. Federation & Global Catalog Flow](#8-federation--global-catalog-flow) | S-01, S-05.4, S-11 |
| [9. Audit Chain Model](#9-audit-chain-model) | S-10, S-02.3 |
| [10. Authentication Lifecycle](#10-authentication-lifecycle) | S-19 |
| [11. Governance Edge Cases](#11-governance-edge-cases) | S-17 |

---

## 1. MCP Tool Coverage Map

Shows all 14 MCP tools and their E2E test coverage status.

```mermaid
graph LR
  subgraph WRITE["Write Path"]
    remember["remember()\nPOST /pg/versions"]
    forget["forget()\nPOST /pg/versions\n(deprecate)"]
    deviate["deviate()\nPOST /api/deviations"]
  end

  subgraph READ["Read Path"]
    recall["recall()\nGET /pg/versions/:t/:k"]
    search["search()\nGET /api/search\n+ Graphiti"]
    history["history()\nGET /pg/versions/:t/:k/history\n+ Graphiti SUPERSEDES"]
    conformance["conformance()\nGET /api/conformance"]
  end

  subgraph GOVERN["Governance"]
    review["review()\nPOST /api/review/:id"]
    pending["pending()\nGET /pg/pending"]
    reflect["reflect()\nPOST /governance/extract"]
  end

  subgraph INFRA["Infrastructure"]
    authenticate["authenticate()\nOAuth 2.1 PKCE"]
    set_agent_context["set_agent_context()\nmodule-level state"]
    config_upload["config_upload()\nPOST /config/upload"]
    export["export()\nPostgreSQL + Graphiti\ndirect query"]
  end

  remember --> |"S-02.1 through S-02.8\nS-05.1–5, S-06, S-10, S-11, S-12"| E2E_CORE(("✅ Core covered"))
  recall --> |"S-02.1, S-02.3–7, S-08, S-12, S-16"| E2E_CORE
  search --> |"S-01 ✓ cross-catalog\nS-02.1 ✓ project-local\n(ILIKE fallback)"| E2E_PARTIAL(("✅ Covered"))
  history --> |"S-16\nHTTP layer only"| E2E_PARTIAL
  conformance --> |"S-04, S-07"| E2E_CORE
  review --> |"S-02.3–8, S-03, S-05.4\nS-06, S-11, S-12, S-15"| E2E_CORE
  pending --> |"S-02.2, S-02.5\nS-03, S-04, S-06"| E2E_CORE
  forget --> |"S-03, S-05.3, S-05.5, S-12"| E2E_CORE
  deviate --> |"S-04, S-05.5, S-07"| E2E_CORE
  authenticate --> |"L1 auth.spec.js"| E2E_CORE
  config_upload --> |"S-01, S-13"| E2E_CORE
  reflect --> MT(("🔴 MT-02\nLLM quality\nnon-deterministic"))
  export --> MT2(("🔴 MT-05\nMCP client\nno HTTP route"))
  set_agent_context --> MT3(("🔴 MT-06\nMCP client\nmodule-level state"))
```

---

## 2. Knowledge Status State Machine

Source: S-12 (Parts 1–G). Every valid, invalid, and coexistence transition tested.

```mermaid
stateDiagram-v2
    [*] --> DRAFT : engineer / non-PA write\nstatus determined by role
    [*] --> ACTIVE : principal_architect write\n(ACTIVE immediately, no approval)

    DRAFT --> ACTIVE : promote (PA only)\nor PA direct write
    DRAFT --> REJECTED : review → reject\n(PA only)

    ACTIVE --> SUPERSEDED : supersede old version\natomic — new ACTIVE created simultaneously
    ACTIVE --> DEPRECATED : deprecate (PA only)\nor PA forget()

    note right of SUPERSEDED
        TERMINAL — no further transitions.
        Never deleted — provenance preserved.
        Audit lineage references both versions.
        Deprecate / supersede routes operate
        on ACTIVE only; SUPERSEDED is read-only.
    end note

    note right of DEPRECATED
        TERMINAL — no further transitions.
        Supersede returns 404 (no ACTIVE to replace).
        Promote returns 404 no_draft (not promotable).
        Entry disappears from Knowledge browser.
    end note

    note right of REJECTED
        Content discarded.
        No ACTIVE entry exists after rejection.
    end note

    note right of DRAFT
        Non-PA write to key with existing ACTIVE:
        lands as DRAFT (not 409 already_exists).
        DRAFT and ACTIVE coexist for the same key.
        Only PA writes return 409 on duplicate ACTIVE.

        Global catalog writes:
        ALL roles land as DRAFT regardless of role.
        (enforceGlobalWriteAuthority)

        GET /api/drafts — PE queue view:
        returns DRAFT entries awaiting review.
        ACTIVE entries excluded from this endpoint.
        After promotion, entry leaves the drafts list.
    end note
```

---

## 3. Conflict Detection & Resolution Flow

Source: S-02.2 (detection), S-02.3–S-02.7 (resolution types), S-02.8 (dashboard), S-06 (multi-user).

```mermaid
flowchart TD
    A["agent calls remember(topic, key, content)"] --> B{"semantic similarity\nsearch across\nproject + global catalogs"}
    B -- "no match found\nor score below threshold" --> C["knowledge stored\nstatus: ACTIVE or DRAFT\n(depends on author role)"]
    B -- "near-duplicate found" --> D["conflict_detected returned\nentry NOT stored\nconflict_id in response"]

    D --> E["conflict record created\nin pending_decisions\nLLM enrichment added async"]

    E --> F["PE reviews\nGET /pg/pending\n→ conflict_briefs array"]
    F --> G["PE picks resolution type"]

    G --> H{resolution}
    H -- supersede --> I["incoming → ACTIVE\nexisting → SUPERSEDED\nreason stored on new version"]
    H -- reject --> J["incoming discarded\nexisting unchanged\nstatus stays ACTIVE"]
    H -- escalate --> K["conflict stays in pending\nstatus: escalated\nfor architecture board"]
    H -- coexist_split --> L["two new ACTIVE entries\nat PE-specified keys\noriginal → SUPERSEDED"]
    H -- coexist_merge --> M["PE-written merged content\nbecomes new ACTIVE\nboth originals → SUPERSEDED"]
    H -- request_changes --> N["conflict stays in pending\nPE note stored\nno state change"]

    N --> F

    subgraph STALE["Stale conflict (S-06)"]
        O["second conflict arrives\nfor same topic:key\nmore_pending_same_key increments"]
        P["first conflict resolved\n→ second shows stale_warning\nbecause active version advanced"]
    end

    style I fill:#d4edda
    style J fill:#d4edda
    style L fill:#d4edda
    style M fill:#d4edda
    style K fill:#fff3cd
    style N fill:#fff3cd
```

---

## 4. Deprecation Workflow

Source: S-03 (full lifecycle), S-05.3 (RBAC: direct deprecate), S-05.5 (forget branching by role).

```mermaid
flowchart TD
    A["forget(topic, key)\nPOST /pg/versions\nstatus: deprecated"] --> B{author role?}

    B -- "principal_architect" --> C["ACTIVE → DEPRECATED\ndirectly, atomically\nno pending queue"]
    B -- "any other role" --> D{"already requested\nby same author?"}

    D -- yes --> E["status: already_requested\ndeduplication — no second row"]
    D -- no --> F["status: deprecation_requested\nrequest queued in pending_decisions"]

    F --> G{"active version advanced\nsince request was created?"}
    G -- yes --> H["stale_warning badge\nshown on pending row\nfor PE to consider"]
    G -- no --> I["normal pending row"]

    H --> J["PE reviews /pending\n→ deprecation_requests section"]
    I --> J

    J --> K{PE action}
    K -- "approve + valid reason" --> L["ACTIVE → DEPRECATED\natomic transition\nknowledge disappears from browser"]
    K -- "reject + valid reason" --> M["entry stays ACTIVE\nrequest resolved: rejected"]

    L --> N["audit lineage: ACTIVE → DEPRECATED\nversion lineage shows transition\nKnowledge browser: entry removed"]

    style C fill:#d4edda
    style L fill:#d4edda
    style M fill:#fff3cd
    style E fill:#f8d7da
```

---

## 5. Deviation Governance Lifecycle

Source: S-04 (full lifecycle), S-05.5 (RBAC), S-07 (conformance impact).

```mermaid
flowchart TD
    A["agent scan finds gap\ndeviate(catalog_id, topic, key,\ndescription, evidence)"] --> B{catalog_id in\nproject globals?}

    B -- no --> C["400 not_linked"]
    B -- yes --> D{"topic:key exists\nin global catalog?"}

    D -- no --> E["404 not_found"]
    D -- yes --> F["severity derived server-side\n= confidence × author_role_score\nPA floor: min 0.70"]

    F --> G{"already recorded?\n(project, catalog, topic, key)"}
    G -- yes --> H["upsert: last_seen_at updated\nis_new: false\nidempotent re-scan"]
    G -- no --> I["new deviation row\nstatus: OPEN\nis_new: true"]

    I --> J["PE / architect actions\n(enforceDeviationActionAuthority:\narchitect+ only)"]
    H --> J

    J --> K{action_type}

    K -- accept --> L["ACCEPTED\nweight: 1.0 in score\nowned debt — still counts"]
    K -- deny --> M["DENIED\nweight: 0.3 in score\ndenial hint if PA + high confidence"]
    K -- "defer (30/45/60/90d)" --> N{"deadline valid?\nexactly 30/45/60/90 days"}

    N -- invalid --> O["400 DEFER_DEADLINE\nconstitutional violation"]
    N -- valid --> P["DEFERRED\nweight: 0.6 in score\ndefer_until stored"]

    P --> Q{"defer_until\npassed?"}
    Q -- yes --> R["OVERDUE\nweight: 1.0\nappears in /pending\noverdue_deferrals"]
    Q -- no --> P

    I --> S["resolved_at set by scan\n(no longer surfaced)"]
    S --> T["RESOLVED\nweight: 0.0"]

    style L fill:#fff3cd
    style M fill:#fff3cd
    style P fill:#cce5ff
    style R fill:#f8d7da
    style T fill:#d4edda
    style O fill:#f8d7da
```

---

## 6. Conformance Scoring Model

Source: S-07 (UNCERTIFIED → CERTIFIED lifecycle), S-04 (deviation status weights).

```mermaid
flowchart LR
    subgraph UNCERTIFIED_STATES["UNCERTIFIED — no numeric score shown"]
        U1["no globals linked\nproject has no global catalogs"]
        U2["linked but sparse\n< 10 ACTIVE entries\nacross all linked catalogs"]
        U3["10+ entries but\nscan_count = 0\nno scan has been run"]
    end

    subgraph CERTIFIED["CERTIFIED — numeric score 0–100"]
        C1["score = ❨1 − weighted_ratio❩ × 100"]
        C2["weighted_ratio =\nΣ❨deviation.severity × status_weight❩\n÷ applicable_catalog_entries"]
        C3["status weights:\nOPEN → 1.0\nOVERDUE → 1.0\nACCEPTED → 1.0\nDEFERRED → 0.6\nDENIED → 0.3\nRESOLVED → 0.0"]
    end

    U1 --> CERT_GATE{"≥ 10 ACTIVE entries\nacross all linked catalogs\nAND scan_count ≥ 1?"}
    U2 --> CERT_GATE
    U3 --> CERT_GATE

    CERT_GATE -- yes --> C1
    CERT_GATE -- no --> UNCERTIFIED_STATES

    C1 --> BADGE{score}
    BADGE -- "≥ 80" --> GREEN["🟢 green badge"]
    BADGE -- "50–79" --> AMBER["🟡 amber badge"]
    BADGE -- "< 50" --> RED["🔴 red badge"]

    subgraph HIERARCHY_ROLLUP["Portfolio Rollup (hierarchy)"]
        R1["node_score = Σ❨child_score × criticality❩ ÷ Σ❨criticality❩"]
        R2["UNCERTIFIED children excluded\nfrom rollup, counted separately"]
    end

    note1["ACCEPTED weight = 1.0 is intentional:\naccepting a deviation does NOT improve your score.\nThe incentive to accept is the audit trail, not score reward."]
```

---

## 7. RBAC Authority Boundaries

Source: S-05.1–S-05.6. The complete role × operation matrix that the tests enforce.

```mermaid
graph TB
    subgraph ROLES["Role Tiers (authority.js)"]
        PA["principal_architect\nscore: 1.00 / tier 4"]
        PE_EQUIV["architect / product_owner\ncompliance_officer\nscore: 0.80–0.90 / tier 3"]
        ENG["senior_engineer / engineer\nscore: 0.55–0.70 / tier 2"]
        EXEC["director / vp_engineering\ngroup_executive\nscore: 0.70–0.75 / tier 3\nread-only governance"]
        ADMIN["is_admin: true\nplatform admin\nnot a role — a flag"]
    end

    subgraph KNOWLEDGE_WRITE["Knowledge Write (S-05.1)"]
        KW1["All roles: POST /api/knowledge\n→ 200 OK"]
        KW2["PA → status: ACTIVE immediately"]
        KW3["All others → status: DRAFT"]
    end

    subgraph GOVERNANCE["Governance Actions (S-05.2, S-05.3, S-05.4)"]
        G1["promote / supersede / deprecate\nbulk-deprecate / conflict-review\n→ PA only\nAll others: 403 forbidden"]
    end

    subgraph GLOBAL_WRITE["Global Catalog Writes (S-05.4)"]
        GW1["engineer / senior_engineer\ndirector / vp_engineering\n→ 403 GLOBAL_WRITE_AUTHORITY"]
        GW2["architect / product_owner\ncompliance_officer\n→ 200 DRAFT\n(needs PA approval)"]
        GW3["principal_architect\n→ 200 ACTIVE directly"]
    end

    subgraph DEVIATION_ACTION["Deviation Actions (S-05.5)"]
        DA1["engineer / senior_engineer\ndirector / vp_engineering\n→ 403 DEVIATION_ACTION_AUTHORITY"]
        DA2["architect / principal_architect\nproduct_owner / compliance_officer\n→ 200 OK"]
    end

    subgraph PORTFOLIO["Portfolio Access (S-05.6)"]
        PF1["engineer / senior_engineer\narchitect\nproduct_owner / compliance_officer\n→ 403"]
        PF2["principal_architect\ndirector / vp_engineering\n→ 200 OK"]
    end

    subgraph FORGET_BRANCH["forget() Branching (S-05.5, S-03)"]
        FB1["PA → deprecated directly"]
        FB2["All others → deprecation_requested\n(queued for PE review)"]
    end

    PA --> KW2
    PA --> G1
    PA --> GW3
    PA --> DA2
    PA --> PF2
    PA --> FB1

    PE_EQUIV --> KW3
    PE_EQUIV --> GW2
    PE_EQUIV --> DA2
    PE_EQUIV --> FB2

    ENG --> KW3
    ENG --> GW1
    ENG --> DA1
    ENG --> FB2

    EXEC --> KW3
    EXEC --> GW1
    EXEC --> DA1
    EXEC --> PF2
    EXEC --> FB2

    ADMIN --> |"GET /admin/config\nPOST /admin/users\nis_admin flag only\nno role equivalent"| ADMIN_ROUTES["Admin routes\n403 for all non-admin JWTs"]
```

---

## 8. Federation & Global Catalog Flow

Source: S-01 (setup + cross-catalog reads), S-05.4 (write authority), S-11 (global writes always DRAFT).

```mermaid
sequenceDiagram
    participant PA as test-pe (PA)
    participant Arch as test-architect
    participant Eng as test-engineer
    participant GW as Gateway
    participant DB as PostgreSQL
    participant Graph as Graphiti

    Note over PA,Graph: Setup — upload configs (S-01, S-13)
    PA->>GW: POST /config/upload (quorum-test-catalog is_global: true)
    GW->>DB: INSERT q_projects (is_global=TRUE)
    PA->>GW: POST /config/upload (quorum-test-project globals: [quorum-test-catalog])
    GW->>DB: INSERT q_projects with globals link validated

    Note over PA,Graph: PA writes to global catalog — lands ACTIVE
    PA->>GW: POST /api/knowledge (project=quorum-test-catalog)
    GW->>GW: enforceGlobalWriteAuthority(PA, catalog, isGlobal=true) → PASS
    GW->>DB: INSERT knowledge_versions status=ACTIVE
    GW->>Graph: add_memory (group_id=quorum-test-catalog)

    Note over Arch,Graph: Architect writes to global catalog — lands DRAFT
    Arch->>GW: POST /api/knowledge (project=quorum-test-catalog)
    GW->>GW: enforceGlobalWriteAuthority(architect, catalog, isGlobal=true) → PASS
    GW->>DB: INSERT knowledge_versions status=DRAFT (architect → always DRAFT)
    PA->>GW: POST /api/review/:id approve
    GW->>DB: UPDATE status=ACTIVE

    Note over Eng,Graph: Engineer reads — cross-catalog search
    Eng->>GW: GET /api/search?q=TLS (project=quorum-test-project)
    GW->>GW: load project config → globals=[quorum-test-catalog]
    GW->>Graph: searchNodes(q, groupIds=[quorum-test-project, quorum-test-catalog])
    Graph-->>GW: nodes from both projects
    GW-->>Eng: results annotated source: "global", catalog_id: "quorum-test-catalog"

    Note over Eng,Graph: Knowledge browser — no global bleed (S-01 step 14)
    Eng->>GW: GET /api/knowledge (project=quorum-test-project)
    GW-->>Eng: only project-local ACTIVE entries (no global entries shown)

    Note over Eng,Graph: Conflict detection spans globals (Wave B fix)
    Eng->>GW: POST /api/knowledge (content contradicts global entry)
    GW->>Graph: searchNodes(content, groupIds=[project, ...globals])
    Graph-->>GW: conflict found in global catalog
    GW-->>Eng: status: conflict_detected (not silently stored)
```

---

## 9. Audit Chain Model

Source: S-10 (Parts A–C: chain integrity, append-only, BLOCKED_METHODS), S-02.3 (lineage after supersede).

```mermaid
flowchart LR
    subgraph EVERY_WRITE["Every knowledge write (remember/review/forget/deprecate)"]
        W1["Tool called"]
        W2["INTENT audit entry written\n(before action)\nchain_position: N\nentry_hash: SHA256(payload+prev_hash)"]
        W3["Business operation\nexecuted atomically\n(PostgreSQL transaction)"]
        W4["OUTCOME audit entry written\n(after action)\nchain_position: N+1\nprev_hash: entry_hash of INTENT"]
    end

    W1 --> W2 --> W3 --> W4

    subgraph CHAIN_PROPERTIES["Chain properties — S-10 Part A"]
        CP1["Sequential integers — no gaps\nNo duplicate chain_positions\nEven after concurrent writes"]
        CP2["Hash chain: each entry's prev_hash\n= entry_hash of position N-1\nTamper detection: any edit breaks the chain"]
        CP3["total_entries only increases\n(GET /pg/audit/stats called twice\n→ second call ≥ first)"]
    end

    subgraph APPEND_ONLY["Append-only enforcement — S-10 Part B (Rule 2)"]
        AO1["PATCH /pg/audit/:id → 404 or 405\nNo modification route exists"]
        AO2["DELETE /pg/audit/:id → 404 or 405\nNo deletion route exists"]
        AO3["Entry hash unchanged after\nboth failed attempts\n(read lineage to verify)"]
        AO4["updateEntry() / deleteEntry()\nalways throw in audit/secondary.js\n(100% constitutional test coverage)"]
    end

    subgraph BLOCKED_METHODS["No hard delete — S-10 Part C (Rule 1)"]
        BM1["POST /graphiti/mcp\n{ method: 'tools/call',\n  params: { name: 'delete_entity', ... } }\n→ 400 or 403"]
        BM2["Gateway blocks before\nrequest reaches Graphiti.\nBLOCKED_METHODS list:\ndelete_entity / delete_fact /\ndelete_episode / delete_memory"]
        BM3["Entry remains ACTIVE after\nblocked attempt\n(no partial deletion side effect)"]
        BM4["No audit entry created\nfor a blocked call"]
    end

    subgraph LINEAGE_API["Audit lineage endpoint"]
        LA1["GET /pg/audit/lineage/:topic/:key\nReturns bidirectional audit trail\nfor a specific knowledge entry"]
        LA2["Every version record → created_by_audit\nEvery audit entry → version_id\n(bidirectional references)"]
    end

    subgraph WHAT_IS_RECORDED["What each audit entry contains"]
        AE1["tool: remember/review/forget/export/...\nauthor: GitHub username\nsession_id: from set_agent_context\nauthor_type: agent | human\ntriggered_by: always set (never null)"]
        AE2["governance_json: intent payload\noutcome_json: result payload\nversion_id: linked version row\nchain_position: sequential integer\nentry_hash: SHA256 of this entry\nprev_hash: chain link"]
    end
```

---

## 10. Authentication Lifecycle

Source: S-19. Automated boundary testing for JWT, JWKS, project scoping, token refresh, and PAT.

```mermaid
flowchart TD
    subgraph JWT_VALIDATION["JWT Validation — S-19 Part A"]
        JV1["Valid ES256 token\n→ 200 / 404 (not 401)"]
        JV2["Missing Authorization header\n→ 401"]
        JV3["Expired token (exp in past)\n→ 401"]
        JV4["Tampered payload + original signature\n→ 401 (signature mismatch)"]
        JV5["HS256-signed token\n→ 401 (algorithm enforcement — ES256 only)"]
        JV6["Valid signature but unknown sub\nnot in DDB user-projects table\n→ 401"]
    end

    subgraph JWKS["JWKS Endpoint — S-19 Part B"]
        JK1["GET /.well-known/jwks.json\n→ 200, no auth required"]
        JK2["kty: 'EC'\nalg: 'ES256'\ncrv: 'P-256'\nuse: 'sig'\nkid: present"]
        JK3["No HS256 or RSA keys\nin the key set"]
    end

    subgraph PROJECT_SCOPING["Project Scoping — S-19 Part C"]
        PS1["Valid JWT + member project\n→ 200"]
        PS2["Valid JWT + non-member project\n→ 403 or 404"]
        PS3["Valid JWT + missing X-Quorum-Project\n→ 400 missing_header"]
    end

    subgraph TOKEN_REFRESH["Token Refresh — S-19 Part D"]
        TR1["Valid refresh token\n→ 200, new JWT with future expiry"]
        TR2["Expired refresh token\n→ 401"]
        TR3["Fabricated refresh token\n→ 401"]
    end

    subgraph PAT["PAT Authentication — S-19 Part E"]
        PA1["Valid PAT in Authorization header\n→ 200 (same routes as JWT)"]
        PA2["Invalid / revoked PAT\n→ 401"]
    end

    subgraph MANUAL["Manual Tests (not automatable)"]
        MT11["MT-11: GitHub OAuth browser flow\nRedirect → callback → JWT issue\nrequires live GitHub OAuth app"]
        MT12["MT-12: PKCE OAuth 2.1 MCP client\nauthorization_code + code_verifier\nrequires live MCP client (stdio)"]
    end
```

---

## 11. Governance Edge Cases

Source: S-17 (Parts A–D). Auto-supersede, PENDING_CONFLICT_CHECK fallback, cross-catalog conflict, enrichment shape.

```mermaid
flowchart TD
    subgraph AUTO_SUPERSEDE["Auto-Supersede — S-17 Part A (GV-1)"]
        AS1["PA writes entry\nconfidence: 0.50 → ACTIVE v1"]
        AS2["PA writes same key again\nconfidence: 0.95\nshouldAutoSupersede() fires\n(authority delta > AUTHORITY_THRESHOLD)"]
        AS3["supersede() called directly\nNO pending_decision created\nNO human review step"]
        AS4["v1 → SUPERSEDED\nv2 → ACTIVE\naudit: conflict_resolution='auto_supersede'\nno reviewer field"]
        AS5["GET /pg/pending: no new decision\nfor this topic:key (auto-resolved)"]
        AS1 --> AS2 --> AS3 --> AS4 --> AS5
    end

    subgraph PENDING_CC["PENDING_CONFLICT_CHECK — S-17 Part B (GV-2)"]
        PC1["Graphiti service unavailable\n(docker pause or unreachable URL)"]
        PC2["remember() call still succeeds\nentry stored with\nstatus: 'PENDING_CONFLICT_CHECK'\n(write must never fail due to\nGraphiti outage)"]
        PC3["Graphiti service resumed"]
        PC4["GET /pg/pending shows entry\nwith status: 'PENDING_CONFLICT_CHECK'\nfor PE to manually review"]
        PC1 --> PC2 --> PC3 --> PC4
    end

    subgraph CROSS_CATALOG["Cross-Catalog Conflict — S-17 Part C (Wave B fix)"]
        CC1["Global catalog has ACTIVE entry\n(security:tls-minimum-version)\nindexed in Graphiti"]
        CC2["graphitiSettle() — wait for indexing"]
        CC3["Project write: content contradicts\nthe global catalog entry\n(project linked via globals: [quorum-test-catalog])"]
        CC4["detectConflict() searches\ngroupIds: [project, quorum-test-catalog]\n→ match found in global catalog"]
        CC5["status: 'conflict_detected'\nconflicting entry has\nsource: 'global'\ncatalog_id: 'quorum-test-catalog'"]
        CC1 --> CC2 --> CC3 --> CC4 --> CC5
    end

    subgraph ENRICHMENT["Enrichment Shape — S-17 Part D (GV-4)"]
        EN1["POST /api/review/:id (conflict action)\nLLM enrichment triggered async"]
        EN2["GET /pg/pending — conflict entry\nenrichment object shape:"]
        EN3["enrichment.analysis: non-empty string\nenrichment.risks_if_approved: Array (2–4 items)\nenrichment.questions_for_reviewer: Array (2–3 items)"]
        EN1 --> EN2 --> EN3
    end

    subgraph WEBHOOK["MT-08 — fireWebhookAsync (manual)"]
        WH1["Conflict detected → async webhook fired\nNon-blocking: response does NOT wait\nConfigure QUORUM_WEBHOOK_URL\nVerify payload: { event: 'conflict_detected',\ntopic, key, conflict_brief }"]
    end
```

---

## Appendix: Suite Weight Summary

| Tier | Scenarios | Weight | Notes |
|------|-----------|--------|-------|
| F4 — core agent workflow | S-02.1–8, S-11 | 156 | every interaction |
| F3 — daily governance/security | S-05.1–6, S-06, S-15, S-19 | 423 | governance + auth lifecycle |
| F2 — weekly operational | S-03, S-04, S-07, S-08, S-12, S-17 | 264 | deviations, deprecations, scoring, conflict edge cases |
| F1.5 — periodic | S-10, S-14, S-16, S-18 | 79.5 | audits, visual, history, governance routes |
| F1 — one-time / rare | S-01, S-09, S-13 | 49 | setup, admin, config |

**Total suite weight: 1107 | 10% gate: 110.7 | Max single blast radius: 7.1% (S-05.1)**

> Suite total recalculated after adding J17 (32), J18 (18), J19 (45) and extending J04 (+4), J09 (+2), J10 (+10.5), J12 (+22), J13 (+4), J15 (+12).
> See [RISK_WEIGHTED_TEST_PLAN.md](../RISK_WEIGHTED_TEST_PLAN.md) for the full binary tree and gate derivation.
