import crypto from 'crypto';

import { getAssistantName } from '../config-store.js';
import { runAgentProcess, requestAgentClose, type AgentRunOutput } from '../agent/agent-runner.js';
import { resolveAssistantRuntimeConfig } from '../assistant/assistant-runtime.js';
import * as workflowDb from '../db/workflows.js';
import type { RegisteredGroup } from '../types.js';
import type {
  WorkflowNodeRecord,
  RoleNodeConfig,
  TaskNodeConfig,
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

function buildWorkflowRegisteredGroup(input: {
  workflowId: string;
  roleNode: WorkflowNodeRecord;
  taskNode: WorkflowNodeRecord;
}): RegisteredGroup {
  const folder = workflowTaskGroupFolder(
    input.workflowId,
    input.roleNode.id,
    input.taskNode.id,
  );
  return {
    name: `Workflow ${input.roleNode.name} - ${input.taskNode.name}`,
    folder,
    trigger: '@workflow',
    added_at: new Date().toISOString(),
    assistantId:
      input.taskNode.assistant_id?.trim() ||
      parseTaskConfig(input.taskNode).assistantId?.trim() ||
      input.roleNode.assistant_id?.trim() ||
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

export interface WorkflowAgentExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  execution_ms?: number;
  poll_count?: number;
}

export function buildTaskPrompt(
  roleNode: WorkflowNodeRecord,
  taskNode: WorkflowNodeRecord,
  runInput: string,
  upstreamMessages: Array<{
    from: string;
    to: string;
    direction: string;
    content: string;
  }>,
): string {
  const roleCfg = parseRoleConfig(roleNode);
  const taskCfg = parseTaskConfig(taskNode);
  const ctx = upstreamMessages
    .map(
      (message) =>
        `From ${message.from} -> ${message.to} [${message.direction}]\n${message.content}`,
    )
    .join('\n\n');
  return `## Workflow Role
${roleNode.name}

## Goal
${taskCfg.goal || roleCfg.goal || roleNode.description || 'Complete the assigned workflow responsibilities.'}

## Backstory
${roleCfg.backstory || ''}

## Task Node
${taskNode.name}

## Task Description
${taskNode.description}

## Expected Output
${taskCfg.expectedOutput || ''}

## Run Input
${runInput}

## Upstream Messages
${ctx || 'No upstream messages yet.'}

## Task Prompt
${taskCfg.prompt || 'Complete the task and return a concise but actionable result.'}

If this node is part of a two-way discussion loop, read the latest upstream messages carefully and respond to the newest feedback directly instead of repeating your previous answer.`;
}

export async function executeWorkflowTask(input: {
  workflowId: string;
  runId: string;
  roleNode: WorkflowNodeRecord;
  taskNode: WorkflowNodeRecord;
  runInput: string;
  upstreamMessages: Array<{
    from: string;
    to: string;
    direction: string;
    content: string;
  }>;
  signal?: AbortSignal;
}): Promise<WorkflowAgentExecutionResult> {
  const {
    workflowId,
    runId,
    roleNode,
    taskNode,
    runInput,
    upstreamMessages,
    signal,
  } =
    input;
  const runtimeJid = workflowTaskRuntimeJid(runId, taskNode.id);
  const group = buildWorkflowRegisteredGroup({ workflowId, roleNode, taskNode });
  const taskCfg = parseTaskConfig(taskNode);

  let executionId = '';
  try {
    const prompt = buildTaskPrompt(
      roleNode,
      taskNode,
      runInput,
      upstreamMessages,
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
    const taskProviderOverrideId = taskCfg.providerOverrideId?.trim() || undefined;
    const taskModelOverride = taskCfg.modelOverride?.trim() || undefined;
    const taskInstructionsAppend = taskCfg.instructionsAppend?.trim() || undefined;
    const taskAllowedDirectories = normalizeTaskAllowedDirectories(
      taskCfg.allowedDirectories,
    );
    const startMs = Date.now();
    let pollCount = 0;
    let latestResult = '';
    let latestError = '';
    let latestSessionId = execution.session_id || undefined;

    const onAbort = () => {
      requestAgentClose(group.folder, execution.runtime_namespace);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

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

    const result = await runAgentProcess(
      group,
      {
        prompt: { text: prompt },
        sessionId: latestExecution?.session_id || undefined,
        groupFolder: group.folder,
        chatJid: runtimeJid,
        isMain: false,
        assistantName: await getAssistantName(),
        managedSkillIds: assistantRuntime.managedSkillIds,
        managedMcpServerIds: assistantRuntime.managedMcpServerIds,
        userSkillIds: assistantRuntime.userSkillIds,
        userMcpServerIds: assistantRuntime.userMcpServerIds,
        managedKbIds: assistantRuntime.managedKbIds,
        resolvedManagedMcpServers: assistantRuntime.resolvedMcpServers,
        projectRootOverride:
          taskAllowedDirectories?.[0] || assistantRuntime.projectRootOverride,
        workspaceExtraDirectories:
          taskAllowedDirectories
            ? taskAllowedDirectories.slice(1)
            : assistantRuntime.repoBindingDirectories?.slice(1),
        allowedDirectoriesOverride:
          taskAllowedDirectories || assistantRuntime.repoBindingDirectories,
        providerOverrideId:
          taskProviderOverrideId || assistantRuntime.providerOverrideId,
        modelOverride: taskModelOverride || assistantRuntime.modelOverride,
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
