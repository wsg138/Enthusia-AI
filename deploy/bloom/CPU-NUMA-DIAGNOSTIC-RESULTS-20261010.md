# Bloom AI CC19EA3C — CPU/NUMA/RAM diagnostic results (2026-10-10 UTC)

## Evidence and scope

User supplied successful console output of the read-only `deploy/bloom/cpu-probe.js` run, timestamp `2026-10-10T00:49:31.437Z`. AI 30B model was **not** started, diagnostic then idled; AI split was manually STOPPED afterward. The earlier 13–14-player comparative spark test indicated severe SMP lag with 4-thread 30B CPU inference; refer to `SPARK-SMP-15-PLAYER-RESULTS-20261010.md`.

## Direct observations

| Field | Actual value | Interpretation |
|---|---|---|
| `processAllowedCpus` | `0-31` | AI container currently allowed to schedule on all host-visible logical CPUs |
| `cgroupEffectiveCpus`, `cgroupConfiguredCpus` | `0-31`, `0-31` | No exclusive or narrower CPU set on AI split |
| `visibleLogicalCpuCount`, `availableParallelism` | 32, 32 | Not physical cores and not reserved CPU resources |
| CPU topology | one socket, **16 physical cores** with SMT siblings `0↔16`, `1↔17`, through `15↔31` | Core-pinning must consider siblings to avoid physical-core contention |
| `cpuQuotaPeriod` | `3200000 100000` | CPU cgroup quota of 32 CPU-seconds per 100ms; **equivalent to 32 logical CPUs of aggregate usage**, NOT pinning or reservation |
| `cpuStats` | `nr_periods 1, nr_throttled 0` | No throttling during this negligible diagnostic; **cannot** establish behavior during inference |
| `processAllowedMemoryNodes`, `cgroupEffectiveMemoryNodes` | `0`, `0` | One NUMA node only |
| `numaNodes` | `node0`: `0-31` | **No alternative NUMA node** to allocate isolated RAM from |
| `memoryLimit` | `44.70 GiB` | Existing hard cgroup memory ceiling (~48GB decimal) |
| `memoryCurrent`, `memoryPeak` | `0.01 GiB`, `0.01 GiB` | Idle probe values, not steady-state 30B inference |
| `memoryHigh`, `swapLimit` | `max`, `max` | No soft high threshold; unrestricted swap within parent/host constraints |
| `swapCurrent`, `memoryEvents` | 0; all 0 for OOM/high/max events | No memory pressure for diagnostic, but doesn't prove absence of other service/host contention |
| `tasksetChildTest` | passed; one child limited to CPU `0` | **Process-level affinity works** inside AI container. It does NOT reserve CPU 0, isolate it from SMP, or change the container cgroup pinning. |

## Decision

**The AI container is not CPU-isolated.** The measured prior performance failure is consistent with CPU contention on the shared host, but process scheduling, shared cache, memory bandwidth, IO and game load still require investigation. No memory OOM is observed in the previous AI benchmark. A single NUMA node rules out separate-node RAM binding as an available isolation strategy on the observed host.

### Next dependency

Request from Bloom host/provider (read-only question first) confirmation whether the customer/provider can configure both AI and SMP Pterodactyl `limits.threads` or Docker `cpuset-cpus` to **non-overlapping full physical core sibling groups**, with host-level reservation or scheduling policy preventing third-party workload contention. Seek the live SMP container's current allowed CPU set, CPU model, placement guarantees, and maintenance constraints before any change.

Physical-core pair example only: physical core 14 = logical 14 and 30. Do **not** select core IDs or pin either service yet: other host services and SMP affinity are unknown. Pterodactyl CPU percentage is a quota, not a core reservation. `taskset` alone does not prevent SMP sharing AI's assigned physical cores.

Provider restrictions may mean dedicated physical core isolation is unavailable. Alternative is separate compute hardware or a lower-thread CPU workload after an explicitly approved new test plan; do not rent, restart or deploy automatically.

## Safety gates

- Keep AI split stopped unless conducting an approved *read-only* diagnostic.
- No automatic repeated 30B CPU load tests, no live SMP changes, no PR #118 merge or production Discord deployment.
- Continue code/knowledge-retrieval work without requiring production inference.
- No more owner requests to manually re-upload scripts until the authorized Blackboard AI-only SFTP workflow becomes accessible and validated. The local Blackboard SFTP implementation is not exposed to the currently connected assistant tools.
