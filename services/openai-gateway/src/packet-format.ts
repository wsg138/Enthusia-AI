/**
 * @enthusia/openai-gateway — escalation packet formatter (W13).
 *
 * Consumes W12's InvestigationPacket and formats it for the OpenAI chat
 * completions API: a system message carrying the stronger model's operating
 * instructions (constraints, secrecy, coding authority) and a user message
 * carrying the structured §22.2 context. Never sends a bare "fix this".
 *
 * Spec: MASTER-SPECIFICATION.md §22.2, §22.4, §89, §17.6.
 */
import { canDisclose, Visibility } from '@enthusia/contracts';
import type { InvestigationPacket, PacketEvidence } from './packet.js';
import type { EscalationKind } from './models.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Per-evidence value cap so a huge log cannot blow the budget blindly. */
export const MAX_EVIDENCE_VALUE_CHARS = 4000;

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) {
    return '_none_';
  }
  return items.map((item) => `- ${item}`).join('\n');
}

function truncateValue(value: string): string {
  if (value.length <= MAX_EVIDENCE_VALUE_CHARS) {
    return value;
  }
  return (
    value.slice(0, MAX_EVIDENCE_VALUE_CHARS) +
    `\n…[truncated: ${value.length - MAX_EVIDENCE_VALUE_CHARS} more chars]`
  );
}

function formatEvidence(item: PacketEvidence): string {
  const lines = [
    `### Evidence ${item.id}`,
    `- claim: ${item.claim}`,
    `- tool: ${item.toolName}`,
    `- source: ${item.source}`,
    `- verification tier: ${item.verificationTier}`,
    `- visibility: ${item.visibility}`,
  ];
  if (item.version !== undefined) {
    lines.push(`- version: ${item.version}`);
  }
  if (item.observedTime !== undefined) {
    lines.push(`- observed: ${item.observedTime}`);
  }
  if (item.excerpt !== undefined) {
    lines.push(`- excerpt: ${item.excerpt}`);
  }
  lines.push('', '```', truncateValue(item.value), '```');
  return lines.join('\n');
}

function formatRepositories(packet: InvestigationPacket): string {
  if (packet.relevantRepositories.length === 0) {
    return '_none identified_';
  }
  return packet.relevantRepositories
    .map((repo) => {
      const shas = Object.entries(packet.currentShas)
        .filter(([source]) => source.includes(repo))
        .map(([, sha]) => sha);
      return shas.length > 0 ? `- ${repo} (SHAs: ${shas.join(', ')})` : `- ${repo}`;
    })
    .join('\n');
}

/**
 * Format the packet into chat messages for the stronger model.
 *
 * Defense in depth (§17.6): SECRET_DENY evidence is dropped here too, even
 * though W12 already redacts it from the packet.
 */
export function formatEscalationMessages(
  packet: InvestigationPacket,
  kind: EscalationKind,
): ChatMessage[] {
  const visibleEvidence = packet.toolEvidence.filter(
    (item) =>
      item.visibility !== Visibility.SECRET_DENY &&
      canDisclose(item.visibility, packet.authorization.visibilityCeiling, {
        isStaff: packet.authorization.actorKind === 'staff',
      }),
  );

  const system = [
    'You are the stronger-model escalation resource for Enthusia AI, a',
    'server-wide intelligence platform for the Enthusia Minecraft network.',
    'A local coordinator investigated a request and escalated it to you',
    `(${kind} work) with structured evidence.`,
    '',
    'Operating rules:',
    '- Verify mutable Enthusia facts against the current sources in the',
    '  packet before asserting them; do not rely on model memory for',
    '  current server facts.',
    `- Never disclose SECRET_DENY material. Respect the visibility ceiling: ${packet.authorization.visibilityCeiling}.`,
    '- Coding authority (§22.4, §89): you may propose reading repos,',
    '  creating branches, modifying code, running tests, and opening PRs,',
    '  all through explicit GitHub workflows. You must NOT merge, deploy,',
    '  restart production, or mutate live data unless the packet explicitly',
    '  authorizes it.',
    '- State what you could not verify, and what would change your answer.',
    '',
    `Produce exactly what the packet's "Expected output" section asks for.`,
  ].join('\n');

  const user = [
    `# Escalation packet ${packet.packetRef}`,
    `trace: ${packet.traceId} · escalation kind: ${kind}`,
    '',
    section('Question', packet.userQuestion),
    '',
    section('Goal', packet.goal),
    '',
    section('Request class', packet.requestClass),
    '',
    section('Relevant repositories', formatRepositories(packet)),
    '',
    section('Relevant files', bulletList(packet.relevantFiles)),
    '',
    section(
      'Current SHAs',
      Object.keys(packet.currentShas).length === 0
        ? '_none recorded_'
        : Object.entries(packet.currentShas)
            .map(([source, sha]) => `- ${source}: ${sha}`)
            .join('\n'),
    ),
    '',
    section('Logs', bulletList(packet.logs)),
    '',
    section(
      'Tool evidence',
      visibleEvidence.length === 0
        ? '_none_'
        : visibleEvidence.map(formatEvidence).join('\n\n'),
    ),
    packet.redactedEvidenceCount > 0
      ? `\n\n_${packet.redactedEvidenceCount} evidence item(s) were redacted for visibility and are not shown._`
      : '',
    '',
    section('Attempted local diagnosis', bulletList(packet.attemptedDiagnosis)),
    '',
    section('Unresolved questions', bulletList(packet.unresolvedQuestions)),
    '',
    section('Constraints', bulletList(packet.constraints)),
    '',
    section(
      'Authorization',
      [
        `- actor: ${packet.authorization.actorId} (${packet.authorization.actorKind})`,
        `- visibility ceiling: ${packet.authorization.visibilityCeiling}`,
      ].join('\n'),
    ),
    '',
    section('Expected output', packet.expectedOutput),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Rough token estimate (characters / 4). Used for pre-call budget guards. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Estimated prompt tokens for a formatted message list. */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message.content) + 4,
    0,
  );
}
