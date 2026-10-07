import { describe, expect, it } from 'vitest';
import {
  StaffModerationStateClient,
  assertAllowedStaffModerationRequest,
} from '../src/client.js';

const API_KEY = 'a'.repeat(48);

function validPayload(version: 'v1' | 'v2' = 'v1') {
  return {
    service: 'enthusia-staff',
    api: 'ai-moderation-state',
    contractVersion: version,
    target: {
      requested: 'Bad_Player',
      playerId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      username: 'Bad_Player',
      ...(version === 'v2'
        ? { moderationSubjectId: '12345678-1234-4234-8234-123456789abc' }
        : {}),
    },
    activeSanctions: [
      {
        sanctionId: '11111111-2222-4333-8444-555555555555',
        caseId: '0123456789ABCDEF',
        type: 'MUTE',
        publicReason: 'Public reason',
        issuedAt: '2026-10-06T20:00:00.000Z',
        expiresAt: '2026-10-06T21:00:00.000Z',
      },
    ],
    recentCases: [
      {
        caseId: '0123456789ABCDEF',
        exactReasonId: 'chat.harassment',
        sanctionFamily: 'chat',
        state: 'OPEN',
        publicReason: 'Public reason',
        issuedAt: '2026-10-06T20:00:00.000Z',
        hasActiveSanctions: true,
        configurationVersion: 'rules-2026.10',
      },
    ],
    fetchedAt: '2026-10-06T20:01:00.000Z',
  };
}

describe('StaffModerationStateClient', () => {
  it('reads the one allowlisted moderation-state endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new StaffModerationStateClient({
      baseUrl: 'https://moderation-read.example.test/',
      apiKey: API_KEY,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify(validPayload()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const result = await client.getState('Bad_Player');

    expect(result.target.username).toBe('Bad_Player');
    expect(result.recentCases[0]?.exactReasonId).toBe('chat.harassment');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://moderation-read.example.test/v1/ai/moderation-state',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"target":"Bad_Player"}');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('accepts v2 and surfaces only the authoritative moderation subject field', async () => {
    const client = new StaffModerationStateClient({
      baseUrl: 'https://moderation-read.example.test',
      apiKey: API_KEY,
      fetchImpl: async () =>
        new Response(JSON.stringify(validPayload('v2')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.getState('Bad_Player');

    expect(result.contractVersion).toBe('v2');
    expect(result.target.moderationSubjectId).toBe(
      '12345678-1234-4234-8234-123456789abc',
    );
  });

  it('keeps v1 compatible without inventing a moderation subject', async () => {
    const client = new StaffModerationStateClient({
      baseUrl: 'https://moderation-read.example.test',
      apiKey: API_KEY,
      fetchImpl: async () =>
        new Response(JSON.stringify(validPayload('v1')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.getState('Bad_Player');

    expect(result.contractVersion).toBe('v1');
    expect(result.target.moderationSubjectId).toBeUndefined();
  });

  it('rejects invalid targets before network access', async () => {
    let calls = 0;
    const client = new StaffModerationStateClient({
      baseUrl: 'https://moderation-read.example.test',
      apiKey: API_KEY,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    });

    await expect(client.getState('../bad')).rejects.toThrow(/Minecraft username/);
    expect(calls).toBe(0);
  });

  it('rejects unexpected private response fields', async () => {
    const payload = validPayload() as ReturnType<typeof validPayload> & {
      internalExplanation?: string;
    };
    payload.internalExplanation = 'private detail';

    const client = new StaffModerationStateClient({
      baseUrl: 'https://moderation-read.example.test',
      apiKey: API_KEY,
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(client.getState('Bad_Player')).rejects.toThrow(
      /incompatible moderation-state contract/,
    );
  });

  it('rejects mismatched target echoes', async () => {
    const payload = validPayload();
    payload.target.requested = 'OtherPlayer';

    const client = new StaffModerationStateClient({
      baseUrl: 'https://moderation-read.example.test',
      apiKey: API_KEY,
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(client.getState('Bad_Player')).rejects.toThrow(
      /target did not match/,
    );
  });

  it('maps target ambiguity without exposing response details', async () => {
    const client = new StaffModerationStateClient({
      baseUrl: 'https://moderation-read.example.test',
      apiKey: API_KEY,
      fetchImpl: async () =>
        new Response(
          '{"code":"target_ambiguous","message":"private provider detail"}',
          { status: 409 },
        ),
    });

    await expect(client.getState('Bad_Player')).rejects.toThrow(
      'Moderation target is ambiguous.',
    );
  });
});

describe('staff moderation request allowlist', () => {
  it('permits only the exact POST read route', () => {
    expect(() =>
      assertAllowedStaffModerationRequest(
        'POST',
        '/v1/ai/moderation-state',
      ),
    ).not.toThrow();

    const forbidden: Array<[string, string]> = [
      ['GET', '/v1/ai/moderation-state'],
      ['POST', '/v1/moderation/actions/confirm'],
      ['DELETE', '/v1/ai/moderation-state'],
      ['POST', 'https://example.test/arbitrary'],
    ];
    for (const [method, path] of forbidden) {
      expect(() =>
        assertAllowedStaffModerationRequest(method, path),
      ).toThrow(/refuses/);
    }
  });
});
