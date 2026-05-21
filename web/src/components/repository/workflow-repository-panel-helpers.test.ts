import { describe, expect, it } from 'vitest';

import type { ResourceBindingInfo } from '../../app-types';
import {
  buildWorkflowMainRepositoryBindingInput,
  getWorkflowMainRepositoryBinding,
} from './workflow-repository-panel-helpers';

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
    ownerType: overrides.ownerType || 'workflow',
    ownerId: overrides.ownerId || 'workflow-1',
    bindingKey: overrides.bindingKey || 'default',
    branch: overrides.branch ?? null,
    workDirectory: overrides.workDirectory ?? null,
    config: overrides.config || {},
    createdAt: overrides.createdAt || '2026-04-21T00:00:00.000Z',
    repositoryName: overrides.repositoryName,
    repositoryCloneUrl: overrides.repositoryCloneUrl,
  };
}

describe('workflow repository panel helpers', () => {
  it('prefers the sdlc binding as the workflow main repository', () => {
    const binding = getWorkflowMainRepositoryBinding([
      makeBinding({ id: 'b-default', bindingKey: 'default' }),
      makeBinding({ id: 'b-sdlc', bindingKey: 'sdlc', branch: 'main' }),
    ]);

    expect(binding?.id).toBe('b-sdlc');
  });

  it('creates repository binding input with the sdlc binding key', () => {
    expect(
      buildWorkflowMainRepositoryBindingInput({
        ownerId: 'workflow-1',
        repositoryId: 'repo-1',
        branch: ' release ',
      }),
    ).toEqual({
      ownerType: 'workflow',
      ownerId: 'workflow-1',
      repositoryId: 'repo-1',
      bindingKey: 'sdlc',
      branch: 'release',
    });
  });
});
