/**
 * Mock moderation API fetch (W15 tests).
 *
 * NO real moderation service connection. This mock stands in for the
 * sibling moderation service's HTTP API so the client's request shape,
 * error handling, and the adapter's failure isolation can be tested
 * deterministically.
 */
import type { FetchFn } from '../src/types.js';

type MockResponseSpec = {
  status?: number;
  body?: unknown;
  /** Reject the request instead of resolving (e.g. network down). */
  rejectWith?: string;
  /** Hang until the request is aborted (tests timeouts). */
  hang?: boolean;
  /** Assert on the outgoing request; throw to fail the test. */
  assertRequest?: (input: string | URL | Request, init?: RequestInit) => void;
};

export class MockModerationApi {
  readonly calls: Array<{ url: string; init?: RequestInit }> = [];

  private handlers: MockResponseSpec[] = [];
  private defaultHandler: MockResponseSpec;

  constructor(defaultHandler: MockResponseSpec = {}) {
    this.defaultHandler = defaultHandler;
  }

  /** Queue one-shot responses, consumed in order. */
  queue(...handlers: MockResponseSpec[]): void {
    this.handlers.push(...handlers);
  }

  get fetch(): FetchFn {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init === undefined) {
        this.calls.push({ url });
      } else {
        this.calls.push({ url, init });
      }
      const spec = this.handlers.shift() ?? this.defaultHandler;
      spec.assertRequest?.(input, init);
      if (spec.rejectWith !== undefined) {
        throw new Error(spec.rejectWith);
      }
      if (spec.hang === true) {
        const signal = init?.signal as AbortSignal | undefined;
        await new Promise<never>((_, reject) => {
          if (signal?.aborted === true) reject(new DOMException('aborted', 'AbortError'));
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        });
      }
      const status = spec.status ?? 200;
      const body = spec.body === undefined ? {} : spec.body;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }) as FetchFn;
  }
}

export function healthyApi(): MockModerationApi {
  return new MockModerationApi({
    status: 200,
    body: { status: 'ok', version: 'mod-1.4.2' },
  });
}

export function downApi(): MockModerationApi {
  return new MockModerationApi({ rejectWith: 'connect ECONNREFUSED 127.0.0.1:8080' });
}

export function sampleDecisionBody() {
  return {
    subjectId: 'mod-subject-42',
    decisions: [
      {
        id: 'dec-1',
        subjectId: 'mod-subject-42',
        verdict: 'flagged',
        categories: ['spam'],
        summary: 'Repeated identical trade spam in hub chat.',
        decidedAt: '2026-09-30T12:00:00.000Z',
        appealed: false,
      },
      {
        id: 'dec-2',
        subjectId: 'mod-subject-42',
        verdict: 'clean',
        categories: [],
        summary: 'Appealed and cleared by staff.',
        decidedAt: '2026-09-25T09:00:00.000Z',
      },
    ],
  };
}
