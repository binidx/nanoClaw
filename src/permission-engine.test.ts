import { describe, it, expect } from 'vitest';
import {
  permissionMatches,
  getEffectivePermissions,
} from './auth/permission-engine.js';

describe('permissionMatches', () => {
  it('exact match', () => {
    expect(permissionMatches(['review.view', 'conversation.send'], 'review.view')).toBe(true);
  });

  it('no match', () => {
    expect(permissionMatches(['review.view'], 'review.create')).toBe(false);
  });

  it('wildcard match: review.* matches review.run.view', () => {
    expect(permissionMatches(['review.*'], 'review.run.view')).toBe(true);
  });

  it('wildcard match: system.* matches system.settings.edit', () => {
    expect(permissionMatches(['system.*'], 'system.settings.edit')).toBe(true);
  });

  it('wildcard does not match unrelated', () => {
    expect(permissionMatches(['review.*'], 'conversation.view')).toBe(false);
  });

  it('empty owned set', () => {
    expect(permissionMatches([], 'review.view')).toBe(false);
  });
});

describe('getEffectivePermissions', () => {
  it('returns role permissions when no overrides', () => {
    const result = getEffectivePermissions({
      rolePermissions: ['a', 'b', 'c'],
      overrides: new Map(),
      fetchedAt: Date.now(),
    });
    expect(result).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(result).toHaveLength(3);
  });

  it('adds allow override', () => {
    const result = getEffectivePermissions({
      rolePermissions: ['a'],
      overrides: new Map([['x', 'allow']]),
      fetchedAt: Date.now(),
    });
    expect(result).toEqual(expect.arrayContaining(['a', 'x']));
  });

  it('removes deny override', () => {
    const result = getEffectivePermissions({
      rolePermissions: ['a', 'b'],
      overrides: new Map([['b', 'deny']]),
      fetchedAt: Date.now(),
    });
    expect(result).toEqual(['a']);
  });

  it('deny takes precedence when both allow and role have it', () => {
    const result = getEffectivePermissions({
      rolePermissions: ['a', 'b'],
      overrides: new Map([['a', 'deny']]),
      fetchedAt: Date.now(),
    });
    expect(result).not.toContain('a');
    expect(result).toContain('b');
  });
});
