/**
 * @enthusia/integration-databases — visibility enforcement tests (W10).
 *
 * Spec: MASTER-SPECIFICATION.md §17. PLAYER_SELF facts are disclosable only
 * to the subject player or authorized staff, and only under a sufficient
 * visibility ceiling. Ticket subjects are filtered per row.
 */
import { describe, expect, it } from 'vitest';
import { Visibility } from '@enthusia/contracts';
import {
  makeHarness,
  selfContext,
  staffContext,
  strangerContext,
  SAMPLE_UUID,
  SAMPLE_DISCORD_ID,
} from './helpers.js';
import type { TicketMetadataResult } from '../src/tools.js';

describe('PLAYER_SELF visibility', () => {
  it('denies a stranger the sample player rank', async () => {
    const { toolset, mock } = makeHarness();
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, strangerContext());
    expect(out.error).toMatchObject({
      code: 'VISIBILITY_DENIED',
      retryable: false,
    });
    expect(out.result).toBeUndefined();
    // The query ran (the tool cannot know the subject before querying), but
    // the payload was withheld.
    expect(mock.calls).toHaveLength(1);
  });

  it('allows staff to read a player rank', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.get_player_rank')!
      .execute({ playerUuid: SAMPLE_UUID }, staffContext());
    expect(out.error).toBeUndefined();
    expect(out.visibility).toBe(Visibility.PLAYER_SELF);
  });

  it('denies PLAYER_SELF data under a PUBLIC ceiling even to staff', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.get_economy_fact')!
      .execute(
        { playerUuid: SAMPLE_UUID, factType: 'balance' },
        staffContext('trace-public', Visibility.PUBLIC),
      );
    expect(out.error).toMatchObject({ code: 'VISIBILITY_DENIED' });
    expect(out.result).toBeUndefined();
  });

  it('denies linked-account resolution to a stranger', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.resolve_linked_account')!
      .execute({ discordId: SAMPLE_DISCORD_ID }, strangerContext());
    expect(out.error).toMatchObject({ code: 'VISIBILITY_DENIED' });
    expect(out.result).toBeUndefined();
  });

  it('allows the Discord owner to resolve their own link', async () => {
    const { toolset } = makeHarness();
    const out = await toolset
      .get('db.resolve_linked_account')!
      .execute({ discordId: SAMPLE_DISCORD_ID }, selfContext());
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ found: true });
  });
});

describe('ticket subject filtering', () => {
  it('redacts the subject for a non-requester, non-staff actor', async () => {
    const { toolset } = makeHarness();
    // Stranger with a STAFF ceiling still cannot see someone else's ticket.
    const out = await toolset
      .get('db.get_ticket_metadata')!
      .execute(
        { ticketId: 'T-1001' },
        strangerContext('trace-s', Visibility.STAFF),
      );
    expect(out.error).toMatchObject({ code: 'VISIBILITY_DENIED' });
    expect(out.result).toBeUndefined();
  });

  it('shows the subject to staff when the row allows STAFF', async () => {
    const { toolset } = makeHarness({
      ticketMetadata: {
        rows: [
          {
            ticket_id: 'T-2002',
            status: 'open',
            subject: 'Staff-only subject',
            subject_visibility: Visibility.STAFF,
            requester_id: 'someone-else',
            requester_uuid: null,
            created_at: '2026-03-01T10:00:00.000Z',
            updated_at: '2026-03-02T11:00:00.000Z',
          },
        ],
      },
    });
    const out = await toolset
      .get('db.get_ticket_metadata')!
      .execute({ ticketId: 'T-2002' }, staffContext());
    expect(out.error).toBeUndefined();
    expect(out.result as TicketMetadataResult).toMatchObject({
      subject: 'Staff-only subject',
      subjectRedacted: false,
    });
    expect(out.visibility).toBe(Visibility.STAFF);
  });

  it('redacts a STAFF subject for the requester under a PLAYER_SELF ceiling', async () => {
    const { toolset } = makeHarness({
      ticketMetadata: {
        rows: [
          {
            ticket_id: 'T-3003',
            status: 'pending',
            subject: 'Internal triage notes',
            subject_visibility: Visibility.STAFF,
            requester_id: SAMPLE_DISCORD_ID,
            requester_uuid: SAMPLE_UUID,
            created_at: '2026-03-01T10:00:00.000Z',
            updated_at: '2026-03-02T11:00:00.000Z',
          },
        ],
      },
    });
    const out = await toolset
      .get('db.get_ticket_metadata')!
      .execute({ ticketId: 'T-3003' }, selfContext());
    expect(out.error).toBeUndefined();
    const result = out.result as TicketMetadataResult;
    expect(result.subject).toBeNull();
    expect(result.subjectRedacted).toBe(true);
    // Status is still visible to the requester.
    expect(result.status).toBe('pending');
    expect(out.visibility).toBe(Visibility.PLAYER_SELF);
  });
});
