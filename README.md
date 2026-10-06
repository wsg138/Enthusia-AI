# Enthusia AI

Enthusia AI is the planned server-wide intelligence platform for the Enthusia Minecraft network.

The project is intentionally broader than a Discord support bot. The target system is a persistent, server-aware AI layer that can answer player and staff questions, inspect current Enthusia systems before making factual claims, retain evidence-backed operational memory, coordinate support tickets, assist moderation, investigate technical issues, and escalate difficult engineering work to stronger external models.

## Authoritative specification

**Read this before implementing anything:**

- [Master Specification](docs/MASTER-SPECIFICATION.md)
- [Memory, Knowledge, and Fact Verification Contract](docs/MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md)
- [Training and Evaluation Specification](docs/TRAINING-AND-EVALUATION-SPEC.md)
- [Worker Execution Plan](docs/WORKER-EXECUTION-PLAN.md)
- [Coordinator Status and Roadmap](docs/COORDINATOR-STATUS-ROADMAP.md) — current implementation/deployment status, open work, and execution priorities

The master specification is the source of truth for product behavior, architecture, memory semantics, knowledge verification, tool access, training, deployment, security, evaluation, and rollout.

If implementation and the specification disagree, implementation should be treated as wrong unless the specification is deliberately amended.

## Core principles

- Current Enthusia facts must be verified against authoritative evidence before being stated.
- Model weights teach behavior; live sources provide current truth.
- Current memory contains only the latest supported belief. Superseded values remain in history, not normal retrieval.
- The AI should investigate relevant context proactively instead of guessing.
- Moderation remains isolated from slower support/reasoning workloads.
- Local models handle routine work; stronger OpenAI models remain available for deep investigation and coding.
- Destructive or high-impact actions require explicit authorization policies.
- Secrets are used by tools, never learned by the model.
- The AI platform is separate from the existing Ticket Bot; the Ticket Bot remains the ticket lifecycle authority.

## License

This project is proprietary. See [LICENSE](LICENSE).

## Repository scaffold (W01)

TypeScript monorepo (npm workspaces, Node.js >= 22 LTS) implementing the
layout from §8 of the master specification:

- `apps/` — discord-bot, ai-gateway
- `services/` — agent-core, knowledge-indexer, memory, tool-gateway, openai-gateway, moderation-adapter
- `packages/` — **contracts** (full implementation), auth, logging, config, source-provenance
- `integrations/` — ticket-bot, github, sftp, databases, minecraft
- `training/` — datasets, generation, preprocessing, finetune, evaluation, export
- `deploy/` — bloom, local
- `tests/` — integration, regression, golden

### Shared contracts (`packages/contracts`)

The critical W01 deliverable — typed contracts all other workstreams consume:

- `Visibility` enum (§17): PUBLIC, PLAYER_SELF, STAFF, MANAGEMENT, SYSTEM_INTERNAL, SECRET_DENY,
  with ceiling/disclosure helpers (`canDisclose`)
- `SourceStatus` enum (W01): CURRENT, SUPERSEDED, INVALID, CONFLICTED, STALE
- `SourceType` enum (§12.1): GITHUB, SFTP_FILE, DOCUMENT, CONFIG, DATABASE_SCHEMA,
  DATABASE_LIVE, DISCORD, TICKET, STAFF, DEPLOYMENT, GENERATED
- `SourceArtifact` (§50), `ToolResult` envelope (§16.2), `ChatRequest`/`AgentResponse` (§48),
  `MemoryKey`/`MemoryRevision`/`MemoryEvidence` (§49 + verification spec),
  health contracts (§36: `/health/live`, `/health/ready`)
- Typed errors: ValidationError, AuthorizationError, NotFoundError, ToolTimeoutError,
  VisibilityDeniedError, StaleSourceError, ConflictError, RateLimitError, ExternalServiceError
- Trace IDs: UUID v4 generation, `x-enthusia-trace-id` propagation

Zod schemas accompany the main interfaces for runtime validation.

### Supporting packages

- `packages/logging` — structured JSON logger (pino) with trace ID support
- `packages/config` — Zod-validated, env-based config with defaults; no secrets in code
- `packages/auth`, `packages/source-provenance` — skeletons for W02/W04

### Getting started

```sh
npm install     # install all workspaces
npm run build   # compile implemented packages
npm run test    # unit + contract tests (vitest)
npm run lint    # eslint
npm run typecheck  # tsc --noEmit across the repo
npm run config:validate  # validate env config (CI)
```

No production secret is required for any of the above. Copy `.env.example`
to `.env` for local development — it contains placeholders only.

### CI

`.github/workflows/ci.yml` runs: lint, typecheck, unit tests, contract tests,
secret scan (gitleaks), and configuration validation.
