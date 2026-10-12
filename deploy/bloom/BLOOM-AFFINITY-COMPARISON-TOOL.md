# Bloom SMP / AI CPU affinity — offline evidence checker

**Scope:** local, read-only analysis of previously captured diagnostics. This is not an inference benchmark, not a server-side probe, not permission to restart Minecraft, and not proof of safe AI co-location.

## Why this exists

Historical Qwen3-30B experiments showed that SMP TPS/MSPT deteriorated during some periods of four-thread CPU inference. Independent SMP lag while AI was stopped also occurred. The AI container previously reported 32 available logical CPUs (16 physical SMT cores) with effective CPU affinity 0-31; the 3200% cgroup CPU quota was **not a core reservation**. Equal CPU IDs in different containers do not prove that the JVM and llama.cpp actually ran simultaneously on the same CPU.

This tool answers a narrower question: *which logical CPU IDs and physical SMT cores did the two containers report being allowed to use?* A CPU permission intersection is a **possibility of contention**, not evidence that contention occurred.

## Requirements

Two **already available, timestamped** diagnostic JSON objects, saved separately as smp-probe.json and ai-probe.json, each containing:

- timeUTC: UTC ISO timestamp for the actual observation.
- processAllowedCpus: e.g. "0-31" from /proc/self/status Cpus_allowed_list.
- cgroupEffectiveCpus: e.g. "0-31" from cpuset.cpus.effective.
- logicalCpuTopology: rows with cpu, socket, core, siblings fields for every permitted CPU; use full topology when possible.
- AI report: modelStarted must be false as written by the existing read-only deploy/bloom/cpu-probe.js. Equivalent provider-supplied **SMP** snapshots can omit that AI-specific field.

The current AI diagnostics are historical. We do **not** have a contemporaneous SMP counterpart. The existing cpu-probe.js targets a generic Node-based AI split; **do not replace the live Minecraft startup file with it**. If SMP readings are needed, obtain equivalent read-only fields through an approved provider/host diagnostic without interrupting the live server.

Use Node.js 22+ without any npm installation or network access:

    node deploy/bloom/bloom-affinity-compare.mjs smp-probe.json ai-probe.json --same-host-confirmed
    node --test deploy/bloom/bloom-affinity-compare.test.mjs

The --same-host-confirmed argument is an operator assertion that both reports came from the same bare-metal host. It does **not** independently verify host identity. Do not use it for different hosts. For direct code consumers samePhysicalHostConfirmed defaults to false, producing an inconclusive result.

## How to interpret results

| Classification | Supports | Does not support |
|---|---|---|
| OVERLAPPING_ALLOWED_LOGICAL_CPUS | Both permission sets contain identical logical CPU IDs | SMP main thread and llama.cpp actually competed there |
| DISJOINT_LOGICAL_CPUS_SHARED_PHYSICAL_CORES | Separate logical sets still share physical SMT core groups | Full physical-core isolation |
| DISJOINT_OBSERVED_CORE_SETS_NOT_RESERVED | Observed allowed logical and physical core groups are separate | Exclusive reservation against host/kernel/other workloads |
| INSUFFICIENT_EVIDENCE | Host/time/topology evidence is insufficient | Any claim of safe isolation |

The effective process set is computed as the intersection of the process allowed list and cgroup effective CPU set. The tool fails closed when reports differ by more than 15 minutes, host identity is not confirmed, topology is missing/contradictory, or Linux ranges are malformed. Two close timestamps still do not prove allocation remained constant between observations.

**Do not treat this checker as a CPU scheduling profiler.** It measures neither Java-thread CPU placement nor runqueue delay, CPU-cache sharing during a tick, memory bandwidth, garbage collection, plugin overhead, or disk contention. Bloom support's request for timestamped **main-thread slow-tick Spark evidence** remains valid.

## Safety and follow-up

No live server changes are necessary to run this tool on saved files. A supervised lower-thread inference test, if eventually approved, must still wait for a verified LoreItems release/deployment hash, an independently stable AI-OFF SMP baseline, workload matching, synchronized AI telemetry, and explicit abort criteria. Do not launch a four-thread stress workload simply to gather a CPU-affinity comparison.

Related: Enthusia-AI issue #119, CPU-NUMA-DIAGNOSTIC-RESULTS-20261010.md, SMP-AI-COMPARISON-TOOL.md, and LoreItems issue #39.
