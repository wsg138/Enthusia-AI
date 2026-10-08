/**
 * Narrow PUBLIC documentation pilot for the isolated Discord test bot.
 *
 * This is not a generic GitHub reader or a substitute for W08/W07 indexing.
 * It reads exactly wsg138/PieCloak's public README pinned to a verified
 * branch commit. No credentials, filesystem access, arbitrary URLs, or writes.
 * No documentation fact is represented as verified deployed runtime state.
 */
import { Visibility, type AgentResponse } from '@enthusia/contracts';
import { createHash } from 'node:crypto';
import type { ResolvedChatRequest } from '@enthusia/agent-core';

const ROOT = 'https://api.github.com/repos/wsg138/PieCloak';
const SHA = /^[a-f0-9]{40}$/i;
const HEADER = { accept: 'application/vnd.github+json', 'user-agent': 'enthusia-ai-public-docs-test/1.0' };
const MAX_DOC_BYTES = 64000;

export interface PublicDocsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function isPieCloakQuestion(text: string): boolean {
  return /\b(?:pie[\s-]*cloak|piecloak)\b/i.test(text) &&
    /\b(?:what|how|work|explain|tell|hide|visibility|distance|radius|esp|base)\b/i.test(text);
}

function recordOf(data: unknown): Record<string, unknown> | null {
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown> : null;
}

export function extractPieCloakDocumentedRules(readme: string): {
  closeRadius: number;
  raycastRadius: number;
  occludingSamples: number;
} | null {
  if (!readme.includes("PieCloak is Enthusia SMP's anti-ESP/base-finding layer") ||
      !readme.includes('It does **not** cancel entity spawns.')) return null;
  const section = readme.split('## Current Enthusia visibility rules')[1]?.split('\n## ')[0];
  if (!section) return null;

  const close = /Within roughly\s+(\d+)\s+blocks/i.exec(section);
  const between = /Between roughly\s+(\d+)\s+and\s+(\d+)\s+blocks/i.exec(section);
  const far = /Beyond roughly\s+(\d+)\s+blocks/i.exec(section);
  const samples = /ray crosses\s+(three|\d+)\s+occluding block samples/i.exec(section);
  if (!close || !between || !far || !samples) return null;
  const near = Number(close[1]);
  const lower = Number(between[1]);
  const upper = Number(between[2]);
  const distant = Number(far[1]);
  const occluding = samples[1]?.toLowerCase() === 'three' ? 3 : Number(samples[1]);
  if (!Number.isInteger(near) || near < 1 || near > 256 ||
      near !== lower || !Number.isInteger(upper) || upper <= near ||
      upper > 256 || upper !== distant || !Number.isInteger(occluding) ||
      occluding < 1 || occluding > 16) return null;
  return { closeRadius: near, raycastRadius: upper, occludingSamples: occluding };
}

/** Return null for unrelated questions; failures on target questions fail closed. */
export class PieCloakPublicDocsPilot {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PublicDocsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (this.timeoutMs < 1 || this.timeoutMs > 15000) throw new Error('invalid public documentation timeout');
  }

  async resolve(request: ResolvedChatRequest): Promise<AgentResponse | null> {
    if (!isPieCloakQuestion(request.message)) return null;
    const unavailable: AgentResponse = {
      text: "I couldn't verify PieCloak's public documentation right now, so I won't guess about its rules or current deployment.",
      actions: [], sources: [], memoryUpdates: [], escalation: null, traceId: request.traceId,
    };
    try {
      const repo = recordOf(await this.getJson(ROOT));
      // Never index a private repository or silently switch branches.
      if (!repo || repo['private'] !== false || repo['default_branch'] !== 'main') return unavailable;
      const head = recordOf(await this.getJson(ROOT + '/git/ref/heads/main'));
      const object = recordOf(head?.['object']);
      const commit = object?.['sha'];
      if (object?.['type'] !== 'commit' || typeof commit !== 'string' || !SHA.test(commit)) return unavailable;
      const file = recordOf(await this.getJson(ROOT + '/contents/README.md?ref=' + commit));
      const blob = file?.['sha'];
      const base64 = file?.['content'];
      if (file?.['type'] !== 'file' || file?.['encoding'] !== 'base64' ||
          typeof blob !== 'string' || !SHA.test(blob) ||
          typeof base64 !== 'string' || base64.length > MAX_DOC_BYTES * 2 ||
          typeof file['size'] !== 'number' || file['size'] > MAX_DOC_BYTES ||
          file['size'] < 1) return unavailable;
      const decoded = Buffer.from(base64.replace(/\s/g, ''), 'base64');
      if (decoded.length !== file['size'] || decoded.length > MAX_DOC_BYTES) return unavailable;
      // Verify the Git blob object identity rather than trusting a claimed SHA.
      const gitBlob = createHash('sha1').update('blob ' + decoded.length + '\0').update(decoded).digest('hex');
      if (gitBlob.toLowerCase() !== blob.toLowerCase()) return unavailable;
      const rules = extractPieCloakDocumentedRules(decoded.toString('utf8'));
      if (!rules) return unavailable;
      const url = 'https://github.com/wsg138/PieCloak/blob/' + commit + '/README.md';
      return {
        text: 'According to the public PieCloak README, PieCloak helps conceal selected entity and block-entity clues from clients to reduce pie-chart/ESP base-finding. It does not remove mobs, stop farms, or hide players. The documented rules always show managed clues within about ' +
          rules.closeRadius + ' blocks. Between about ' + rules.closeRadius + ' and ' +
          rules.raycastRadius + ' blocks, it checks line of sight and hides clues behind ' +
          rules.occludingSamples + ' occluding block samples; beyond ' +
          rules.raycastRadius + ' blocks, managed clues are hidden. These are documented settings, not proof of the currently deployed plugin or its health.\nSource: ' + url +
          '\nDocumentation revision: ' + commit.slice(0, 12) + '.',
        actions: [],
        sources: [{
          artifactId: 'github:wsg138/PieCloak@' + commit + ':README.md',
          description: 'Public PieCloak README at commit ' + commit + ' (' + url + ')',
          visibility: Visibility.PUBLIC,
        }],
        memoryUpdates: [],
        escalation: null,
        traceId: request.traceId,
      };
    } catch {
      // Includes network errors, malformed JSON and GitHub rate limiting.
      // Do not log external response bodies, credentials or raw HTML.
      return unavailable;
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: 'GET', headers: HEADER, redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error('GitHub public source unavailable');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_DOC_BYTES * 3) throw new Error('GitHub public source too large');
    // Explicit byte cap even if server omits Content-Length.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BYTES * 3) throw new Error('GitHub public source too large');
    return JSON.parse(text) as unknown;
  }
}
