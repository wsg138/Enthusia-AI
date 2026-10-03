import { describe, expect, it } from 'vitest';
import { SourceType, Visibility } from '@enthusia/contracts';
import {
  assignVisibility,
  defaultVisibilityForSourceType,
  DEFAULT_VISIBILITY_BY_SOURCE_TYPE,
} from '../src/visibility.js';
import { SecretDenyRejectedError } from '../src/errors.js';

describe('defaultVisibilityForSourceType', () => {
  it('covers every source type', () => {
    for (const type of Object.values(SourceType)) {
      expect(DEFAULT_VISIBILITY_BY_SOURCE_TYPE[type]).toBeDefined();
    }
  });

  it('is conservative: live player data defaults to MANAGEMENT, tickets to PLAYER_SELF', () => {
    expect(defaultVisibilityForSourceType(SourceType.DATABASE_LIVE)).toBe(Visibility.MANAGEMENT);
    expect(defaultVisibilityForSourceType(SourceType.TICKET)).toBe(Visibility.PLAYER_SELF);
  });

  it('never defaults to PUBLIC or SECRET_DENY', () => {
    for (const type of Object.values(SourceType)) {
      const v = defaultVisibilityForSourceType(type);
      expect(v).not.toBe(Visibility.PUBLIC);
      expect(v).not.toBe(Visibility.SECRET_DENY);
    }
  });
});

describe('assignVisibility', () => {
  it('an explicit visibility always wins over the default', () => {
    expect(
      assignVisibility({ sourceType: SourceType.DOCUMENT, explicit: Visibility.PUBLIC }),
    ).toBe(Visibility.PUBLIC);
  });

  it('useDefault opts in to the conservative default', () => {
    expect(assignVisibility({ sourceType: SourceType.GITHUB, useDefault: true })).toBe(
      Visibility.STAFF,
    );
  });

  it('requires either an explicit visibility or an explicit default opt-in', () => {
    expect(() => assignVisibility({ sourceType: SourceType.GITHUB })).toThrow(
      /requires an explicit visibility/,
    );
  });

  it('rejects SECRET_DENY outright (§17.6: never indexed)', () => {
    expect(() =>
      assignVisibility({ sourceType: SourceType.CONFIG, explicit: Visibility.SECRET_DENY }),
    ).toThrow(SecretDenyRejectedError);
  });
});
