import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { getNodeExecutable } from '../node-executable.js';
import { getRepositoryById } from '../db/repositories.js';
import { listOwnerBindings } from '../tenant/resource-binding-service.js';
import { getCurrentUserId, SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { createUserMcpServer } from '../user/user-mcp-service.js';
import { createUserSkill } from '../user/user-skill-service.js';
import * as db from '../db/workflows.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { parseWorkflowConfig } from './config.js';
import type {
  WorkflowArtifactRecord,
  WorkflowRunGraph,
  WorkflowRunRecord,
} from './types.js';

const execFileAsync = promisify(execFile);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workflow';
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildSummaryMarkdown(graph: WorkflowRunGraph): string {
  const lines: string[] = [
    `# ${graph.workflow.name} Run ${graph.run.id}`,
    '',
    `Status: ${graph.run.status}`,
    `Created: ${graph.run.created_at}`,
    graph.run.started_at ? `Started: ${graph.run.started_at}` : '',
    graph.run.completed_at ? `Completed: ${graph.run.completed_at}` : '',
    '',
    '## Input',
    '',
    graph.run.input || '(empty)',
    '',
    '## Output',
    '',
    graph.run.output || '(empty)',
    '',
    '## Nodes',
    '',
  ].filter(Boolean);

  for (const runNode of graph.runNodes) {
    const node = graph.nodes.find((item) => item.id === runNode.node_id);
    lines.push(
      `### ${node?.name || runNode.node_id}`,
      '',
      `Status: ${runNode.status}`,
      runNode.last_error ? `Error: ${runNode.last_error}` : '',
      '',
      runNode.output_snapshot || '(no output)',
      '',
    );
  }
  return lines.filter((line, index, array) => line || array[index - 1]).join('\n');
}

function buildBundlePayload(graph: WorkflowRunGraph): Record<string, unknown> {
  return {
    workflow: graph.workflow,
    run: graph.run,
    nodes: graph.nodes,
    edges: graph.edges,
    runNodes: graph.runNodes,
    messages: graph.messages,
    messageFrames: graph.messageFrames,
    pendingTransfers: graph.pendingTransfers,
    interventions: graph.interventions,
    executions: graph.executions.map((execution) => ({
      ...execution,
      prompt_text: execution.prompt_text ? '[redacted prompt]' : '',
    })),
  };
}

export async function ensureWorkflowArtifacts(
  runId: string,
): Promise<WorkflowArtifactRecord[]> {
  const existing = await db.listWorkflowArtifacts(runId);
  const graph = await db.getWorkflowRunGraph(runId);
  if (!graph) return existing;
  if (graph.run.status !== 'completed' && graph.run.status !== 'failed') {
    return existing;
  }
  if (existing.some((artifact) => artifact.artifact_type === 'summary')) {
    return existing;
  }
  const summary = buildSummaryMarkdown(graph);
  const bundle = buildBundlePayload(graph);
  const summaryArtifact = await db.createWorkflowArtifact({
    run_id: runId,
    artifact_type: 'summary',
    name: `${graph.workflow.name} summary`,
    summary: `Workflow run ${graph.run.status}`,
    content_text: summary,
    payload_json: JSON.stringify({
      fileList: ['summary.md', 'bundle.json'],
      runId,
    }),
  });
  const bundleArtifact = await db.createWorkflowArtifact({
    run_id: runId,
    artifact_type: 'bundle',
    name: `${graph.workflow.name} bundle`,
    summary: 'JSON workflow run export bundle',
    content_text: JSON.stringify(bundle, null, 2),
    payload_json: JSON.stringify({
      fileList: ['summary.md', 'bundle.json'],
      runId,
    }),
  });
  return [...existing, summaryArtifact, bundleArtifact];
}

export async function buildWorkflowExportBundle(
  runId: string,
): Promise<Record<string, unknown>> {
  const graph = await db.getWorkflowRunGraph(runId);
  if (!graph) throw new Error('Run not found');
  const artifacts = await ensureWorkflowArtifacts(runId);
  return {
    exportedAt: new Date().toISOString(),
    graph: buildBundlePayload(graph),
    artifacts,
  };
}

export async function commitAndPushWorkflowRun(
  runId: string,
): Promise<WorkflowArtifactRecord> {
  const graph = await db.getWorkflowRunGraph(runId);
  if (!graph) throw new Error('Run not found');
  const artifacts = await ensureWorkflowArtifacts(runId);
  const summary = artifacts.find((artifact) => artifact.artifact_type === 'summary');
  const bundle = artifacts.find((artifact) => artifact.artifact_type === 'bundle');
  const config = parseWorkflowConfig(graph.workflow);
  const bindings = await listOwnerBindings('workflow', graph.workflow.id, getCurrentUserId());
  const binding = bindings.find(
    (item) =>
      item.resourceType === 'repository' &&
      (!config.repositoryPolicy?.bindingKey ||
        item.bindingKey === config.repositoryPolicy.bindingKey),
  );
  if (!binding) throw new Error('Workflow has no repository binding');
  const repository = await getRepositoryById(binding.resourceId, getCurrentUserId());
  if (!repository) throw new Error('Repository not found');
  const configWorktree =
    typeof binding.config.worktree_path === 'string'
      ? binding.config.worktree_path
      : '';
  const repoPath =
    configWorktree ||
    binding.workDirectory ||
    repository.local_repo_path ||
    '';
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error('Repository worktree is not available');
  }

  const branchName = `workflow/${slugify(graph.workflow.name)}/${graph.run.id.slice(0, 8)}`;
  const artifactDir = path.join(
    repoPath,
    '.nanoclaw',
    'workflows',
    slugify(graph.workflow.id),
    graph.run.id,
  );
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, 'summary.md'),
    summary?.content_text || buildSummaryMarkdown(graph),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(artifactDir, 'bundle.json'),
    bundle?.content_text || JSON.stringify(buildBundlePayload(graph), null, 2),
    'utf-8',
  );

  const runGit = async (args: string[]) =>
    execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    });
  await runGit(['checkout', '-B', branchName]);
  await runGit(['add', path.relative(repoPath, artifactDir)]);
  const status = await runGit(['status', '--porcelain', '--', path.relative(repoPath, artifactDir)]);
  let committed = false;
  if (status.stdout.trim()) {
    await runGit([
      'commit',
      '-m',
      `Add workflow artifacts for ${graph.workflow.name} ${graph.run.id.slice(0, 8)}`,
    ]);
    committed = true;
  }

  let pushStatus = 'pushed';
  let pushError = '';
  try {
    await runGit(['push', '-u', 'origin', branchName]);
  } catch (err) {
    pushStatus = 'push_failed';
    pushError = err instanceof Error ? err.message : String(err);
  }

  return db.createWorkflowArtifact({
    run_id: runId,
    artifact_type: 'commit',
    name: `Branch ${branchName}`,
    summary: pushStatus === 'pushed' ? 'Committed and pushed workflow artifacts' : 'Committed locally; push failed',
    status: pushStatus,
    payload_json: JSON.stringify({
      repositoryId: repository.id,
      repositoryName: repository.name,
      branchName,
      committed,
      pushError,
      artifactDir,
    }),
  });
}

export async function publishWorkflowRun(input: {
  runId: string;
  target?: 'skill' | 'mcp' | 'system';
}): Promise<WorkflowArtifactRecord> {
  const graph = await db.getWorkflowRunGraph(input.runId);
  if (!graph) throw new Error('Run not found');
  const artifacts = await ensureWorkflowArtifacts(input.runId);
  const summary = artifacts.find((artifact) => artifact.artifact_type === 'summary');
  const config = parseWorkflowConfig(graph.workflow);
  const target =
    input.target ||
    config.artifactPolicy.publishTarget ||
    config.publishTarget ||
    (config.kind === 'mcp' ? 'mcp' : config.kind === 'system_capability' ? 'system' : 'skill');
  const visibility = config.visibility === 'private' ? 'private' : 'shared';
  const ownerId = target === 'system' ? SYSTEM_USER_ID : getCurrentUserId();
  const description =
    graph.workflow.description ||
    `Published capability generated from workflow run ${graph.run.id}`;

  if (target === 'mcp') {
    const mcpRoot = path.join(DATA_DIR, 'workflow-publications', graph.run.id);
    fs.mkdirSync(mcpRoot, { recursive: true });
    const entryPath = path.join(mcpRoot, 'workflow-capability.mjs');
    fs.writeFileSync(
      entryPath,
      [
        'console.error("This workflow MCP package is a publication marker.");',
        'console.error("Use the paired workflow artifact bundle for runtime implementation details.");',
        'setInterval(() => {}, 2147483647);',
      ].join('\n'),
      'utf-8',
    );
    const server = await createUserMcpServer(ownerId, {
      name: graph.workflow.name,
      description,
      command: getNodeExecutable(),
      args: [entryPath],
      enabled: false,
      visibility,
      sourceType: 'workflow',
      sourceRef: graph.run.id,
      metadata: {
        capabilities: ['workflow.run_artifact'],
        generator: {
          kind: 'manual',
          templateId: 'workflow',
        },
        notes: `Workflow run ${graph.run.id}`,
      },
    });
    return db.createWorkflowArtifact({
      run_id: input.runId,
      artifact_type: 'publish',
      name: `MCP ${server.name}`,
      summary: 'Published workflow run as a disabled MCP capability marker',
      status: 'published',
      payload_json: JSON.stringify({ target, mcpId: server.id, visibility }),
    });
  }

  const skill = await createUserSkill(ownerId, {
    name: graph.workflow.name,
    description,
    summary: summary?.summary || `Workflow run ${graph.run.status}`,
    skillContent:
      summary?.content_text ||
      `# ${graph.workflow.name}\n\nWorkflow run ${graph.run.id}`,
    enabled: false,
    visibility,
    sourceType: 'workflow',
    sourceRef: graph.run.id,
    tags: ['workflow'],
    metadata: {
      capabilities: ['workflow.run_artifact'],
      generator: {
        kind: 'manual',
        templateId: 'workflow',
      },
      notes: `Workflow run ${graph.run.id}`,
    },
  });
  logger.info(
    { runId: input.runId, target, skillId: skill.id },
    'workflow artifact published',
  );
  return db.createWorkflowArtifact({
    run_id: input.runId,
    artifact_type: 'publish',
    name: `${target === 'system' ? 'System capability' : 'Skill'} ${skill.name}`,
    summary: 'Published workflow run as a shared skill capability',
    status: 'published',
    payload_json: JSON.stringify({ target, skillId: skill.id, visibility }),
  });
}
