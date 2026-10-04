# Enthusia AI — Resource Limits (W21)

Spec: MASTER-SPECIFICATION.md §§9.2, 35.2–35.4, 63. The spec wins over this
document in any disagreement.

**Status:** documented targets only — nothing is provisioned or enforced yet.

---

## 1. Machine context (§63)

The dedicated machine reportedly has **over 100 GB of spare RAM available**,
but the AI must coexist with the SMP. Strategy: start bounded, benchmark,
and only then increase experimentally.

## 2. Memory

| Consumer | Cap | Rationale |
|----------|-----|-----------|
| Model server (llama.cpp) | **24–32 GB** initial envelope; default **28 GB** | Spec §63 initial approach: "model server capped around 24–32 GB". 28 GB is the midpoint default in `resource-limits.env`; stay inside the envelope until benchmarks say otherwise. |
| Vector DB | Bounded (operator-set, start ≤ 16 GB) | §63: "vector DB bounded". |
| Agent service | 8 GB (`MemoryMax=8G`) | Orchestration + tool plumbing, no model weights. |
| Discord adapter | 2 GB | Thin adapter; no model weights. |
| Indexer | 4 GB | Background batch work. |

Rules:

- **No swap thrashing** (§63): `MemoryMax` is a hard cap; size workloads so the
  host never swaps. If the model needs more than 32 GB, that is an explicit,
  benchmark-backed decision — not silent growth.
- Model RAM is observable: `enthusia_model_ram_bytes` gauge and
  `modelRamBytes` in `/health/ready` (§36).

## 3. CPU

**Do not allow inference to saturate all cores** (§35.2).

| Consumer | Threads | Rationale |
|----------|---------|-----------|
| llama.cpp inference | `INFERENCE_THREADS=8` (default) | Explicitly bounded; §9.2 requires "controlled thread count". |
| Indexer | `INDEXER_THREADS=2` (default) | Low-priority background work (§63). |
| Agent / Discord | Node default (I/O-bound) | No heavy compute; keep event loop responsive. |

- Optional **CPU pinning** (`CPU_PIN` / systemd `CPUAffinity`), e.g. `8-15`,
  keeps inference off SMP-critical cores.
- **Benchmark impact on** (§35.2): MSPT, tick time, chunk work, garbage
  collection, network thread responsiveness — measure before and during local
  inference, indexing, model startup, and concurrent queries (WORKER-EXECUTION-PLAN §24).
- If SMP degrades: stop inference first (§5.1 of RUNBOOK.md), then tune threads/pinning.

## 4. Disk

| Consumer | Budget | Rationale |
|----------|--------|-----------|
| Model artifacts | ~2× largest model | Current + previous for instant rollback (§4 of RUNBOOK.md, §64 manifest). |
| Vector store | Operator-set quota | Bounded per §63. |
| Logs | 10 GB rotation cap per host | Structured JSON; rotate aggressively (see LOGGING.md). |
| Postgres | Operator-set quota | Durable metadata (§9.4). |

## 5. OOM behavior (§35.4)

Support inference failure must not kill SMP, moderation, or the Ticket Bot.

- AI roles run with elevated OOM scores (`OOMScoreAdjust=500` agent,
  `800` inference; `OOM_SCORE_ADJ=500` on the panel): **the AI is always the
  first thing the kernel kills**.
- SMP-critical services keep default OOM scores.
- An AI OOM is an expected, survivable event — see RUNBOOK §5.2. It is also a
  rollback trigger if it recurs (§4.2).

## 6. Startup sequencing (§35.3)

- AI starts **after** SMP-critical services. Large model startup must not
  coincide with SMP-critical operations.
- AI restarts never require Ticket Bot restarts; Ticket Bot restarts never
  reload the local LLM. The roles are independent units/servers.

## 7. Network

- Raw llama.cpp binds to `127.0.0.1` by default. If another container must reach it,
  bind only to a private/internal address and firewall that allocation from public ingress.
- Enthusia health/metrics endpoints are scraped only by trusted internal monitoring (§36).
- Egress: OpenAI escalation only, bounded by §37 cost controls.

## 8. Growth policy (§63)

> "If stable, increase model/resources experimentally."

Increases are allowed only after: (a) SMP benchmarks show no degradation
during inference/indexing/startup/concurrent queries, and (b) the new bound
is recorded here with the benchmark evidence. Default posture is conservative.
