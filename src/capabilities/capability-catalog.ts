import type { AssistantMcpBindingRecord, ManagedMcpTemplate } from '../assistant/assistant-mcp.js';
import type { AssistantSummary } from '../db.js';
import type { UserMcpServerRecord, UserSkillRecord } from '../db/marketplace.js';
import type { AssistantRepoBinding } from '../assistant/assistant-repo.js';
import type { RepositoryInfo } from '../repo-review/repository-service.js';
import type { WorkflowRecord } from '../workflow/types.js';
import {
  getProjectGraphConfigFromRepository,
  type ProjectGraphConfig,
} from '../project-graph/project-graph-service.js';

export type CapabilityNodeType =
  | 'assistant'
  | 'repository'
  | 'project_graph'
  | 'skill'
  | 'mcp_template'
  | 'user_skill'
  | 'user_mcp'
  | 'workflow';

export interface CapabilityNode {
  id: string;
  type: CapabilityNodeType;
  label: string;
  description: string | null;
  enabled: boolean;
  capabilities: string[];
  metadata: Record<string, unknown>;
}

export interface CapabilityEdge {
  source: string;
  target: string;
  relation:
    | 'binds'
    | 'uses'
    | 'recommends'
    | 'has_capability'
    | 'orchestrates';
  metadata?: Record<string, unknown>;
}

export interface CapabilityCatalog {
  generatedAt: string;
  nodes: CapabilityNode[];
  edges: CapabilityEdge[];
}

export interface ManagedSkillCatalogEntry {
  id: string;
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
}

export interface BuildCapabilityCatalogInput {
  assistants: AssistantSummary[];
  repositories: RepositoryInfo[];
  workflows: WorkflowRecord[];
  managedSkills: ManagedSkillCatalogEntry[];
  managedMcpTemplates: ManagedMcpTemplate[];
  userSkills: UserSkillRecord[];
  userMcpServers: UserMcpServerRecord[];
  assistantRepoBindingsByAssistantId?: Map<string, AssistantRepoBinding[]>;
  assistantMcpBindingsByAssistantId?: Map<string, AssistantMcpBindingRecord[]>;
}

function nodeId(type: CapabilityNodeType, id: string): string {
  return `${type}:${id}`;
}

function addNode(nodes: Map<string, CapabilityNode>, node: CapabilityNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

function addEdge(edges: Map<string, CapabilityEdge>, edge: CapabilityEdge): void {
  const key = `${edge.source}->${edge.relation}->${edge.target}`;
  if (!edges.has(key)) {
    edges.set(key, edge);
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function projectGraphEnabled(repository: RepositoryInfo): boolean {
  return repository.features.some(
    (feature) => feature.featureType === 'project_graph' && feature.enabled,
  );
}

function addProjectGraphEdges(input: {
  nodes: Map<string, CapabilityNode>;
  edges: Map<string, CapabilityEdge>;
  repository: RepositoryInfo;
  config: ProjectGraphConfig;
}): void {
  const repositoryNodeId = nodeId('repository', input.repository.id);
  const graphNodeId = nodeId('project_graph', input.repository.id);
  addNode(input.nodes, {
    id: graphNodeId,
    type: 'project_graph',
    label: `${input.repository.name} project graph`,
    description: input.repository.aiDescription || null,
    enabled: input.config.enabled,
    capabilities: [
      'project.route_service',
      'project.map_dependencies',
      'project.map_data_assets',
      'resource.recommend_bindings',
    ],
    metadata: {
      repositoryId: input.repository.id,
      scanners: input.config.scanners,
      owners: input.config.owners,
      businessDomain: input.config.businessDomain,
      serviceNames: input.config.serviceNames,
    },
  });
  addEdge(input.edges, {
    source: repositoryNodeId,
    target: graphNodeId,
    relation: 'has_capability',
  });
  for (const skillId of input.config.skillIds) {
    addEdge(input.edges, {
      source: graphNodeId,
      target: nodeId('skill', skillId),
      relation: 'recommends',
      metadata: { source: 'project_graph_config' },
    });
  }
  for (const serverId of input.config.mcpServerIds) {
    addEdge(input.edges, {
      source: graphNodeId,
      target: nodeId('mcp_template', serverId),
      relation: 'recommends',
      metadata: { source: 'project_graph_config' },
    });
  }
}

export function buildCapabilityCatalog(
  input: BuildCapabilityCatalogInput,
): CapabilityCatalog {
  const nodes = new Map<string, CapabilityNode>();
  const edges = new Map<string, CapabilityEdge>();

  for (const skill of input.managedSkills) {
    addNode(nodes, {
      id: nodeId('skill', skill.id),
      type: 'skill',
      label: skill.name || skill.id,
      description: skill.description || null,
      enabled: skill.enabled !== false,
      capabilities: ['skill.apply_instructions', 'skill.extend_agent_behavior'],
      metadata: { source: skill.source || 'managed' },
    });
  }

  for (const server of input.managedMcpTemplates) {
    addNode(nodes, {
      id: nodeId('mcp_template', server.id),
      type: 'mcp_template',
      label: server.name || server.id,
      description: null,
      enabled: server.enabled !== false,
      capabilities: ['mcp.provide_tools', 'mcp.connect_external_context'],
      metadata: {
        command: server.command,
        args: server.args,
        envKeyCount: Object.keys(server.env || {}).length,
      },
    });
  }

  for (const skill of input.userSkills) {
    addNode(nodes, {
      id: nodeId('user_skill', skill.id),
      type: 'user_skill',
      label: skill.name || skill.id,
      description: skill.description || skill.summary || null,
      enabled: skill.enabled !== 0,
      capabilities: ['skill.apply_instructions', 'skill.user_owned'],
      metadata: {
        visibility: skill.visibility,
        sourceType: skill.source_type,
        sourceRef: skill.source_ref,
      },
    });
  }

  for (const server of input.userMcpServers) {
    addNode(nodes, {
      id: nodeId('user_mcp', server.id),
      type: 'user_mcp',
      label: server.name || server.id,
      description: server.description || null,
      enabled: server.enabled !== 0,
      capabilities: ['mcp.provide_tools', 'mcp.user_owned'],
      metadata: {
        command: server.command,
        args: parseStringArray(parseJsonArray(server.args_json)),
        envKeyCount: Object.keys(parseJsonObject(server.env_json)).length,
        visibility: server.visibility,
        sourceType: server.source_type,
        sourceRef: server.source_ref,
      },
    });
  }

  for (const repository of input.repositories) {
    const hasProjectGraph = projectGraphEnabled(repository);
    addNode(nodes, {
      id: nodeId('repository', repository.id),
      type: 'repository',
      label: repository.name,
      description: repository.aiDescription || null,
      enabled: repository.enabled,
      capabilities: [
        'repository.provide_code_context',
        ...(hasProjectGraph ? ['repository.provide_project_graph'] : []),
      ],
      metadata: {
        language: repository.language,
        defaultBranch: repository.defaultTargetBranch,
        localRepoPath: repository.localRepoPath,
        cloneUrl: repository.cloneUrl,
        techStack: repository.techStack,
      },
    });
    const graphConfig = getProjectGraphConfigFromRepository(repository);
    if (graphConfig.enabled || hasProjectGraph) {
      addProjectGraphEdges({
        nodes,
        edges,
        repository,
        config: graphConfig,
      });
    }
  }

  for (const assistant of input.assistants) {
    const assistantNodeId = nodeId('assistant', assistant.id);
    addNode(nodes, {
      id: assistantNodeId,
      type: 'assistant',
      label: assistant.name,
      description: assistant.description || null,
      enabled: assistant.enabled,
      capabilities: ['assistant.compose_resources', 'assistant.run_chat'],
      metadata: {
        visibility: assistant.visibility,
        providerId: assistant.config.providerId || null,
        model: assistant.config.model || null,
      },
    });
    for (const skillId of assistant.config.skillIds) {
      addEdge(edges, {
        source: assistantNodeId,
        target: nodeId('skill', skillId),
        relation: 'uses',
        metadata: { source: 'assistant_config' },
      });
    }
    for (const skillId of assistant.config.userSkillIds || []) {
      addEdge(edges, {
        source: assistantNodeId,
        target: nodeId('user_skill', skillId),
        relation: 'uses',
        metadata: { source: 'assistant_config' },
      });
    }
    for (const serverId of assistant.config.mcpServerIds) {
      addEdge(edges, {
        source: assistantNodeId,
        target: nodeId('mcp_template', serverId),
        relation: 'uses',
        metadata: { source: 'legacy_assistant_config' },
      });
    }
    for (const serverId of assistant.config.userMcpServerIds || []) {
      addEdge(edges, {
        source: assistantNodeId,
        target: nodeId('user_mcp', serverId),
        relation: 'uses',
        metadata: { source: 'assistant_config' },
      });
    }
    for (const binding of input.assistantRepoBindingsByAssistantId?.get(assistant.id) || []) {
      addEdge(edges, {
        source: assistantNodeId,
        target: nodeId('repository', binding.repository_id),
        relation: 'binds',
        metadata: {
          bindingId: binding.id,
          branch: binding.active_branch || binding.default_branch,
          enabled: binding.enabled === 1,
        },
      });
    }
    for (const binding of input.assistantMcpBindingsByAssistantId?.get(assistant.id) || []) {
      addEdge(edges, {
        source: assistantNodeId,
        target: nodeId('mcp_template', binding.template_server_id),
        relation: 'binds',
        metadata: {
          bindingId: binding.id,
          enabled: binding.enabled === 1,
        },
      });
    }
  }

  for (const workflow of input.workflows) {
    const workflowNodeId = nodeId('workflow', workflow.id);
    const workflowConfig = parseJsonObject(workflow.workflow_config);
    addNode(nodes, {
      id: workflowNodeId,
      type: 'workflow',
      label: workflow.name,
      description: workflow.description || null,
      enabled: workflow.status !== 'archived',
      capabilities: ['workflow.orchestrate_capabilities', 'workflow.compose_steps'],
      metadata: {
        status: workflow.status,
        kind: workflowConfig.kind || null,
        editorMode: workflowConfig.editorMode || null,
      },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  };
}
