# Historical Ticket Production Extraction Runbook

This runbook is the operational bridge between the Support Bot historical-ticket
exporter and Enthusia-AI W18. It does not weaken
`training/datasets/GOVERNANCE-CHECKPOINT.md`.

## Hard stop rules

- Never copy or print `DATABASE_URL`, bot tokens, webhook credentials, or other
  runtime secrets.
- Never place raw ticket exports, deletion-exclusion ledgers, or real sanitized
  review artifacts inside a Git worktree.
- Metadata-only coverage checks may run before the content-export sign-off because
  they do not emit ticket message content.
- Real content export requires the completed run-specific governance sign-off,
  `--ack-governance`, and a deletion-exclusion ledger.
- No W18 output is training data merely because the sanitizer accepted it.
  W16 admission and owner review are later gates.
- Do not use historical appeals/reports/management decisions as current punishment
  or policy authority.

## Phase 1 — production archive coverage (metadata only)

Run this inside the deployed Support Bot's `enthusiasupport` directory, using
its already-configured production environment:

```bash
npm run export:training-tickets -- --count-only
```

The command must not require or print a guild ID or database credential when
the production database contains exactly one ticket guild. It fails closed if
there are zero or multiple guilds.

Expected output is aggregate metadata only:

- `archive_database_rows`: all retained closed tickets across ticket types;
- `eligible_database_rows`: closed `GENERAL_SUPPORT` + `BUG_REPORT`;
- `by_ticket_type`: full closed-archive type split;
- `eligible_by_ticket_type`: first-pass training-scope split;
- archive and eligible earliest/latest `createdAt` / `closedAt` timestamps.

### Coverage decision

Record the JSON output in issue #65 **only if it contains aggregate counts and
timestamps as expected**.

Do not infer that the current MySQL database contains the legacy Ticket Bot
archive merely because it contains some historical rows. Compare the earliest
archive timestamp with independently known deployment/history evidence.

- If the archive clearly reaches into the legacy-ticket era, continue with the
  governed pilot below.
- If it begins only with the current Support Bot era, stop content extraction
  and locate/import the older transcript source separately.
- If the result is ambiguous, treat legacy coverage as unproven.

## Phase 2 — complete the run-specific governance record

Before real message content is exported, record in
`training/datasets/GOVERNANCE-CHECKPOINT.md` / issue #65:

- owner approval for this extraction run;
- categories: first pass is only closed `GENERAL_SUPPORT` + `BUG_REPORT`;
- date range selected from the metadata result;
- raw retention: delete no later than 30 days after successful W18 consumption;
- sanitized/versioned derivative retention per W16 lifecycle;
- deletion/exclusion propagation owner/process;
- extraction operator/process;
- dataset version and run ID.

The deletion-exclusion ledger is a tab-separated file outside Git:

```text
# Discord user ID<TAB>optional known historical alias<TAB>optional second alias
123456789012345678	OldUsername
```

An intentionally empty ledger may contain comments only, but it must represent
an explicit deletion-request check for the content run; do not use an empty
file merely because no ledger was prepared.

## Phase 3 — bounded real-content pilot

Use a new raw output path outside Git. Start small; do not begin with the whole
archive.

```bash
npm run export:training-tickets -- \
  --max-tickets 20 \
  --deletion-exclusions-file /secure/private/ticket-deletion-exclusions.tsv \
  --out /secure/private/w18-pilot-raw.jsonl \
  --ack-governance
```

Optional `--from` / `--to` bounds should be used when the approved run scope
is narrower than the whole retained archive.

The exporter must:

- read only closed first-pass ticket types;
- drop deleted and historically edited messages;
- accept staff identity only when ticket-time staff actions prove it;
- omit unproven participant messages;
- pseudonymize known participant IDs/usernames in metadata and message text;
- enforce deletion-request exclusions;
- write a new restricted raw file rather than overwriting;
- refuse raw output inside Git.

### Phase 3b — archived Discord fallback for missing DB mirrors

Use this only when the production coverage review proves that a closed first-pass
ticket exists but its structured `ticket_messages` relation is empty. MySQL remains
the primary source; do not re-fetch Discord history for tickets that already have a
structured message mirror.

The Support Bot recovery command is:

```bash
npm run export:training-tickets-discord-recovery -- \\
  --max-tickets 25 \\
  --max-messages-per-ticket 500 \\
  --deletion-exclusions-file /secure/private/ticket-deletion-exclusions.tsv \\
  --out /secure/private/w18-discord-recovery-raw.jsonl \\
  --ack-governance
```

The recovery path is deliberately read-only and bounded:

- it selects only closed `GENERAL_SUPPORT` / `BUG_REPORT` rows with zero mirrored
  DB messages and a database-recorded archived channel ID;
- callers cannot provide arbitrary Discord channel IDs or URLs;
- deleted Discord messages are absent from the recovered history;
- Discord `editedAt` is converted into `MESSAGE_EDITED` provenance so the existing
  exporter excludes edited messages;
- tickets whose surviving channel history exceeds the configured bound fail closed;
- deletion-exclusion checks run against both database participants and recovered
  message authors/text;
- output uses the same pseudonymized W18 transcript contract as the MySQL exporter;
- the command never writes recovered messages back into MySQL.

Treat this as fallback evidence, not as proof that the archive is complete. Archived
channels may have been deleted by retention limits or may be unavailable. Record
aggregate recovery counts and exclusions, never raw identities/content, in issue #65.

Recovered output then follows the exact same Phase 4 W18 sanitization and manual
review gates below. It is never admitted directly to W16.

## Phase 4 — immediate W18 sanitization

Run the W18 sanitizer with both the raw file and output directory outside Git:

```bash
cd training/ticket-corpus
python -m enthusia_ticket_corpus.real_ingest \
  --input /secure/private/w18-pilot-raw.jsonl \
  --output-dir /secure/private/w18-pilot-sanitized \
  --dataset-version ticket-real-pilot-v1 \
  --reference-date <ISO-8601 current-truth reference> \
  --run-id w18-real-pilot-001 \
  --operator <authorized-operator> \
  --ack-governance
```

When a reviewed current-facts JSON file is available, pass
`--live-facts-json <path>` so volatile historical claims can be compared with
current truth.

Expected review-only artifacts:

- `positive-review-candidates.jsonl`;
- `negative-eval-candidates.jsonl`;
- `rejected.jsonl` containing IDs/reasons only;
- `manifest.json` with hashes, counts, provenance, source period, and run data.

W18 excludes severe PII/doxxing-grade records before ordinary redaction,
screens for credential-pattern material and excludes anything that cannot be
cleaned safely, pseudonymizes/redacts ordinary PII, labels stale facts, and
partitions poor/outdated/incomplete responses away from positive examples.

## Phase 5 — manual pilot review

Before any broad export, manually inspect every positive pilot candidate and a
sample of negative/rejected metadata.

Verify:

- no raw Discord IDs/usernames or real-world identities survive;
- no credentials or reusable secret material survive;
- player/staff roles are correct;
- staff replies are actually good examples rather than merely present;
- current-state claims are verified or marked stale;
- support wording is useful and natural;
- no historical moderator decision is being converted into current policy;
- no private/internal command syntax leaks into player-facing examples.

Any systemic failure goes back into the exporter/W18 code. Do not fix a systemic
problem by deleting a few bad rows and continuing.

## Phase 6 — broad export and W16 admission gate

Only after the pilot passes:

1. export the approved historical range in bounded batches;
2. sanitize every batch through W18 immediately;
3. preserve manifests/hashes and content-free rejection logs;
4. delete raw exports within the approved retention window;
5. send eligible sanitized candidates to W16;
6. run W16 secret scan, dedupe, leak-group splitting, contamination checks,
   dataset versioning, and train/dev/test split logic;
7. keep `BAD_RESPONSE`, `OUTDATED`, and `INCOMPLETE` material for
   negative/evaluation use rather than positive SFT;
8. require the owner-review gate before the resulting data contributes to a
   training release.

## Parallel synthetic-data gate

Historical-ticket work does not replace PR #25's synthetic/source-grounded
owner gate. The two lanes converge at W16 after their independent quality
checks. PR #25 must still run a fresh exact-10 Qwen owner-review smoke after
its post-gate fixes, and must stop before 30 examples/W16 until the owner
reviews those 10.
