import crypto from 'crypto';

import { getAssistantName } from '../config-store.js';
import { resolveAssistantRuntimeConfig } from '../assistant/assistant-runtime.js';
import { runAgentProcess, requestAgentClose, type AgentRunOutput } from '../agent/agent-runner.js';
import { getSession, setSession } from '../db.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import {
  clearProfileForChat,
  setProfileForChat,
} from './runner-profile-registry.js';
import type { RunnerProfile } from './runner-profiles.js';
import type { WorkteamAgentRecord, WorkteamTaskRecord } from './types.js';
import type { RegisteredGroup } from '../types.js';

export const AGENT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_TASK_TIMEOUT_MS = 600_000;

export function buildTaskPrompt(
  task: WorkteamTaskRecord,
  context: string,
  agent: WorkteamAgentRecord,
): string {
  return `## Your Role
You are a ${agent.role}. ${agent.goal}

## Background  
${agent.backstory}

## Task: ${task.name}
${task.description}

## Expected Output
${task.expected_output}

## Context from Previous Tasks
${context}`;
}

export function aggregateTaskOutputs(
  outputs: Array<{ taskName: string; output: string }>,
): string {
  const parts: string[] = [];
  for (const { taskName, output } of outputs) {
    parts.push(`=== Task: ${taskName} ===\n${output}\n\n----------\n`);
  }
  return parts.join('\n');
}

export interface AgentExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  execution_ms?: number;
  poll_count?: number;
}

function workteamTaskRuntimeJid(
  agent: WorkteamAgentRecord,
  taskId: string,
): string {
  return `workteam-runtime:${agent.team_id}:${agent.id}:${taskId}`;
}

function workteamTaskGroupFolder(
  agent: WorkteamAgentRecord,
  taskId: string,
): string {
  const digest = crypto
    .createHash('sha1')
    .update(`${agent.team_id}:${agent.id}:${taskId}`)
    .digest('hex')
    .slice(0, 20);
  return `wt_${digest}`;
}

function buildWorkteamRegisteredGroup(
  agent: WorkteamAgentRecord,
  task: WorkteamTaskRecord,
): RegisteredGroup {
  const modelPref = getModelPreference(agent);
  return {
    name: `Workteam ${agent.role} - ${task.name}`,
    folder: workteamTaskGroupFolder(agent, task.id),
    trigger: '@workteam',
    added_at: new Date().toISOString(),
    assistantId: agent.assistant_id?.trim() || null,
    requiresTrigger: false,
    isMain: false,
    model: modelPref || null,
  };
}

function getModelPreference(agent: WorkteamAgentRecord): string | undefined {
  try {
    const cfg = JSON.parse(agent.tools_config || '{}') as Record<
      string,
      unknown
    >;
    return typeof cfg.model_preference === 'string'
      ? cfg.model_preference
      : undefined;
  } catch {
    return undefined;
  }
}

export async function executeAgentTask(
  agent: WorkteamAgentRecord,
  task: WorkteamTaskRecord,
  context: string,
  signal?: AbortSignal,
  runnerProfile?: RunnerProfile,
): Promise<AgentExecutionResult> {
  const runtimeJid = workteamTaskRuntimeJid(agent, task.id);
  const group = buildWorkteamRegisteredGroup(agent, task);

  // Register the runner profile so spawnAgent can merge its env when this
  // chatJid's agent process starts. Cleared in `finally` so long-lived
  // registry entries never outlive a task.
  if (runnerProfile) {
    setProfileForChat(runtimeJid, runnerProfile);
  }

  try {
    const prompt = (
      await resolvePromptText({
        promptKey: 'workteam.task',
        variables: {
          agentRole: agent.role,
          agentGoal: agent.goal,
          agentBackstory: agent.backstory,
          taskName: task.name,
          taskDescription: task.description,
          expectedOutput: task.expected_output,
          context,
        },
        fallbackText: buildTaskPrompt(task, context, agent),
      })
    ).text;
    const assistantRuntime = await resolveAssistantRuntimeConfig(group, {}, {});
    const sessionId = await getSession(group.folder);

    const startMs = Date.now();
    let pollCount = 0;
    let latestResult = '';
    let latestError = '';
    let latestSessionId = sessionId;

    const onAbort = () => {
      requestAgentClose(group.folder);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const onOutput = async (output: AgentRunOutput) => {
      pollCount += 1;
      if (output.newSessionId) {
        latestSessionId = output.newSessionId;
        await setSession(group.folder, output.newSessionId);
      }
      if (output.result) latestResult = output.result;
      if (output.error) latestError = output.error;
    };

    const result = await runAgentProcess(
      group,
      {
        prompt: { text: prompt },
        sessionId: sessionId || undefined,
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
        projectRootOverride: assistantRuntime.projectRootOverride,
        workspaceExtraDirectories:
          assistantRuntime.repoBindingDirectories?.slice(1),
        allowedDirectoriesOverride: assistantRuntime.repoBindingDirectories,
        providerOverrideId: assistantRuntime.providerOverrideId,
        modelOverride: assistantRuntime.modelOverride,
        soulSystemPrompt: assistantRuntime.soulSystemPrompt,
        instructionsAppend: assistantRuntime.instructionsAppend,
        assistantRuleMode: assistantRuntime.instructionsMode,
      },
      () => {
        /* workteam executor does not register queue processes here */
      },
      onOutput,
    );
    signal?.removeEventListener('abort', onAbort);

    if (signal?.aborted) {
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
      return {
        success: false,
        output: latestResult,
        error: latestError,
        execution_ms: Date.now() - startMs,
        poll_count: pollCount,
      };
    }

    latestResult = result.result || latestResult;
    if (latestSessionId && latestSessionId !== sessionId) {
      await setSession(group.folder, latestSessionId);
    }
    return {
      success: true,
      output: latestResult,
      execution_ms: Date.now() - startMs,
      poll_count: pollCount,
    };
  } finally {
    if (runnerProfile) clearProfileForChat(runtimeJid);
  }
}
