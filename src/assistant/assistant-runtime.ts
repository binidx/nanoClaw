import { type AssistantRuleMode, type AssistantPersona } from './assistant-config.js';
import { t } from '../i18n/index.js';
import {
  listAssistantRepoBindings,
  type AssistantRepoBinding,
} from './assistant-repo.js';
import {
  type AiProvider,
  type AssistantSummary,
  getAssistant,
  getConfig,
  getProvider,
  getAssistantMcpBindingSecret,
  listAssistantMcpBindings,
} from '../db.js';
import {
  resolveAssistantMcpServers,
  type AssistantMcpBindingRecord,
  type AssistantMcpBindingSecretRecord,
  type ManagedMcpTemplate,
} from './assistant-mcp.js';
import {
  parseManagedMcpServersConfig,
  WEB_MCP_SERVERS_CONFIG_KEY,
} from '../runtime/runtime-customization.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import type { RegisteredGroup } from '../types.js';

export interface ResolvedAssistantRuntimeConfig {
  assistantId: string | null;
  assistantName: string | null;
  managedSkillIds?: string[];
  managedMcpServerIds?: string[];
  userSkillIds?: string[];
  userMcpServerIds?: string[];
  managedKbIds?: string[];
  resolvedMcpServers?: Array<{
    id: string;
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    bindingId: string;
    templateServerId: string;
    source: 'assistant_binding' | 'legacy_config';
  }>;
  persona?: AssistantPersona;
  repoBindingDirectories?: string[];
  projectRootOverride?: string;
  providerOverrideId?: string;
  modelOverride?: string;
  providerType?: AiProvider['type'] | null;
  soulSystemPrompt?: string;
  instructionsAppend?: string;
  instructionsMode?: AssistantRuleMode;
  providerAlias?: string | null;
}

export interface ResolveAssistantRuntimeOptions {
  requireEnabled?: boolean;
}

export async function buildAssistantInstructionsAppend(
  assistant: Pick<AssistantSummary, 'name' | 'config'> | null | undefined,
): Promise<string> {
  const sections: string[] = [];
  if (assistant) {
    const persona = assistant.config.persona;
    if (persona) {
      const personaParts: string[] = [];
      if (persona.role) personaParts.push(`Role: ${persona.role}`);
      if (persona.style) personaParts.push(`Style: ${persona.style}`);
      if (persona.guidelines) personaParts.push(`Guidelines:\n${persona.guidelines}`);
      if (persona.constraints) personaParts.push(`Constraints:\n${persona.constraints}`);
      if (personaParts.length > 0) {
        const personaBlock = await resolvePromptText({
          promptKey: 'assistant.profile.persona_wrapper',
          variables: {
            assistantName: assistant.name,
            personaParts: personaParts.join('\n'),
          },
        });
        sections.push(
          personaBlock.text,
        );
      }
    }
    const systemPrompt = assistant.config.rules.systemPrompt?.trim();
    const extraInstructions = assistant.config.rules.extraInstructions?.trim();
    if (systemPrompt) {
      const systemBlock = await resolvePromptText({
        promptKey: 'assistant.profile.system_wrapper',
        variables: { assistantName: assistant.name, systemPrompt },
      });
      sections.push(systemBlock.text);
    }
    if (extraInstructions) {
      const extraBlock = await resolvePromptText({
        promptKey: 'assistant.profile.extra_wrapper',
        variables: {
          assistantName: assistant.name,
          extraInstructions,
        },
      });
      sections.push(extraBlock.text);
    }
  }
  return sections.join('\n\n').trim();
}

export async function buildConversationSoulSystemPrompt(
  soulPrompt?: string,
): Promise<string> {
  const trimmed = soulPrompt?.trim();
  if (!trimmed) return '';
  const resolved = await resolvePromptText({
    promptKey: 'assistant.soul.primary_policy_wrapper',
    variables: { soulPrompt: trimmed },
  });
  return resolved.text;
}

export async function resolveAssistantRuntimeConfig(
  group: RegisteredGroup,
  deps: {
    getAssistantById?: typeof getAssistant;
    getProviderById?: typeof getProvider;
    listAssistantMcpBindingsByAssistantId?: typeof listAssistantMcpBindings;
    getAssistantMcpBindingSecretById?: typeof getAssistantMcpBindingSecret;
    listManagedMcpTemplates?: () =>
      | ManagedMcpTemplate[]
      | Promise<ManagedMcpTemplate[]>;
    listRepoBindings?: (assistantId: string) => Promise<AssistantRepoBinding[]>;
  } = {},
  options: ResolveAssistantRuntimeOptions & { soulPrompt?: string } = {},
): Promise<ResolvedAssistantRuntimeConfig> {
  const assistantId = group.assistantId?.trim() || null;
  const convProviderId = group.providerId?.trim() || null;
  const convModel = group.model?.trim() || null;

  if (!assistantId) {
    const soulOnly = await buildConversationSoulSystemPrompt(options.soulPrompt);
    const customInstructions = group.agentConfig?.customInstructions?.trim();

    const readProvider = deps.getProviderById || getProvider;
    const convProvider = convProviderId
      ? await readProvider(convProviderId)
      : undefined;

    return {
      assistantId: null,
      assistantName: null,
      providerOverrideId: convProvider?.id || convProviderId || undefined,
      modelOverride: convModel || convProvider?.model || undefined,
      providerType: convProvider?.type || null,
      soulSystemPrompt: soulOnly || undefined,
      instructionsAppend: customInstructions || undefined,
      instructionsMode: customInstructions ? 'append' : undefined,
      providerAlias: convProvider?.alias || null,
    };
  }

  const readAssistant = deps.getAssistantById || getAssistant;
  const readProvider = deps.getProviderById || getProvider;
  const readAssistantBindings =
    deps.listAssistantMcpBindingsByAssistantId || listAssistantMcpBindings;
  const readAssistantSecret =
    deps.getAssistantMcpBindingSecretById || getAssistantMcpBindingSecret;
  const listManagedMcpTemplates =
    deps.listManagedMcpTemplates ||
    (async () => {
      try {
        return parseManagedMcpServersConfig(
          await getConfig(WEB_MCP_SERVERS_CONFIG_KEY),
        );
      } catch {
        return [];
      }
    });
  const assistant = await readAssistant(assistantId);
  if (!assistant) {
    if (options.requireEnabled) {
      throw new Error(t('errors.assistantNotFound', { id: assistantId }, undefined));
    }
    const soulFallback = await buildConversationSoulSystemPrompt(options.soulPrompt);
    const customInstructions = group.agentConfig?.customInstructions?.trim();
    return {
      assistantId,
      assistantName: null,
      providerType: null,
      soulSystemPrompt: soulFallback || undefined,
      instructionsAppend: customInstructions || undefined,
      instructionsMode: 'append',
      providerAlias: null,
    };
  }
  if (options.requireEnabled && !assistant.enabled) {
    throw new Error(t('errors.assistantDisabled', { name: assistant.name }, undefined));
  }
  let assistantBindings: AssistantMcpBindingRecord[] = [];
  try {
    assistantBindings = await readAssistantBindings(assistantId);
  } catch {
    assistantBindings = [];
  }
  const secretRecordsByBindingId = new Map<
    string,
    AssistantMcpBindingSecretRecord
  >();
  for (const binding of assistantBindings) {
    try {
      const secret = await readAssistantSecret(assistantId, binding.id);
      if (secret) {
        secretRecordsByBindingId.set(binding.id, secret);
      }
    } catch {
      // ignore missing secrets
    }
  }
  const templates = await listManagedMcpTemplates();
  const resolvedMcpServers = resolveAssistantMcpServers({
    assistantId,
    legacyTemplateIds: assistant.config.mcpServerIds,
    templates,
    bindings: assistantBindings,
    secretRecordsByBindingId,
  });
  const readRepoBindings = deps.listRepoBindings || listAssistantRepoBindings;
  let repoBindings: AssistantRepoBinding[] = [];
  try {
    repoBindings = await readRepoBindings(assistantId);
  } catch {
    repoBindings = [];
  }
  const enabledRepoBindings = repoBindings.filter((b) => b.enabled);
  const repoBindingDirectories = enabledRepoBindings
    .map((b) => b.worktree_path || b.local_path)
    .filter(Boolean) as string[];
  const repoProjectRoot = repoBindingDirectories[0] || undefined;

  const assistantProviderIdStr = assistant?.config.providerId?.trim() || null;
  const effectiveProviderId = convProviderId || assistantProviderIdStr;
  const provider = effectiveProviderId
    ? await readProvider(effectiveProviderId)
    : undefined;

  const effectiveModel = convModel
    || assistant.config.model
    || provider?.model
    || undefined;

  return {
    assistantId,
    assistantName: assistant.name,
    managedSkillIds: assistant.config.skillIds,
    managedMcpServerIds: assistant.config.mcpServerIds,
    userSkillIds: assistant.config.userSkillIds.length > 0
      ? assistant.config.userSkillIds : undefined,
    userMcpServerIds: assistant.config.userMcpServerIds.length > 0
      ? assistant.config.userMcpServerIds : undefined,
    managedKbIds: assistant.config.kbIds,
    resolvedMcpServers,
    persona: assistant.config.persona,
    repoBindingDirectories: repoBindingDirectories.length > 0 ? repoBindingDirectories : undefined,
    projectRootOverride: repoProjectRoot,
    providerOverrideId: provider?.id || effectiveProviderId || undefined,
    modelOverride: effectiveModel,
    providerType: provider?.type || null,
    soulSystemPrompt:
      await buildConversationSoulSystemPrompt(options.soulPrompt) || undefined,
    instructionsAppend: await buildResolvedAssistantInstructionsAppend({
      assistant,
      customInstructions: group.agentConfig?.customInstructions,
    }),
    instructionsMode: assistant.config.rules.mode || 'append',
    providerAlias: provider?.alias || null,
  };
}

export async function buildResolvedAssistantInstructionsAppend(input: {
  assistant: Pick<AssistantSummary, 'name' | 'config'> | null | undefined;
  customInstructions?: string | null;
}): Promise<string | undefined> {
  const base = await buildAssistantInstructionsAppend(input.assistant);
  const custom = input.customInstructions?.trim();
  if (!custom) {
    return base || undefined;
  }
  return [base, custom].filter(Boolean).join('\n\n') || undefined;
}

export async function resolveProviderOverride(
  providerId: string | undefined,
  deps: {
    getProviderById?: typeof getProvider;
  } = {},
): Promise<AiProvider | undefined> {
  const id = providerId?.trim();
  if (!id) return undefined;
  const readProvider = deps.getProviderById || getProvider;
  return readProvider(id);
}
