import type {
  WorkflowArtifactPolicy,
  WorkflowConfig,
  WorkflowKind,
  WorkflowRecord,
  WorkflowVisibility,
} from './types.js';

const WORKFLOW_KINDS = new Set<WorkflowKind>([
  'repository',
  'skill',
  'mcp',
  'system_capability',
  'general',
]);

const WORKFLOW_VISIBILITIES = new Set<WorkflowVisibility>([
  'private',
  'shared',
  'system',
]);

export const DEFAULT_WORKFLOW_MESSAGE_DELAY_MS = 15_000;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asWorkflowKind(value: unknown): WorkflowKind {
  return typeof value === 'string' && WORKFLOW_KINDS.has(value as WorkflowKind)
    ? (value as WorkflowKind)
    : 'general';
}

function asWorkflowVisibility(value: unknown): WorkflowVisibility {
  return typeof value === 'string' &&
    WORKFLOW_VISIBILITIES.has(value as WorkflowVisibility)
    ? (value as WorkflowVisibility)
    : 'private';
}

function asMessageDelayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_WORKFLOW_MESSAGE_DELAY_MS;
  }
  return Math.max(0, Math.min(86_400_000, Math.floor(value)));
}

function normalizeArtifactPolicy(value: unknown): WorkflowArtifactPolicy {
  const raw = asObject(value);
  const publishTarget =
    raw.publishTarget === 'skill' ||
    raw.publishTarget === 'mcp' ||
    raw.publishTarget === 'system'
      ? raw.publishTarget
      : undefined;
  return {
    exportable: raw.exportable !== false,
    ...(typeof raw.commitToBranch === 'boolean'
      ? { commitToBranch: raw.commitToBranch }
      : {}),
    ...(publishTarget ? { publishTarget } : {}),
  };
}

export function normalizeWorkflowConfig(input: unknown): WorkflowConfig {
  const raw = asObject(input);
  const repositoryPolicy = asObject(raw.repositoryPolicy);
  const publishTarget =
    raw.publishTarget === 'skill' ||
    raw.publishTarget === 'mcp' ||
    raw.publishTarget === 'system'
      ? raw.publishTarget
      : undefined;
  return {
    kind: asWorkflowKind(raw.kind),
    visibility: asWorkflowVisibility(raw.visibility),
    repositoryPolicy: {
      ...(typeof repositoryPolicy.required === 'boolean'
        ? { required: repositoryPolicy.required }
        : {}),
      ...(typeof repositoryPolicy.bindingKey === 'string' &&
      repositoryPolicy.bindingKey.trim()
        ? { bindingKey: repositoryPolicy.bindingKey.trim() }
        : {}),
    },
    artifactPolicy: normalizeArtifactPolicy(raw.artifactPolicy),
    messageDelayMs: asMessageDelayMs(raw.messageDelayMs),
    ...(publishTarget ? { publishTarget } : {}),
  };
}

export function parseWorkflowConfig(record: WorkflowRecord | undefined): WorkflowConfig {
  if (!record) return normalizeWorkflowConfig({});
  try {
    return normalizeWorkflowConfig(JSON.parse(record.workflow_config || '{}'));
  } catch {
    return normalizeWorkflowConfig({});
  }
}
