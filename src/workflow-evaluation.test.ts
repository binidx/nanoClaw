import { describe, expect, it } from 'vitest';

import { evaluateWorkflowRunGraph } from './workflow/evaluation.js';
import type { WorkflowRunGraph } from './workflow/types.js';

function baseGraph(overrides: Partial<WorkflowRunGraph> = {}): WorkflowRunGraph {
  return {
    run: {
      id: 'run-1',
      workflow_id: 'wf-1',
      status: 'completed',
      input: '',
      output: '',
      created_at: '2026-05-21T00:00:00.000Z',
      started_at: '2026-05-21T00:00:00.000Z',
      completed_at: '2026-05-21T00:00:01.000Z',
    },
    workflow: {
      id: 'wf-1',
      name: 'Workflow',
      description: '',
      user_id: 'user-1',
      status: 'active',
      workflow_config: JSON.stringify({
        evaluationPolicy: { enabled: true },
        artifactPolicy: { exportable: false },
      }),
      created_at: '2026-05-21T00:00:00.000Z',
      updated_at: '2026-05-21T00:00:00.000Z',
    },
    nodes: [],
    edges: [],
    runNodes: [],
    messages: [],
    interventions: [],
    executions: [],
    executionEvents: [],
    dialogueSessions: [],
    messageFrames: [],
    pendingTransfers: [],
    artifacts: [],
    ...overrides,
  };
}

describe('evaluateWorkflowRunGraph', () => {
  it('warns when outputSchema is configured but not enforced', () => {
    const evaluation = evaluateWorkflowRunGraph(
      baseGraph({
        nodes: [
          {
            id: 'node-1',
            workflow_id: 'wf-1',
            node_type: 'task',
            name: 'Review',
            description: '',
            role_node_id: '',
            assistant_id: '',
            config_json: JSON.stringify({
              outputSchema: JSON.stringify({ required: ['verdict'] }),
            }),
            position_x: 0,
            position_y: 0,
            sort_order: 0,
            created_at: '2026-05-21T00:00:00.000Z',
            updated_at: '2026-05-21T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'output_schema_not_enforced' }),
      ]),
    );
  });

  it('reports handoff contract validation errors from transfer payloads', () => {
    const evaluation = evaluateWorkflowRunGraph(
      baseGraph({
        pendingTransfers: [
          {
            id: 'transfer-1',
            run_id: 'run-1',
            edge_id: 'edge-1',
            source_node_id: 'tester',
            target_node_id: 'developer',
            direction: 'one_way',
            message_type: 'node_output',
            status: 'pending',
            content_text: 'bad output',
            payload_json: JSON.stringify({
              verdict: {
                verdict: 'blocked',
                validationErrors: ['Output contract requires an explicit verdict'],
              },
            }),
            delay_ms: 0,
            due_at: '2026-05-21T00:00:00.000Z',
            created_by: '__system__',
            sent_at: '',
            created_at: '2026-05-21T00:00:00.000Z',
            updated_at: '2026-05-21T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(evaluation.status).toBe('fail');
    expect(evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'handoff_contract_validation_error',
          severity: 'error',
        }),
      ]),
    );
  });
});
