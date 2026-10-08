/**
 * @enthusia/agent-core — response assembly (W12).
 *
 * Spec §15.1 steps 8–9 (decide local answer versus escalation, produce
 * response) and §11.3 (mandatory answer grounding).
 *
 * The assembler is deterministic and policy-enforcing:
 * - every factual sentence comes from an orchestrator-computed
 *   {@link ClaimAssessment}, never from model output;
 * - supported claims become bounded, conversational answer parts;
 * - unsupported claims say they could not be verified — the answer never guesses;
 * - contradicted claims surface the conflicting disclosable values without
 *   leaking backend source labels;
 * - source provenance remains structural in AgentResponse.sources rather than
 *   being printed as internal diagnostics in player-facing prose;
 * - only evidence disclosable under the request's visibility ceiling may
 *   contribute to rendered content (§17); SECRET_DENY is never disclosable.
 *
 * Model-produced ResponseDraft text is treated as untrusted framing. Only a
 * tiny allowlist of non-factual social phrases may survive. Factual content is
 * assembled here so prompt wording cannot bypass verification.
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
  ResponseStyleProfile,
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
  /** Verified claims that are optional introductory/background context. */
  backgroundClaims?: string[];
  /** Privacy-safe familiarity hint; never contains raw player memory. */
  responseStyle?: ResponseStyleProfile;
  /** Investigation notes worth surfacing (e.g. budget exhaustion). */
  notes?: string[];
}

/**
 * Bounded factual representation used by the player-facing renderer.
 * Every value here comes from deterministic verification, never free-form
 * model prose.
 */
export type VerifiedAnswerPart =
  | {
      kind: 'supported';
      claim: string;
      value: string;
    }
  | {
      kind: 'unsupported';
      claim: string;
    }
  | {
      kind: 'contradicted';
      claim: string;
      values: string[];
    };

const COULD_NOT_VERIFY = 'I could not verify';
const SAFE_PREAMBLES = new Set(["Here's what I found."]);
const SAFE_CLOSINGS = new Set(['Hope that helps.']);

/**
 * Assemble the final {@link AgentResponse} from verified claim assessments.
 */
export function assembleResponse(args: AssembleArgs): AgentResponse {
  const { request, assessments, evidence, escalation, memoryProposals, draft } =
    args;
  const ceiling = request.visibilityCeiling;
  const disclosure = disclosureOpts(request.actor);
  const visibleAssessments = assessmentsForStyle(
    assessments,
    args.backgroundClaims ?? [],
    args.responseStyle,
  );

  // Bot-capability questions are about this application's supported behavior,
  // not mutable server facts. Provide a short, bounded explanation rather
  // than presenting a hallucinated claim about the user's question itself.
  // Keep the evidence-first path for all other questions.
  if (
    /^(?:what can you do|what are your capabilities)[?!.\s]*$/i.test(request.message.trim()) &&
    escalation === null &&
    visibleAssessments.every((assessment) => assessment.verdict === 'unsupported')
  ) {
    return {
      text: 'I can help explain general topics and work through Enthusia questions. ' +
        'For current server information, player accounts, punishments, or tickets, ' +
        'I need connected, verified sources and will not guess without them.',
      actions: [],
      sources: [],
      memoryUpdates: [],
      escalation: null,
      traceId: request.traceId,
    };
  }

  const lines: string[] = [];
  const preamble = safeFraming(draft.preamble, SAFE_PREAMBLES);
  if (preamble !== undefined) {
    lines.push(preamble);
  }

  const answerParts = buildVerifiedAnswerParts(
    visibleAssessments,
    ceiling,
    disclosure,
  );
  if (answerParts.length === 0) {
    lines.push(
      `${COULD_NOT_VERIFY} an answer because there weren't any checkable claims to verify.`,
    );
  } else {
    lines.push(...answerParts.map(renderAnswerPart));
  }

  if (escalation) {
    lines.push(escalationLine(escalation));
  }

  const surfacedNotes = (args.notes ?? []).filter((n) => n.trim().length > 0);
  if (surfacedNotes.length > 0) {
    lines.push(`One limitation: ${ensureSentence(surfacedNotes[0] as string)}`);
  }

  const closing = safeFraming(draft.closing, SAFE_CLOSINGS);
  if (closing !== undefined) {
    lines.push(closing);
  }

  const visibleClaims = new Set(visibleAssessments.map((assessment) => assessment.claim));
  const sources = buildCitations(evidence, ceiling, disclosure, visibleClaims);

  return {
    text: lines.join('\n\n'),
    actions: [],
    sources,
    memoryUpdates: memoryProposals,
    escalation: escalation ? toWireEscalation(escalation) : null,
    traceId: request.traceId,
  };
}

export interface AnswerDisclosure {
  isSubject: boolean;
  isStaff: boolean;
}

/**
 * Derive §17 disclosure options from the actor. Staff actors may see
 * PLAYER_SELF evidence; anyone else may not (the orchestrator cannot prove
 * subject identity here — W11 owns that — so isSubject stays false).
 */
function disclosureOpts(actor: Actor): AnswerDisclosure {
  return {
    isSubject: false,
    isStaff: actor.type === 'staff',
  };
}

function assessmentsForStyle(
  assessments: ClaimAssessment[],
  backgroundClaims: string[],
  responseStyle: ResponseStyleProfile | undefined,
): ClaimAssessment[] {
  if (responseStyle === undefined) return assessments;
  if (backgroundClaims.length === 0) return assessments;
  if (responseStyle.familiarity === 'NEW') return assessments;

  const background = new Set(backgroundClaims);
  if (responseStyle.familiarity === 'UNKNOWN') {
    return unknownStyleAssessments(assessments, background);
  }
  return directStyleAssessments(assessments, background);
}

function directStyleAssessments(
  assessments: ClaimAssessment[],
  background: ReadonlySet<string>,
): ClaimAssessment[] {
  const direct = assessments.filter(
    (assessment) => !background.has(assessment.claim),
  );
  return fallbackIfEmpty(direct, assessments);
}

function unknownStyleAssessments(
  assessments: ClaimAssessment[],
  background: ReadonlySet<string>,
): ClaimAssessment[] {
  const firstBackground = assessments.find(
    (assessment) => background.has(assessment.claim),
  );
  if (firstBackground === undefined) return assessments;

  const selected = assessments.filter((assessment) =>
    shouldShowUnknownAssessment(assessment, firstBackground, background),
  );
  return fallbackIfEmpty(selected, assessments);
}

function shouldShowUnknownAssessment(
  assessment: ClaimAssessment,
  firstBackground: ClaimAssessment,
  background: ReadonlySet<string>,
): boolean {
  if (!background.has(assessment.claim)) return true;
  return assessment === firstBackground;
}

function fallbackIfEmpty(
  selected: ClaimAssessment[],
  fallback: ClaimAssessment[],
): ClaimAssessment[] {
  return selected.length === 0 ? fallback : selected;
}

/**
 * Convert verified assessments into a bounded factual answer plan.
 *
 * A nominally supported assessment is downgraded to unsupported when no
 * supporting evidence is actually disclosable at this boundary. This makes
 * the exported assembler fail closed even when called outside the normal
 * orchestrator path.
 */
export function buildVerifiedAnswerParts(
  assessments: ClaimAssessment[],
  ceiling: Visibility,
  disclosure: AnswerDisclosure,
): VerifiedAnswerPart[] {
  return assessments.map((assessment) => {
    if (assessment.verdict === 'supported') {
      const hasDisclosableSupport = assessment.supporting.some((item) =>
        canDisclose(item.visibility, ceiling, disclosure),
      );
      const value = assessment.assertedValue?.trim();
      if (hasDisclosableSupport && value) {
        return {
          kind: 'supported',
          claim: assessment.claim,
          value,
        };
      }
      return { kind: 'unsupported', claim: assessment.claim };
    }

    if (assessment.verdict === 'unsupported') {
      return { kind: 'unsupported', claim: assessment.claim };
    }

    const values = unique(
      assessment.contradicting
        .filter((item) => canDisclose(item.visibility, ceiling, disclosure))
        .map((item) => item.value.trim())
        .filter(Boolean),
    );
    return {
      kind: 'contradicted',
      claim: assessment.claim,
      values,
    };
  });
}

function renderAnswerPart(part: VerifiedAnswerPart): string {
  switch (part.kind) {
    case 'supported':
      return renderSupportedFact(part.claim, part.value);
    case 'unsupported':
      return `${COULD_NOT_VERIFY} ${naturalClaim(part.claim)} from current sources.`;
    case 'contradicted': {
      const subject = naturalClaim(part.claim);
      if (part.values.length === 0) {
        return (
          `I found conflicting current information about ${subject}, so I'm not ` +
          'going to guess which answer is right.'
        );
      }
      return (
        `I found conflicting current information about ${subject}: ` +
        `${part.values.join(' versus ')}. I'm not going to guess which one is current.`
      );
    }
  }
}

const PROPOSITION_WORDS = new Set([
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'can',
  'cannot',
  'will',
  'should',
  'use',
  'uses',
  'allow',
  'allows',
  'require',
  'requires',
]);

const LEADING_DETERMINERS = [
  'the ',
  'your ',
  'my ',
  'this ',
  'that ',
  'these ',
  'those ',
] as const;

function renderSupportedFact(claim: string, value: string): string {
  const cleanClaim = trimSentencePunctuation(claim);
  const cleanValue = trimSentencePunctuation(value);
  const meaning = meaningSubject(cleanClaim);
  if (meaning !== undefined) {
    return `${meaning} means ${cleanValue}.`;
  }

  if (looksLikeCompleteSentence(value)) {
    return ensureSentence(value);
  }

  if (looksLikeProposition(cleanClaim)) {
    return `For “${cleanClaim},” current information says ${cleanValue}.`;
  }

  const lowerClaim = cleanClaim.toLowerCase();
  const hasDeterminer = LEADING_DETERMINERS.some((prefix) =>
    lowerClaim.startsWith(prefix),
  );
  return `${hasDeterminer ? '' : 'The '}${cleanClaim} is ${cleanValue}.`;
}

function naturalClaim(claim: string): string {
  const clean = trimSentencePunctuation(claim);
  const meaning = meaningSubject(clean);
  return meaning === undefined ? clean : `what ${meaning} means`;
}

function meaningSubject(claim: string): string | undefined {
  const suffix = ' meaning';
  if (!claim.toLowerCase().endsWith(suffix)) return undefined;
  const subject = claim.slice(0, -suffix.length).trim();
  return subject.length === 0 ? undefined : subject;
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(' ')
    .map((word) => trimSentencePunctuation(word))
    .filter(Boolean);
}

function looksLikeCompleteSentence(value: string): boolean {
  const clean = value.trim();
  if (endsSentence(clean)) return true;
  const tokens = words(clean);
  return (
    tokens.length >= 4 &&
    tokens.some((word) => PROPOSITION_WORDS.has(word))
  );
}

function looksLikeProposition(claim: string): boolean {
  return words(claim).some((word) => PROPOSITION_WORDS.has(word));
}

function trimSentencePunctuation(value: string): string {
  let end = value.trim().length;
  const trimmed = value.trim();
  while (end > 0 && isSentencePunctuation(trimmed[end - 1] as string)) {
    end -= 1;
  }
  return trimmed.slice(0, end);
}

function isSentencePunctuation(value: string): boolean {
  return value === '.' || value === '!' || value === '?';
}

function endsSentence(value: string): boolean {
  if (value.length === 0) return false;
  return isSentencePunctuation(value[value.length - 1] as string);
}

function ensureSentence(value: string): string {
  const clean = value.trim();
  if (clean.length === 0) return clean;
  return endsSentence(clean) ? clean : `${clean}.`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeFraming(
  value: string | undefined,
  allowlist: ReadonlySet<string>,
): string | undefined {
  const clean = value?.trim();
  return clean !== undefined && allowlist.has(clean) ? clean : undefined;
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
  disclosure: AnswerDisclosure,
  allowedClaims?: ReadonlySet<string>,
): ResponseSource[] {
  const seen = new Set<string>();
  const citations: ResponseSource[] = [];
  for (const item of evidence) {
    if (allowedClaims !== undefined && !allowedClaims.has(item.claim)) continue;
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
