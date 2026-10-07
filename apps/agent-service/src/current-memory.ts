import {
  SourceStatus,
  Visibility,
  type ToolResult,
} from '@enthusia/contracts';
import {
  MemoryService,
  type CurrentMemory,
  type MemoryRef,
} from '@enthusia/memory';
import {
  encodeFreshness,
  type Tool,
  type ToolCallContext,
  type ToolMetadata,
} from '@enthusia/agent-core';

const SOURCE = 'current-memory';
const MAX_IDENTITY_PART_LENGTH = 160;
const MAX_VALUE_LENGTH = 2_000;
const MAX_SUMMARY_LENGTH = 600;

interface CurrentMemoryFactPayload {
  value: string;
  excerpt: string;
  memory: {
    keyId: string;
    namespace: string;
    key: string;
    scope: string;
    status: SourceStatus.CURRENT;
  };
}

interface PublicMemoryError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Exact-key, CURRENT-only, PUBLIC-only W05 memory read.
 *
 * This deliberately does not expose search, history, raw SQL, private memory,
 * or visibility downgrades. Specialized tools own identity-scoped memory such
 * as player familiarity.
 */
export class PublicCurrentMemoryTool
  implements Tool<{ namespace: string; key: string; scope: string }>
{
  readonly meta: ToolMetadata = {
    name: 'memory.current_fact',
    description:
      'Read one exact CURRENT, evidence-backed PUBLIC structured-memory fact ' +
      'by namespace, key, and scope. Does not search history or private memory.',
    parameters: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Exact structured-memory namespace.',
        },
        key: {
          type: 'string',
          description: 'Exact structured-memory concept key.',
        },
        scope: {
          type: 'string',
          description: 'Exact structured-memory scope, such as global or smp.',
        },
      },
      required: ['namespace', 'key', 'scope'],
    },
    verificationTier: 'C',
    privacySensitive: false,
    maxVisibility: Visibility.PUBLIC,
  };

  constructor(private readonly memory: MemoryService) {}

  async execute(
    params: { namespace: string; key: string; scope: string },
    ctx: ToolCallContext,
  ): Promise<ToolResult<unknown>> {
    const timestamp = new Date().toISOString();
    try {
      ctx.signal?.throwIfAborted();
      const ref = normalizeRef(params);
      const current = this.memory.getCurrent(ref);
      const payload = publicFactPayload(current);
      return {
        toolName: this.meta.name,
        timestamp,
        source: SOURCE,
        visibility: Visibility.PUBLIC,
        correlationId: ctx.traceId,
        freshness: encodeFreshness({
          version: current!.revision.id,
          observedTime:
            current!.revision.verifiedAt ?? current!.revision.createdAt,
          sourceStatus: SourceStatus.CURRENT,
        }),
        result: payload,
      };
    } catch (error) {
      return {
        toolName: this.meta.name,
        timestamp,
        source: SOURCE,
        visibility: Visibility.PUBLIC,
        correlationId: ctx.traceId,
        error: publicMemoryError(error),
      };
    }
  }
}

function normalizeRef(
  params: { namespace: string; key: string; scope: string },
): MemoryRef {
  return {
    namespace: normalizeIdentityPart(params.namespace),
    key: normalizeIdentityPart(params.key),
    scope: normalizeIdentityPart(params.scope),
  };
}

function normalizeIdentityPart(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_memory_ref');
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_IDENTITY_PART_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error('invalid_memory_ref');
  }
  return normalized;
}

function publicFactPayload(
  current: CurrentMemory | null,
): CurrentMemoryFactPayload {
  if (
    current === null ||
    current.key.visibility !== Visibility.PUBLIC ||
    current.revision.status !== SourceStatus.CURRENT ||
    current.revision.evidence.length === 0
  ) {
    throw new Error('public_memory_unavailable');
  }

  return {
    value: boundedValue(current.revision.value),
    excerpt: boundedText(current.revision.summary, MAX_SUMMARY_LENGTH),
    memory: {
      keyId: current.key.id,
      namespace: current.key.namespace,
      key: current.key.key,
      scope: current.key.scope,
      status: SourceStatus.CURRENT,
    },
  };
}

function boundedValue(value: unknown): string {
  let rendered: string;
  if (typeof value === 'string') {
    rendered = value.trim();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    rendered = String(value);
  } else if (typeof value === 'boolean') {
    rendered = String(value);
  } else {
    try {
      rendered = JSON.stringify(value) ?? '';
    } catch {
      throw new Error('public_memory_unavailable');
    }
  }

  if (rendered.length < 1 || rendered.length > MAX_VALUE_LENGTH) {
    throw new Error('public_memory_unavailable');
  }
  return rendered;
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  return normalized.slice(0, maximum - 1) + '…';
}

function publicMemoryError(error: unknown): PublicMemoryError {
  if (error instanceof Error && error.message === 'invalid_memory_ref') {
    return {
      code: 'invalid_memory_ref',
      message: 'A valid exact memory namespace, key, and scope are required.',
      retryable: false,
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'memory_read_aborted',
      message: 'Current memory lookup was cancelled.',
      retryable: true,
    };
  }
  return {
    code: 'public_memory_unavailable',
    message: 'No verified current public memory fact is available for that key.',
    retryable: false,
  };
}
