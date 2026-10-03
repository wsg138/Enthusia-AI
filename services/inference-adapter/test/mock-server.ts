import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * Fake OpenAI-compatible inference server for unit tests.
 *
 * Implements just enough of the surface the adapter uses:
 * - POST /v1/chat/completions (JSON and SSE streaming)
 * - GET /v1/models
 *
 * Failure injection: `failChatTimes` (HTTP 500), `chatStatus` (e.g. 400),
 * `chatDelayMs`, and `chatHang` (never responds — for timeout tests).
 */

export interface MockServerBehavior {
  failChatTimes?: number;
  chatStatus?: number;
  chatDelayMs?: number;
  chatHang?: boolean;
  streamChunks?: string[];
  streamLineEnding?: 'lf' | 'crlf';
  streamHangAfterHeaders?: boolean;
  invalidChatResponse?: boolean;
  modelId?: string;
  modelMeta?: Record<string, unknown>;
  modelsEmpty?: boolean;
}

export interface MockServerStats {
  chatRequests: number;
  modelRequests: number;
  lastAuthHeader: string | string[] | undefined;
  lastRequestBody: unknown;
  lastStreamFlag: boolean | undefined;
}

export interface MockServer {
  url: string;
  stats: MockServerStats;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: unknown) => {
      data += String(chunk);
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startMockServer(behavior: MockServerBehavior = {}): Promise<MockServer> {
  const modelId = behavior.modelId ?? 'mock-model';
  const stats: MockServerStats = {
    chatRequests: 0,
    modelRequests: 0,
    lastAuthHeader: undefined,
    lastRequestBody: undefined,
    lastStreamFlag: undefined,
  };
  let chatFailuresRemaining = behavior.failChatTimes ?? 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/v1/models') {
        stats.modelRequests += 1;
        stats.lastAuthHeader = req.headers['authorization'];
        const data =
          behavior.modelsEmpty === true
            ? []
            : [
                {
                  id: modelId,
                  object: 'model',
                  created: 1700000000,
                  owned_by: 'mock',
                  ...(behavior.modelMeta !== undefined ? { meta: behavior.modelMeta } : {}),
                },
              ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data }));
        return;
      }
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        stats.chatRequests += 1;
        stats.lastAuthHeader = req.headers['authorization'];
        const raw = await readBody(req);
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          parsedBody = undefined;
        }
        stats.lastRequestBody = parsedBody;
        const stream =
          typeof parsedBody === 'object' &&
          parsedBody !== null &&
          (parsedBody as { stream?: unknown }).stream === true;
        stats.lastStreamFlag = stream;

        if (behavior.chatHang === true) {
          return; // Never respond: the client must time out on its own.
        }
        if (behavior.chatDelayMs !== undefined && behavior.chatDelayMs > 0) {
          await new Promise((r) => setTimeout(r, behavior.chatDelayMs));
        }
        if (chatFailuresRemaining > 0) {
          chatFailuresRemaining -= 1;
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock upstream failure', type: 'server_error' } }));
          return;
        }
        const status = behavior.chatStatus ?? 200;
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: `mock status ${status}`, type: 'invalid_request_error' } }),
          );
          return;
        }
        if (stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          if (behavior.streamHangAfterHeaders === true) {
            res.flushHeaders();
            return;
          }
          const eol = behavior.streamLineEnding === 'crlf' ? '\r\n' : '\n';
          for (const piece of behavior.streamChunks ?? ['Hello', ' world']) {
            res.write(
              `data: ${JSON.stringify({
                id: 'chatcmpl-mock',
                object: 'chat.completion.chunk',
                model: modelId,
                choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }],
              })}${eol}${eol}`,
            );
          }
          // llama.cpp-style final chunk carrying usage.
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              model: modelId,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
            })}${eol}${eol}`,
          );
          res.write(`data: [DONE]${eol}${eol}`);
          res.end();
          return;
        }
        if (behavior.invalidChatResponse === true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ object: 'chat.completion', choices: 'not-an-array' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: 1700000000,
            model: modelId,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Hello from mock' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Mock server failed to bind');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
