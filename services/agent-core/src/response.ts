/**
 * @enthusia/agent-core — response assembly (W12).
 *
 * Spec §15.1 steps 8–9 (decide local answer versus escalation, produce
 * response) and §11.3 (mandatory answer grounding).
 *
 * The assembler is deterministic and policy-enforcing:
 * - every factual sentence comes from an orchestrator-computed
 *   {@link ClaimAssessment}, never from model output;
 * - supported claims are asserted with their source;
 * - unsupported claims say "could not verify" — the answer never guesses;
 * - contradicted claims surface the uncertainty and note the escalation;
 * - only evidence disclosable under the request's visibility ceiling is
 *   cited (§17); SECRET_DENY is never disclosable, and PLAYER_SELF evidence
 *   additionally requires staff (or subject) standing.
 *
 * The reasoner's draft contributes conversational framing (greeting,
 * sign-off) only. Factual content is assembled here so tests are
 * deterministic and the "no evidence → could not verify" policy cannot be
 * bypassed by model wording.
 */
import { canDisclose, Visibility } from '@enthusia/contracts';
import type {
  AgentResponse,
  MemoryUpdateProposal,
  ResponseSource,
} from '@enthusia/contracts';
import type {
  Actor,
  ClaimAssessment,
  EvidenceItem,
  ResolvedChatRequest,
  ResponseDraft,
} from './types.js';
import {
  toWireEscalation,
  type EscalationDecision,
} from './escalation.js';

export interface AssembleArgs {
  request: ResolvedChatRequest;
  assessments: ClaimAssessment[];
  /** All evidence (for citations and the source trace, §79). */
  evidence: EvidenceItem[];
  escalation: EscalationDecision | null;
  memoryProposals: MemoryUpdateProposal[];
  draft: ResponseDraft;
  /** Investigation notes worth surfacing (e.g. budget exhaustion). */
  notes?: string[];
}

const COULD_NOT_VERIFY = 'I could not verify';

/**
 * Assemble the final {@link AgentResponse} from verified claim assessments.
 */
export function assembleResponse(args: AssembleArgs): AgentResponse {
  const { request, assessments, evidence, escalation, memoryProposals, draft } =
    args;
  const ceiling = request.visibilityCeiling;
  const disclosure = disclosureOpts(request.actor);

  const lines: string[] = [];
  if (draft.preamble && draft.preamble.trim().length > 0) {
    lines.push(draft.preamble.trim());
  }

  if (assessments.length === 0) {
    lines.push(
      `${COULD_NOT_VERIFY} an answer: no checkable claims were identified for this request.`,
    );
  }

  for (const assessment of assessments) {
    lines.push(claimLine(assessment, ceiling, disclosure));
  }

  if (escalation) {
    lines.push(escalationLine(escalation));
  }

  const surfacedNotes = (args.notes ?? []).filter((n) => n.trim().length > 0);
  if (surfacedNotes.length > 0) {
    lines.push(`Note: ${surfacedNotes[0] as string}`);
  }

  if (draft.closing && draft.closing.trim().length > 0) {
    lines.push(draft.closing.trim());
  }

  const sources = buildCitations(evidence, ceiling, disclosure);

  return {
    text: lines.join('\n\n'),
    actions: [],
    sources,
    memoryUpdates: memoryProposals,
    escalation: escalation ? toWireEscalation(escalation) : null,
    traceId: request.traceId,
  };
}

interface DisclosureOpts {
  isSubject: boolean;
  isStaff: boolean;
}

/**
 * Derive §17 disclosure options from the actor. Staff actors may see
 * PLAYER_SELF evidence; anyone else may not (the orchestrator cannot prove
 * subject identity here — W11 owns that — so isSubject stays false).
 */
function disclosureOpts(actor: Actor): DisclosureOpts {
  return {
    isSubject: false,
    isStaff: actor.type === 'staff',
  };
}

/** One factual line per claim — the policy made visible. */
function claimLine(
  assessment: ClaimAssessment,
  ceiling: Visibility,
  disclosure: DisclosureOpts,
): string {
  switch (assessment.verdict) {
    case 'supported': {
      const citable = assessment.supporting.filter((e) =>
        canDisclose(e.visibility, ceiling, disclosure),
      );
      const sourceNote =
        citable.length > 0
          ? ` (source: ${(citable[0] as EvidenceItem).source})`
          : '';
      return `${assessment.claim}: ${assessment.assertedValue ?? '(no value)'}${sourceNote}`;
    }
    case 'unsupported':
      return `${COULD_NOT_VERIFY} ${assessment.claim}: no current evidence was found.`;
    case 'contradicted': {
      const parts = assessment.contradicting
        .filter((e) => canDisclose(e.visibility, ceiling, disclosure))
        .map((e) => `${e.source} says "${e.value}"`);
      const detail = parts.length > 0 ? `: ${parts.join('; ')}` : '.';
      return (
        `I found conflicting evidence about ${assessment.claim}${detail} ` +
        `I've flagged this for staff review rather than guessing.`
      );
    }
  }
}

function escalationLine(escalation: EscalationDecision): string {
  switch (escalation.target) {
    case 'openai':
      return `I've escalated this to our stronger model for deeper analysis. ${escalation.reason}`;
    case 'staff':
      return `I've flagged this for staff review. ${escalation.reason}`;
    case 'owner':
      return `I've flagged this for the server owner. ${escalation.reason}`;
  }
}

/** Citations for disclosable evidence (§79 response source trace). */
function buildCitations(
  evidence: EvidenceItem[],
  ceiling: Visibility,
  disclosure: DisclosureOpts,
): ResponseSource[] {
  const seen = new Set<string>();
  const citations: ResponseSource[] = [];
  for (const item of evidence) {
    if (!canDisclose(item.visibility, ceiling, disclosure)) continue;
    const key = `${item.source}::${item.version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      artifactId: item.id,
      description: `${item.claim}: "${item.value}" (via ${item.source})`,
      visibility: item.visibility,
    });
  }
  return citations;
}
