import { describe, expect, it } from 'vitest';
import type {
  AgentResponse,
  ChatRequest,
  MemoryEvidence,
  MemoryKey,
  MemoryRevision,
  SourceArtifact,
  ToolResult,
} from '../src/index.js';
import {
  AuthorizationError,
  ConflictError,
  EnthusiaError,
  EvidenceRole,
  ExternalServiceError,
  MEMORY_REVISION_STATUSES,
  NotFoundError,
  RateLimitError,
  SourceStatus,
  SourceType,
  StaleSourceError,
  ToolTimeoutError,
  TRACE_ID_HEADER,
  ValidationError,
  Visibility,
  VisibilityDeniedError,
  agentResponseSchema,
  canDisclose,
  chatRequestSchema,
  extractTraceId,
  isValidTraceId,
  livenessResponseSchema,
  memoryEvidenceSchema,
  memoryKeySchema,
  memoryRevisionSchema,
  newTraceId,
  readinessResponseSchema,
  sourceArtifactSchema,
  toolResultSchema,
} from '../src/index.js';

describe('Visibility', () => {
  it('defines the six spec classes', () => {
    expect(Object.values(Visibility)).toEqual([
      'PUBLIC',
      'PLAYER_SELF',
      'STAFF',
      'MANAGEMENT',
      'SYSTEM_INTERNAL',
      'SECRET_DENY',
    ]);
  });

  it('enforces ceilings: item at or below ceiling is disclosable', () => {
    expect(canDisclose(Visibility.PUBLIC, Visibility.PUBLIC)).toBe(true);
    expect(canDisclose(Visibility.PUBLIC, Visibility.STAFF)).toBe(true);
    expect(canDisclose(Visibility.STAFF, Visibility.STAFF)).toBe(true);
    expect(canDisclose(Visibility.STAFF, Visibility.PUBLIC)).toBe(false);
    expect(canDisclose(Visibility.SYSTEM_INTERNAL, Visibility.MANAGEMENT)).toBe(false);
  });

  it('never discloses SECRET_DENY', () => {
    for (const ceiling of Object.values(Visibility)) {
      expect(canDisclose(Visibility.SECRET_DENY, ceiling, { isStaff: true })).toBe(false);
    }
  });

  it('requires identity for PLAYER_SELF', () => {
    expect(canDisclose(Visibility.PLAYER_SELF, Visibility.STAFF)).toBe(false);
    expect(canDisclose(Visibility.PLAYER_SELF, Visibility.STAFF, { isSubject: true })).toBe(true);
    expect(canDisclose(Visibility.PLAYER_SELF, Visibility.STAFF, { isStaff: true })).toBe(true);
  });
});

describe('SourceStatus', () => {
  it('defines the five spec statuses', () => {
    expect(Object.values(SourceStatus)).toEqual([
      'CURRENT',
      'SUPERSEDED',
      'INVALID',
      'CONFLICTED',
      'STALE',
    ]);
  });

  it('memory revision statuses cover all five states', () => {
    expect([...MEMORY_REVISION_STATUSES]).toEqual(Object.values(SourceStatus));
  });
});

describe('SourceType', () => {
  it('defines the eleven spec source types', () => {
    expect(Object.values(SourceType)).toEqual([
      'GITHUB',
      'SFTP_FILE',
      'DOCUMENT',
      'CONFIG',
      'DATABASE_SCHEMA',
      'DATABASE_LIVE',
      'DISCORD',
      'TICKET',
      'STAFF',
      'DEPLOYMENT',
      'GENERATED',
    ]);
  });
});

describe('SourceArtifact', () => {
  const valid: SourceArtifact = {
    artifactId: 'art-1',
    sourceType: SourceType.GITHUB,
    sourceLocator: 'github:wsg138/EnthusiaStaff@abc123:plugin.yml',
    component: 'knowledge-indexer',
    visibility: Visibility.PUBLIC,
    authority: 'github',
    version: 'abc123',
    observedTime: '2026-10-03T15:00:00Z',
    indexedTime: '2026-10-03T15:01:00Z',
    current: true,
  };

  it('accepts a valid artifact', () => {
    expect(sourceArtifactSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a bad timestamp', () => {
    expect(() =>
      sourceArtifactSchema.parse({ ...valid, observedTime: 'not-a-time' }),
    ).toThrow();
  });

  it('rejects unknown visibility', () => {
    expect(() =>
      sourceArtifactSchema.parse({ ...valid, visibility: 'EVERYONE' }),
    ).toThrow();
  });
});

describe('ToolResult envelope', () => {
  it('accepts a successful result', () => {
    const r: ToolResult = {
      toolName: 'knowledge.search',
      timestamp: '2026-10-03T15:00:00Z',
      source: 'knowledge-indexer',
      visibility: Visibility.STAFF,
      correlationId: newTraceId(),
      freshness: 'index-2026-10-03T14:00Z',
      result: { hits: 3 },
    };
    expect(toolResultSchema.parse(r)).toEqual(r);
  });

  it('accepts an error result without payload', () => {
    const r: ToolResult = {
      toolName: 'github.getFile',
      timestamp: '2026-10-03T15:00:00Z',
      source: 'tool-gateway',
      visibility: Visibility.SYSTEM_INTERNAL,
      correlationId: newTraceId(),
      error: { code: 'TOOL_TIMEOUT', message: 'timed out', retryable: true },
    };
    expect(toolResultSchema.parse(r).error?.code).toBe('TOOL_TIMEOUT');
  });
});

describe('Chat contracts', () => {
  it('accepts a valid chat request', () => {
    const req: ChatRequest = {
      surface: 'discord',
      actor: { id: '123', type: 'player', displayName: 'Lincoln' },
      conversationId: 'conv-1',
      message: 'What is the server IP?',
      visibilityCeiling: Visibility.PUBLIC,
    };
    expect(chatRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects unknown surfaces', () => {
    expect(() =>
      chatRequestSchema.parse({
        surface: 'sms',
        actor: { id: '1', type: 'player' },
        conversationId: 'c',
        message: 'hi',
        visibilityCeiling: Visibility.PUBLIC,
      }),
    ).toThrow();
  });

  it('accepts a valid agent response', () => {
    const res: AgentResponse = {
      text: 'The server IP is play.enthusia.gg.',
      actions: [],
      sources: [{ description: 'network config', visibility: Visibility.PUBLIC }],
      memoryUpdates: [],
      escalation: null,
      traceId: newTraceId(),
    };
    expect(agentResponseSchema.parse(res)).toEqual(res);
  });
});

describe('Memory contracts', () => {
  const key: MemoryKey = {
    id: 'mk-1',
    namespace: 'network',
    key: 'connection.ip',
    scope: 'global',
    visibility: Visibility.PUBLIC,
  };

  it('accepts a memory key', () => {
    expect(memoryKeySchema.parse(key)).toEqual(key);
  });

  it('accepts a CURRENT revision with evidence linkage', () => {
    const rev: MemoryRevision = {
      id: 'mr-2',
      memoryKeyId: 'mk-1',
      value: 'play.enthusia.gg',
      summary: 'Current server connection address',
      status: SourceStatus.CURRENT,
      validFrom: '2026-10-01T00:00:00Z',
      createdAt: '2026-10-01T00:00:00Z',
      authority: 'indexer',
      evidenceReferences: ['me-1'],
      supersedesRevisionId: 'mr-1',
    };
    expect(memoryRevisionSchema.parse(rev)).toEqual(rev);
  });

  it('accepts all evidence roles', () => {
    for (const role of Object.values(EvidenceRole)) {
      const ev: MemoryEvidence = {
        id: 'me-1',
        revisionId: 'mr-2',
        sourceArtifactId: 'art-1',
        sourceVersion: 'abc123',
        evidenceRole: role,
      };
      expect(memoryEvidenceSchema.parse(ev).evidenceRole).toBe(role);
    }
  });
});

describe('Health contracts', () => {
  it('accepts a liveness response', () => {
    expect(
      livenessResponseSchema.parse({ status: 'ok', version: '0.1.0', uptimeSeconds: 42 }),
    ).toBeTruthy();
  });

  it('rejects non-ok liveness status', () => {
    expect(() =>
      livenessResponseSchema.parse({ status: 'degraded', version: '0.1.0', uptimeSeconds: 1 }),
    ).toThrow();
  });

  it('accepts a readiness response with dependencies', () => {
    const parsed = readinessResponseSchema.parse({
      status: 'degraded',
      version: '0.1.0',
      uptimeSeconds: 10,
      dependencies: [{ name: 'postgres', status: 'ok', latencyMs: 3 }],
      modelLoaded: false,
    });
    expect(parsed.dependencies).toHaveLength(1);
  });
});

describe('Typed errors', () => {
  it('carries code, status, message, and traceId', () => {
    const err = new ValidationError('bad input', { traceId: 't-1' });
    expect(err).toBeInstanceOf(EnthusiaError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    expect(err.traceId).toBe('t-1');
    expect(err.toJSON()).toEqual({
      name: 'ValidationError',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'bad input',
      traceId: 't-1',
    });
  });

  it('uses the spec status codes', () => {
    expect(new AuthorizationError('x').statusCode).toBe(403);
    expect(new NotFoundError('x').statusCode).toBe(404);
    expect(new ToolTimeoutError('t', 1000).statusCode).toBe(504);
    expect(new VisibilityDeniedError().statusCode).toBe(403);
    expect(new StaleSourceError('s').statusCode).toBe(410);
    expect(new ConflictError('x').statusCode).toBe(409);
    expect(new RateLimitError('x', 30).statusCode).toBe(429);
    expect(new ExternalServiceError('openai', 'boom').statusCode).toBe(502);
  });

  it('keeps internal detail out of toJSON', () => {
    const err = new ExternalServiceError('openai', 'boom', {
      detail: { apiKey: 'must-not-leak' },
    });
    expect(JSON.stringify(err)).not.toContain('must-not-leak');
  });

  it('RateLimitError carries retryAfterSeconds', () => {
    expect(new RateLimitError('slow down', 30).retryAfterSeconds).toBe(30);
  });
});

describe('Trace IDs', () => {
  it('generates unique UUID v4 trace IDs', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
    expect(isValidTraceId(a)).toBe(true);
    expect(isValidTraceId('not-a-uuid')).toBe(false);
  });

  it('propagates a valid inbound header', () => {
    const incoming = newTraceId();
    expect(extractTraceId({ [TRACE_ID_HEADER]: incoming })).toBe(incoming);
  });

  it('generates a fresh ID when the header is missing or invalid', () => {
    expect(isValidTraceId(extractTraceId({}))).toBe(true);
    expect(isValidTraceId(extractTraceId({ [TRACE_ID_HEADER]: 'bogus' }))).toBe(true);
  });
});
