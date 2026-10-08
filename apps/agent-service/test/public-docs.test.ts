import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Visibility } from '@enthusia/contracts';
import type { ResolvedChatRequest } from '@enthusia/agent-core';
import {
  PieCloakPublicDocsPilot,
  extractPieCloakDocumentedRules,
  isPieCloakQuestion,
} from '../src/public-docs.js';

const COMMIT = 'a'.repeat(40);
const README = [
  "# PieCloak",
  "PieCloak is Enthusia SMP's anti-ESP/base-finding layer.",
  "It does **not** cancel entity spawns.",
  "## Current Enthusia visibility rules",
  "1. **Within roughly 24 blocks:** always shown.",
  "2. **Between roughly 24 and 48 blocks:** the engine raycasts.",
  "Once the ray crosses three occluding block samples, the clue is treated as hidden.",
  "3. **Beyond roughly 48 blocks:** hidden.",
  "## Commands",
].join('\n');

function sample(): ResolvedChatRequest {
  return {
    traceId: '123e4567-e89b-12d3-a456-426614174000',
    surface: 'discord',
    actor: { id: 'test-1', type: 'player' },
    conversationId: 'discord:test-guild:ai-testing',
    message: 'How does the pie cloak system work on the server?',
    visibilityCeiling: Visibility.PUBLIC,
  };
}

function mockClient(overrides: {
  privateRepo?: boolean;
  branch?: string;
  readme?: string;
  ref?: string;
  size?: number;
  content?: string;
} = {}) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).not.toHaveProperty('authorization');
    let data: object = {};
    if (url.endsWith('/repos/wsg138/PieCloak')) {
      data = { private: overrides.privateRepo ?? false, default_branch: overrides.branch ?? 'main' };
    } else if (url.endsWith('/git/ref/heads/main')) {
      data = { object: { type: 'commit', sha: overrides.ref ?? COMMIT } };
    } else if (url.endsWith('/contents/README.md?ref=' + COMMIT)) {
      const readme = overrides.readme ?? README;
      const content = overrides.content ?? Buffer.from(readme).toString('base64');
      const bytes = Buffer.from(readme);
      const blobSha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      data = {
        sha: blobSha, size: overrides.size ?? Buffer.byteLength(readme),
        encoding: 'base64', content, type: 'file',
      };
    } else {
      throw new Error('Unexpected GitHub URL: ' + url);
    }
    return Response.json(data);
  };
  return { fetchImpl, calls };
}

describe('PieCloak public documentation pilot (synthetic, no network)', () => {
  it('matches only explicit PieCloak questions', () => {
    expect(isPieCloakQuestion('How does pie cloak work?')).toBe(true);
    expect(isPieCloakQuestion('What is PieCloak?')).toBe(true);
    expect(isPieCloakQuestion('What is the server IP?')).toBe(false);
  });

  it('extracts consistent 24/48/3 documentation limits', () => {
    expect(extractPieCloakDocumentedRules(README)).toEqual({
      closeRadius: 24, raycastRadius: 48, occludingSamples: 3,
    });
    expect(extractPieCloakDocumentedRules(README.replace('Beyond roughly 48', 'Beyond roughly 60'))).toBeNull();
  });

  it('uses only verified public README pinned to an exact commit SHA', async () => {
    const client = mockClient();
    const answer = await new PieCloakPublicDocsPilot(client).resolve(sample());
    expect(answer?.text).toContain('24 blocks');
    expect(answer?.text).toContain('48 blocks');
    expect(answer?.text).toContain('3 occluding');
    expect(answer?.text).toContain('not proof of the currently deployed plugin');
    expect(answer?.text).toContain('/blob/' + COMMIT + '/README.md');
    expect(answer?.escalation).toBeNull();
    expect(answer?.sources).toHaveLength(1);
    expect(answer?.sources[0]?.visibility).toBe(Visibility.PUBLIC);
    expect(client.calls).toHaveLength(3);
    expect(client.calls.every((url) => url.startsWith('https://api.github.com/repos/wsg138/PieCloak'))).toBe(true);
  });

  it('does not reach the network for unrelated questions', async () => {
    const client = mockClient();
    const answer = await new PieCloakPublicDocsPilot(client).resolve({
      ...sample(), message: 'Tell me the server IP',
    });
    expect(answer).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it('fails closed for private repos, moved branches and invalid commit SHAs', async () => {
    for (const options of [
      { privateRepo: true },
      { branch: 'private-branch' },
      { ref: 'invalid-ref' },
    ]) {
      const answer = await new PieCloakPublicDocsPilot(mockClient(options)).resolve(sample());
      expect(answer?.text).toContain("couldn't verify");
      expect(answer?.sources).toEqual([]);
    }
  });

  it('fails closed for unrecognizable, oversized, or corrupt documents', async () => {
    for (const options of [
      { readme: 'This document contains unrelated instructions' },
      { size: 65000 },
      { content: '!!!notbase64!!!' },
    ]) {
      const answer = await new PieCloakPublicDocsPilot(mockClient(options)).resolve(sample());
      expect(answer?.text).toContain("couldn't verify");
      expect(answer?.sources).toEqual([]);
    }
  });

  it('fails closed on network errors without exposing the reason to a player', async () => {
    const pilot = new PieCloakPublicDocsPilot({
      fetchImpl: async () => { throw new Error('synthetic external secret exposed'); },
    });
    const answer = await pilot.resolve(sample());
    expect(answer?.text).not.toContain('synthetic external secret');
    expect(answer?.text).toContain("couldn't verify");
    expect(answer?.escalation).toBeNull();
  });
});
