# Data Governance Checkpoint — Historical Ticket Corpus (W18)

**Status:** ⏳ CHECKPOINT — required before any real ticket extraction.
**Workstream:** W18 — Historical ticket corpus (Enthusia-AI).
**Applies to:** `training/ticket-corpus/` pipeline and any future real-ticket extraction job.
**Fixtures only so far:** This workstream has processed SYNTHETIC FIXTURE tickets only.
**ABSOLUTELY NO real ticket data has been extracted, accessed, or processed.**

Per MASTER-SPECIFICATION §26.1, §41; TRAINING-AND-EVALUATION-SPEC §2; and
WORKER-EXECUTION-PLAN §21, real-ticket extraction/training **must not** begin
until this checkpoint is complete **and** the sign-off block (§9) is filled in.

---

## 1. Data source

| Item | Definition |
|---|---|
| System | Enthusia Discord guild support tickets — ticket channels created by the server's Ticket Bot integration (see MASTER-SPEC §20, workstream W14) |
| Data | Ticket channel transcripts: message content, author IDs/usernames, speaker role (player / staff / bot), message timestamps, channel metadata (ticket ID, category, opened/closed timestamps) |
| Mechanism | Export via the Ticket Bot's transcript capability or the Discord API under the bot's guild authorization. Exact mechanism is confirmed at extraction time — it is NOT assumed by this checkpoint. |
| Scope | Closed support tickets in public support ticket categories only |

**Explicitly out of scope for extraction** — see §5 Exclusions.

## 2. Owner authorization

Historical tickets are an **owner-directed planned data source**:

- MASTER-SPECIFICATION §26.1 — "Historical ticket data is an owner-directed planned source."
- MASTER-SPECIFICATION §41 — "The project owner explicitly wants historical tickets included in the training plan."
- TRAINING-AND-EVALUATION-SPEC §2 — lists "historical real Enthusia support tickets" as a planned source and requires this governance checkpoint first.

Owner direction covers the *plan*. It does **not** pre-authorize a specific
extraction run. Before the first real extraction:

1. This checkpoint document must be reviewed and approved by the owner.
2. The owner must confirm the ticket scope (which categories / date range).
3. The approval (who, when) must be recorded in §9.

## 3. Platform / data obligations

- **Discord Terms of Service and Developer Terms of Service / Developer Policy.**
  Ticket data comes from Discord. Extraction must respect Discord's rules on
  user data: collect only what the task needs, do not transfer user data to
  third parties, honor deletion requests, and keep bot tokens/credentials out
  of all datasets (see §7).
- **User deletion / erasure requests.** If a player requests deletion of their
  data, their tickets must be excluded from (or removed from) the corpus, and
  any derived training candidates must be regenerated without them.
- **Guild privacy posture.** Ticket channels are semi-private (visible to the
  ticket author and staff). Treating them as public training text without
  redaction and labeling would misrepresent their visibility. Redacted
  candidates are labeled `visibility: "staff"` (never `"public"`) unless the
  content is independently public.
- **No legal advice.** This checkpoint is an engineering compliance record, not
  legal counsel. If the owner wants a legal review, that happens before
  extraction, not after.

## 4. Retention policy (PROPOSED — owner to confirm before real extraction)

| Artifact | Proposed retention | Notes |
|---|---|---|
| Raw ticket extracts | Deleted ≤ 30 days after the pipeline run that consumed them | Raw extracts contain unredacted PII; they must not accumulate |
| Redacted intermediate corpus | Retained while the derived dataset version is in use; deleted on supersession | Pseudonymized, no secrets |
| Training candidates + manifests | Versioned, immutable per W16's versioning rules; retained per dataset lifecycle | `PRIVATE_EXCLUDE` and secret-rejected records are never written into training partitions |
| Rejection/exclusion logs | Retained with the dataset version (record IDs + reasons only, no content) | Needed for auditability |

Default: **minimize retention of raw data; keep only redacted, versioned
derivatives.** The owner confirms or amends these periods in §9 before the
first real extraction.

## 5. Exclusions — what will NOT be extracted

1. **Direct messages (DMs)** — any ticket sourced from a DM channel, or any DM content pasted into a ticket.
2. **Deleted tickets / deleted messages** — if it was deleted, it stays deleted.
3. **Staff-private deliberation** — staff-only channels and internal deliberation threads are not ticket transcripts.
4. **Voice channel content** — no audio, no voice transcripts.
5. **Deletion-requested content** — tickets (or messages) from users with a pending/completed data-deletion request.
6. **Doxxing / severe PII dumps** — tickets whose core content is someone's real-world identity, address, or similar: excluded entirely rather than redacted.
7. **Under-13 / minor safety content** — any ticket that would require handling a minor's personal data beyond redaction is excluded.
8. **Bot/credential material** — messages that are primarily bot tokens, webhook URLs, or credentials are excluded at the secret-handling stage (§7).

Exclusion happens **before** redaction where possible (cheaper and safer than
redacting content that should never have been collected).

## 6. Privacy measures

- **Pseudonymization.** Discord user IDs, mentions (`<@…>`), raw snowflakes,
  and usernames are replaced with deterministic pseudonyms (`PLAYER_N`,
  `STAFF_N`, `BOT`) scoped to the corpus run. Mapping tables are kept with the
  redacted intermediate only, under the same retention rule as §4.
- **Redaction.** Emails, IPv4/IPv6 addresses, phone-number shapes, and URL
  query strings (which often carry tokens) are replaced with typed
  placeholders (`[EMAIL]`, `[IP]`, …). Redaction is configurable via
  `training/ticket-corpus/redaction.yml`.
- **Minimization.** Only ticket channels in the approved categories and date
  range are extracted. Nothing else in the guild is in scope.
- **Access control.** Real extraction runs are performed by the owner or an
  explicitly authorized operator; raw extracts never leave the operator's
  controlled environment.
- **No re-identification.** Pseudonyms are not reversed for training, and
  training candidates must not contain enough residual detail to re-identify
  a player.

## 7. Secret handling

Detection is **shape-based** (patterns match the *shape* of secrets, never real
values), mirroring the W16 dataset pipeline's secret-scan contract:

- API keys (`sk-…`, `ghp_…`/`github_pat_…`, `AKIA…`, Stripe live keys)
- Discord bot tokens, bearer tokens
- `password`/`secret`/`api_key` assignments
- Private key blocks (`-----BEGIN … PRIVATE KEY-----`)
- High-entropy quoted credential assignments

Policy (enforced by `training/ticket-corpus/enthusia_ticket_corpus/secrets.py`):

1. **Scan** every ticket transcript for credential shapes.
2. **Remove**: redact the matched secret value (`[SECRET_REMOVED:<pattern>]`).
   Private-key blocks cause the containing message to be dropped entirely.
3. **Verify**: re-scan after removal. Any residual credential shape → the
   ticket candidate is **REJECTED** — it never enters a training partition and
   is reported only as an exclusion (record ID + reason, no content).
4. Secrets are **never redacted-and-kept as training content**. Rejection is
   the only outcome for uncleanable material, matching W16's policy.

## 8. Historical facts vs. live facts (critical rule)

**Historical ticket facts do NOT outrank current live facts.**
A historical decision can teach process while its old configuration fact is
stale (WORKER-EXECUTION-PLAN §21).

Enforced by the pipeline:

- `markOutdated()` flags factual claims that may be stale (volatile shapes:
  IPs/hostnames, prices, permission nodes, plugin versions, temporal
  "currently" claims; age-based risk; contradiction against live facts).
- A candidate whose answer relies on a fact contradicted by current live
  facts is labeled `OUTDATED`, never `GOOD`/`IDEAL`.
- Ticket-derived records carry provenance (`source: "ticket:<id>"`,
  `source_version: <closed date>`) so the training stack can always tell
  history apart from current truth.

## 9. Sign-off — required before the first real extraction

- [ ] Owner has reviewed and approved this checkpoint (name + date):
- [ ] Ticket scope confirmed (categories, date range):
- [ ] Retention periods in §4 confirmed or amended:
- [ ] Deletion-request process confirmed (who handles, how exclusions propagate):
- [ ] Extraction operator authorized (name):
- [ ] Extraction run recorded (date, scope, dataset version produced):

**Until every box is checked, the only permissible input to
`training/ticket-corpus/` is synthetic fixture data.**

---

*Document version: 1.0 (W18). Changes to this checkpoint after sign-off require
re-approval and are recorded in the dataset manifest's governance reference.*
