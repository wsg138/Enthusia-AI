/**
 * Staging-only extractive answer path for approved PUBLIC documentation.
 *
 * The model NEVER sees retrieved text. We quote only safe, bounded fragments
 * as externally-sourced documents, NOT as conversational instructions or as
 * proof of current SMP deployment. No arbitrary links are trusted.
 */
import { Visibility, type AgentResponse } from '@enthusia/contracts';
import type { ResolvedChatRequest } from '@enthusia/agent-core';
import { KnowledgeSearchTool, type KnowledgeSearchResult } from './knowledge-search.js';

const TOPICS = [
  { name: 'PieCloak', match: /\bpie[\s-]*cloak\b/i, locator: 'github:wsg138/PieCloak:README.md' },
  { name: 'Warzones', match: /\bwarzones?\b|\bmaceguard\b/i, locator: 'github:wsg138/MaceGuard:README.md' },
] as const;
const DOCUMENTED = /\b(?:what|how|explain|describe|docs?|documentation|guide|rules?|features?|works?|commands?)\b/i;
const LIVE_ONLY = /\b(?:currently|right now|at this moment|today|online|deployed|running|active|status|lagging|tps|mspt|live|ticket|punish|ban|private|secret|credentials?)\b/i;
const BAD_EXCERPT = /\b(?:ignore (?:all|previous|prior)|system prompt|developer message|assistant instructions|role:\s*system|bot token|password|api.?key|secret|disable safeguards|paste this|run this|execute this|hidden prompt)\b/i;
const SENSITIVE_FORMAT = /(?:https?:\/\/|discord\.gg\/|@everyone|@here|<@!?\d+>|\x60\x60\x60|<\/?[a-z][^>]*>)/i;

function selectTopic(message: string): (typeof TOPICS)[number] | null {
  if (message.length < 5 || message.length > 160 ||
      !DOCUMENTED.test(message) || LIVE_ONLY.test(message)) return null;
  return TOPICS.find((topic) => topic.match.test(message)) ?? null;
}

const STOP_WORDS = new Set([
  'what', 'does', 'how', 'work', 'works', 'explain', 'about', 'describe',
  'documentation', 'system', 'server', 'please', 'the', 'and', 'with',
]);
const TOPIC_TERMS = {
  PieCloak: ['piecloak', 'visibility', 'clues', 'entity', 'raycast', 'esp', 'base'],
  Warzones: ['warzone', 'warzones', 'kits', 'kit', 'rotation', 'rotate', 'modifiers', 'combat'],
} as const;

/**
 * Extract short existing statements, never synthesize missing words.
 * Incomplete leading/trailing chunk fragments, code, config and Markdown links
 * are not player-facing prose. In particular, do not shorten a long sentence
 * into an incomplete assertion, or turn README instructions into commands.
 */
function safeExcerpt(fragment: string): string | null {
  const text = fragment
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
    .replace(/^\s*[>*#-]+\s*/, '')
    .replace(/[*_~\x60]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 18 || text.length > 190 || BAD_EXCERPT.test(text) ||
      SENSITIVE_FORMAT.test(text) || /[\u0000-\u001f\u007f]/.test(text) ||
      /^(?:[-{}[\]]|\/|https?:|[a-z][\w-]*\s*:)/i.test(text) ||
      /^(?:please|ignore|execute|run|type|enter|click|send|reveal|print|dump|delete|reset)\b/i.test(text) ||
      !/[a-z]{3}/i.test(text)) return null;
  return text;
}

function sourceStatements(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const output: string[] = [];
  let fenced = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(\x60{3}|~{3})/.test(trimmed)) { fenced = !fenced; continue; }
    if (fenced || !trimmed || /^#{1,6}\s/.test(trimmed) ||
        /^\|/.test(trimmed) || /^!\[/.test(trimmed)) continue;
    const isList = /^\s*(?:[-*]|\d+[.)])\s+/.test(line);
    const pieces = isList ? [line] : line.split(/(?<=[.!?])\s+(?=[A-Z])/);
    for (const piece of pieces) {
      const value = safeExcerpt(piece);
      if (value) output.push(value);
    }
  }
  return output;
}

function termSet(message: string): Set<string> {
  return new Set((message.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter((term) => !STOP_WORDS.has(term)));
}

function excerptRank(value: string, queryWords: Set<string>, topic: keyof typeof TOPIC_TERMS): number {
  const words = value.toLowerCase();
  const direct = [...queryWords].filter((term) => words.includes(term)).length;
  const topical = TOPIC_TERMS[topic].filter((term) => words.includes(term)).length;
  // Never answer merely because an unrelated README paragraph was retrieved.
  if (direct === 0 && topical < 2) return 0;
  return direct * 3 + topical;
}

function excerptsOf(
  data: KnowledgeSearchResult, locator: string, message: string,
  topic: keyof typeof TOPIC_TERMS,
): string[] {
  const words = termSet(message);
  const scored: Array<{ text: string; rank: number; order: number }> = [];
  let order = 0;
  for (const source of data.excerpts) {
    if (source.sourceLocator !== locator) continue;
    for (const text of sourceStatements(source.text)) {
      const rank = excerptRank(text, words, topic);
      if (rank > 0 && !scored.some((candidate) => candidate.text === text)) {
        scored.push({ text, rank, order });
      }
      order++;
    }
  }
  // Prefer passages matching what was actually asked, then keep their
  // original source order. Never splice fragments together as a new claim.
  return scored.sort((a, b) => b.rank - a.rank || a.order - b.order)
    .slice(0, 3).map((candidate) => candidate.text);
}

function emptyAnswer(request: ResolvedChatRequest): AgentResponse {
  return {
    text: "I couldn't confirm a relevant passage in the current public documentation. I won't guess about the server's rules.",
    outcome: 'unverified',
    actions: [], sources: [], memoryUpdates: [], escalation: null,
    traceId: request.traceId,
  };
}

export class IndexedPublicDocsResolver {
  constructor(private readonly tool: KnowledgeSearchTool) {}

  async resolve(request: ResolvedChatRequest): Promise<AgentResponse | null> {
    const topic = selectTopic(request.message);
    if (topic === null) return null;
    const result = await this.tool.execute(
      { question: request.message },
      { traceId: request.traceId, actor: request.actor, visibilityCeiling: Visibility.PUBLIC },
    );
    if (result.error || !result.result) return emptyAnswer(request);
    // The typed tool performed HTTP and provenance schema validation already.
    const document = result.result as KnowledgeSearchResult;
    const selected = document.excerpts.filter((h) => h.sourceLocator === topic.locator);
    if (selected.length === 0) return emptyAnswer(request);
    if (new Set(selected.map((h) => h.commitSha)).size !== 1) return emptyAnswer(request);
    const selectedSha = selected[0]?.commitSha;
    if (!selectedSha || !/^[a-f0-9]{40}$/i.test(selectedSha)) return emptyAnswer(request);
    const parts = excerptsOf(document, topic.locator, request.message, topic.name);
    if (parts.length === 0) return emptyAnswer(request);

    const repo = topic.name === 'PieCloak' ? 'PieCloak' : 'MaceGuard';
    const url = 'https://github.com/wsg138/' + repo + '/blob/' + selectedSha + '/README.md';
    const text = '**' + topic.name + ' — public documentation excerpts**\n' +
      parts.map((part) => '• “' + part.replace(/[“”]/g, '') + '”').join('\n') +
      '\n\n_Quoted documentation, not confirmation of what is currently deployed._';
    return {
      text,
      outcome: 'answered',
      actions: [],
      sources: [{
        artifactId: 'github:wsg138/' + repo + '@' + selectedSha + ':README.md',
        description: 'Verified public README at commit ' + selectedSha + ' (' + url + ')',
        visibility: Visibility.PUBLIC,
      }],
      memoryUpdates: [], escalation: null, traceId: request.traceId,
    };
  }
}
