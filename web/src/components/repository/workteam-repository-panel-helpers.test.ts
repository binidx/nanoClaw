import { describe, expect, it } from 'vitest';

import type { ResourceBindingInfo } from '../../app-types';
import {
  buildWorkteamMainRepositoryBindingInput,
  getWorkteamMainRepositoryBinding,
} from './workteam-repository-panel-helpers';

function makeBinding(
  overrides: Partial<ResourceBindingInfo> & {
    id: string;
    resourceId?: string;
  },
): ResourceBindingInfo {
  return {
    id: overrides.id,
    resourceType: overrides.resourceType || 'repository',
    resourceId: overrides.resourceId || 'repo-1',
    ownerType: overrides.ownerType || 'workteam',
    ownerId: overrides.ownerId || 'team-1',
    bindingKey: overrides.bindingKey || 'default',
    branch: overrides.branch ?? null,
    workDirectory: overrides.workDirectory ?? null,
    config: overrides.config || {},
    createdAt: overrides.createdAt || '2026-04-21T00:00:00.000Z',
    repositoryName: overrides.repositoryName,
    repositoryCloneUrl: overrides.repositoryCloneUrl,
  };
}

describe('workteam repository panel helpers', () => {
  it('prefers the sdlc binding as the team main repository', () => {
    const binding = getWorkteamMainRepositoryBinding([
      makeBinding({ id: 'b-default', bindingKey: 'default' }),
      makeBinding({ id: 'b-sdlc', bindingKey: 'sdlc', branch: 'main' }),
    ]);

    expect(binding?.id).toBe('b-sdlc');
  });

  it('creates repository binding input with the sdlc binding key', () => {
    expect(
      buildWorkteamMainRepositoryBindingInput({
        ownerId: 'team-1',
        repositoryId: 'repo-1',
        branch: ' release ',
      }),
    ).toEqual({
      ownerType: 'workteam',
      ownerId: 'team-1',
      repositoryId: 'repo-1',
      bindingKey: 'sdlc',
      branch: 'release',
    });
  });
});
