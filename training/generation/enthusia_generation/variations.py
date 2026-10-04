"""Linguistic variation forms (TRAINING-AND-EVALUATION-SPEC section 5).

For each feature/system the spec requires more than one linguistic form per
underlying scenario:

    faq                 simple FAQ
    typo                typo-heavy question (deterministic, seeded)
    new_player          new-player wording (opener pool, seeded)
    advanced            advanced question (explicit per-scenario variant)
    wrong_assumption    incorrect assumption (explicit per-scenario variant)
    missing_evidence    missing evidence (explicit per-scenario variant)
    conflicting_evidence conflicting evidence (explicit per-scenario variant)
    troubleshooting     player-specific troubleshooting (usually a tool trace)
    historical          historical question (explicit per-scenario variant)
    staff_only          staff-only question (visibility=staff, explicit variant)
    escalation          escalation-required case (explicit per-scenario variant)

Forms faq/typo/new_player are rendered algorithmically from a scenario's base
Q&A. All other forms require an explicit per-scenario variant so the content
stays coherent. A scenario lists the forms it supports; corpus.py only emits
defined (scenario, form) pairs.
"""

from __future__ import annotations

import random
import re

# All variation forms defined by the spec.
FORMS = (
    "faq",
    "typo",
    "new_player",
    "advanced",
    "wrong_assumption",
    "missing_evidence",
    "conflicting_evidence",
    "troubleshooting",
    "historical",
    "staff_only",
    "escalation",
)

# Forms rendered algorithmically from the base Q&A (no explicit variant needed).
ALGORITHMIC_FORMS = ("faq", "typo", "new_player")

# Tag applied per form (used for coverage + W16 special partitions).
FORM_TAGS = {
    "faq": "faq",
    "typo": "typo-heavy",
    "new_player": "new-player",
    "advanced": "advanced",
    "wrong_assumption": "incorrect-assumption",
    "missing_evidence": "missing-evidence",
    "conflicting_evidence": "conflicting-evidence",
    "troubleshooting": "troubleshooting",
    "historical": "historical",
    "staff_only": "staff-only",
    "escalation": "escalation",
}

NEW_PLAYER_OPENERS = (
    "hi im new here, ",
    "sorry if this is a dumb question but ",
    "i just joined yesterday and ",
    "first time playing on a server like this, ",
)

NEW_PLAYER_CLOSERS = (
    " thanks!",
    " pls help",
    "",
)


def _typo_word(word: str, rng: random.Random) -> str:
    """Apply one small deterministic typo to a word."""
    if len(word) < 4 or not word.isalpha():
        return word
    op = rng.random()
    i = rng.randrange(len(word))
    if op < 0.4 and len(word) > 4:
        # drop a letter
        return word[:i] + word[i + 1 :]
    if op < 0.7 and i < len(word) - 1:
        # swap two adjacent letters
        return word[:i] + word[i + 1] + word[i] + word[i + 2 :]
    # double a letter
    return word[: i + 1] + word[i] + word[i + 1 :]


def typo_transform(text: str, rng: random.Random, rate: float = 0.10) -> str:
    """Inject typos into ~rate of eligible words. Deterministic given rng.

    Guarantees at least one typo when the text has any eligible word, so a
    "typo-heavy" variant is never byte-identical to its base rendering.
    """
    parts = re.split(r"(\W+)", text)
    eligible = [i for i, p in enumerate(parts) if p.isalpha() and len(p) >= 4]
    chosen = {i for i in eligible if rng.random() < rate}
    if eligible and not chosen:
        chosen = {rng.choice(eligible)}
    out = []
    for i, p in enumerate(parts):
        if i in chosen:
            new = _typo_word(p.lower(), rng)
            # _typo_word can no-op on repeated adjacent letters; force a change.
            if new == p.lower():
                new = p.lower() + p.lower()[-1]
            out.append(new)
        else:
            out.append(p)
    return "".join(out)


def new_player_transform(text: str, rng: random.Random) -> str:
    opener = rng.choice(NEW_PLAYER_OPENERS)
    closer = rng.choice(NEW_PLAYER_CLOSERS)
    return opener + text[0].lower() + text[1:] + closer


def render_user_message(form: str, base_user: str, rng: random.Random) -> str:
    """Render the user message for an algorithmic form."""
    if form == "faq":
        return base_user
    if form == "typo":
        return typo_transform(base_user, rng)
    if form == "new_player":
        return new_player_transform(base_user, rng)
    raise ValueError(f"form {form!r} is not algorithmic; provide an explicit variant")
