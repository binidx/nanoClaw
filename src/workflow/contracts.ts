import type {
  TaskNodeConfig,
  WorkflowContextPolicy,
  WorkflowEdgeCondition,
  WorkflowMessageFrameType,
  WorkflowNodeVerdict,
} from './types.js';

export interface WorkflowHandoffMessage {
  from: string;
  to: string;
  direction: string;
  content: string;
  frameType?: WorkflowMessageFrameType;
  edgeId?: string;
}

export interface WorkflowVerdictParseResult {
  verdict: WorkflowNodeVerdict;
  hasExplicitVerdict: boolean;
  reason?: string;
  suggestedFix?: string;
  rollbackNodeId?: string;
  payload?: Record<string, unknown>;
  validationErrors: string[];
}

export interface WorkflowOutputContractResult extends WorkflowVerdictParseResult {
  blockedByContract: boolean;
  failedByContract: boolean;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function parseSchemaObject(schemaText: string | undefined): Record<string, unknown> | null {
  if (!schemaText?.trim()) return null;
  return extractJsonObject(schemaText);
}

function expectedJsonType(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (
      normalized === 'string' ||
      normalized === 'number' ||
      normalized === 'boolean' ||
      normalized === 'object' ||
      normalized === 'array'
    ) {
      return normalized;
    }
  }
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return null;
}

function actualJsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateAgainstLightweightSchema(
  payload: Record<string, unknown> | undefined,
  schema: Record<string, unknown> | null,
): string[] {
  if (!schema) return [];
  if (!payload) return ['Output did not contain a JSON object for schema validation'];
  const errors: string[] = [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : Object.keys(schema).filter(
        (key) =>
          key !== 'type' &&
          key !== 'properties' &&
          key !== 'required' &&
          key !== 'additionalProperties',
      );
  for (const key of required) {
    if (!(key in payload)) errors.push(`Missing required output field "${key}"`);
  }
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : schema;
  for (const [key, descriptor] of Object.entries(properties)) {
    if (!(key in payload)) continue;
    const expected =
      descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
        ? expectedJsonType((descriptor as Record<string, unknown>).type)
        : expectedJsonType(descriptor);
    if (!expected) continue;
    const actual = actualJsonType(payload[key]);
    if (actual !== expected) {
      errors.push(`Output field "${key}" expected ${expected}, got ${actual}`);
    }
  }
  return errors;
}

export function parseWorkflowVerdict(output: string): WorkflowVerdictParseResult {
  const payload = extractJsonObject(output);
  const rawVerdict =
    typeof payload?.verdict === 'string' ? payload.verdict.toLowerCase() : '';
  const hasExplicitVerdict =
    rawVerdict === 'pass' ||
    rawVerdict === 'fail' ||
    rawVerdict === 'failed' ||
    rawVerdict === 'blocked';
  const verdict: WorkflowNodeVerdict =
    rawVerdict === 'fail' || rawVerdict === 'failed'
      ? 'fail'
      : rawVerdict === 'blocked'
        ? 'blocked'
        : 'pass';
  const reason =
    typeof payload?.reason === 'string'
      ? payload.reason
      : typeof payload?.failureReason === 'string'
        ? payload.failureReason
        : undefined;
  const suggestedFix =
    typeof payload?.suggestedFix === 'string'
      ? payload.suggestedFix
      : typeof payload?.fix === 'string'
        ? payload.fix
        : undefined;
  const rollbackNodeId =
    typeof payload?.rollbackNodeId === 'string'
      ? payload.rollbackNodeId
      : typeof payload?.targetRollbackNodeId === 'string'
        ? payload.targetRollbackNodeId
        : undefined;
  return {
    verdict,
    hasExplicitVerdict,
    reason,
    suggestedFix,
    rollbackNodeId,
    payload: payload ?? undefined,
    validationErrors: [],
  };
}

export function evaluateWorkflowOutputContract(input: {
  output: string;
  taskConfig: TaskNodeConfig;
  verdictRequired?: boolean;
}): WorkflowOutputContractResult {
  const contract = input.taskConfig.outputContract ?? {};
  const result = parseWorkflowVerdict(input.output);
  const verdictRequired = Boolean(input.verdictRequired || contract.verdictRequired);
  const validationErrors = [...result.validationErrors];
  const schemaMode = contract.schemaValidation ?? (contract.strictJson ? 'block' : 'off');
  const schema = parseSchemaObject(input.taskConfig.outputSchema);
  if (contract.strictJson && !result.payload) {
    validationErrors.push('Output contract requires a JSON object');
  }
  if (verdictRequired && !result.hasExplicitVerdict) {
    validationErrors.push('Output contract requires an explicit verdict');
  }
  if (schemaMode !== 'off') {
    validationErrors.push(...validateAgainstLightweightSchema(result.payload, schema));
  }
  const blockedByContract = Boolean(
    validationErrors.length > 0 &&
      (verdictRequired || schemaMode === 'block' || contract.strictJson),
  );
  return {
    ...result,
    verdict: blockedByContract ? 'blocked' : result.verdict,
    reason:
      blockedByContract && !result.reason
        ? validationErrors.join('; ')
        : result.reason,
    validationErrors,
    blockedByContract,
    failedByContract: false,
  };
}

function trimMessageContent(content: string, maxChars: number | undefined): string {
  if (!maxChars || maxChars <= 0 || content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(0, maxChars))}\n[truncated ${content.length - maxChars} chars]`;
}

export function applyWorkflowContextPolicy(
  messages: WorkflowHandoffMessage[],
  policy: WorkflowContextPolicy | undefined,
): WorkflowHandoffMessage[] {
  if (!policy) return messages;
  let next = messages;
  if (policy.includeFrameTypes?.length) {
    const allowed = new Set(policy.includeFrameTypes);
    next = next.filter((message) => !message.frameType || allowed.has(message.frameType));
  }
  if (policy.mode === 'feedback_first') {
    next = [
      ...next.filter((message) => message.frameType === 'feedback'),
      ...next.filter((message) => message.frameType !== 'feedback'),
    ];
  }
  if (policy.mode === 'latest' && next.length > 0) {
    const latestByEdge = new Map<string, WorkflowHandoffMessage>();
    for (const message of next) {
      latestByEdge.set(message.edgeId || `${message.from}->${message.to}`, message);
    }
    next = Array.from(latestByEdge.values());
  }
  if (typeof policy.maxMessages === 'number' && Number.isFinite(policy.maxMessages)) {
    next = next.slice(-Math.max(0, Math.floor(policy.maxMessages)));
  }
  next = next.map((message) => ({
    ...message,
    content: trimMessageContent(message.content, policy.maxCharsPerMessage),
  }));
  if (typeof policy.maxTotalChars === 'number' && Number.isFinite(policy.maxTotalChars)) {
    const maxTotal = Math.max(0, Math.floor(policy.maxTotalChars));
    let remaining = maxTotal;
    const kept: WorkflowHandoffMessage[] = [];
    for (const message of [...next].reverse()) {
      if (remaining <= 0) break;
      const content =
        message.content.length > remaining
          ? message.content.slice(0, remaining)
          : message.content;
      kept.unshift({ ...message, content });
      remaining -= content.length;
    }
    next = kept;
  }
  return next;
}

export function edgeConditionRequiresVerdict(
  condition: WorkflowEdgeCondition,
  requireVerdict?: boolean,
): boolean {
  return Boolean(
    requireVerdict ||
      condition === 'on_pass' ||
      condition === 'on_fail' ||
      condition === 'on_blocked',
  );
}
