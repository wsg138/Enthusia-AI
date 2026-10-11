# Offline Spark binary audit: entities, regions, TPS and slow ticks

This **read-only**, Python 3.12 standard-library tool inspects **downloaded original** `.sparkprofile` and `.sparkhealth` protobuf files. It does **not** connect to Minecraft, Bloom, Discord or a network. The script cannot retrieve files directly from spark.lucko.me URLs; supply the binary capture files locally. **Never commit raw Spark captures**: they may contain private player, configuration or system data.

## Commands

```sh
python deploy/bloom/spark_report_audit.py /path/to/profile.sparkprofile
python deploy/bloom/spark_report_audit.py /path/to/after.sparkprofile --compare /path/to/before.sparkprofile
python deploy/bloom/spark_report_audit.py /path/to/health.sparkhealth --json
python -m unittest discover -s deploy/bloom -p "test_spark_report_audit.py" -v
```

Reports include:

- UTC capture timestamp and, for profiles, full timed windows with TPS, median MSPT, longest tick, player count and selected ticks from **thresholded** samplers.
- Captured snapshot counts of total loaded entities, mobs per type, *chunks containing entities*, and the five densest **Spark entity regions** with world, entity total, number of populated chunks and top mob types.
- A conservative entity-density notice when a single region contains **500+** entities; this is a diagnostic lead, not proof of lag.
- With `--compare`, changes in total entity population, zombified piglins, or largest regional concentration. The heuristic thresholds are >200 or 10%; >50 or 10%; and >100 or 10%, respectively, taking the larger margin. A warning identifies confounding demand, not process or host causality.
- JSON mode for downstream reporting. Profile data uses a 256 MiB input limit, pure Python wire decoder, and rejects malformed/truncated protobuf wire fields.

### Validated against the original October 11 captures

| Source capture | Type | Zombified piglins | All loaded entities | Largest region | Populated chunks |
| --- | --- | ---: | ---: | ---: | ---: |
| [2W1BTSTfMe](https://spark.lucko.me/2W1BTSTfMe) | Java slow-tick profile | **2,028** | 4,013 | **1,678 / 24 chunks** | 515 |
| [pB56VgyBI7](https://spark.lucko.me/pB56VgyBI7) | Ordinary Java profile | **0** | 2,493 | **238 / 24 chunks** | 848 |
| [LLMPz76gwY](https://spark.lucko.me/LLMPz76gwY) | Spark health | **0** | 2,514 | **238 / 23 chunks** | 870 |
| [MvZQp3UPQ9](https://spark.lucko.me/MvZQp3UPQ9) | Java slow-tick profile | 523 | 3,137 | 258 / 41 chunks | 966 |
| [8VCWs7kJjP](https://spark.lucko.me/8VCWs7kJjP) | Java slow-tick profile | 1,226 | 3,862 | 783 / 24 chunks | 1,007 |

**Important:** "Chunks containing entities" is **not** the Spark per-minute `loadedChunks` statistic (the latter includes empty chunks). Never substitute one for the other in `smp-colocation-compare.mjs`. This output is not a synchronized test comparison unless workload, players, timing and entity distribution are independently observed per test phase.

For the lagging profile, the **100ms-thresholded sampler selected 316 slow ticks** in total, though its complete minute-window fields account for fewer. An ordinary profiler's tick count must **not** be mislabeled "ticks >100ms"; the tool reports n/a for threshold counts in ordinary profiles.

## Critical limitations

1. **Platform world statistics are capture-wide snapshots**. They are not recorded separately for each TPS/MSPT minute. Do not copy the entity counts into every window or treat matching final counts as proof of matching demand throughout a test.
2. The tool **does not parse or attribute sampled Java call stacks**, CPU scheduler behavior, entity hotspots' coordinates, active plugin versions, or farm ownership. Use the Spark viewer and additional server data for those investigations.
3. The worlds/regions are entity groups as represented by Spark; reported region counts are not a perfect census of every saved entity. An unloaded farm does not appear.
4. Filename timestamps, clock drift, player distribution and plugin versions matter. Never claim this script alone proves the cause of a TPS regression, or that a CPU co-location test is safe.
5. The implementation is validated against the listed owner-supplied current-format captures and synthetic decoder tests. A future Spark serialization change may require the parser to be revised. **Fail closed** on missing or malformed world statistics rather than silently displaying zeroes.

## Restart verification protocol

After a normal owner-approved SMP restart of the uploaded Staff and DiaryKeeper builds, do **not** initiate another high CPU workload to force a regression. First verify startup logs, the actual installed JAR hashes/version and plugin health, then capture `/spark tps`, a `/spark health upload`, and a Java-sampler `/spark profiler --only-ticks-over 100 --timeout 300` when slow ticks naturally occur. If the server is running stably with few/no slow ticks, that is useful evidence too: don't infer failures from an empty threshold-filtered flamegraph.

For **AuthorityBridge migration**: the integrated rank/collector features default **off**. Auto-imported old config files do not activate them. The original standalone AuthorityBridge JAR and any new embedded flags require a separate controlled cutover to avoid duplicate listeners, database import ambiguity and exposing a rank port. Do not activate Policy v2. See `EnthusiaStaff/docs/authority-bridge-consolidation.md`.
