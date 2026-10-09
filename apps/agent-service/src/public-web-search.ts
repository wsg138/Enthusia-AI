/**
 * Staging-only web.search_public: optional Brave Search API evidence discovery.
 * Public web search results are NEVER proof of live Enthusia policy, config,
 * player identity, sanctions, current SMP deployment, or protected records.
 * Snippets are untrusted data, not model instructions and not claim evidence.
 * Never fetch user-selected URLs or allow redirects; network destination is fixed.
 */
import { Visibility, type ToolResult } from '@enthusia/contracts';
import type { Tool, ToolCallContext, ToolMetadata } from '@enthusia/agent-core';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_BYTES = 32_000;
const MAX_QUERY_LENGTH = 180;
const MAX_QUERIES_PER_HOUR = 30;
const BLOCKED = /(?:\b(?:bearer|token|password|private.?key|session.?cookie|webhook)\b|(?:sk|gh[psu]|xox[baprs])[_-][a-zA-Z0-9_-]{15,}|\b\d{14,}\b)/i;
const COMMANDS = /(?:ignore (?:all|previous|the instructions)|system prompt|developer message|execute (?:this|command)|run this|print (?:secrets|token)|api.?key|password|curl\s|wget\s)/i;

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Brave result metadata is not validation of the linked page's claims. */
  verified: false;
  deploymentVerified: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
  // Treat anything that looks like an embedded command or secret as untrusted
  // and do not forward it to the reasoner or user.
  return COMMANDS.test(text) ? '' : text;
}

export function safePublicUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 800) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.port || url.hash || /[\u0000-\u001f]/.test(value)) return null;
    const host = url.hostname.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') ||
        host === 'localhost' || host.endsWith('.localhost') ||
        host.endsWith('.local') || host.endsWith('.internal') ||
        host.endsWith('.onion') || host.endsWith('.example') ||
        host.endsWith('.test') || /^\d+(?:\.\d+){3}$/.test(host) ||
        host.includes('..')) return null;
    return url.toString();
  } catch { return null; }
}

export function parsePublicWebHits(input: unknown): SearchHit[] | null {
  if (!isRecord(input) || !isRecord(input['web'])) return null;
  const data = input['web']['results'];
  if (!Array.isArray(data) || data.length > 30) return null;
  const hits: SearchHit[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const url = safePublicUrl(item['url']);
    const title = safeText(item['title'], 140);
    const snippet = safeText(item['description'], 350);
    if (!url || !title || !snippet) continue;
    if (hits.some(hit => hit.url === url)) continue;
    hits.push({ title, url, snippet, verified: false, deploymentVerified: false });
    if (hits.length === 5) break;
  }
  return hits;
}

export class PublicWebSearchTool implements Tool<{ question: string }> {
  readonly meta: ToolMetadata = {
    name: 'web.search_public',
    description: 'Search PUBLIC internet pages to discover reading material for general questions. ' +
      'Unverified search snippets are hints, not claim-level evidence or proof of deployed Enthusia state. ' +
      'Never submit credentials, private messages, usernames, server records, ticket contents or policies.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'Public, generic web search text (no private data)' } },
      required: ['question'],
    },
    privacySensitive: false,
    maxVisibility: Visibility.PUBLIC,
  };
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private requests: number[] = [];

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch }) {
    if (typeof options.apiKey !== 'string' ||
        options.apiKey.trim().length < 20 || options.apiKey.length > 256 ||
        /[\r\n]/.test(options.apiKey)) {
      throw new Error('Public search API key must be set securely by the operator');
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(params: { question: string }, ctx: ToolCallContext): Promise<ToolResult<unknown>> {
    const envelope = {
      toolName: this.meta.name,
      timestamp: new Date().toISOString(),
      source: 'brave-public-search-unverified',
      visibility: Visibility.PUBLIC,
      correlationId: ctx.traceId,
    };
    const question = params.question;
    if (typeof question !== 'string' || question.trim().length < 3 ||
        question.length > MAX_QUERY_LENGTH || /[\u0000-\u001f]/.test(question) ||
        BLOCKED.test(question)) {
      return { ...envelope, error: {
        code: 'WEB_SEARCH_UNSAFE_QUERY',
        message: 'Only short public questions without private information can be searched.',
        retryable: false,
      } };
    }
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < 3_600_000);
    if (this.requests.length >= MAX_QUERIES_PER_HOUR) {
      return { ...envelope, error: {
        code: 'WEB_SEARCH_BUDGET',
        message: 'Public search hourly budget exhausted.',
        retryable: true,
      } };
    }
    this.requests.push(now);
    try {
      const query = new URL(ENDPOINT);
      query.searchParams.set('q', question.trim());
      query.searchParams.set('count', '5');
      query.searchParams.set('safesearch', 'strict');
      query.searchParams.set('search_lang', 'en');
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);
      const response = await this.fetchImpl(query.toString(), {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/json',
          'x-subscription-token': this.apiKey,
        },
      });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
        throw new Error('search provider unavailable');
      }
      const bytes = await response.text();
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('oversized search response');
      const hits = parsePublicWebHits(JSON.parse(bytes));
      if (!hits) throw new Error('invalid source');
      // Deliberately no encoded CURRENT freshness and no {value}/{excerpt}.
      // The claim verifier cannot promote search snippets to factual evidence.
      return { ...envelope, result: {
        results: hits, searchProvider: 'brave', verified: false,
        deploymentVerified: false, claimEvidence: false,
      } };
    } catch {
      return { ...envelope, error: {
        code: 'WEB_SEARCH_UNAVAILABLE',
        message: 'Public search temporarily unavailable. No facts were verified.',
        retryable: true,
      } };
    }
  }
}
