/**
 * Mock AI-Moderation-API fetch used by W15 contract/failure-isolation tests.
 *
 * The fixtures mirror the privacy-safe support-context contract implemented
 * by AI-Moderation-API Policy v1. No real moderation service is contacted.
 */
import type { FetchFn } from '../src/types.js';

type MockResponseSpec = {
  status?: number;
  body?: unknown;
  rejectWith?: string;
  hang?: boolean;
  assertRequest?: (input: string | URL | Request, init?: RequestInit) => void;
};

export class MockModerationApi {
  readonly calls: Array<{ url: string; init?: RequestInit }> = [];

  private handlers: MockResponseSpec[] = [];
  private defaultHandler: MockResponseSpec;

  constructor(defaultHandler: MockResponseSpec = {}) {
    this.defaultHandler = defaultHandler;
  }

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
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
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
    body: readyHealthBody(),
  });
}

export function readyHealthBody() {
  return {
    status: 'ready',
    ready: true,
    schema_version: 3,
    request_queue_depth: 0,
    request_queue_capacity: 256,
    request_workers: 4,
    classifier_ready: true,
    classifier_mode: 'onnx',
    local_model_version: 'w12-test',
    advisory_enabled: false,
    advisory_queue_depth: 0,
    advisory_queue_capacity: 256,
    rehydrated_context_messages: 42,
    context_ready: true,
  };
}

export function notReadyHealthBody() {
  return {
    ...readyHealthBody(),
    status: 'not_ready',
    ready: false,
    classifier_ready: false,
    classifier_mode: 'unavailable',
  };
}

export function downApi(): MockModerationApi {
  return new MockModerationApi({
    rejectWith: 'connect ECONNREFUSED 127.0.0.1:8080',
  });
}

export function sampleDecisionBody() {
  return {
    subject_id: 'canonical-player-42',
    decisions: [
      {
        event_id: 'event-1',
        occurred_at: '2026-09-30T12:00:00.000Z',
        platform: 'minecraft',
        semantic_label: 'SEVERE_HARASSMENT',
        message_action: 'BLOCK',
        review_priority: 'NORMAL',
        strike_recommendation: 'STRIKE',
        containment: 'NONE',
        support_flow: 'NONE',
        reason_codes: ['repeated_targeted_harassment'],
        decision_source: 'AI',
      },
      {
        event_id: 'event-2',
        occurred_at: '2026-09-25T09:00:00.000Z',
        platform: 'discord',
        semantic_label: 'LOW_LEVEL_HARASSMENT',
        message_action: 'ALLOW',
        review_priority: 'NONE',
        strike_recommendation: 'EVIDENCE',
        containment: 'NONE',
        support_flow: 'NONE',
        reason_codes: ['staff_corrected'],
        decision_source: 'ACCEPTED_CORRECTION',
      },
    ],
  };
}
