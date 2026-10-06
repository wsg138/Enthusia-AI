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
        "Assume the player may be unfamiliar with this server-specific topic. If the "
        "answer depends on knowing what the system is, first explain it in one short "
        "plain-language sentence, then answer directly. Do not assume they already know "
        "server-specific terms such as reputation, mail categories, ranks, or staff tools."
    )


def _mode_instruction(response_mode: str) -> str:
    if response_mode == "player_boundary":
        return (
            "This is a normal player asking about the TARGET staff/internal function. "
            "Base the scenario on that target function; do not dodge to a nearby public "
            "command. The USER should describe the staff action in plain language instead "
            "of quoting slash-command syntax, hidden subcommands, or permission nodes. For "
            "example, prefer 'Can players reload this system?' over 'How do I use /x reload?'. "
            "The ASSISTANT must not repeat or expand staff command syntax, subcommands, permission "
            "nodes, operator requirements, backend details, or operational steps. It may "
            "acknowledge the high-level tool/action the player named, then simply explain "
            "that it is for staff/internal server management and normal players do not need "
            "those controls. Invite the player to explain their real goal so a safe "
            "player-facing option can be suggested. Do not invent a technical purpose."
        )
    return (
        "Write a normal player-facing answer. Sound like a helpful real server assistant, "
        "not documentation: lead with the useful answer, use simple everyday wording, "
        "short active sentences, and natural contractions where they fit. Prefer direct "
        "phrasing over robotic wording. Example: prefer 'Run the command to open the menu' "
        "over 'You can open the menu by using the command.' If something is unavailable, "
        "prefer 'It isn't active right now, so it won't work yet' over formal wording like "
        "'Please check back later once the feature is deployed.' Keep the tone warm and "
        "aware of the player's situation without forcing excitement. Do not expose "
        "permission nodes or backend jargon unless the player's question directly "
        "requires that information."
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
7. A category/reason/example list is NOT evidence for an earning, granting, unlocking,
   or automatic trigger mechanism. If EVIDENCE only defines what a category means, ask
   what it means and explain that meaning; do not say the player earns/gets it by doing it.
   Abstract example: evidence "X | Used for Y" supports "X is a category used for Y";
   it does NOT support "You earn X by doing Y."
8. Preserve relationships between units exactly. An interval is not an equality with a
   rate: never rewrite "every N ticks / up to M attempts per second" as "N ticks equals
   M attempts per second."
9. Keep server-specific nouns grounded. Do not replace an evidence term such as "event"
   with a broader unsupported noun such as "game" just to sound natural.
10. Choose the category by the player's actual need. Explanations of server-specific
   concepts such as reputation categories should normally use onboarding, not rank, unless
   the evidence is actually about a player rank or role.
11. Do not output secrets, credentials, hidden reasoning, chain-of-thought, evidence IDs,
   source IDs, SHAs, visibility, or internal validator metadata.

TARGET_EVIDENCE_LINE:
{job["target_line"]}

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