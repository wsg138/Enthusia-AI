import { describe, expect, it } from 'vitest';
import { SourceStatus } from '@enthusia/contracts';
import {
  allowedEvents,
  isCurrentStatus,
  isLatestStatus,
  transitionStatus,
} from '../src/lifecycle.js';

describe('transitionStatus', () => {
  it('CURRENT can be superseded, invalidated, marked stale, or conflicted', () => {
    expect(transitionStatus(SourceStatus.CURRENT, 'SUPERSEDE')).toBe(SourceStatus.SUPERSEDED);
    expect(transitionStatus(SourceStatus.CURRENT, 'INVALIDATE')).toBe(SourceStatus.INVALID);
    expect(transitionStatus(SourceStatus.CURRENT, 'MARK_STALE')).toBe(SourceStatus.STALE);
    expect(transitionStatus(SourceStatus.CURRENT, 'REPORT_CONFLICT')).toBe(
      SourceStatus.CONFLICTED,
    );
  });

  it('STALE can be revalidated or invalidated', () => {
    expect(transitionStatus(SourceStatus.STALE, 'REVALIDATE')).toBe(SourceStatus.CURRENT);
    expect(transitionStatus(SourceStatus.STALE, 'INVALIDATE')).toBe(SourceStatus.INVALID);
  });

  it('CONFLICTED can be resolved or invalidated', () => {
    expect(transitionStatus(SourceStatus.CONFLICTED, 'RESOLVE_CONFLICT')).toBe(
      SourceStatus.CURRENT,
    );
    expect(transitionStatus(SourceStatus.CONFLICTED, 'INVALIDATE')).toBe(SourceStatus.INVALID);
  });

  it('SUPERSEDED is historical forever: only INVALIDATE is legal', () => {
    expect(transitionStatus(SourceStatus.SUPERSEDED, 'INVALIDATE')).toBe(SourceStatus.INVALID);
    expect(() => transitionStatus(SourceStatus.SUPERSEDED, 'REVALIDATE')).toThrow(
      /illegal lifecycle transition/,
    );
    expect(() => transitionStatus(SourceStatus.SUPERSEDED, 'RESOLVE_CONFLICT')).toThrow(
      /illegal lifecycle transition/,
    );
  });

  it('INVALID is terminal', () => {
    for (const event of allowedEvents(SourceStatus.INVALID)) {
      expect.unreachable(`INVALID should allow no events, got ${event}`);
    }
    expect(() => transitionStatus(SourceStatus.INVALID, 'REVALIDATE')).toThrow(
      /illegal lifecycle transition/,
    );
  });
});

describe('allowedEvents', () => {
  it('lists the legal events per status', () => {
    expect(allowedEvents(SourceStatus.CURRENT)).toEqual(
      expect.arrayContaining(['SUPERSEDE', 'INVALIDATE', 'MARK_STALE', 'REPORT_CONFLICT']),
    );
    expect(allowedEvents(SourceStatus.CURRENT)).toHaveLength(4);
  });
});

describe('isLatestStatus', () => {
  it('STALE and CONFLICTED heads remain the latest indexed artifact', () => {
    expect(isLatestStatus(SourceStatus.CURRENT)).toBe(true);
    expect(isLatestStatus(SourceStatus.STALE)).toBe(true);
    expect(isLatestStatus(SourceStatus.CONFLICTED)).toBe(true);
    expect(isLatestStatus(SourceStatus.SUPERSEDED)).toBe(false);
    expect(isLatestStatus(SourceStatus.INVALID)).toBe(false);
  });
});

describe('isCurrentStatus', () => {
  it('only CURRENT counts as the current view', () => {
    expect(isCurrentStatus(SourceStatus.CURRENT)).toBe(true);
    expect(isCurrentStatus(SourceStatus.STALE)).toBe(false);
    expect(isCurrentStatus(SourceStatus.SUPERSEDED)).toBe(false);
    expect(isCurrentStatus(SourceStatus.INVALID)).toBe(false);
    expect(isCurrentStatus(SourceStatus.CONFLICTED)).toBe(false);
  });
});
