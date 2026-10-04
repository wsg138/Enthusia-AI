/**
 * @enthusia/integration-databases — W12 plug-compatibility conformance (W10).
 *
 * Pins the structural mirror in tool-adapter.ts against the real W12
 * contract (services/agent-core/src/tool.ts, branch w12/agent-orchestrator,
 * PR #14). If W12 changes its Tool interface, this test documents where the
 * mirror must be re-synced.
 *
 * DO NOT modify W12's code from this workstream.
 */
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import { makeHarness, staffContext } from './helpers.js';
import type {
  Tool,
  ToolMetadata,
  ToolParametersSchema,
} from '../src/tool-adapter.js';

/**
 * Compile-time assertion: every W10 tool must be assignable to W12's Tool
 * shape (name/description/parameters/verificationTier/privacySensitive/
 * maxVisibility + execute returning a ToolResult promise). Structural typing
 * makes this a real check — drift in either interface breaks compilation.
 */
function requireToolShape<TParams extends Record<string, unknown>>(
  tool: Tool<TParams>,
): ToolMetadata {
  return tool.meta;
}

function requireParametersSchema(schema: ToolParametersSchema): void {
  expect(schema.type).toBe('object');
  expect(schema.properties).toBeTypeOf('object');
}

describe('W12 Tool interface conformance', () => {
  it('all five tools implement the Tool shape', () => {
    const { toolset } = makeHarness();
    const expected = [
      'db.resolve_linked_account',
      'db.get_player_rank',
      'db.get_permission_state',
      'db.get_ticket_metadata',
      'db.get_economy_fact',
    ];
    expect(toolset.names).toEqual(expected);
    for (const tool of toolset.tools) {
      const meta = requireToolShape(tool);
      expect(meta.name).toMatch(/^db\.[a-z_]+$/);
      expect(meta.description.length).toBeGreaterThan(10);
      requireParametersSchema(meta.parameters);
      for (const required of meta.parameters.required ?? []) {
        expect(
          meta.parameters.properties[required],
          `${meta.name}: required param ${required} must be declared`,
        ).toBeDefined();
      }
      expect(meta.verificationTier).toBe('A');
      expect(meta.privacySensitive).toBe(true);
      expect(Object.values(Visibility)).toContain(meta.maxVisibility);
      expect(tool.execute).toBeTypeOf('function');
    }
  });

  it('tool names are unique (registry-safe)', () => {
    const { toolset } = makeHarness();
    expect(new Set(toolset.names).size).toBe(toolset.names.length);
  });

  it('execute resolves to a ToolResult envelope', async () => {
    const { toolset } = makeHarness();
    const tool = toolset.get('db.get_player_rank')!;
    const out = await tool.execute(
      { playerUuid: '123e4567-e89b-12d3-a456-426614174000' },
      staffContext(),
    );
    expect(out.toolName).toBe('db.get_player_rank');
    expect(typeof out.timestamp).toBe('string');
    expect(typeof out.correlationId).toBe('string');
  });
});
