# Bloom AI split: CPU affinity, RAM and NUMA preflight

Prepared: 2026-10-09 (EDT). Read-only CPU/RAM investigation. NO live SMP modification, model benchmark, or deployment.

## Why

13–14-player SMP test: AI off sustained near 20 TPS; during four-thread 30B inference two one-minute windows declined to 16.92 and 16.67 TPS; recovered near test end. AI peak sampled memory was about 13.6 GiB against its 48 GiB server allocation. The initial priority is CPU scheduling/isolation rather than increasing RAM.

Pterodactyl admin supports CPU pinning through the server build 'threads' field mapped to Docker CpusetCpus. CPU percentage is a quota, not a dedicated core assignment. RAM limits are ceilings, not physical reservations. Linux/Docker may bind memory to specific NUMA nodes (cpuset.mems), but this is only useful with suitable hardware and provider support.

References:
- https://github.com/pterodactyl/panel/blob/1.0-develop/app/Http/Requests/Api/Application/Servers/StoreServerRequest.php
- https://docs.docker.com/engine/containers/run/
- https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html

## Read-only test — ONLY AI split CC19EA3C

1. Keep SMP operating normally. Confirm CC19EA3C is STOPPED.
2. Open AI split Files. Rename existing root bloom-30b.js to bloom-30b.saved.txt; retain the existing model GGUF, binary, hashes and server marker. Never delete those.
3. Bloom Files > Download from URL:
   https://raw.githubusercontent.com/wsg138/Enthusia-AI/fix/discord-command-safe-upsert-20261008/deploy/bloom/cpu-probe.js
4. Rename downloaded cpu-probe.js to bloom-30b.js (12 characters). Ensure this is the sole root *.js file. Leave startup MAIN FILE set to bloom-30b.js. The observed egg runs ordinary Node only for this filename.
5. Start CC19EA3C. This script does NOT launch inference, download anything, or contact SMP/Discord. It only reads /proc and cgroup/sysfs; if taskset is installed it briefly constrains one harmless child Node process to one allowed CPU to check process-level affinity support.
6. Copy console diagnostic JSON and tasksetChildTest, then manually STOP the AI split. The script intentionally idles without workload after printing so Pterodactyl cannot accidentally restart it after clean exit. Rename probe bloom-30b.js to cpu-probe.saved.txt afterward, and keep the AI split STOPPED until we evaluate results.

## What readings mean

- cgroupEffectiveCpus / processAllowedCpus = actual permitted logical CPU IDs.
- cgroupConfiguredCpus can be empty when inheriting from parent. cpuQuotaPeriod sets CPU time budget, NOT location.
- logicalCpuTopology includes physical core/socket and SMT siblings if sysfs is exposed. Pinning should separate SMP AND AI across physical cores and sibling logical CPUs; restricting AI alone is NOT full isolation if SMP is still allowed on those cores.
- tasksetChildTest passing demonstrates ability to narrow affinity for an unprivileged child, NOT guaranteed exclusive CPU resources. Failure might mean taskset is missing.
- cgroupEffectiveMemoryNodes / numaNodes reveal NUMA placement possibilities. One node gives no meaningful alternative NUMA pool.
- memoryLimit, memoryCurrent, memoryPeak, swapCurrent, memoryEvents measure current memory limits/pressure. NUMA placement is not a RAM reservation and cannot necessarily fix shared memory bandwidth or cache contention.

## Next requirement from Bloom support

Ask whether they can set Pterodactyl CPU pinning (limits.threads / Docker cpuset-cpus) on the AI and live SMP splits to different physical cores, including SMT sibling pairs, and whether their panel exposes this option to customers. Request CPU model/core topology, current allowed CPU lists for both splits, CPU overcommit and whether NUMA pinning (cpuset-mems) is available. Do NOT ask them to reconfigure a running SMP without arranging safe timing.

We will not run another sustained AI test until the affinity/core topology and any CPU isolation change are checked. Draft PR #118 stays HOLD.
