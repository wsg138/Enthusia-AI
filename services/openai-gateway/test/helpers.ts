/**
 * Test helpers for @enthusia/openai-gateway.
 *
 * - Local mock of the OpenAI /chat/completions endpoint (node:http).
 * - A valid InvestigationPacket fixture.
 *
 * No real API keys, no real network. Fake keys never use an `sk-` prefix
 * so secret scans stay clean.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Visibility } from '@enthusia/contracts';
import type { InvestigationPacket } from '../src/packet.js';

export const FAKE_API_KEY = 'test-openai-key-not-real';

export interface MockServer {
  url: string;
  /** Raw request bodies received, in order. */
  requests: unknown[];
  close: () => Promise<void>;
}

export type MockHandler = (body: unknown, res: ServerResponse) => void;

export async function startMockOpenAIServer(
  handler: MockHandler,
): Promise<MockServer> {
  const requests: unknown[] = [];
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        let body: unknown = null;
        try {
          body = raw.length > 0 ? (JSON.parse(raw) as unknown) : null;
        } catch {
          body = null;
        }
        requests.push(body);
        handler(body, res);
      });
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

/** Handler that answers like a successful chat completion. */
export function chatCompletionsOk(
  content: string,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
): MockHandler {
  return (_body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage,
      }),
    );
  };
}

/** Handler that answers with an HTTP error envelope. */
export function chatCompletionsError(
  status: number,
  code: string,
  message: string,
): MockHandler {
  return (_body, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { message, type: 'server_error', code } }),
    );
  };
}

/** Handler that never responds (for timeout tests). */
export function neverRespond(): MockHandler {
  return () => {
    // Intentionally hold the connection open forever.
  };
}

/** A well-formed §22.2 investigation packet fixture. */
export function makePacket(
  overrides: Partial<InvestigationPacket> = {},
): InvestigationPacket {
  return {
    packetRef: 'packet:trace-1',
    traceId: 'trace-1',
    userQuestion: 'Why does /staff vanish break on the hub server?',
    goal: 'Diagnose the vanish failure on hub and propose a fix.',
    requestClass: 'engineering',
    relevantRepositories: ['wsg138/EnthusiaStaff'],
    relevantFiles: ['src/main/java/StaffMode.java'],
    currentShas: {
      'github:wsg138/EnthusiaStaff@abc123:src/main/java/StaffMode.java': 'abc123',
    },
    logs: ['github.code_search completed against current StaffMode.java'],
    toolEvidence: [
      {
        id: 'e1',
        claim: 'vanish listener registered on hub',
        value: 'listener count: 1',
        toolName: 'github.code_search',
        source: 'github:wsg138/EnthusiaStaff@abc123:src/main/java/StaffMode.java',
        visibility: Visibility.STAFF,
        verificationTier: 'tool-verified',
        version: 'abc123',
        observedTime: '2026-10-03T12:00:00Z',
      },
    ],
    attemptedDiagnosis: ['called github.code_search for StaffMode.java (ok, 120ms)'],
    unresolvedQuestions: ['Why does the vanish listener not fire on hub joins?'],
    constraints: ['No production writes without explicit staff authorization (§22.4).'],
    authorization: {
      actorId: 'staff-42',
      actorKind: 'staff',
      visibilityCeiling: Visibility.STAFF,
    },
    expectedOutput: 'Diagnosis and a concrete code change proposal with verification steps.',
    redactedEvidenceCount: 0,
    ...overrides,
  };
}
