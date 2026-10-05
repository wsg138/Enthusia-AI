from __future__ import annotations

CATEGORIES = [
    "onboarding",
    "commands",
    "permissions",
    "rank",
    "economy",
    "tickets",
    "rules",
    "bugs",
    "account linking",
    "ambiguity",
    "escalation",
    "stale data",
    "conflicting evidence",
    "privacy",
]
PUBLIC_PROFILES = ("novice", "familiar")


def profiles_for(response_mode: str) -> tuple[str, ...]:
    return PUBLIC_PROFILES if response_mode == "player_support" else ("novice",)


def _profile_instruction(profile: str) -> str:
    if profile == "familiar":
        return (
            "Assume the player has already demonstrated familiarity with this topic. "
            "Answer directly without reteaching basics."
        )
    return (
        "Assume the player may be unfamiliar with this topic. If needed, add at most "
        "one short background sentence before the direct answer."
    )


def _mode_instruction(response_mode: str) -> str:
    if response_mode == "player_boundary":
        return (
            "This is a normal player asking about a staff/internal tool. Do not reveal "
            "staff command syntax, subcommands, permission nodes, backend details, or "
            "operational steps in either the question or answer. Briefly state the "
            "boundary and invite them to explain their goal so a player-facing option "
            "can be suggested."
        )
    return (
        "Write a normal player-facing answer. Keep it clear, concise, friendly, and "
        "conversational. Do not expose permission nodes or backend jargon unless the "
        "player's question directly requires that information."
    )


def build_prompt(job: dict) -> str:
    categories = ", ".join(CATEGORIES)
    mode_instruction = _mode_instruction(job["response_mode"])
    profile_instruction = _profile_instruction(job["familiarity_profile"])
    return f"""You are creating ONE source-grounded Enthusia support training candidate.

Use ONLY the bounded EVIDENCE below for factual claims. You may rewrite those facts into
natural language, but you may not strengthen, broaden, or invent them.

If the evidence is not useful enough for a safe support example, output exactly:
{{"skip":true,"reason":"not useful for support training"}}

Otherwise output exactly one JSON object with:
- category: one of [{categories}]
- scenario: at most 18 words
- user: a natural question, at most 30 words
- assistant: the final natural reply, 1-3 short sentences and at most 70 words
- tags: at most 4 short labels

Rules:
1. Question and answer must be completely supported by EVIDENCE.
2. {mode_instruction}
3. {profile_instruction}
4. Do not mention private memory, account age, prior chats, or why explanation depth changed.
5. Do not claim GitHub/source code proves a feature is live. Preserve staging, retained,
   test, not-deployed, or "when deployed" qualifications exactly when relevant.
6. Do not invent ranks, commands, permissions, prices, numbers, mechanics, tool calls,
   or deployment status. In particular, do not add an Elite rank or general player /fly.
7. Do not output secrets, credentials, hidden reasoning, chain-of-thought, evidence IDs,
   source IDs, SHAs, visibility, or internal validator metadata.

REPOSITORY_ROLE: {job["role"]}
RESPONSE_MODE: {job["response_mode"]}
FAMILIARITY_PROFILE: {job["familiarity_profile"]}
PRODUCTION_AUTHORITY: {job["production_authority"]}
PATH: {job["path"]}

EVIDENCE:
<<<
{job["evidence_text"]}
>>>
"""