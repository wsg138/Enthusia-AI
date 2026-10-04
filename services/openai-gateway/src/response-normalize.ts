/**
 * @enthusia/openai-gateway — response normalization (W13).
 *
 * Converts the stronger model's chat completion into the @enthusia/contracts
 * AgentResponse shape so downstream surfaces (agent-core, Discord, staff)
 * treat an escalated answer exactly like any other agent turn.
 *
 * Spec: MASTER-SPECIFICATION.md §22.3 (OpenAI response handling), §48.2
 * (AgentResponse). Per §22.3 the local agent still verifies applicable
 * current facts and presents the player-safe result; normalization here
 * preserves the raw model output, its provenance, and the cost, so that
 * verification pass has everything it needs.
 */
import { canDisclose } from '@enthusia/contracts';
import type { AgentResponse, ResponseSource } from '@enthusia/contracts';
import type { InvestigationPacket } from './packet.js';
import type { TokenUsage } from './openai-client.js';

export interface NormalizeInput {
  content: string;
  model: string;
  finishReason: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
  packet: InvestigationPacket;
  escalationReason: string;
}

export interface NormalizedEscalation {
  /** Internal stronger-model analysis; MUST pass local verification before presentation. */
  analysisContent: string;
  response: AgentResponse;
  usage: TokenUsage;
  estimatedCostUsd: number;
  model: string;
}

/**
 * Build the AgentResponse for a completed escalation.
 *
 * - text: the stronger model's output verbatim (player-safe filtering and
 *   fact verification are the local agent's job, §22.3).
 * - sources: the packet's tool evidence, so every claim stays grounded.
 * - escalation: marked as resolved via the strong-model target, carrying
 *   the packet ref, model, token usage, and cost for audit.
 */
export function normalizeToAgentResponse(
  input: NormalizeInput,
): AgentResponse {
  const seen = new Set<string>();
  const sources: ResponseSource[] = [];
  for (const evidence of input.packet.toolEvidence) {
    if (
      !canDisclose(
        evidence.visibility,
        input.packet.authorization.visibilityCeiling,
        { isStaff: input.packet.authorization.actorKind === 'staff' },
      )
    ) {
      continue;
    }
    const key = `${evidence.source}\u0000${evidence.claim}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sources.push({
      artifactId: evidence.source,
      description: `${evidence.claim} — ${evidence.toolName} (${evidence.verificationTier})`,
      visibility: evidence.visibility,
    });
  }

  const auditPayload = {
    packetRef: input.packet.packetRef,
    model: input.model,
    finishReason: input.finishReason,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    totalTokens: input.usage.totalTokens,
    estimatedCostUsd: input.estimatedCostUsd,
  };

  return {
    text:
      'Stronger-model analysis completed and is awaiting local fact verification before presentation.',
    actions: [
      {
        type: 'escalation.completed',
        payload: { ...auditPayload, requiresLocalVerification: true },
      },
    ],
    sources,
    memoryUpdates: [],
    escalation: {
      reason: input.escalationReason,
      target: 'strong-model',
      context: auditPayload,
    },
    traceId: input.packet.traceId,
  };
}
