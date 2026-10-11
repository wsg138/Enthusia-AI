import { z } from 'zod';
import { Visibility } from './visibility.js';

/**
 * Chat request / agent response contracts — the stable API boundary for all
 * surfaces (Discord, Minecraft, ticket, staff).
 *
 * Spec: MASTER-SPECIFICATION.md §48.1 / §48.2.
 */

/** Product surface the request arrived on. */
export type Surface = 'discord' | 'minecraft' | 'ticket' | 'staff';

export const SURFACES: readonly Surface[] = ['discord', 'minecraft', 'ticket', 'staff'] as const;

export type ActorType = 'player' | 'staff' | 'system' | 'unknown';

export interface Actor {
  /** Stable actor identity (player UUID, Discord user ID, staff ID, ...). */
  id: string;
  type: ActorType;
  displayName?: string;
  /** Linked Minecraft UUID when the actor is a player known to the network. */
  linkedUuid?: string;
}

export interface ChatRequest {
  surface: Surface;
  actor: Actor;
  /** Conversation/thread identity for continuity. */
  conversationId: string;
  /** The raw user message. */
  message: string;
  /** Surface-specific context (channel, ticket ID, locale, ...). */
  context?: Record<string, unknown>;
  /** Maximum visibility the response may draw on (§17). */
  visibilityCeiling: Visibility;
  /** Optional caller-supplied trace ID; generated when absent. */
  traceId?: string;
}

export interface AgentAction {
  /** Action type, e.g. 'tool.call', 'ticket.update', 'escalate.human'. */
  type: string;
  payload?: Record<string, unknown>;
}

export interface ResponseSource {
  /** Linked source artifact when the claim is artifact-backed. */
  artifactId?: string;
  /** Human-readable description of the evidence. */
  description: string;
  visibility: Visibility;
}

export interface MemoryUpdateProposal {
  namespace: string;
  key: string;
  scope: string;
  summary: string;
  /** Proposed value/summary; exact storage shape is the memory service's. */
  value: unknown;
}

export interface Escalation {
  reason: string;
  /** 'human' → staff queue; 'strong-model' → OpenAI escalation (§5.9). */
  target: 'human' | 'strong-model';
  context?: Record<string, unknown>;
}

export interface AgentResponse {
  /** User-facing text (already visibility-filtered for the surface). */
  text: string;
  actions: AgentAction[];
  /** Evidence backing the answer (§11.3 mandatory answer grounding). */
  sources: ResponseSource[];
  /** Memory writes proposed/applied during this turn. */
  memoryUpdates: MemoryUpdateProposal[];
  /** Set when the request was escalated instead of answered directly. */
  escalation: Escalation | null;
  traceId: string;
  /** Result for surface UX: answered, unverified, or an internal processing error. */
  outcome?: 'answered' | 'unverified' | 'error';
}

const actorSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['player', 'staff', 'system', 'unknown']),
  displayName: z.string().optional(),
  linkedUuid: z.string().optional(),
});

export const chatRequestSchema = z.object({
  surface: z.enum(SURFACES),
  actor: actorSchema,
  conversationId: z.string().min(1),
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
  visibilityCeiling: z.nativeEnum(Visibility),
  traceId: z.string().optional(),
});

export const agentResponseSchema = z.object({
  text: z.string(),
  actions: z.array(
    z.object({
      type: z.string().min(1),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  sources: z.array(
    z.object({
      artifactId: z.string().optional(),
      description: z.string().min(1),
      visibility: z.nativeEnum(Visibility),
    }),
  ),
  memoryUpdates: z.array(
    z.object({
      namespace: z.string().min(1),
      key: z.string().min(1),
      scope: z.string().min(1),
      summary: z.string().min(1),
      value: z.unknown(),
    }),
  ),
  escalation: z
    .object({
      reason: z.string().min(1),
      target: z.enum(['human', 'strong-model']),
      context: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
  traceId: z.string().min(1),
  outcome: z.enum(['answered', 'unverified', 'error']).optional(),
});
