# deploy/bloom

Bloom.host (Pterodactyl) deployment target — W21.

SKELETON (W01). No deployment happens from this workstream.

Planned contents:

- Pterodactyl egg / startup configuration;
- process supervisor config with resource limits (CPU/RAM bounds per §9.2, §63);
- environment wiring (secrets injected by the panel, never committed);
- health-check wiring (`/health/live`, `/health/ready`);
- rollback procedure.

Constraints: the AI processes must never starve the SMP of resources (§63);
AI process failure must not stop SMP, moderation, or the Ticket Bot.
