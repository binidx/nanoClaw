import crypto from 'crypto';

import { getAssistantName } from '../config-store.js';
import { runAgentProcess, requestAgentClose, type AgentRunOutput } from '../agent/agent-runner.js';
import { resolveAssistantRuntimeConfig } from '../assistant/assistant-runtime.js';
import { getVisibleProvidersForUser } from '../db.js';
import { getRepositoryById } from '../db/repositories.js';
import * as workflowDb from '../db/workflows.js';
import {
  buildWorkflowProjectGraphQuestion,
  prepareProjectGraphContext,
  type ProjectGraphRetrievalProfile,
} from '../code-intelligence/project-graph-context.js';
import { listOwnerBindings } from '../tenant/resource-binding-service.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import type { RegisteredGroup } from '../types.js';
import {
  clearProfileForChat,
  setProfileForChat,
} from './runner-profile-registry.js';
import { resolveRunnerProfile } from './runner-profiles.js';
import type {
  WorkflowNodeRecord,
  RoleNodeConfig,
  TaskNodeConfig,
  WorkflowToolPolicy,
} from './types.js';

export const AGENT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_TASK_TIMEOUT_MS = 600_000;

function workflowTaskRuntimeJid(
  runId: string,
  taskNodeId: string,
): string {
  return `workflow-runtime:${runId}:${taskNodeId}`;
}

function workflowTaskGroupFolder(
  workflowId: string,
  roleNodeId: string,
  taskNodeId: string,
): string {
  const digest = crypto
    .createHash('sha1')
    .update(`${workflowId}:${roleNodeId}:${taskNodeId}`)
    .digest('hex')
    .slice(0, 20);
  return `wf_${digest}`;
}

function fallbackRoleNode(taskNode: WorkflowNodeRecord): WorkflowNodeRecord {
  return {
    ...taskNode,
    id: taskNode.role_node_id || `workflow-runtime-role:${taskNode.workflow_id}`,
    node_type: 'role',
    name: 'Workflow Runtime',
    description: 'Implicit workflow runtime role',
    role_node_id: '',
    config_json: JSON.stringify({
      goal: 'Execute the workflow node reliably.',
      backstory: '',
    }),
  };
}

function buildWorkflowRegisteredGroup(input: {
  workflowId: string;
  roleNode?: WorkflowNodeRecord;
  taskNode: WorkflowNodeRecord;
}): RegisteredGroup {
  const roleNode = input.roleNode ?? fallbackRoleNode(input.taskNode);
  const folder = workflowTaskGroupFolder(
    input.workflowId,
    roleNode.id,
    input.taskNode.id,
  );
  return {
    name: `Workflow ${roleNode.name} - ${input.taskNode.name}`,
    folder,
    trigger: '@workflow',
    added_at: new Date().toISOString(),
    assistantId:
      input.taskNode.assistant_id?.trim() ||
      parseTaskConfig(input.taskNode).assistantId?.trim() ||
      roleNode.assistant_id?.trim() ||
      null,
    requiresTrigger: false,
    isMain: false,
  };
}

function parseRoleConfig(node: WorkflowNodeRecord): RoleNodeConfig {
  try {
    return JSON.parse(node.config_json || '{}') as RoleNodeConfig;
  } catch {
    return {};
  }
}

function parseTaskConfig(node: WorkflowNodeRecord): TaskNodeConfig {
  try {
    return JSON.parse(node.config_json || '{}') as TaskNodeConfig;
  } catch {
    return {};
  }
}

function normalizeTaskAllowedDirectories(
  value: TaskNodeConfig['allowedDirectories'],
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkflowProjectGraphFocusPaths(
  value: TaskNodeConfig['projectGraph'],
): string[] {
  if (!value?.focusPaths || !Array.isArray(value.focusPaths)) return [];
  return value.focusPaths
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry.length > 0);
}

function normalizeWorkflowProjectGraphQueryOptions(
  value: TaskNodeConfig['projectGraph'],
): {
  relationFilter?: Array<'contains' | 'imports' | 'calls' | 'references'>;
  depth?: number;
  tokenBudget?: number;
  maxNodes?: number;
  maxSeeds?: number;
} {
  const normalized: {
    relationFilter?: Array<'contains' | 'imports' | 'calls' | 'references'>;
    depth?: number;
    tokenBudget?: number;
    maxNodes?: number;
    maxSeeds?: number;
  } = {};
  if (Array.isArray(value?.relationFilter) && value.relationFilter.length > 0) {
    normalized.relationFilter = value.relationFilter;
  }
  if (typeof value?.depth === 'number' && Number.isFinite(value.depth)) {
    normalized.depth = value.depth;
  }
  if (
    typeof value?.tokenBudget === 'number' &&
    Number.isFinite(value.tokenBudget)
  ) {
    normalized.tokenBudget = value.tokenBudget;
  }
  if (typeof value?.maxNodes === 'number' && Number.isFinite(value.maxNodes)) {
    normalized.maxNodes = value.maxNodes;
  }
  if (typeof value?.maxSeeds === 'number' && Number.isFinite(value.maxSeeds)) {
    normalized.maxSeeds = value.maxSeeds;
  }
  return normalized;
}

function inferWorkflowProjectGraphProfile(input: {
  taskNode: WorkflowNodeRecord;
  roleNode?: WorkflowNodeRecord;
  taskConfig: TaskNodeConfig;
  runInput: string;
  upstreamMessages: Array<{
    from: string;
    to: string;
    direction: string;
    content: string;
  }>;
}): ProjectGraphRetrievalProfile {
  const configured = input.taskConfig.projectGraph?.profile;
  if (configured) return configured;
  const text = [
    input.roleNode?.name || '',
    input.taskNode.name,
    input.taskNode.description,
    input.taskConfig.goal || '',
    input.taskConfig.prompt || '',
    input.taskConfig.expectedOutput || '',
    input.runInput,
    ...input.upstreamMessages.slice(-3).map((message) => message.content),
  ]
    .join(' ')
    .toLowerCase();
  if (/(test|spec|regression|verify|qa|验证|测试)/.test(text)) {
    return 'tests';
  }
  if (/(config|env|setting|flag|deploy|release|鉴权|权限|配置)/.test(text)) {
    return 'config';
  }
  if (/(impact|dependency|blast radius|影响|依赖|回归范围)/.test(text)) {
    return 'impact';
  }
  if (/(workflow|pipeline|orchestrator|agent|编排|工作流)/.test(text)) {
    return 'workflow';
  }
  if (/(where|implement|location|入口|实现|在哪|功能)/.test(text)) {
    return 'implementation';
  }
  return 'workflow';
}

function effectiveToolPolicy(
  workflowPolicy: WorkflowToolPolicy | undefined,
  taskPolicy: WorkflowToolPolicy | undefined,
): WorkflowToolPolicy {
  return taskPolicy ?? workflowPolicy ?? { mode: 'assistant_default' };
}

async function assertVisibleProvider(providerId: string | undefined): Promise<void> {
  if (!providerId) return;
  const visibleProviders = await getVisibleProvidersForUser(getCurrentUserId(), 'llm');
  if (!visibleProviders.some((provider) => provider.id === providerId)) {
    throw new Error('Workflow node references a provider the current user cannot access');
  }
}

async function buildWorkflowTaskProjectContext(input: {
  workflowId: string;
  workflowName?: string;
  repositoryBindingKey?: string;
  roleNode?: WorkflowNodeRecord;
  taskNode: WorkflowNodeRecord;
  runInput: string;
  upstreamMessages: Array<{
    from: string;
    to: string;
    direction: string;
    content: string;
  }>;
}): Promise<string> {
  const bindings = await listOwnerBindings(
    'workflow',
    input.workflowId,
    getCurrentUserId(),
  );
  const binding = bindings.find(
    (item) =>
      item.resourceType === 'repository' &&
      (!input.repositoryBindingKey ||
        item.bindingKey === input.repositoryBindingKey),
  );
  if (!binding) return '';
  const repository = await getRepositoryById(binding.resourceId, getCurrentUserId());
  if (!repository) return '';
  const taskCfg = parseTaskConfig(input.taskNode);
  if (taskCfg.projectGraph?.enabled === false) return '';
  const focusPaths = normalizeWorkflowProjectGraphFocusPaths(taskCfg.projectGraph);
  const graphQueryOptions = normalizeWorkflowProjectGraphQueryOptions(
    taskCfg.projectGraph,
  );
  const retrievalProfile = inferWorkflowProjectGraphProfile({
    taskNode: input.taskNode,
    roleNode: input.roleNode,
    taskConfig: taskCfg,
    runInput: input.runInput,
    upstreamMessages: input.upstreamMessages,
  });
  const question = buildWorkflowProjectGraphQuestion({
    workflowName: input.workflowName,
    roleName: input.roleNode?.name,
    taskName: input.taskNode.name,
    taskDescription: input.taskNode.description,
    taskPrompt: taskCfg.prompt,
    runInput: input.runInput,
    retrievalProfile,
    focusPaths,
    upstreamMessages: input.upstreamMessages,
  });
  const context = await prepareProjectGraphContext({
    repositoryId: binding.resourceId,
    branch: binding.branch || repository.default_target_branch || 'main',
    intent: 'workflow',
    question,
    profile: retrievalProfile,
    focusPaths,
    queryOptions: graphQueryOptions,
    persist: {
      source: 'workflow',
      kind: 'prepared_context',
      metadata: {
        workflowId: input.workflowId,
        workflowName: input.workflowName || '',
        taskNodeId: input.taskNode.id,
        taskNodeName: input.taskNode.name,
        retrievalProfile,
        focusPaths,
      },
    },
  });
  return context.contextText;
}

async function resolveWorkflowRepositoryRuntime(input: {
  workflowId: string;
  repositoryBindingKey?: string;
}): Promise<{
  repositoryId: string;
  worktreePath?: string;
  allowedDirectories?: string[];
} | null> {
  const bindings = await listOwnerBindings(
    'workflow',
    input.workflowId,
    getCurrentUserId(),
  );
  const binding = bindings.find(
    (item) =>
      item.resourceType === 'repository' &&
      (!input.repositoryBindingKey ||
        item.bindingKey === input.repositoryBindingKey),
  );
  if (!binding) return null;
  const repository = await getRepositoryById(binding.resourceId, getCurrentUserId());
  if (!repository) return null;
  const bindingConfig =
    binding.config && typeof binding.config === 'object' ? binding.config : {};
  const configuredWorktree =
    typeof bindingConfig.worktree_path === 'string'
      ? bindingConfig.worktree_path.trim()
      : '';
  const worktreePath =
    binding.workDirectory?.trim() ||
    configuredWorktree ||
    repository.local_repo_path?.trim() ||
    undefined;
  return {
    repositoryId: binding.resourceId,
    worktreePath,
    allowedDirectories: worktreePath ? [worktreePath] : undefined,
  };
}

function restrictResolvedMcpServers(
  servers: Awaited<ReturnType<typeof resolveAssistantRuntimeConfig>>['resolvedMcpServers'],
  allowedIds: string[] | undefined,
) {
  if (!Array.isArray(servers) || !allowedIds) return undefined;
  const allowed = new Set(allowedIds);
  return servers.filter(
    (server) => allowed.has(server.id) || allowed.has(server.templateServerId),
  );
}

export interface WorkflowAgentExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  execution_ms?: number;
  poll_count?: number;
}

export function buildTaskPrompt(
  roleNode: WorkflowNodeRecord | undefined,
  taskNode: WorkflowNodeRecord,
  runInput: string,
  upstreamMessages: Array<{
    from: string;
    to: string;
    direction: string;
    content: string;
  }>,
  projectContextBlock = '',
): string {
  const resolvedRoleNode = roleNode ?? fallbackRoleNode(taskNode);
  const roleCfg = parseRoleConfig(resolvedRoleNode);
  const taskCfg = parseTaskConfig(taskNode);
  const ctx = upstreamMessages
    .map(
      (message) =>
        `From ${message.from} -> ${message.to} [${message.direction}]\n${message.content}`,
    )
    .join('\n\n');
  return `## Workflow Role
${resolvedRoleNode.name}

## Goal
${taskCfg.objective || taskCfg.goal || roleCfg.goal || resolvedRoleNode.description || 'Complete the assigned workflow responsibilities.'}

## Backstory
${roleCfg.backstory || ''}

## Task Node
${taskNode.name}

## Task Description
${taskNode.description}

## Acceptance Criteria
${taskCfg.acceptanceCriteria || taskCfg.expectedOutput || ''}

## Expected Output
${taskCfg.expectedOutput || ''}

## Output Schema
${taskCfg.outputSchema || 'Free-form text unless the node contract asks for JSON. Review/test nodes should return JSON with verdict: "pass" | "fail" | "blocked", reason, suggestedFix, and rollbackNodeId when routing depends on the result.'}

## Output Contract
${
  taskCfg.outputContract?.verdictRequired || taskCfg.outputContract?.strictJson
    ? `Return a JSON object. ${taskCfg.outputContract.verdictRequired ? 'Include verdict: "pass" | "fail" | "blocked".' : ''} ${taskCfg.outputContract.strictJson ? 'Do not wrap the final answer in prose outside the JSON object.' : ''}`
    : 'When downstream routing depends on this node, include verdict: "pass" | "fail" | "blocked" in the final JSON object.'
}

## Handoff Contract
${taskCfg.handoffContract || 'Make downstream handoff content actionable and concise.'}

## Run Input
${runInput}

## Upstream Messages
${ctx || 'No upstream messages yet.'}

## Project Graph Context
${projectContextBlock || 'No repository graph context available.'}

## Task Prompt
${taskCfg.prompt || 'Complete the task and return a concise but actionable result.'}

If this node is part of a two-way discussion loop, read the latest upstream messages carefully and respond to the newest feedback directly instead of repeating your previous answer.`;
}

export async function executeWorkflowTask(input: {
  workflowId: string;
  workflowName?: string;
  runId: string;
  roleNode?: WorkflowNodeRecord;
  taskNode: WorkflowNodeRecord;
  runInput: string;
  upstreamMessages: Array<{
    from: string;
    to: string;
    direction: string;
    content: string;
  }>;
  toolPolicy?: WorkflowToolPolicy;
  repositoryBindingKey?: string;
  signal?: AbortSignal;
}): Promise<WorkflowAgentExecutionResult> {
  const {
    workflowId,
    workflowName,
    runId,
    roleNode,
    taskNode,
    runInput,
    upstreamMessages,
    toolPolicy: workflowToolPolicy,
    repositoryBindingKey,
    signal,
  } =
    input;
  const runtimeJid = workflowTaskRuntimeJid(runId, taskNode.id);
  const group = buildWorkflowRegisteredGroup({ workflowId, roleNode, taskNode });
  const taskCfg = parseTaskConfig(taskNode);

  let executionId = '';
  try {
    const projectContextBlock = await buildWorkflowTaskProjectContext({
      workflowId,
      workflowName,
      repositoryBindingKey,
      roleNode,
      taskNode,
      runInput,
      upstreamMessages,
    });
    const prompt = buildTaskPrompt(
      roleNode,
      taskNode,
      runInput,
      upstreamMessages,
      projectContextBlock,
    );
    const latestExecution = await workflowDb.getLatestWorkflowNodeExecution(
      runId,
      taskNode.id,
    );
    const execution = await workflowDb.createWorkflowNodeExecution({
      run_id: runId,
      node_id: taskNode.id,
      runtime_namespace: crypto.randomUUID(),
      group_folder: group.folder,
      prompt_text: prompt,
      session_id: latestExecution?.session_id || '',
    });
    executionId = execution.id;

    const assistantRuntime = await resolveAssistantRuntimeConfig(group, {}, {});
    const workflowRepositoryRuntime = await resolveWorkflowRepositoryRuntime({
      workflowId,
      repositoryBindingKey,
    });
    const runnerProfile = await resolveRunnerProfile(
      workflowRepositoryRuntime?.repositoryId,
      { worktreePath: workflowRepositoryRuntime?.worktreePath },
    );
    const taskProviderOverrideId = taskCfg.providerOverrideId?.trim() || undefined;
    const taskModelOverride = taskCfg.modelOverride?.trim() || undefined;
    const taskInstructionsAppend = taskCfg.instructionsAppend?.trim() || undefined;
    const taskAllowedDirectories = normalizeTaskAllowedDirectories(
      taskCfg.allowedDirectories,
    );
    const effectiveAllowedDirectories =
      taskAllowedDirectories ||
      workflowRepositoryRuntime?.allowedDirectories ||
      assistantRuntime.repoBindingDirectories;
    const toolPolicy = effectiveToolPolicy(workflowToolPolicy, taskCfg.toolPolicy);
    const restricted = toolPolicy.mode === 'restricted';
    const managedSkillIds = restricted ? toolPolicy.managedSkillIds : assistantRuntime.managedSkillIds;
    const userSkillIds = restricted ? toolPolicy.userSkillIds : assistantRuntime.userSkillIds;
    const managedMcpServerIds = restricted
      ? toolPolicy.managedMcpServerIds
      : assistantRuntime.managedMcpServerIds;
    const userMcpServerIds = restricted
      ? toolPolicy.userMcpServerIds
      : assistantRuntime.userMcpServerIds;
    const managedKbIds = restricted ? toolPolicy.managedKbIds : assistantRuntime.managedKbIds;
    const resolvedManagedMcpServers = restricted
      ? restrictResolvedMcpServers(assistantRuntime.resolvedMcpServers, managedMcpServerIds)
      : assistantRuntime.resolvedMcpServers;
    const providerOverrideId = restricted
      ? toolPolicy.providerOverrideId
      : taskProviderOverrideId || assistantRuntime.providerOverrideId;
    const modelOverride = restricted
      ? toolPolicy.modelOverride
      : taskModelOverride || assistantRuntime.modelOverride;
    await assertVisibleProvider(providerOverrideId);
    const startMs = Date.now();
    let pollCount = 0;
    let latestResult = '';
    let latestError = '';
    let latestSessionId = execution.session_id || undefined;

    const onAbort = () => {
      requestAgentClose(group.folder, execution.runtime_namespace);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (runnerProfile) {
      setProfileForChat(runtimeJid, runnerProfile);
    }

    const onOutput = async (output: AgentRunOutput) => {
      pollCount += 1;
      if (output.newSessionId) {
        latestSessionId = output.newSessionId;
        await workflowDb.updateWorkflowNodeExecution(execution.id, {
          session_id: output.newSessionId,
        });
      }
      if (output.result) latestResult = output.result;
      if (output.error) latestError = output.error;
      const payload = JSON.stringify(output);
      if (output.turnEvent) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: output.turnEvent.type,
          payload_json: payload,
        });
      } else if (output.event) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: `event:${output.event.kind}:${output.event.status}`,
          payload_json: payload,
        });
      } else if (output.approvalRequest) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: 'approval_request',
          payload_json: payload,
        });
      } else if (output.approvalResolved) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: 'approval_resolved',
          payload_json: payload,
        });
      } else if (output.askRequest) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: 'ask_request',
          payload_json: payload,
        });
      } else if (output.askResolved) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: 'ask_resolved',
          payload_json: payload,
        });
      } else if (output.streamChunk) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: 'stream_chunk',
          payload_json: payload,
        });
      } else if (output.result) {
        await workflowDb.insertWorkflowNodeExecutionEvent({
          execution_id: execution.id,
          run_id: runId,
          node_id: taskNode.id,
          event_kind: 'result',
          payload_json: payload,
        });
      }
    };

    const result = await (async () => {
      try {
        return await runAgentProcess(
          group,
          {
            prompt: { text: prompt },
            sessionId: latestExecution?.session_id || undefined,
            groupFolder: group.folder,
            chatJid: runtimeJid,
            isMain: false,
            assistantName: await getAssistantName(),
            managedSkillIds,
            managedMcpServerIds,
            userSkillIds,
            userMcpServerIds,
            managedKbIds,
            resolvedManagedMcpServers,
            projectRootOverride:
              effectiveAllowedDirectories?.[0] || assistantRuntime.projectRootOverride,
            workspaceExtraDirectories:
              effectiveAllowedDirectories?.slice(1) ||
              assistantRuntime.repoBindingDirectories?.slice(1),
            allowedDirectoriesOverride: effectiveAllowedDirectories,
            providerOverrideId,
            modelOverride,
            soulSystemPrompt: assistantRuntime.soulSystemPrompt,
            instructionsAppend:
              [assistantRuntime.instructionsAppend, taskInstructionsAppend]
                .filter(Boolean)
                .join('\n\n') || undefined,
            assistantRuleMode: assistantRuntime.instructionsMode,
          },
          () => {
            /* workflow executor does not register queue processes */
          },
          onOutput,
        );
      } finally {
        if (runnerProfile) {
          clearProfileForChat(runtimeJid);
        }
      }
    })();
    signal?.removeEventListener('abort', onAbort);
    if (result.newSessionId) {
      latestSessionId = result.newSessionId;
      await workflowDb.updateWorkflowNodeExecution(execution.id, {
        session_id: result.newSessionId,
      });
    }

    if (signal?.aborted) {
      await workflowDb.updateWorkflowNodeExecution(execution.id, {
        status: 'cancelled',
        output_text: latestResult,
        error_text: 'Task cancelled',
        session_id: latestSessionId,
        completed_at: new Date().toISOString(),
      });
      return {
        success: false,
        output: latestResult,
        error: 'Task cancelled',
        execution_ms: Date.now() - startMs,
        poll_count: pollCount,
      };
    }

    if (result.status === 'error') {
      latestError = result.error || latestError || 'Agent execution failed';
      await workflowDb.updateWorkflowNodeExecution(execution.id, {
        status: 'failed',
        output_text: latestResult,
        error_text: latestError,
        session_id: latestSessionId,
        completed_at: new Date().toISOString(),
      });
      return {
        success: false,
        output: latestResult,
        error: latestError,
        execution_ms: Date.now() - startMs,
        poll_count: pollCount,
      };
    }

    latestResult = result.result || latestResult;
    await workflowDb.updateWorkflowNodeExecution(execution.id, {
      status: 'completed',
      output_text: latestResult,
      error_text: '',
      session_id: latestSessionId,
      completed_at: new Date().toISOString(),
    });
    return {
      success: true,
      output: latestResult,
      execution_ms: Date.now() - startMs,
      poll_count: pollCount,
    };
  } catch (err) {
    if (executionId) {
      await workflowDb.updateWorkflowNodeExecution(executionId, {
        status: 'failed',
        error_text: err instanceof Error ? err.message : String(err),
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
