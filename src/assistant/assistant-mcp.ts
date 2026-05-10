export interface ManagedMcpTemplate {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface AssistantMcpBindingRecord {
  id: string;
  assistant_id: string;
  template_server_id: string;
  alias: string | null;
  enabled: number;
  args_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantMcpBindingSecretRecord {
  binding_id: string;
  env_json: string;
  updated_at: string;
}

export interface AssistantMcpSecretStatus {
  configured: boolean;
  keyCount: number;
  updatedAt: string | null;
}

export interface AssistantMcpBindingView {
  id: string;
  assistantId: string;
  templateServerId: string;
  templateName: string;
  alias: string | null;
  enabled: boolean;
  args: string[];
  templateEnvKeys: string[];
  secretStatus: AssistantMcpSecretStatus;
  usesTemplateEnvFallback: boolean;
  source: 'assistant_binding' | 'legacy_config';
}

export interface ResolvedAssistantMcpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  bindingId: string;
  templateServerId: string;
  source: 'assistant_binding' | 'legacy_config';
}

function normalizeIdSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'binding';
}

export function createAssistantMcpBindingId(
  assistantId: string,
  templateServerId: string,
): string {
  return `amb-${normalizeIdSegment(assistantId)}-${normalizeIdSegment(templateServerId)}`;
}

export function parseAssistantMcpBindingArgs(record: {
  args_json?: string | null;
}): string[] {
  if (!record.args_json?.trim()) return [];
  try {
    const parsed = JSON.parse(record.args_json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseAssistantMcpSecretEnv(
  record: Pick<AssistantMcpBindingSecretRecord, 'env_json'> | null | undefined,
): Record<string, string> {
  if (!record?.env_json?.trim()) return {};
  try {
    const parsed = JSON.parse(record.env_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') continue;
      output[key] = value;
    }
    return output;
  } catch {
    return {};
  }
}

function buildSecretStatus(
  secretRecord: AssistantMcpBindingSecretRecord | null | undefined,
): AssistantMcpSecretStatus {
  const env = parseAssistantMcpSecretEnv(secretRecord);
  const keyCount = Object.keys(env).length;
  return {
    configured: keyCount > 0,
    keyCount,
    updatedAt: secretRecord?.updated_at || null,
  };
}

export function buildAssistantMcpBindingViews(input: {
  assistantId: string;
  legacyTemplateIds: string[];
  templates: ManagedMcpTemplate[];
  bindings: AssistantMcpBindingRecord[];
  secretRecordsByBindingId?: Map<string, AssistantMcpBindingSecretRecord>;
}): AssistantMcpBindingView[] {
  const templatesById = new Map(
    input.templates.map((template) => [template.id, template]),
  );
  const secretRecordsByBindingId =
    input.secretRecordsByBindingId || new Map<string, AssistantMcpBindingSecretRecord>();

  if (input.bindings.length === 0) {
    return input.legacyTemplateIds.map((templateId) => {
      const template = templatesById.get(templateId);
      return {
        id: createAssistantMcpBindingId(input.assistantId, templateId),
        assistantId: input.assistantId,
        templateServerId: templateId,
        templateName: template?.name || templateId,
        alias: null,
        enabled: true,
        args: template?.args ? [...template.args] : [],
        templateEnvKeys: Object.keys(template?.env || {}),
        secretStatus: {
          configured: false,
          keyCount: 0,
          updatedAt: null,
        },
        usesTemplateEnvFallback: Object.keys(template?.env || {}).length > 0,
        source: 'legacy_config',
      };
    });
  }

  return input.bindings.map((binding) => {
    const template = templatesById.get(binding.template_server_id);
    const secretRecord = secretRecordsByBindingId.get(binding.id);
    const secretEnv = parseAssistantMcpSecretEnv(secretRecord);
    const templateEnvKeys = Object.keys(template?.env || {});
    const usesTemplateEnvFallback = templateEnvKeys.some(
      (key) => !(key in secretEnv),
    );
    return {
      id: binding.id,
      assistantId: binding.assistant_id,
      templateServerId: binding.template_server_id,
      templateName: template?.name || binding.template_server_id,
      alias: binding.alias,
      enabled: binding.enabled === 1,
      args: (() => {
        const args = parseAssistantMcpBindingArgs(binding);
        return args.length > 0 ? args : [...(template?.args || [])];
      })(),
      templateEnvKeys,
      secretStatus: buildSecretStatus(secretRecord),
      usesTemplateEnvFallback,
      source: 'assistant_binding',
    };
  });
}

export function resolveAssistantMcpServers(input: {
  assistantId: string;
  legacyTemplateIds: string[];
  templates: ManagedMcpTemplate[];
  bindings: AssistantMcpBindingRecord[];
  secretRecordsByBindingId?: Map<string, AssistantMcpBindingSecretRecord>;
}): ResolvedAssistantMcpServer[] {
  const templatesById = new Map(
    input.templates.map((template) => [template.id, template]),
  );
  const secretRecordsByBindingId =
    input.secretRecordsByBindingId || new Map<string, AssistantMcpBindingSecretRecord>();
  const bindingViews = buildAssistantMcpBindingViews(input);
  return bindingViews.reduce<ResolvedAssistantMcpServer[]>((servers, binding) => {
    if (!binding.enabled) return servers;
    const template = templatesById.get(binding.templateServerId);
    if (!template || !template.enabled) return servers;
    const secretEnv = parseAssistantMcpSecretEnv(
      secretRecordsByBindingId.get(binding.id),
    );
    servers.push({
      id: binding.id,
      name: binding.alias?.trim() || template.name || template.id,
      command: template.command,
      args: binding.args.length > 0 ? [...binding.args] : [...template.args],
      env: {
        ...template.env,
        ...secretEnv,
      },
      bindingId: binding.id,
      templateServerId: binding.templateServerId,
      source: binding.source,
    });
    return servers;
  }, []);
}
