# Enthusia AI

Enthusia AI is the planned server-wide intelligence platform for the Enthusia Minecraft network.

The project is intentionally broader than a Discord support bot. The target system is a persistent, server-aware AI layer that can answer player and staff questions, inspect current Enthusia systems before making factual claims, retain evidence-backed operational memory, coordinate support tickets, assist moderation, investigate technical issues, and escalate difficult engineering work to stronger external models.

## Authoritative specification

**Read this before implementing anything:**

- [Master Specification](docs/MASTER-SPECIFICATION.md)
- [Memory, Knowledge, and Fact Verification Contract](docs/MEMORY-KNOWLEDGE-VERIFICATION-SPEC.md)
- [Training and Evaluation Specification](docs/TRAINING-AND-EVALUATION-SPEC.md)
- [Worker Execution Plan](docs/WORKER-EXECUTION-PLAN.md)

The master specification is the source of truth for product behavior, architecture, memory semantics, knowledge verification, tool access, training, deployment, security, evaluation, and rollout.

If implementation and the specification disagree, implementation should be treated as wrong unless the specification is deliberately amended.

## Core principles

- Current Enthusia facts must be verified against authoritative evidence before being stated.
- Model weights teach behavior; live sources provide current truth.
- Current memory contains only the latest supported belief. Superseded values remain in history, not normal retrieval.
- The AI should investigate relevant context proactively instead of guessing.
- Moderation remains isolated from slower support/reasoning workloads.
- Local models handle routine work; stronger OpenAI models remain available for deep investigation and coding.
- Destructive or high-impact actions require explicit authorization policies.
- Secrets are used by tools, never learned by the model.
- The AI platform is separate from the existing Ticket Bot; the Ticket Bot remains the ticket lifecycle authority.

## License

This project is proprietary. See [LICENSE](LICENSE).
