/**
 * @enthusia/ai-gateway — stable API boundary for Discord/Minecraft/Ticket surfaces.
 *
 * Spec: MASTER-SPECIFICATION.md §§7, 18, 36, 37, 47, 48;
 * WORKER-EXECUTION-PLAN.md §5 (W02).
 *
 * Owns: request ingress, service authentication, rate limits, conversation
 * routing (to the mock agent in W02), trace IDs, visibility ceiling
 * propagation, and health endpoints.
 *
 * Endpoints: POST /v1/chat, GET /health/live, GET /health/ready.
 */
export * from './config.js';
export * from './auth.js';
export * from './rate-limit.js';
export * from './agent.js';
export * from './router.js';
export * from './server.js';
