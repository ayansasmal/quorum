# ADR-0011: LLM Provider Strategy — Stay on OpenAI, Defer Local Models

**Status:** Accepted
**Date:** 2026-07-27
**Deciders:** Platform team

---

## Context

Quorum's Graphiti fork (`graphiti/quorum-graphiti`) currently runs on OpenAI for both
LLM inference (`gpt-4o-mini`) and embeddings (`text-embedding-3-small`), in both local
dev and production. The motivation to look at local models was two specific goals:

- **Cost** — reduce recurring OpenAI API spend
- **Offline dev capability** — be able to develop/test without a network dependency

This was evaluated against OpenAI's own open-weight model, **gpt-oss** (`gpt-oss-20b` /
`gpt-oss-120b`), served locally via Ollama and consumed through Graphiti's existing
OpenAI-compatible client path — not a new integration, but code already present in
this fork.

### What was confirmed to already work

- `graphiti_core/llm_client/openai_generic_client.py` targets any OpenAI-compatible
  `/chat/completions` endpoint (Ollama included). `factories.py`'s
  `is_non_openai_provider(base_url)` auto-detects a non-OpenAI `base_url` and switches
  to this client automatically — no new provider code needed.
- That client already defaults to native `json_schema` structured output, strips
  markdown code fences local models commonly wrap JSON in, raises a clear
  `EmptyResponseError` instead of a cryptic parse failure, and retries transient
  JSON/rate-limit failures 4x with backoff.
- `graphiti_core/embedder/openai.py`'s `OpenAIEmbedder` accepts a plain `base_url`
  override with no additional wiring — Ollama's `/v1/embeddings` endpoint is
  OpenAI-wire-compatible, so this reuses the existing `openai` embedder provider.
- Hardware fits: gpt-oss-20b (3.6B active params, MoE) runs on the dev machine's
  32GB unified memory (Apple M2 Max). gpt-oss-120b (~80GB) does not.

### Gaps found during the investigation

- **`mcp_server/README.md`'s Ollama example is stale.** It suggests
  `embedder.provider: "sentence_transformers"`, but that provider is **not
  implemented** in this fork's `EmbedderClientFactory` (only `openai`,
  `azure_openai`, `gemini`, `voyage` exist). The correct local-embedding path is
  the `openai` provider pointed at Ollama's endpoint with an Ollama-servable
  embedding model (e.g. `nomic-embed-text`, 768-dim).
- **`structured_output_mode` (`json_schema` vs. `json_object` fallback) is not
  wired through `LLMConfig`.** It exists as a constructor parameter on
  `OpenAIGenericClient`, but `factories.py`'s `case 'openai':` branch always uses
  the default — there is currently no config-level way to fall back to
  `json_object` mode for a model that doesn't handle `json_schema` well.
- **Docker Desktop on macOS does not pass through Metal/GPU to containers.**
  Running Ollama *inside* Docker on this machine would be CPU-only. The viable
  setup is Ollama running natively on the host, with the Graphiti container
  pointed at `http://host.docker.internal:11434/v1`.
- **FalkorDB's vector index dimension is frozen at graph-creation time**
  (`graphiti_core/embedder/client.py`'s `embedding_dim` field). Swapping embedding
  models on a graph that already has vectors indexed at a different dimension
  requires a wipe and re-ingest, not just a config change.
- **No extraction-quality validation has been run** against gpt-oss on Quorum's
  specific prompts. This fork's own regression suite
  (`tests/prompts/test_quorum_prompt_regressions.py`,
  `tests/utils/maintenance/test_edge_operations.py`) exists precisely because the
  fork's contradiction-detection logic (`dedupe_edges.py`) is deliberately
  conservative and tuned against GPT-4o-mini-class output — a weaker local model
  could produce *valid* JSON that still mis-detects or misses a contradiction,
  which would not be caught by any of the JSON-parsing hardening above.

## Decision

**Stay on OpenAI (`gpt-4o-mini` + `text-embedding-3-small`) for both dev and
production. Do not adopt a local model at this time.**

The stated motivations (cost, offline dev) are real but not currently pressing
enough to justify the validation effort — current OpenAI spend has not been
identified as a material cost, and offline capability has not blocked any actual
work yet. Given the project is pre-production, there is no urgency forcing this
decision now, and adopting a local model without running the extraction-quality
regression suite first would be trading a known-good baseline for an unvalidated
one for a benefit that is currently theoretical.

This is a **deferral, not a rejection**. The path to revisit is already scoped
(see below) precisely so this doesn't need to be re-investigated from scratch
later.

## Consequences

**Positive:**
- No change to a working stack; no new failure mode introduced
- No extraction-quality regression risk taken on before it's actually needed
- The investigation is preserved here, so revisiting costs re-reading this ADR,
  not re-deriving the fork's LLM client architecture again

**Negative:**
- No offline dev capability yet — dev work still depends on network + OpenAI
  availability
- Recurring OpenAI cost continues unchanged

**If this is revisited, the concrete plan is:**
1. Scope it as a **dev-only opt-in profile** (e.g. `config-docker-ollama.yaml`,
   alongside the existing `config-docker-falkordb.yaml` sibling configs) —
   production's `crossplane/environments/prod.yaml` stays pinned to OpenAI
   regardless of dev-profile outcome.
2. Run Ollama **natively on the host**, not inside Docker (Metal passthrough gap
   above); point the Graphiti container's `llm.providers.openai.api_url` /
   `embedder.providers.openai.api_url` at `http://host.docker.internal:11434/v1`.
3. Use `gpt-oss-20b` for the LLM and `nomic-embed-text` for embeddings, with
   `embedder.dimensions: 768` set explicitly to match.
4. Add the missing `structured_output_mode` field to `LLMConfig` and thread it
   into `factories.py`'s `case 'openai':` branch, so a fallback to `json_object`
   mode is a config change, not a code patch, if `json_schema` mode proves
   unreliable against Ollama.
5. Before trusting it beyond casual dev smoke-testing, run
   `tests/prompts/test_quorum_prompt_regressions.py` and
   `tests/utils/maintenance/test_edge_operations.py` against the Ollama-backed
   client as a functional smoke gate.
6. Only consider extending this to production if the cost motivation becomes
   concrete — that would additionally require a real extraction-quality
   comparison against the OpenAI baseline, not just the regression suite passing.
