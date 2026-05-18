import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runAgentProcessMock,
  resolveAssistantRuntimeConfigMock,
  getAssistantNameMock,
  listOwnerBindingsMock,
  getRepositoryByIdMock,
  prepareProjectGraphContextMock,
} = vi.hoisted(() => ({
  runAgentProcessMock: vi.fn(),
  resolveAssistantRuntimeConfigMock: vi.fn(),
  getAssistantNameMock: vi.fn(),
  listOwnerBindingsMock: vi.fn(),
  getRepositoryByIdMock: vi.fn(),
  prepareProjectGraphContextMock: vi.fn(),
}));

vi.mock('./agent/agent-runner.js', () => ({
  runAgentProcess: runAgentProcessMock,
  requestAgentClose: vi.fn(),
}));

vi.mock('./assistant/assistant-runtime.js', () => ({
  resolveAssistantRuntimeConfig: resolveAssistantRuntimeConfigMock,
}));

vi.mock('./config-store.js', () => ({
  getAssistantName: getAssistantNameMock,
}));

vi.mock('./tenant/resource-binding-service.js', () => ({
  listOwnerBindings: listOwnerBindingsMock,
}));

vi.mock('./db/repositories.js', () => ({
  getRepositoryById: getRepositoryByIdMock,
}));

vi.mock('./code-intelligence/project-graph-context.js', () => ({
  buildWorkflowProjectGraphQuestion: vi.fn(() => 'workflow graph question'),
  prepareProjectGraphContext: prepareProjectGraphContextMock,
}));

vi.mock('./tenant/tenant-context.js', () => ({
  getCurrentUserId: vi.fn(() => 'test-user'),
  SYSTEM_USER_ID: '__system__',
}));

import { _initTestDatabase } from './db/init.js';
import * as workflowDb from './db/workflows.js';
import { executeWorkflowTask } from './workflow/agent-adapter.js';
import type { WorkflowNodeRecord } from './workflow/types.js';

function roleNode(): WorkflowNodeRecord {
  return {
    id: 'role-1',
    workflow_id: 'wf-1',
    node_type: 'role',
    name: 'Builder',
    description: 'Build things',
    role_node_id: '',
    assistant_id: 'assistant-role',
    config_json: JSON.stringify({
      goal: 'Ship implementation',
      backstory: 'Reliable implementer',
    }),
    position_x: 0,
    position_y: 0,
    sort_order: 0,
    created_at: '2026-04-30T00:00:00.000Z',
    updated_at: '2026-04-30T00:00:00.000Z',
  };
}

function taskNode(): WorkflowNodeRecord {
  return {
    id: 'task-1',
    workflow_id: 'wf-1',
    node_type: 'task',
    name: 'Implement',
    description: 'Implement feature',
    role_node_id: 'role-1',
    assistant_id: '',
    config_json: JSON.stringify({
      prompt: 'Implement the feature',
      providerOverrideId: 'provider-node',
      modelOverride: 'gpt-node',
      instructionsAppend: 'Node-specific instruction',
      allowedDirectories: ['/repo/main', '/repo/tests'],
    }),
    position_x: 0,
    position_y: 0,
    sort_order: 0,
    created_at: '2026-04-30T00:00:00.000Z',
    updated_at: '2026-04-30T00:00:00.000Z',
  };
}

function taskNodeWithAssistant(): WorkflowNodeRecord {
  return {
    ...taskNode(),
    assistant_id: 'assistant-task',
    config_json: JSON.stringify({
      prompt: 'Implement the feature',
    }),
  };
}

describe('workflow agent adapter', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
    resolveAssistantRuntimeConfigMock.mockResolvedValue({
      managedSkillIds: undefined,
      managedMcpServerIds: undefined,
      userSkillIds: undefined,
      userMcpServerIds: undefined,
      managedKbIds: undefined,
      resolvedMcpServers: undefined,
      projectRootOverride: '/assistant/root',
      repoBindingDirectories: ['/assistant/root', '/assistant/extra'],
      providerOverrideId: 'provider-assistant',
      modelOverride: 'gpt-assistant',
      soulSystemPrompt: undefined,
      instructionsAppend: 'Assistant instruction',
      instructionsMode: 'append',
    });
    getAssistantNameMock.mockResolvedValue('NanoClaw');
    listOwnerBindingsMock.mockResolvedValue([]);
    getRepositoryByIdMock.mockResolvedValue(null);
    prepareProjectGraphContextMock.mockResolvedValue({
      status: 'missing',
      repositoryId: '',
      branch: '',
      intent: 'workflow',
      question: '',
      focusPaths: [],
      relationFilter: [],
      communities: [],
      nodeCount: 0,
      edgeCount: 0,
      tokenBudget: 0,
      startNodes: [],
      topFiles: [],
      topFunctions: [],
      topChunks: [],
      edges: [],
      contextText: '',
      message: 'graph_unavailable',
    });
    runAgentProcessMock.mockImplementation(async (_group, input) => ({
      status: 'success',
      result: JSON.stringify(input),
      newSessionId: 'session-node',
    }));
  });

  it('applies node-level provider/model/instructions/directories ahead of assistant defaults', async () => {
    const result = await executeWorkflowTask({
      workflowId: 'wf-1',
      runId: 'run-1',
      roleNode: roleNode(),
      taskNode: taskNode(),
      runInput: 'Run input',
      upstreamMessages: [],
    });

    expect(result.success).toBe(true);
    expect(runAgentProcessMock).toHaveBeenCalledTimes(1);
    const [, input] = runAgentProcessMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      providerOverrideId: 'provider-node',
      modelOverride: 'gpt-node',
      projectRootOverride: '/repo/main',
      allowedDirectoriesOverride: ['/repo/main', '/repo/tests'],
      workspaceExtraDirectories: ['/repo/tests'],
      instructionsAppend: expect.stringContaining('Node-specific instruction'),
    });
    expect(String(input.instructionsAppend)).toContain('Assistant instruction');

    const executions = await workflowDb.listWorkflowNodeExecutions('run-1');
    expect(executions[0]).toMatchObject({
      node_id: 'task-1',
      session_id: 'session-node',
    });
  });

  it('injects project graph context when the workflow is bound to a repository', async () => {
    listOwnerBindingsMock.mockResolvedValue([
      {
        resourceType: 'repository',
        resourceId: 'repo-1',
        bindingKey: 'main',
        branch: 'feature/refactor',
      },
    ]);
    getRepositoryByIdMock.mockResolvedValue({
      id: 'repo-1',
      default_target_branch: 'main',
    });
    prepareProjectGraphContextMock.mockResolvedValue({
      status: 'ready',
      repositoryId: 'repo-1',
      branch: 'feature/refactor',
      intent: 'workflow',
      question: 'workflow graph question',
      focusPaths: [],
      relationFilter: ['calls'],
      communities: ['src'],
      nodeCount: 4,
      edgeCount: 3,
      tokenBudget: 1800,
      startNodes: [],
      topFiles: [],
      topFunctions: [],
      topChunks: [],
      edges: [],
      contextText: 'Project Graph Retrieval:\nstatus: ready\nquestion: workflow graph question',
    });

    const result = await executeWorkflowTask({
      workflowId: 'wf-1',
      workflowName: 'Repo Workflow',
      runId: 'run-1',
      roleNode: roleNode(),
      taskNode: taskNode(),
      runInput: 'Run input',
      upstreamMessages: [],
      repositoryBindingKey: 'main',
    });

    expect(result.success).toBe(true);
    expect(listOwnerBindingsMock).toHaveBeenCalledWith(
      'workflow',
      'wf-1',
      'test-user',
    );
    expect(prepareProjectGraphContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo-1',
        branch: 'feature/refactor',
        intent: 'workflow',
      }),
    );
    const [, input] = runAgentProcessMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String((input.prompt as { text: string }).text)).toContain(
      '## Project Graph Context',
    );
    expect(String((input.prompt as { text: string }).text)).toContain(
      'Project Graph Retrieval:',
    );
  });

  it('uses a worker assistant binding ahead of the role assistant', async () => {
    const result = await executeWorkflowTask({
      workflowId: 'wf-1',
      runId: 'run-1',
      roleNode: roleNode(),
      taskNode: taskNodeWithAssistant(),
      runInput: 'Run input',
      upstreamMessages: [],
    });

    expect(result.success).toBe(true);
    expect(resolveAssistantRuntimeConfigMock).toHaveBeenCalledTimes(1);
    const [group] = resolveAssistantRuntimeConfigMock.mock.calls[0] as [
      { assistantId?: string | null },
    ];
    expect(group.assistantId).toBe('assistant-task');
  });

  it('restricts injected tools and provider/model when workflow tool policy is restricted', async () => {
    resolveAssistantRuntimeConfigMock.mockResolvedValue({
      managedSkillIds: ['assistant-skill'],
      managedMcpServerIds: ['assistant-mcp'],
      userSkillIds: ['assistant-user-skill'],
      userMcpServerIds: ['assistant-user-mcp'],
      managedKbIds: ['assistant-kb'],
      resolvedMcpServers: [
        {
          id: 'allowed-mcp',
          templateServerId: 'allowed-template',
          name: 'Allowed',
          command: 'node',
          args: [],
          env: {},
          bindingId: 'binding-1',
          source: 'assistant_binding',
        },
        {
          id: 'blocked-mcp',
          templateServerId: 'blocked-template',
          name: 'Blocked',
          command: 'node',
          args: [],
          env: {},
          bindingId: 'binding-2',
          source: 'assistant_binding',
        },
      ],
      projectRootOverride: '/assistant/root',
      repoBindingDirectories: ['/assistant/root'],
      providerOverrideId: 'provider-assistant',
      modelOverride: 'gpt-assistant',
      instructionsAppend: 'Assistant instruction',
      instructionsMode: 'append',
    });

    const result = await executeWorkflowTask({
      workflowId: 'wf-1',
      runId: 'run-1',
      roleNode: roleNode(),
      taskNode: taskNode(),
      runInput: 'Run input',
      upstreamMessages: [],
      toolPolicy: {
        mode: 'restricted',
        managedSkillIds: ['allowed-skill'],
        managedMcpServerIds: ['allowed-mcp'],
        userSkillIds: ['allowed-user-skill'],
        userMcpServerIds: ['allowed-user-mcp'],
        managedKbIds: ['allowed-kb'],
        providerOverrideId: 'provider-allowed',
        modelOverride: 'gpt-allowed',
      },
    });

    expect(result.success).toBe(true);
    const [, input] = runAgentProcessMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      managedSkillIds: ['allowed-skill'],
      managedMcpServerIds: ['allowed-mcp'],
      userSkillIds: ['allowed-user-skill'],
      userMcpServerIds: ['allowed-user-mcp'],
      managedKbIds: ['allowed-kb'],
      providerOverrideId: 'provider-allowed',
      modelOverride: 'gpt-allowed',
    });
    expect(input.resolvedManagedMcpServers).toEqual([
      expect.objectContaining({ id: 'allowed-mcp' }),
    ]);
  });
});
