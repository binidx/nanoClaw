import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tenant-context.js', () => ({
  getCurrentUserId: vi.fn(() => 'test-user'),
  SYSTEM_USER_ID: '__system__',
}));

import { _initTestDatabase } from './db/init.js';
import * as workteamDb from './db/workteam.js';
import * as workflowDb from './db/workflows.js';
import { createBinding, listBindingsByOwner } from './db/resource-bindings.js';
import { bridgeWorkteamToWorkflow } from './workteam/bridge-to-workflow.js';

describe('bridgeWorkteamToWorkflow', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('converts a workteam snapshot into a workflow definition and copies bindings', async () => {
    const team = await workteamDb.createWorkteam({
      name: 'Legacy Team',
      description: 'legacy pipeline',
      process_type: 'dag',
      workflow_config: { legacy: true },
    });
    const agentA = await workteamDb.addWorkteamAgent(team.id, {
      role: 'Architect',
      goal: 'Plan system',
      backstory: 'senior architect',
      assistant_id: 'assistant-a',
      tools_config: { model_preference: 'gpt-5.4' },
      sort_order: 0,
    });
    const agentB = await workteamDb.addWorkteamAgent(team.id, {
      role: 'Builder',
      goal: 'Implement plan',
      assistant_id: 'assistant-b',
      sort_order: 1,
    });
    const taskA = await workteamDb.addWorkteamTask(team.id, {
      agent_id: agentA.id,
      name: 'Plan',
      description: 'Make a plan',
      expected_output: 'plan text',
      sort_order: 0,
    });
    await workteamDb.addWorkteamTask(team.id, {
      agent_id: agentB.id,
      name: 'Build',
      description: 'Build it',
      expected_output: 'code',
      dependencies: [taskA.id],
      sort_order: 1,
    });
    await createBinding(
      {
        resourceType: 'repository',
        resourceId: 'repo-1',
        ownerType: 'workteam',
        ownerId: team.id,
        bindingKey: 'sdlc',
        branch: 'main',
      },
      'test-user',
    );

    const snapshot = await workteamDb.getWorkteamSnapshot(team.id);
    expect(snapshot).toBeTruthy();

    const workflow = await bridgeWorkteamToWorkflow({
      snapshot: snapshot!,
      userId: 'test-user',
    });

    expect(workflow?.workflow).toMatchObject({
      name: 'Legacy Team Workflow',
      description: 'legacy pipeline',
    });
    expect(workflow?.nodes.filter((node) => node.node_type === 'role')).toHaveLength(2);
    expect(workflow?.nodes.filter((node) => node.node_type === 'task')).toHaveLength(2);
    expect(workflow?.edges).toHaveLength(1);

    const copiedBindings = await listBindingsByOwner(
      'workflow',
      workflow!.workflow.id,
    );
    expect(copiedBindings).toEqual([
      expect.objectContaining({
        resource_type: 'repository',
        resource_id: 'repo-1',
        owner_type: 'workflow',
        binding_key: 'sdlc',
      }),
    ]);

    const persisted = await workflowDb.getWorkflowSnapshot(workflow!.workflow.id);
    expect(persisted?.nodes.some((node) => node.name === 'Architect')).toBe(true);
  });
});
