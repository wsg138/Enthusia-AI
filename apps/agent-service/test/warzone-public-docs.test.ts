import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import type { ResolvedChatRequest } from '@enthusia/agent-core';
import {
  WarzonePublicDocsPilot, isWarzoneRotationQuestion,
  warzoneReadmeRecognized,
} from '../src/warzone-public-docs.js';

const COMMIT = 'a'.repeat(40);
const README = [
  '# MaceGuard',
  'MaceGuard provides Warzone kits.',
  'Warzone kits are supported by an anchored repeating schedule.',
  'The cycle uses DAYS, WEEKS, or MONTHS.',
  'A manual override takes precedence without pausing or shifting the automatic cycle.',
  'CombatLogX combat-carryover:',
  '/warzone next',
  '/warzone schedule',
].join('\n');

function request(): ResolvedChatRequest {
  return {
    surface: 'discord',
    actor: { id: 'test-user', type: 'player' },
    conversationId: 'discord:test:ai-testing',
    message: 'Can you explain how the Warzones combat rotator system works?',
    visibilityCeiling: Visibility.PUBLIC,
    traceId: '123e4567-e89b-12d3-a456-426614174000',
  };
}

function mockClient(options: {
  repoPrivate?: boolean; branch?: string; sha?: string;
  readme?: string; wrongBlob?: boolean;
} = {}) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).not.toHaveProperty('authorization');
    if (url === 'https://api.github.com/repos/wsg138/MaceGuard') {
      return Response.json({ private: options.repoPrivate ?? false, default_branch: options.branch ?? 'main' });
    }
    if (url.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { type: 'commit', sha: options.sha ?? COMMIT } });
    }
    if (url.endsWith('/contents/README.md?ref=' + COMMIT)) {
      const bytes = Buffer.from(options.readme ?? README);
      const sha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      return Response.json({
        type: 'file', encoding: 'base64', size: bytes.length,
        sha: options.wrongBlob ? 'f'.repeat(40) : sha,
        content: bytes.toString('base64'),
      });
    }
    throw new Error('Non-allowlisted endpoint used: ' + url);
  };
  return { fetchImpl, calls };
}

describe('Warzone public docs: exact source, zero secrets', () => {
  it('detects the Warzone rotator question, but no unrelated prompts', () => {
    expect(isWarzoneRotationQuestion(request().message)).toBe(true);
    expect(isWarzoneRotationQuestion('What is your IP?')).toBe(false);
    expect(isWarzoneRotationQuestion('Warzones ticket history for player X')).toBe(false);
    expect(isWarzoneRotationQuestion('Warzone combat logs for player X')).toBe(false);
  });

  it('requires all expected README gameplay sections', () => {
    expect(warzoneReadmeRecognized(README)).toBe(true);
    expect(warzoneReadmeRecognized(README.replace('A manual override', 'Something else'))).toBe(false);
  });

  it('produces a short grounded explanation at a verified exact commit', async () => {
    const mock = mockClient();
    const response = await new WarzonePublicDocsPilot(mock).resolve(request());
    expect(response?.outcome).toBe('answered');
    expect(response?.text).toContain('**Rotation:**');
    expect(response?.text).toContain('**Combat rules:**');
    expect(response?.text).toContain('**Overrides:**');
    expect(response?.text).toContain('not confirmation of what is currently active');
    expect(response?.sources[0]?.artifactId).toBe('github:wsg138/MaceGuard@' + COMMIT + ':README.md');
    expect(mock.calls).toHaveLength(3);
  });

  it('does not access the internet for unrelated questions', async () => {
    const mock = mockClient();
    expect(await new WarzonePublicDocsPilot(mock).resolve({
      ...request(), message: 'How is the Minecraft server doing?',
    })).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it('does not trust private repositories, changed branches, bad commits, bad blobs, or missing sections', async () => {
    for (const options of [
      { repoPrivate: true }, { branch: 'dev' }, { sha: 'not-a-sha' },
      { wrongBlob: true }, { readme: 'Unrelated text' },
    ]) {
      const response = await new WarzonePublicDocsPilot(mockClient(options)).resolve(request());
      expect(response?.outcome).toBe('unverified');
      expect(response?.sources).toEqual([]);
      expect(response?.text).not.toContain('**Rotation:**');
    }
  });

  it('never reflects network errors or secrets into replies', async () => {
    const pilot = new WarzonePublicDocsPilot({
      fetchImpl: async () => { throw new Error('a fake private token'); },
    });
    const response = await pilot.resolve(request());
    expect(response?.outcome).toBe('unverified');
    expect(response?.text).not.toContain('private token');
  });
});
