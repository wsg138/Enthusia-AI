/**
 * @enthusia/agent-core — agent orchestrator (W12).
 *
 * The local AI's investigative behavior (MASTER-SPECIFICATION.md §15):
 * intent classification, evidence planning, tool selection, the bounded
 * investigation loop, tool budgets (§78), claim verification (§11),
 * policy-driven escalation (§22), response assembly, and memory update
 * proposals (W05 owns the writes).
 *
 * Tools are injected via {@link ToolRegistry}; the reasoner (local model via
 * W03) is injected via {@link Reasoner}. All consequential decisions —
 * budgets, privacy, verification verdicts, escalation — are computed
 * deterministically by this package, never by the model (§15.4).
 */

// Orchestrator entry point
export { AgentOrchestrator, resolveTraceId, wantsDeepInvestigation } from './orchestrator.js';
export type {
  OrchestratorDeps,
  VerifiedTopicHelpEvent,
} from './orchestrator.js';

// Core types
export {
  ESCALATION_TARGETS,
  REQUEST_CLASSES,
  VERIFICATION_TIERS,
  isEscalationTarget,
  isRequestClass,
  verificationTierRank,
} from './types.js';
export type {
  Actor,
  ChatRequest,
  ClaimAssessment,
  ClaimEvidencePayload,
  ClaimVerdict,
  Contradiction,
  EscalationHint,
  EscalationTarget,
  EvidenceItem,
  EvidencePlanStep,
  ExecutedToolCall,
  IntentClassification,
  InvestigationSnapshot,
  MemoryIdentity,
  MemoryUpdateProposal,
  RequestClass,
  ResolvedChatRequest,
  ResponseDraft,
  ResponseFamiliarityLevel,
  ResponseStyleProfile,
  SupersededMemory,
  ToolCallProposal,
  TraceId,
  VerificationTier,
} from './types.js';

// Tool interface + DI registry (W10/W08/W07/W05/W11 plug tools in here)
export { ToolRegistry, validateToolParams } from './tool.js';
export type {
  Tool,
  ToolCallContext,
  ToolMetadata,
  ToolParameterProperty,
  ToolParametersSchema,
} from './tool.js';

// Reasoner seam (W03-backed in production; mocked in tests)
export { TimeoutReasoner } from './reasoner.js';
export type {
  ClaimHint,
  DraftArgs,
  InvestigationDecision,
  Reasoner,
} from './reasoner.js';

// Freshness convention for ToolResult.freshness
export { decodeFreshness, encodeFreshness } from './freshness.js';
export type { FreshnessInfo } from './freshness.js';

// Budgets (§78)
export { BudgetTracker, BUDGET_POLICIES, policyForRequestClass } from './budget.js';
export type { BudgetOverrides, BudgetPolicy } from './budget.js';

// Pipeline stages (also usable standalone)
export { classifyIntent, normalizeClassification } from './intent.js';
export { buildEvidencePlan, normalizePlan } from './evidence-plan.js';
export type { EvidencePlan } from './evidence-plan.js';
export {
  runInvestigation,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './investigation.js';
export type {
  InvestigationDeps,
  InvestigationInput,
  InvestigationOutcome,
  TerminationReason,
} from './investigation.js';
export {
  DEFAULT_MAX_LIVE_AGE_MS,
  assessAllClaims,
  assessAllClaimsDisclosable,
  assessClaim,
  assessClaimDisclosable,
  detectContradictions,
  extractClaimEvidence,
  isCurrentEvidence,
  isToolSuccess,
  normalizeValue,
} from './verification.js';
export type { DisclosureFilter, VerificationOptions } from './verification.js';
export { decideEscalation, packetRefFor, toWireEscalation } from './escalation.js';
export type { EscalationDecision, EscalationInput } from './escalation.js';
export {
  buildInvestigationPacket,
  extractFiles,
  extractRepositories,
  isPacketVisible,
} from './packet.js';
export type { InvestigationPacket, PacketEvidence, PacketInput } from './packet.js';
export {
  normalizeMemoryProposals,
  proposalFromSuperseded,
  looksLikeSecret,
} from './memory-updates.js';
export {
  DEFAULT_STYLE_TOOL_TIMEOUT_MS,
  MIN_FAMILIARITY_CONFIDENCE,
  TOPIC_FAMILIARITY_TOOL,
  resolveResponseStyle,
} from './response-style.js';
export type { ResponseStyleDeps } from './response-style.js';
export {
  assembleResponse,
  buildVerifiedAnswerParts,
} from './response.js';
export type {
  AnswerDisclosure,
  AssembleArgs,
  VerifiedAnswerPart,
} from './response.js';
