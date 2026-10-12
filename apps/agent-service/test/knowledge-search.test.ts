import { describe, expect, it } from 'vitest';
import { SourceStatus, Visibility } from '@enthusia/contracts';
import type { ToolCallContext } from '@enthusia/agent-core';
import { KnowledgeSearchTool, validatePublicKnowledge } from '../src/knowledge-search.js';

const KEY = 'synthetic-only-private-indexer-key';
const HASH = 'a'.repeat(40);
const ctx: ToolCallContext = {
  traceId: 'synthetic-trace', actor: { id: 'player', type: 'player' },
  visibilityCeiling: Visibility.PUBLIC,
};
function body(overrides: Record<string, unknown> = {}) {
  return {
    hits: [{
      text: 'Warzones rotates kits and combat modifiers.',
      sourceLocator: 'github:wsg138/MaceGuard:README.md',
      artifactId: 'synthetic-artifact',
      version: HASH,
      commitSha: 'b'.repeat(40),
      status: SourceStatus.CURRENT,
      score: 0.85,
      deploymentVerified: false,
    }],
    sourceMode: 'github-documentation-only',
    verifiedAt: new Date().toISOString(),
    deploymentVerified: false,
    ...overrides,
  };
}
const buildTool = (payload: unknown, status = 200) =>
  new KnowledgeSearchTool({
    baseUrl: 'http://127.0.0.1:4300',
    apiKey: KEY,
    fetchImpl: async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect((init?.headers as Record<string, string>)?.['authorization']).toBe('Bearer ' + KEY);
      return Response.json(payload, { status });
    },
  });

describe('Agent W12 public knowledge.search read tool (not registered in runtime yet)', () => {
  it('accepts bounded CURRENT PUBLIC source hits and preserves provenance', async () => {
    const tool = buildTool(body());
    expect(tool.meta.name).toBe('knowledge.search');
    expect(tool.meta.privacySensitive).toBe(false);
    expect(tool.meta.maxVisibility).toBe(Visibility.PUBLIC);
    const result = await tool.execute({ question: 'How do Warzones rotate kits?' }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.freshness).toContain('CURRENT');
    expect(result.source).toBe('github-public-documentation');
    const payload = result.result as { excerpts: Array<{ sourceLocator: string; deploymentVerified: boolean }> };
    expect(payload.excerpts).toHaveLength(1);
    expect(payload.excerpts[0]?.sourceLocator).toBe('github:wsg138/MaceGuard:README.md');
    expect(payload.excerpts[0]?.deploymentVerified).toBe(false);
  });

  it('never allows user-selected source repository or staff-only visibility', async () => {
    for (const sourceLocator of [
      'github:outside/private:README.md',
      'github:wsg138/EnthusiaStaff:README.md',
    ]) {
      expect(validatePublicKnowledge(body({
        hits: [{ ...body().hits[0], sourceLocator }],
      }))).toBeNull();
    }
    expect(validatePublicKnowledge(body({
      hits: [{ ...body().hits[0], status: SourceStatus.SUPERSEDED }],
    }))).toBeNull();
    expect(validatePublicKnowledge(body({ deploymentVerified: true }))).toBeNull();
  });

  it('rejects stale evidence and malformed text/data', () => {
    expect(validatePublicKnowledge(body({
      verifiedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    }))).toBeNull();
    expect(validatePublicKnowledge(body({
      hits: [{ ...body().hits[0], text: 'X'.repeat(1500) }],
    }))).toBeNull();
    expect(validatePublicKnowledge(body({
      hits: [{ ...body().hits[0], version: 'not-a-commit' }],
    }))).toBeNull();
  });

  it('fails closed for unavailable sources without printing response or secrets', async () => {
    const tool = buildTool({ internalError: 'synthetic-secret-material' }, 503);
    const result = await tool.execute({ question: 'Warzones current status' }, ctx);
    expect(result.error?.code).toBe('KNOWLEDGE_SOURCE_UNAVAILABLE');
    expect(result.result).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-material');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('rejects external service endpoints and invalid questions', async () => {
    expect(() => new KnowledgeSearchTool({
      baseUrl: 'https://github.com', apiKey: KEY,
    })).toThrow('internal loopback');
    const tool = buildTool(body());
    const result = await tool.execute({ question: 'x' }, ctx);
    expect(result.error?.code).toBe('KNOWLEDGE_INVALID_QUERY');
  });
});
