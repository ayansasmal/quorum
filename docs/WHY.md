# Why Quorum?

> Eight narratives from teams who've felt this pain — five within a single team, three that emerge only when you scale across teams.

---

## 1. The institutional memory problem

Your most senior engineer leaves. They spent three years making decisions: why you use session tokens instead of JWTs for internal services, why the connection pool is capped at 10, why you never call the payments API directly from Lambda functions. It's all in their head — or scattered across 200 Slack threads and a stale Confluence page nobody updates.

The new hire asks Claude Code for advice. Claude gives technically correct guidance that contradicts every one of those decisions. Your codebase gradually drifts toward patterns your senior engineer would never have allowed.

**What Quorum does:** every architectural decision your team makes through Claude Code is stored with its author, rationale, and confidence level. When the same question comes up six months later, Claude recalls the existing decision before offering advice — and if the new context suggests the decision should change, it surfaces the conflict for a human to resolve rather than silently overwriting it.

---

## 2. The AI contradiction problem

You have three engineers using Claude Code simultaneously. They're all building different parts of the same system. By end of week:

- One has stored “always use exponential backoff with jitter for retries”
- Another has stored “use a fixed 500ms retry interval for simplicity”
- A third asked Claude about retry strategy and got a synthesis of both, presented confidently

Nobody flagged the conflict. The codebase now has two retry patterns. Future Claude sessions inherit whichever snippet they happen to read first.

**What Quorum does:** when a second entry is stored that contradicts an existing one, Quorum surfaces the conflict immediately — with the original author, the timestamp, and an LLM analysis of the tension. A human decides: supersede, coexist in different contexts, or reject the new addition. The decision and the reason are stored. The contradiction cannot silently persist.

---

## 3. The onboarding cost problem

Onboarding a new engineer costs two to four weeks of senior time — not because the codebase is complex, but because the *reasoning* behind the codebase is invisible. Why is this service stateless? Why does this queue use dead-letter routing but that one doesn’t? Why is there a custom auth middleware when the framework ships one?

The answers exist. They're in ADR documents nobody reads, commit messages nobody searches, and the minds of people who've moved on.

**What Quorum does:** the Claude Code skill runs `reflect()` after every significant task, automatically extracting learnable decisions and patterns into the knowledge graph. Within weeks of onboarding Quorum, teams have a living ADR library that stays current because it’s maintained by the engineers doing the work — not by a documentation process that competes with shipping.

New engineers ask Claude Code questions and get answers grounded in *your team’s actual decisions* — not generic best practices.

---

## 4. The decision drift problem

Six months ago your principal architect decided: “No direct database access from Lambda functions — all DB calls go through the service layer.” It was a hard-won decision after a production incident. It’s in an ADR. It’s in Confluence. It’s been ignored in twelve PRs since then because nobody checks.

**What Quorum does:** the decision is stored with `authority_weight: 1.0` under the principal architect’s identity. When an engineer or agent attempts to write a pattern that violates it, the conflict is surfaced — not as a lint rule, but as a governed knowledge conflict that requires a human resolution. The only way to override it is to explicitly supersede it with a reason, creating an audit trail that captures who made the call and why.

Authority-weighted knowledge means the decisions that matter most are the hardest to accidentally override.

---

## 5. The buried business requirement problem

A product manager makes a call: guest checkout must remain available. Conversion research showed 40% of users abandon when forced to register. The requirement ships. The feature works. The ticket closes.

Six months later, a developer is refactoring the checkout flow. The guest path looks like dead code — there’s no test specifically labelled “guest checkout requirement” and the analytics dashboard isn’t obvious. They remove it. The business rationale was buried in a Jira ticket, invisible to Claude Code. The regression ships.

This isn’t an engineering knowledge failure. It’s a *business knowledge* failure. The feature existed because of a product decision, not a technical one. No architectural decision record covers it. No pattern describes it. The *why this exists* was never stored anywhere the team’s AI tooling could see.

**What Quorum does:** business requirements are first-class knowledge. The requirement is stored as `product:guest-checkout-requirement`, entity type `Requirement`, authored by the product manager: *“Guest checkout must remain available. Conversion data shows 40% abandonment on mandatory registration. Any removal requires product owner sign-off and fresh conversion analysis.”*

When the developer’s agent generates a refactor that removes the feature, the conflict surfaces immediately: an active requirement with the product owner’s authority exists. The human decides — not the refactor.

Engineering decisions explain *how* things are built. Business requirements explain *why* they exist and *when* they apply. Both are institutional knowledge. Both are stored, governed, and protected in Quorum.

---

## 6. The invisible standard violation problem

Your platform team maintains a global engineering catalog: "all services must use KMS for secrets at rest", "PII must never leave `eu-west-1`", "never store session tokens in Redis". Twelve product teams are building services. They all use Claude Code. They have no visibility into the global catalog — their agents give advice based on the team's local knowledge graph.

A new service team stores a pattern: "use environment variables for API keys — simple and portable." Their agent follows it. Three services ship with API keys in env vars. The KMS requirement was in the global catalog. Nobody saw the conflict.

**What Quorum does:** federation and deviation governance work together. Product teams link their project config to the global catalog: `"globals": ["platform-security-standards"]`. Now every `remember()` call by any agent on that team runs conflict detection against both the local graph and the global catalog. The pattern "use environment variables for API keys" triggers a conflict with the global KMS standard — immediately, at write time, before any code ships.

The team's agent records the deviation via `deviate()` rather than silently proceeding. The principal engineer reviews it: accept as a sanctioned exception (with reason and expiry), deny (must fix before next release), or defer (30, 45, 60, or 90 days with a mandatory revisit). The conflict is governed, not ignored.

The platform team can see which services have open deviations against their standards. "We have a KMS compliance gap on three services" becomes a fact, not a suspicion.

---

## 7. The standards compliance black hole

Six months after adopting shared engineering standards, your CTO asks a simple question: are teams actually following them? The honest answer is: nobody knows.

Some teams are rigorous. Others have drifted. A few have made intentional exceptions that were never documented. The platform team has a catalog of 40 ACTIVE standards. None of the 12 product teams has a conformance score. The quarterly engineering review is tomorrow.

**What Quorum does:** every project that links a global catalog gets a conformance score automatically. The score is weighted: unactioned OPEN deviations reduce it the most, OVERDUE deferrals nearly as much, ACCEPTED exceptions reduce it less (they're governed), DENIED deviations the least (someone rejected the standard, which is governed), RESOLVED deviations not at all. A project with no global catalogs or fewer than 10 ACTIVE catalog entries shows as UNCERTIFIED — which is itself signal.

The `conformance()` MCP tool lets any agent check a project's score and surface the top open deviations by severity before the review. The dashboard Stats page shows each project's score badge — green above 80, amber 50–80, red below 50. The CTO's portfolio view shows a weighted rollup across all certified projects, org-wide compliance at a glance.

"Are teams following standards?" goes from an unanswerable question to a number with a breakdown.

---

## 8. The portfolio blindspot

A VP of Engineering oversees eight teams. Each runs Claude Code with their own Quorum project. Each has a local knowledge graph growing steadily. But from the VP's perspective, the org is opaque: which teams are aligned to global standards? Which have open deviations that have gone stale? Which team's architecture is drifting in a direction that contradicts what the platform team established?

The answer lives in eight separate graphs that nobody has a cross-cutting view of.

**What Quorum does:** portfolio intelligence is role-gated to `principal_architect`, `director`, `vp_engineering`, `group_executive`, and admins — no accidental exposure of project internals. The `GET /api/portfolio` endpoint loads every project, applies the org hierarchy filter (so a VP only sees teams under their node), and returns a weighted criticality rollup: a single portfolio conformance score, a count of certified vs uncertified projects, and per-project scores.

In the Knowledge browser, global catalog entries show a `denial_hint_count` badge — a red pill showing how many projects have explicitly denied that standard. A catalog entry with eight denials is a signal that the standard may be unrealistic or needs revisiting. One denial might be a rogue team. Eight is a policy problem.

The VP doesn't need to chase eight team leads for a status update. The governance trail is already there — because every deviation, every acceptance, every deferral was recorded at the point it happened.

---

## Who Quorum is for

- **Engineering managers** whose teams use AI coding assistants and need confidence that agents are following the team’s actual standards — not generic internet advice.
- **Platform engineers** building internal developer platforms who want AI assistance to be consistent, governed, and auditable across all teams connecting to the platform. Global catalogs let the platform team publish standards once and have every product team’s agents check against them automatically.
- **CTOs and architects** who need to know that critical decisions — auth patterns, data residency constraints, compliance requirements — cannot be quietly overridden by a well-meaning junior engineer or an AI that doesn’t know what it doesn’t know. The portfolio view gives a single weighted conformance score across all teams without chasing eight team leads.
- **VPs of Engineering and directors** who need org-wide visibility into how well teams are aligned to shared standards, where deviations are piling up, and which parts of the portfolio are drifting — without reading eight separate knowledge graphs.
- **Principal architects** who set global standards and need to know when teams deviate, why, and whether those deviations are governed (accepted/denied/deferred) or just silently happening.
- **Product managers** whose feature requirements and business rules need to survive refactors, team changes, and the next AI assistant that joins the team.
- **Teams scaling their use of Claude Code** beyond individual productivity into shared, collaborative AI-assisted engineering — and beyond a single team into multi-team organisations where standards need to travel with the work.

---

Quorum is not a knowledge base you maintain. It’s a governance layer that grows from the work your team is already doing — engineering and business alike.
