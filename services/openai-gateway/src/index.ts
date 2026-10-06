/**
 * @enthusia/openai-gateway — strong-model escalation gateway with cost controls (W13).
 *
 * The stronger-model/coding escalation path for Enthusia AI. It also exposes
 * a separately gated, bounded image-evidence observer for ticket evidence.
 * W12's agent core investigates locally and builds the structured §22.2 investigation
 * packet; this service decides (policy), formats, sends (OpenAI chat
 * completions), budgets, and normalizes the result to AgentResponse.
 *
 * Spec: MASTER-SPECIFICATION.md §§22, 37, 46, 89; WORKER-EXECUTION-PLAN.md §16.
 * If this code and the spec disagree, the spec wins.
 */
export * from './models.js';
export * from './packet.js';
export * from './packet-format.js';
export * from './openai-client.js';
export * from './image-evidence.js';
export * from './stable-json.js';
export * from './budget.js';
export * from './config.js';
export * from './escalation-policy.js';
export * from './response-normalize.js';

import { loadConfig, ConfigError, type GatewayConfig } from './config.js';
import {
  assertValidInvestigationPacket,
  type InvestigationPacket,
} from './packet.js';
import {
  authorizeEscalation,
  type AuthorizedEscalation,
  type EscalationDecision,
} from './escalation-policy.js';
import {
  estimatePromptTokens,
  formatEscalationMessages,
} from './packet-format.js';
import { OpenAIClient } from './openai-client.js';
import { CostTracker } from './budget.js';
import {
  normalizeToAgentResponse,
  type NormalizedEscalation,
} from './response-normalize.js';
import type { EscalationKind } from './models.js';

/** Input for one escalation run. */
export interface RunEscalationInput {
  /** W12's escalation decision (target must be 'openai'). */
  decision: EscalationDecision;
  /** W12's structured §22.2 investigation packet. */
  packet: InvestigationPacket;
  /** OpenAI escalations already consumed for this traceId (§37). */
  escalationsUsedForTrace: number;
}

/** Injectable dependencies (tests, embedding services). */
export interface RunEscalationDeps {
  config?: GatewayConfig;
  client?: OpenAIClient;
  tracker?: CostTracker;
}

export interface RunEscalationResult extends NormalizedEscalation {
  kind: EscalationKind;
  authorization: AuthorizedEscalation;
}

/**
 * Run one escalation end to end:
 * validate packet → policy gate → format → budget pre-check → call →
 * record spend → normalize to AgentResponse.
 *
 * Throws InvalidPacketError, EscalationDeniedError, ConfigError,
 * BudgetExceededError, OpenAIError subclasses. Never touches the live
 * network except the configured OpenAI base URL; never logs the API key.
 */
export async function runEscalation(
  input: RunEscalationInput,
  deps: RunEscalationDeps = {},
): Promise<RunEscalationResult> {
  const config = deps.config ?? loadConfig();

  // 1. The packet must be a well-formed §22.2 packet before anything else.
  assertValidInvestigationPacket(input.packet);

  // 2. No credentials, no escalation. (Tests use a fake key + mock server.)
  if (config.apiKey.trim().length === 0) {
    throw new ConfigError(
      'OPENAI_API_KEY is not set; refusing to escalate without credentials',
    );
  }

  // 3. Policy gate: target, packet↔decision consistency, per-request call cap.
  const authorization = authorizeEscalation({
    decision: input.decision,
    packet: input.packet,
    escalationsUsedForTrace: input.escalationsUsedForTrace,
    maxEscalationsPerRequest: config.budget.maxEscalationsPerRequest,
    modelSelection: config.modelSelection,
  });

  // 4. Format the §22.2 packet for the stronger model.
  const messages = formatEscalationMessages(input.packet, authorization.kind);
  const promptTokens = estimatePromptTokens(messages);

  // 5. Budget pre-check (per-request + per-day) BEFORE the API call.
  const tracker =
    deps.tracker ?? new CostTracker(config.budget, config.modelPrices);
  tracker.checkBudget(
    input.packet.traceId,
    authorization.model,
    promptTokens,
    config.maxOutputTokens,
  );

  // 6. Call the stronger model (with timeout).
  const client =
    deps.client ??
    new OpenAIClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    });
  const completion = await client.chatCompletions({
    model: authorization.model,
    messages,
    maxOutputTokens: config.maxOutputTokens,
  });

  // 7. Log tokens used and estimated cost.
  const usageRecord = tracker.recordUsage({
    traceId: input.packet.traceId,
    packetRef: input.packet.packetRef,
    model: authorization.model,
    promptTokens: completion.usage.promptTokens,
    completionTokens: completion.usage.completionTokens,
  });

  // 8. Normalize to the AgentResponse contract.
  const response = normalizeToAgentResponse({
    content: completion.content,
    model: authorization.model,
    finishReason: completion.finishReason,
    usage: completion.usage,
    estimatedCostUsd: usageRecord.estimatedCostUsd,
    packet: input.packet,
    escalationReason: input.decision.reason,
  });

  return {
    analysisContent: completion.content,
    response,
    usage: completion.usage,
    estimatedCostUsd: usageRecord.estimatedCostUsd,
    model: authorization.model,
    kind: authorization.kind,
    authorization,
  };
}
