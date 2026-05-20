# Why Quorum?

> Four narratives from teams who've felt this pain — plus one that most teams don't realise they have.

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

## Who Quorum is for

- **Engineering managers** whose teams use AI coding assistants and need confidence that agents are following the team’s actual standards — not generic internet advice.
- **Platform engineers** building internal developer platforms who want AI assistance to be consistent, governed, and auditable across all teams connecting to the platform.
- **CTOs and architects** who need to know that critical decisions — auth patterns, data residency constraints, compliance requirements — cannot be quietly overridden by a well-meaning junior engineer or an AI that doesn’t know what it doesn’t know.
- **Product managers** whose feature requirements and business rules need to survive refactors, team changes, and the next AI assistant that joins the team.
- **Teams scaling their use of Claude Code** beyond individual productivity into shared, collaborative AI-assisted engineering.

---

Quorum is not a knowledge base you maintain. It’s a governance layer that grows from the work your team is already doing — engineering and business alike.
