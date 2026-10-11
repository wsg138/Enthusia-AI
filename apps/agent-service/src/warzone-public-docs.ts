/** Isolated PUBLIC read-only Warzone Rotator docs pilot. */
import { createHash } from 'node:crypto';
import { Visibility, type AgentResponse } from '@enthusia/contracts';
import type { ResolvedChatRequest } from '@enthusia/agent-core';
import type { PublicDocsOptions } from './public-docs.js';

const ROOT = 'https://api.github.com/repos/wsg138/MaceGuard';
const SHA = /^[a-f0-9]{40}$/i;
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'enthusia-ai-public-docs-test/1.0' };
const LIMIT = 90000;

function recordOf(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown> : null;
}

export function isWarzoneRotationQuestion(message: string): boolean {
  return /\b(?:warzones?|warzone[\s-]*rotator|warzonerotator)\b/i.test(message) &&
    (/\b(?:rotat(?:or|ion|es?|ing)|kits?|modifiers?|schedule)\b/i.test(message) ||
      /\b(?:how|explain|what)\b.*\b(?:works?|system|rules?)\b/i.test(message));
}

/** Fail closed when approved documentation changes its relevant sections. */
export function warzoneReadmeRecognized(readme: string): boolean {
  const expected = [
    '# MaceGuard', 'Warzone kits', 'an anchored repeating',
    'DAYS', 'WEEKS', 'MONTHS',
    'A manual override takes precedence',
    'without pausing or shifting the automatic cycle',
    '/warzone next', '/warzone schedule', 'combat-carryover',
  ];
  return expected.every((phrase) => readme.includes(phrase));
}

export class WarzonePublicDocsPilot {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PublicDocsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (this.timeoutMs < 1 || this.timeoutMs > 15000) throw new Error('invalid documentation timeout');
  }

  async resolve(request: ResolvedChatRequest): Promise<AgentResponse | null> {
    if (!isWarzoneRotationQuestion(request.message)) return null;
    const unavailable: AgentResponse = {
      text: "I couldn't verify the public Warzones documentation right now, so I won't guess about its rules or what is currently active.",
      actions: [], sources: [], memoryUpdates: [], escalation: null,
      traceId: request.traceId, outcome: 'unverified',
    };
    try {
      const repo = recordOf(await this.getJson(ROOT));
      if (!repo || repo['private'] !== false || repo['default_branch'] !== 'main') return unavailable;
      const head = recordOf(await this.getJson(ROOT + '/git/ref/heads/main'));
      const object = recordOf(head?.['object']);
      const commit = object?.['sha'];
      if (object?.['type'] !== 'commit' || typeof commit !== 'string' || !SHA.test(commit)) return unavailable;
      const file = recordOf(await this.getJson(ROOT + '/contents/README.md?ref=' + commit));
      const size = file?.['size'];
      const content = file?.['content'];
      const blob = file?.['sha'];
      if (file?.['type'] !== 'file' || file?.['encoding'] !== 'base64' ||
          typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > LIMIT ||
          typeof blob !== 'string' || !SHA.test(blob) ||
          typeof content !== 'string' || content.length > LIMIT * 2) return unavailable;
      const bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
      if (bytes.length !== size) return unavailable;
      const actualSha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      if (actualSha.toLowerCase() !== blob.toLowerCase()) return unavailable;
      if (!warzoneReadmeRecognized(bytes.toString('utf8'))) return unavailable;

      const url = 'https://github.com/wsg138/MaceGuard/blob/' + commit + '/README.md';
      return {
        text: '**Warzones changes which PvP rules are active.** Instead of keeping the same combat settings, it rotates between kits and modifiers.\n\n' +
          '**How it works**\n' +
          '• **Rotation:** A schedule cycles through kits, random setups, or chosen modifiers.\n' +
          '• **Combat rules:** Each setup can change things like mace, spear, pearls, wind charges, or cobwebs.\n' +
          '• **Overrides:** Staff can temporarily choose a setup; the regular schedule continues in the background.\n\n' +
          '**See what is active:** Use /warzone, /warzone next, or /warzone schedule.\n' +
          '_These are documented features, not confirmation of what is currently active on the server._\n' +
          'Source: ' + url + '\nDocumentation revision: ' + commit.slice(0, 12) + '.',
        actions: [],
        sources: [{
          artifactId: 'github:wsg138/MaceGuard@' + commit + ':README.md',
          description: 'Public MaceGuard Warzone documentation at commit ' + commit + ' (' + url + ')',
          visibility: Visibility.PUBLIC,
        }],
        memoryUpdates: [],
        escalation: null,
        traceId: request.traceId,
        outcome: 'answered',
      };
    } catch {
      return unavailable;
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: 'GET', redirect: 'error', headers: HEADERS,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error('public GitHub documentation unavailable');
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > LIMIT * 3) throw new Error('documentation response too large');
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > LIMIT * 3) throw new Error('documentation response too large');
    return JSON.parse(text) as unknown;
  }
}
