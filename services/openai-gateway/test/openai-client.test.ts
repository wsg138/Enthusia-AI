import { describe, expect, it } from 'vitest';
import {
  OpenAIApiError,
  OpenAIClient,
  OpenAIParseError,
  OpenAITimeoutError,
} from '../src/openai-client.js';
import {
  chatCompletionsError,
  chatCompletionsOk,
  FAKE_API_KEY,
  neverRespond,
  startMockOpenAIServer,
} from './helpers.js';

function clientFor(url: string, timeoutMs = 5000): OpenAIClient {
  return new OpenAIClient({ apiKey: FAKE_API_KEY, baseUrl: url, timeoutMs });
}

describe('OpenAIClient against a mock server', () => {
  it('posts to /chat/completions and returns content + usage', async () => {
    const server = await startMockOpenAIServer(
      chatCompletionsOk('Diagnosis: the listener is registered twice.'),
    );
    try {
      const result = await clientFor(server.url).chatCompletions({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(result.content).toBe('Diagnosis: the listener is registered twice.');
      expect(result.model).toBe('mock-model');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
      expect(server.requests).toHaveLength(1);
      const body = server.requests[0] as Record<string, unknown>;
      expect(body['model']).toBe('gpt-5.2');
      expect(body['messages']).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('posts bounded base64 image content without an external image URL', async () => {
    const server = await startMockOpenAIServer(
      chatCompletionsOk('{"summary":"ok"}'),
    );
    try {
      await clientFor(server.url).imageChatCompletion({
        model: 'vision-test-model',
        systemPrompt: 'observe only',
        userPrompt: 'describe visible evidence',
        image: {
          bytes: new Uint8Array([1, 2, 3, 4]),
          contentType: 'image/png',
          detail: 'high',
        },
        maxOutputTokens: 500,
        temperature: 0,
      });
      const body = server.requests[0] as {
        messages?: Array<{ content?: unknown }>;
      };
      const user = body.messages?.[1] as {
        content?: Array<{
          type?: string;
          text?: string;
          image_url?: { url?: string; detail?: string };
        }>;
      };
      expect(user.content?.[0]).toEqual({
        type: 'text',
        text: 'describe visible evidence',
      });
      expect(user.content?.[1]?.type).toBe('image_url');
      expect(user.content?.[1]?.image_url?.url).toBe(
        'data:image/png;base64,AQIDBA==',
      );
      expect(user.content?.[1]?.image_url?.detail).toBe('high');
      expect(JSON.stringify(body)).not.toContain('discordapp');
      expect(JSON.stringify(body)).not.toContain('http://');
      expect(JSON.stringify(body)).not.toContain('https://');
    } finally {
      await server.close();
    }
  });

  it('maps HTTP errors to OpenAIApiError with status and code', async () => {
    const server = await startMockOpenAIServer(
      chatCompletionsError(429, 'rate_limit_exceeded', 'slow down'),
    );
    try {
      await expect(
        clientFor(server.url).chatCompletions({
          model: 'gpt-5.2',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toMatchObject({ name: 'OpenAIApiError' });
      try {
        await clientFor(server.url).chatCompletions({
          model: 'gpt-5.2',
          messages: [{ role: 'user', content: 'hi' }],
        });
        expect.unreachable('should have thrown');
      } catch (error) {
        const apiError = error as OpenAIApiError;
        expect(apiError).toBeInstanceOf(OpenAIApiError);
        expect(apiError.status).toBe(429);
        expect(apiError.code).toBe('rate_limit_exceeded');
        expect(apiError.message).toContain('slow down');
        expect(apiError.message).not.toContain(FAKE_API_KEY);
      }
    } finally {
      await server.close();
    }
  });

  it('raises OpenAITimeoutError when the server never responds', async () => {
    const server = await startMockOpenAIServer(neverRespond());
    try {
      await expect(
        clientFor(server.url, 150).chatCompletions({
          model: 'gpt-5.2',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toBeInstanceOf(OpenAITimeoutError);
    } finally {
      await server.close();
    }
  });

  it('raises OpenAIParseError on malformed responses', async () => {
    const server = await startMockOpenAIServer((_body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [] }));
    });
    try {
      await expect(
        clientFor(server.url).chatCompletions({
          model: 'gpt-5.2',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toBeInstanceOf(OpenAIParseError);
    } finally {
      await server.close();
    }
  });

  it('estimates usage when the response omits it', async () => {
    const server = await startMockOpenAIServer((_body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'mock-model',
          choices: [
            {
              message: { role: 'assistant', content: 'short answer' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
    try {
      const result = await clientFor(server.url).chatCompletions({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello world' }],
      });
      expect(result.usage.promptTokens).toBeGreaterThan(0);
      expect(result.usage.completionTokens).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBe(
        result.usage.promptTokens + result.usage.completionTokens,
      );
    } finally {
      await server.close();
    }
  });
});
