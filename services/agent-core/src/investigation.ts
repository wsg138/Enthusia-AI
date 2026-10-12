/**
 * @enthusia/agent-core — bounded investigation loop (W12).
 *
 * Spec §15.1 steps 5–7 (retrieve/verify, inspect contradictions, expand
 * search if needed) and §15.3 (bounded curiosity: budgets, max depth,
 * timeouts, visibility constraints).
 *
 * Hard guarantees, independent of the reasoner:
 * - the loop terminates: tool budget, iteration cap, reasoner-call cap, and
 *   wall-clock timeout are all enforced here;
 * - privacy-sensitive tools are refused unless the classification says the
 *   request needs private context (§15.3, "never query irrelevant private
 *   context");
 * - unknown or invented tools are never executed;
 * - when the reasoner stops early but the plan lists untried tools for
 *   evidence-less claims, the orchestrator auto-expands the search once per
 *   claim (bounded by the same budget).
 */
import { Visibility } from '@enthusia/contracts';
import type { MemoryUpdateProposal } from '@enthusia/contracts';
import type { BudgetPolicy, BudgetTracker } from './budget.js';
import type { EvidencePlanStep } from './types.js';
import type {
  Contradiction,
  EscalationHint,
  EvidenceItem,
  ExecutedToolCall,
  IntentClassification,
  InvestigationSnapshot,
  ResolvedChatRequest,
  ToolCallProposal,
} from './types.js';
import type { Reasoner } from './reasoner.js';
import type { ClaimHint, InvestigationDecision } from './reasoner.js';
import type { ToolCallContext, ToolRegistry } from './tool.js';
import { validateToolParams } from './tool.js';
import {
  detectContradictions,
  extractClaimEvidence,
  isToolSuccess,
  type VerificationOptions,
} from './verification.js';

/** Default consecutive-failure threshold (§22.1 "repeated local tool failures"). */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** Default per-tool timeout. */
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export type TerminationReason =
  | 'evidence_complete'
  | 'budget_exhausted'
  | 'repeated_tool_failures'
  | 'timeout'
  | 'privacy_blocked'
  | 'reasoner_error';

export interface InvestigationDeps {
  reasoner: Reasoner;
  registry: ToolRegistry;
  policy: BudgetPolicy;
  budget: BudgetTracker;
  /** Epoch milliseconds clock (injectable for tests). */
  nowMs?: () => number;
  maxConsecutiveFailures?: number;
  toolTimeoutMs?: number;
  verification?: VerificationOptions;
}

export interface InvestigationInput {
  request: ResolvedChatRequest;
  classification: IntentClassification;
  plan: EvidencePlanStep[];
}

export interface InvestigationOutcome {
  request: ResolvedChatRequest;
  classification: IntentClassification;
  plan: EvidencePlanStep[];
  evidence: EvidenceItem[];
  executedCalls: ExecutedToolCall[];
  contradictions: Contradiction[];
  consecutiveFailures: number;
  claimHints: ClaimHint[];
  memoryProposals: MemoryUpdateProposal[];
  escalationHint?: EscalationHint;
  termination: TerminationReason;
  /** SECRET_DENY payloads dropped without ingestion (§17.6). */
  secretPayloadsDropped: number;
  /** Free-form trace notes (auto-expansions, blocked calls, ...). */
  notes: string[];
}

/** A proposal after sanitization: either executable or refused with a reason. */
interface SanitizedProposal {
  proposal: ToolCallProposal;
  executable: boolean;
  blockReason?: string;
}

/**
 * Run the bounded investigation loop.
 *
 * Returns the outcome; the orchestrator then verifies claims, decides
 * escalation, and assembles the response.
 */
export async function runInvestigation(
  input: InvestigationInput,
  deps: InvestigationDeps,
): Promise<InvestigationOutcome> {
  const nowMs = deps.nowMs ?? Date.now;
  const maxConsecutiveFailures =
    deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const toolTimeoutMs = deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const deadline = nowMs() + deps.policy.timeoutMs;

  const evidence: EvidenceItem[] = [];
  const executedCalls: ExecutedToolCall[] = [];
  const notes: string[] = [];
  const claimHints: ClaimHint[] = [];
  const memoryProposals: MemoryUpdateProposal[] = [];
  let escalationHint: EscalationHint | undefined;
  let consecutiveFailures = 0;
  let secretPayloadsDropped = 0;
  let evidenceCounter = 0;

  const snapshot = (): InvestigationSnapshot => ({
    request: input.request,
    classification: input.classification,
    plan: input.plan,
    evidence: [...evidence],
    contradictions: detectContradictions(evidence),
    executedCalls: [...executedCalls],
    consecutiveFailures,
    budget: {
      toolCallsRemaining: deps.budget.toolCallsRemaining(),
      iterationsRemaining: deps.budget.iterationsRemaining(),
      reasonerCallsRemaining: deps.budget.reasonerCallsRemaining(),
    },
  });

  const executeRound = async (
    proposals: ToolCallProposal[],
    autoExpanded: boolean,
  ): Promise<void> => {
    for (const proposal of proposals) {
      const tool = deps.registry.get(proposal.toolName);
      if (!tool) continue; // sanitized already; defensive
      const started = nowMs();
      const timeoutSignal =
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(toolTimeoutMs)
          : undefined;
      const ctx: ToolCallContext = {
        traceId: input.request.traceId,
        actor: input.request.actor,
        visibilityCeiling: input.request.visibilityCeiling,
        ...(timeoutSignal !== undefined ? { signal: timeoutSignal } : {}),
      };
      const call: ExecutedToolCall = {
        toolName: proposal.toolName,
        params: proposal.params,
        ...(proposal.claim ? { claim: proposal.claim } : {}),
        ok: false,
        blocked: false,
        durationMs: 0,
      };
      try {
        const envelope = await tool.execute(proposal.params, ctx);
        call.durationMs = nowMs() - started;
        if (envelope.visibility === Visibility.SECRET_DENY) {
          // §17.6: SECRET_DENY material is never ingested into model-visible
          // storage. The call itself succeeded; the payload is dropped
          // without inspection.
          call.ok = true;
          consecutiveFailures = 0;
          secretPayloadsDropped += 1;
          notes.push(
            `tool ${proposal.toolName} returned SECRET_DENY data; payload dropped (§17.6)`,
          );
        } else if (isToolSuccess(envelope)) {
          call.ok = true;
          consecutiveFailures = 0;
          evidenceCounter += 1;
          const item = extractClaimEvidence(
            `e${evidenceCounter}`,
            proposal.claim ?? input.classification.claims[0] ?? '(unclaimed)',
            proposal.toolName,
            envelope,
            tool.meta.verificationTier,
            {
              ...(deps.verification ?? {}),
              nowMs: nowMs(),
            },
          );
          if (item) {
            evidence.push(item);
          } else if (autoExpanded) {
            notes.push(
              `auto-expanded ${proposal.toolName} returned no claim evidence`,
            );
          }
        } else {
          call.ok = false;
          if (envelope.error?.code !== undefined) {
            call.errorCode = envelope.error.code;
          }
          consecutiveFailures += 1;
          notes.push(
            `tool ${proposal.toolName} failed: ${envelope.error?.code ?? 'unknown'} — ${envelope.error?.message ?? ''}`,
          );
        }
      } catch (err) {
        call.durationMs = nowMs() - started;
        call.ok = false;
        call.errorCode = 'tool_execution_error';
        consecutiveFailures += 1;
        notes.push(
          `tool ${proposal.toolName} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      executedCalls.push(call);
      deps.budget.recordToolCalls(1);
    }
  };

  // With no planned evidence steps there is nothing to investigate.
  // Do not force a model-generated tool decision when no tools are usable.
  if (input.plan.length === 0) {
    return finish('evidence_complete');
  }

  // Main loop — every exit path is deterministic and budget-bounded.
  for (;;) {
    if (deps.budget.exhausted()) {
      return finish('budget_exhausted');
    }
    if (nowMs() > deadline) {
      return finish('timeout');
    }
    if (!deps.budget.canCallReasoner()) {
      return finish('budget_exhausted');
    }

    deps.budget.recordReasonerCalls(1);
    let decision: InvestigationDecision;
    try {
      decision = await deps.reasoner.nextStep(snapshot());
    } catch (err) {
      notes.push(
        `reasoner error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return finish('reasoner_error');
    }
    mergeDecisionHints(decision);

    const sanitized = sanitizeProposals(
      decision.action === 'call_tools' ? decision.calls : [],
      input,
      deps,
    );
    const executable = sanitized.filter((s) => s.executable);
    const refused = sanitized.filter((s) => !s.executable);

    for (const r of refused) {
      executedCalls.push({
        toolName: r.proposal.toolName,
        params: r.proposal.params,
        ...(r.proposal.claim ? { claim: r.proposal.claim } : {}),
        ok: false,
        blocked: true,
        ...(r.blockReason !== undefined ? { blockReason: r.blockReason } : {}),
        durationMs: 0,
      });
      notes.push(`refused ${r.proposal.toolName}: ${r.blockReason}`);
    }

    if (executable.length === 0) {
      // §15.1 step 7: expand the search when evidence is incomplete — whether
      // the reasoner stopped early or every proposed call was refused.
      const expansion = sanitizeProposals(
        planExpansion(input, deps, executedCalls, evidence),
        input,
        deps,
      );
      for (const r of expansion) {
        if (!r.executable) {
          notes.push(
            `auto-expansion refused ${r.proposal.toolName}: ${r.blockReason}`,
          );
        }
      }
      const executableExpansion = expansion.filter((s) => s.executable);
      if (
        executableExpansion.length > 0 &&
        deps.budget.canCallTools(executableExpansion.length) &&
        deps.budget.canIterate()
      ) {
        notes.push(
          `auto-expanding search: ${executableExpansion.map((e) => e.proposal.toolName).join(', ')}`,
        );
        await executeRound(
          executableExpansion.map((s) => s.proposal),
          true,
        );
        deps.budget.recordIteration();
        if (consecutiveFailures >= maxConsecutiveFailures) {
          return finish('repeated_tool_failures');
        }
        continue;
      }
      if (decision.action === 'finish' || decision.calls.length === 0) {
        return finish('evidence_complete');
      }
      // The reasoner proposed calls but every one was refused.
      const allPrivacy =
        refused.length > 0 &&
        refused.every((r) => (r.blockReason ?? '').startsWith('privacy'));
      return finish(allPrivacy ? 'privacy_blocked' : 'evidence_complete');
    }

    if (!deps.budget.canCallTools(executable.length)) {
      return finish('budget_exhausted');
    }
    if (!deps.budget.canIterate()) {
      return finish('budget_exhausted');
    }

    await executeRound(
      executable.map((s) => s.proposal),
      false,
    );
    deps.budget.recordIteration();

    if (consecutiveFailures >= maxConsecutiveFailures) {
      return finish('repeated_tool_failures');
    }
  }

  function finish(termination: TerminationReason): InvestigationOutcome {
    return {
      request: input.request,
      classification: input.classification,
      plan: input.plan,
      evidence,
      executedCalls,
      contradictions: detectContradictions(evidence),
      consecutiveFailures,
      claimHints,
      memoryProposals,
      ...(escalationHint ? { escalationHint } : {}),
      termination,
      notes,
      secretPayloadsDropped,
    };
  }

  function mergeDecisionHints(decision: InvestigationDecision): void {
    if (decision.claimHints) {
      claimHints.push(...decision.claimHints);
    }
    if (decision.memoryProposals) {
      memoryProposals.push(...decision.memoryProposals);
    }
    if (decision.escalationHint) {
      escalationHint = decision.escalationHint;
    }
    if (decision.note) {
      notes.push(`reasoner: ${decision.note}`);
    }
  }
}

/**
 * Sanitize reasoner-proposed tool calls. Refusals (never executions):
 * - unknown tools (the model may not invent tools);
 * - tools that may return SECRET_DENY data (§17.6);
 * - privacy-sensitive tools when the request does not need private context;
 * - params failing structural validation.
 */
function sanitizeProposals(
  proposals: ToolCallProposal[],
  input: InvestigationInput,
  deps: InvestigationDeps,
): SanitizedProposal[] {
  return proposals.map((proposal) => {
    const tool = deps.registry.get(proposal.toolName);
    if (!tool) {
      return {
        proposal,
        executable: false,
        blockReason: `unknown tool "${proposal.toolName}"`,
      };
    }
    if (tool.meta.maxVisibility === Visibility.SECRET_DENY) {
      return {
        proposal,
        executable: false,
        blockReason:
          `refused: tool "${proposal.toolName}" may return SECRET_DENY data (§17.6)`,
      };
    }
    if (
      tool.meta.privacySensitive &&
      !input.classification.needsPrivateContext
    ) {
      return {
        proposal,
        executable: false,
        blockReason:
          `privacy: tool "${proposal.toolName}" reads private context ` +
          `which this request does not require (§15.3)`,
      };
    }
    const paramProblems = validateToolParams(
      tool.meta,
      proposal.params ?? {},
    );
    if (paramProblems.length > 0) {
      return {
        proposal,
        executable: false,
        blockReason: `invalid params: ${paramProblems.join('; ')}`,
      };
    }
    return { proposal, executable: true };
  });
}

/**
 * Auto-expansion (§15.1 step 7): for claims with no current evidence, find
 * plan candidate tools that have not been tried yet (and pass the privacy
 * gate). Bounded: one untried tool per evidence-less claim, subject to the
 * same budget as everything else.
 */
function planExpansion(
  input: InvestigationInput,
  deps: InvestigationDeps,
  executedCalls: ExecutedToolCall[],
  evidence: EvidenceItem[],
): ToolCallProposal[] {
  const tried = new Set(executedCalls.map((c) => c.toolName));
  const hasCurrentEvidence = (claim: string): boolean =>
    evidence.some((e) => e.claim === claim && e.current);
  const expansion: ToolCallProposal[] = [];
  for (const step of input.plan) {
    if (hasCurrentEvidence(step.claim)) continue;
    const candidate = step.candidateTools.find((name) => {
      if (tried.has(name)) return false;
      const tool = deps.registry.get(name);
      if (!tool) return false;
      if (
        tool.meta.privacySensitive &&
        !input.classification.needsPrivateContext
      ) {
        return false;
      }
      return true;
    });
    if (candidate) {
      tried.add(candidate);
      expansion.push({
        toolName: candidate,
        params: step.params ?? {},
        claim: step.claim,
        rationale: 'auto-expansion: claim has no current evidence yet',
      });
    }
  }
  return expansion;
}
