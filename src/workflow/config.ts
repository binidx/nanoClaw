import type {
  WorkflowArtifactPolicy,
  WorkflowConfig,
  WorkflowEditorMode,
  WorkflowEvaluationPolicy,
  WorkflowGuardrailsConfig,
  WorkflowKind,
  WorkflowRecord,
  WorkflowToolPolicy,
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
const WORKFLOW_EDITOR_MODES = new Set<WorkflowEditorMode>([
  'legacy',
  'fixed_pipeline_v1',
]);

export const DEFAULT_WORKFLOW_MESSAGE_DELAY_MS = 15_000;
export const DEFAULT_WORKFLOW_GUARDRAILS: WorkflowGuardrailsConfig = {
  maxDurationMs: 30 * 60 * 1000,
  concurrentNodes: 2,
  maxNodeRuns: 50,
  maxTransfers: 100,
  maxToolCalls: 200,
  maxExecutionEvents: 2000,
  maxEstimatedContextCharsPerNode: 60000,
};

const TOOL_POLICY_MODES = new Set<WorkflowToolPolicy['mode']>([
  'assistant_default',
  'restricted',
]);

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

function asWorkflowEditorMode(value: unknown): WorkflowEditorMode {
  return typeof value === 'string' &&
    WORKFLOW_EDITOR_MODES.has(value as WorkflowEditorMode)
    ? (value as WorkflowEditorMode)
    : 'legacy';
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

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

export function normalizeWorkflowGuardrails(value: unknown): WorkflowGuardrailsConfig {
  const raw = asObject(value);
  return {
    maxDurationMs: boundedInt(
      raw.maxDurationMs,
      DEFAULT_WORKFLOW_GUARDRAILS.maxDurationMs,
      1000,
      7 * 24 * 60 * 60 * 1000,
    ),
    concurrentNodes: boundedInt(raw.concurrentNodes, DEFAULT_WORKFLOW_GUARDRAILS.concurrentNodes, 1, 32),
    maxNodeRuns: boundedInt(raw.maxNodeRuns, DEFAULT_WORKFLOW_GUARDRAILS.maxNodeRuns, 1, 10000),
    maxTransfers: boundedInt(raw.maxTransfers, DEFAULT_WORKFLOW_GUARDRAILS.maxTransfers, 0, 100000),
    maxToolCalls: boundedInt(raw.maxToolCalls, DEFAULT_WORKFLOW_GUARDRAILS.maxToolCalls, 0, 100000),
    maxExecutionEvents: boundedInt(
      raw.maxExecutionEvents,
      DEFAULT_WORKFLOW_GUARDRAILS.maxExecutionEvents,
      1,
      1000000,
    ),
    maxEstimatedContextCharsPerNode: boundedInt(
      raw.maxEstimatedContextCharsPerNode,
      DEFAULT_WORKFLOW_GUARDRAILS.maxEstimatedContextCharsPerNode,
      1000,
      10000000,
    ),
  };
}

export function normalizeWorkflowToolPolicy(value: unknown): WorkflowToolPolicy {
  const raw = asObject(value);
  const mode =
    typeof raw.mode === 'string' && TOOL_POLICY_MODES.has(raw.mode as WorkflowToolPolicy['mode'])
      ? (raw.mode as WorkflowToolPolicy['mode'])
      : 'assistant_default';
  const policy: WorkflowToolPolicy = { mode };
  for (const key of [
    'managedSkillIds',
    'userSkillIds',
    'managedMcpServerIds',
    'userMcpServerIds',
    'managedKbIds',
  ] as const) {
    const list = stringList(raw[key]);
    if (list) policy[key] = list;
  }
  if (typeof raw.providerOverrideId === 'string' && raw.providerOverrideId.trim()) {
    policy.providerOverrideId = raw.providerOverrideId.trim();
  }
  if (typeof raw.modelOverride === 'string' && raw.modelOverride.trim()) {
    policy.modelOverride = raw.modelOverride.trim();
  }
  return policy;
}

function normalizeEvaluationPolicy(value: unknown): WorkflowEvaluationPolicy {
  const raw = asObject(value);
  return { enabled: raw.enabled !== false };
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
    editorMode: asWorkflowEditorMode(raw.editorMode),
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
    guardrails: normalizeWorkflowGuardrails(raw.guardrails),
    toolPolicy: normalizeWorkflowToolPolicy(raw.toolPolicy),
    evaluationPolicy: normalizeEvaluationPolicy(raw.evaluationPolicy),
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
