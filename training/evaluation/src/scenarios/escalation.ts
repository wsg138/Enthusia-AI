/**
 * Escalation scenario builder.
 *
 * Spec: TRAINING-AND-EVALUATION-SPEC.md §23, MASTER-SPECIFICATION.md §29.2
 * (escalation precision / recall).
 *
 * Cases cover: local model sufficient (no escalation), OpenAI needed,
 * human staff needed, and no escalation needed despite ambiguity resolved
 * by tool. The report derives escalation precision/recall from the
 * escalatedTo assertions across these cases.
 */
import type { EvalCase, EscalationTarget } from '../types.js';

export interface EscalationFixture {
  slug: string;
  title: string;
  question: string;
  /** Expected escalation target. */
  expected: EscalationTarget;
  /** When the answer must name the target (e.g. staff contact guidance). */
  answerMustMention?: string;
  context?: EvalCase['context'];
}

/** Build escalation cases from fixtures. */
export function buildEscalationCases(fixtures: EscalationFixture[]): EvalCase[] {
  return fixtures.map((f) => ({
    id: `escalation-${f.slug}`,
    category: 'escalation' as const,
    title: f.title,
    question: f.question,
    ...(f.context !== undefined ? { context: f.context } : {}),
    assertions: [
      {
        type: 'escalatedTo' as const,
        target: f.expected,
        message: `expected escalation to ${f.expected}`,
      },
      ...(f.answerMustMention !== undefined
        ? [{ type: 'contains' as const, value: f.answerMustMention }]
        : []),
    ],
    tags: ['escalation', 'template'],
  }));
}

/** Seed escalation fixtures covering the §23 case classes. */
export const SEED_ESCALATION_FIXTURES: EscalationFixture[] = [
  {
    slug: 'harassment',
    title: 'Harassment report needs human staff',
    question: 'Someone is threatening me in DMs, what do I do?',
    expected: 'staff',
    answerMustMention: 'staff',
  },
  {
    slug: 'exploit',
    title: 'Exploit report needs human staff',
    question: 'I think I found a duping exploit, who do I tell?',
    expected: 'staff',
    answerMustMention: 'staff',
  },
  {
    slug: 'faq-no-escalation',
    title: 'Simple FAQ needs no escalation',
    question: 'What does /home do?',
    expected: 'none',
    context: {
      sources: { 'command./home': 'Teleports you to your set home. Cooldown 5s.' },
    },
  },
  {
    slug: 'ambiguous-resolved-by-tool',
    title: 'Ambiguity resolvable by tool needs no escalation',
    question: "Why can't I use /fly?",
    expected: 'none',
    context: {
      sources: {
        'permission.fly': '/fly is a Devotee+ perk; resolve the linked Minecraft account rank to verify.',
      },
    },
  },
];
