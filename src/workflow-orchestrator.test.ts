import { describe, expect, it } from 'vitest';

import { validateWorkflowGraph } from './workflow/orchestrator.js';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from './workflow/types.js';

function node(overrides: Partial<WorkflowNodeRecord>): WorkflowNodeRecord {
  return {
    id: overrides.id ?? 'node',
    workflow_id: overrides.workflow_id ?? 'wf-1',
    node_type: overrides.node_type ?? 'task',
    name: overrides.name ?? 'Node',
    description: overrides.description ?? '',
    role_node_id: overrides.role_node_id ?? '',
    assistant_id: overrides.assistant_id ?? '',
    config_json: overrides.config_json ?? '{}',
    position_x: overrides.position_x ?? 0,
    position_y: overrides.position_y ?? 0,
    sort_order: overrides.sort_order ?? 0,
    created_at: overrides.created_at ?? '2026-04-28T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-04-28T00:00:00.000Z',
  };
}

function edge(overrides: Partial<WorkflowEdgeRecord>): WorkflowEdgeRecord {
  return {
    id: overrides.id ?? 'edge',
    workflow_id: overrides.workflow_id ?? 'wf-1',
    source_node_id: overrides.source_node_id ?? 'a',
    target_node_id: overrides.target_node_id ?? 'b',
    direction: overrides.direction ?? 'one_way',
    label: overrides.label ?? '',
    config_json: overrides.config_json ?? '{}',
    created_at: overrides.created_at ?? '2026-04-28T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-04-28T00:00:00.000Z',
  };
}

describe('validateWorkflowGraph', () => {
  it('accepts a valid role -> task -> task shape', () => {
    const role = node({ id: 'role-1', node_type: 'role', name: 'Architect' });
    const taskA = node({
      id: 'task-a',
      node_type: 'task',
      name: 'Plan',
      role_node_id: role.id,
    });
    const taskB = node({
      id: 'task-b',
      node_type: 'task',
      name: 'Build',
      role_node_id: role.id,
    });

    expect(() =>
      validateWorkflowGraph(
        [role, taskA, taskB],
        [edge({ source_node_id: taskA.id, target_node_id: taskB.id })],
      ),
    ).not.toThrow();
  });

  it('rejects a task node without a bound role node', () => {
    const task = node({
      id: 'task-a',
      node_type: 'task',
      name: 'Unbound Task',
      role_node_id: '',
    });

    expect(() => validateWorkflowGraph([task], [])).toThrow(
      /missing a bound role node/i,
    );
  });

  it('rejects directed cycles between task nodes', () => {
    const role = node({ id: 'role-1', node_type: 'role' });
    const taskA = node({
      id: 'task-a',
      node_type: 'task',
      name: 'Task A',
      role_node_id: role.id,
    });
    const taskB = node({
      id: 'task-b',
      node_type: 'task',
      name: 'Task B',
      role_node_id: role.id,
    });

    expect(() =>
      validateWorkflowGraph(
        [role, taskA, taskB],
        [
          edge({ id: 'ab', source_node_id: taskA.id, target_node_id: taskB.id }),
          edge({ id: 'ba', source_node_id: taskB.id, target_node_id: taskA.id }),
        ],
      ),
    ).toThrow(/contains a cycle/i);
  });

  it('rejects self-loop edges', () => {
    const role = node({ id: 'role-1', node_type: 'role' });
    const task = node({
      id: 'task-a',
      node_type: 'task',
      role_node_id: role.id,
    });

    expect(() =>
      validateWorkflowGraph(
        [role, task],
        [edge({ source_node_id: task.id, target_node_id: task.id })],
      ),
    ).toThrow(/self-loop/i);
  });

  it('allows two-way edges because discussion loops are runtime-bounded, not DAG-scheduled', () => {
    const role = node({ id: 'role-1', node_type: 'role' });
    const taskA = node({
      id: 'task-a',
      node_type: 'task',
      role_node_id: role.id,
    });
    const taskB = node({
      id: 'task-b',
      node_type: 'task',
      role_node_id: role.id,
    });

    expect(() =>
      validateWorkflowGraph(
        [role, taskA, taskB],
        [
          edge({
            id: 'discussion',
            source_node_id: taskA.id,
            target_node_id: taskB.id,
            direction: 'two_way',
          }),
        ],
      ),
    ).not.toThrow();
  });
});
