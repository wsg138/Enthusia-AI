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

function safeExcerpt(fragment: string): string | null {
  const text = fragment
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/^[\s>*#\-]+/, '')
    .replace(/[*_~\x60]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 28 || text.length > 190 || BAD_EXCERPT.test(text) ||
      SENSITIVE_FORMAT.test(text) || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function excerptsOf(data: KnowledgeSearchResult, locator: string, message: string): string[] {
  const words = new Set((message.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter((w) => !['what', 'does', 'work', 'works', 'explain', 'about', 'describe', 'documentation'].includes(w)));
  const output: string[] = [];
  for (const source of data.excerpts) {
    if (source.sourceLocator !== locator) continue;
    const fragments = source.text.split(/\n+|(?<=[.!?])\s+/);
    for (const line of fragments) {
      const clean = safeExcerpt(line);
      if (!clean || ![...words].some((w) => clean.toLowerCase().includes(w)) ||
          output.includes(clean)) continue;
      output.push(clean);
      if (output.length === 2) return output;
    }
  }
  return output;
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
    const parts = excerptsOf(document, topic.locator, request.message);
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
