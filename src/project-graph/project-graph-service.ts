import type { RepositoryInfo } from '../repo-review/repository-service.js';
import { loadCodeIndexSnapshot } from '../db/code-index-db.js';
import type { CodeIndexChunkRecord } from '../code-intelligence/code-index-types.js';
import {
  createProjectGraphRun,
  finishProjectGraphRun,
  getLatestProjectGraphRun,
  listProjectGraphDocuments,
  listProjectGraphEdges,
  listProjectGraphFacts,
  listProjectGraphRuns,
  replaceProjectGraphRunArtifacts,
  type ProjectGraphConfidence,
  type ProjectGraphDocumentRecord,
  type ProjectGraphEdgeRecord,
  type ProjectGraphFactRecord,
  type ProjectGraphFactSource,
  type ProjectGraphRunRecord,
} from '../db/project-graph.js';

export interface ProjectGraphConfig {
  enabled: boolean;
  scanners: string[];
  skillIds: string[];
  mcpServerIds: string[];
  includePaths: string[];
  excludePaths: string[];
  serviceNames: {
    production: string;
    testing: string;
    nacosKeys: string[];
    logServiceNames: string[];
  };
  owners: string[];
  businessDomain: string;
  systemAliases: string[];
  databaseBindings: string[];
  logBindings: string[];
}

export interface ProjectGraphOverview {
  repositoryId: string;
  config: ProjectGraphConfig;
  latestRun: ProjectGraphRunRecord | null;
  facts: ProjectGraphFactInfo[];
  edges: ProjectGraphEdgeInfo[];
  documents: ProjectGraphDocumentInfo[];
  runs: ProjectGraphRunRecord[];
}

export interface ProjectGraphResourceContext {
  repositoryId: string;
  enabled: boolean;
  latestRunStatus: string;
  latestRunAt: string | null;
  serviceNames: string[];
  logServiceNames: string[];
  nacosKeys: string[];
  owners: string[];
  businessDomain: string;
  skillIds: string[];
  mcpServerIds: string[];
  downstreamServices: string[];
  tables: Array<{
    name: string;
    relation: string;
    confidence: ProjectGraphConfidence;
  }>;
  documents: Array<{
    docType: string;
    title: string;
    status: string;
  }>;
}

export interface ProjectGraphFactInfo {
  id: string;
  kind: string;
  name: string;
  value: Record<string, unknown>;
  source: ProjectGraphFactSource;
  confidence: ProjectGraphConfidence;
  locked: boolean;
  evidence: ProjectGraphEvidence[];
  updatedAt: string;
}

export interface ProjectGraphEdgeInfo {
  id: string;
  fromKind: string;
  fromName: string;
  relation: string;
  toKind: string;
  toName: string;
  confidence: ProjectGraphConfidence;
  evidence: ProjectGraphEvidence[];
}

export interface ProjectGraphDocumentInfo {
  id: string;
  docType: string;
  title: string;
  status: string;
  content: string;
  source: ProjectGraphFactSource;
  confidence: ProjectGraphConfidence;
  updatedAt: string;
}

interface ProjectGraphEvidence {
  label: string;
  filePath?: string;
  line?: number;
  summary?: string;
}

const SCANNER_VERSION = 'project-graph-v1';

export const DEFAULT_PROJECT_GRAPH_CONFIG: ProjectGraphConfig = {
  enabled: true,
  scanners: [
    'overview',
    'docs',
    'runtime_config',
    'service_dependencies',
    'database_usage',
  ],
  skillIds: [],
  mcpServerIds: [],
  includePaths: [],
  excludePaths: ['node_modules/**', 'dist/**', 'build/**', 'target/**'],
  serviceNames: {
    production: '',
    testing: '',
    nacosKeys: [],
    logServiceNames: [],
  },
  owners: [],
  businessDomain: '',
  systemAliases: [],
  databaseBindings: [],
  logBindings: [],
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeServiceNames(
  value: unknown,
): ProjectGraphConfig['serviceNames'] {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    production: String(raw.production || '').trim(),
    testing: String(raw.testing || '').trim(),
    nacosKeys: asStringArray(raw.nacosKeys),
    logServiceNames: asStringArray(raw.logServiceNames),
  };
}

export function normalizeProjectGraphConfig(
  input: unknown,
): ProjectGraphConfig {
  const raw =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    enabled:
      typeof raw.enabled === 'boolean'
        ? raw.enabled
        : DEFAULT_PROJECT_GRAPH_CONFIG.enabled,
    scanners:
      asStringArray(raw.scanners).length > 0
        ? asStringArray(raw.scanners)
        : [...DEFAULT_PROJECT_GRAPH_CONFIG.scanners],
    skillIds: asStringArray(raw.skillIds),
    mcpServerIds: asStringArray(raw.mcpServerIds),
    includePaths: asStringArray(raw.includePaths),
    excludePaths:
      asStringArray(raw.excludePaths).length > 0
        ? asStringArray(raw.excludePaths)
        : [...DEFAULT_PROJECT_GRAPH_CONFIG.excludePaths],
    serviceNames: normalizeServiceNames(raw.serviceNames),
    owners: asStringArray(raw.owners),
    businessDomain: String(raw.businessDomain || '').trim(),
    systemAliases: asStringArray(raw.systemAliases),
    databaseBindings: asStringArray(raw.databaseBindings),
    logBindings: asStringArray(raw.logBindings),
  };
}

export function getProjectGraphConfigFromRepository(
  repository: RepositoryInfo,
): ProjectGraphConfig {
  const feature = repository.features.find(
    (item) => item.featureType === 'project_graph',
  );
  return normalizeProjectGraphConfig({
    ...feature?.config,
    enabled: feature ? feature.enabled : DEFAULT_PROJECT_GRAPH_CONFIG.enabled,
  });
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toFactInfo(record: ProjectGraphFactRecord): ProjectGraphFactInfo {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    value: parseJson(record.value_json, {}),
    source: record.source,
    confidence: record.confidence,
    locked: record.locked === 1,
    evidence: parseJson<ProjectGraphEvidence[]>(record.evidence_json, []),
    updatedAt: record.updated_at,
  };
}

function toEdgeInfo(record: ProjectGraphEdgeRecord): ProjectGraphEdgeInfo {
  return {
    id: record.id,
    fromKind: record.from_kind,
    fromName: record.from_name,
    relation: record.relation,
    toKind: record.to_kind,
    toName: record.to_name,
    confidence: record.confidence,
    evidence: parseJson<ProjectGraphEvidence[]>(record.evidence_json, []),
  };
}

function toDocumentInfo(
  record: ProjectGraphDocumentRecord,
): ProjectGraphDocumentInfo {
  return {
    id: record.id,
    docType: record.doc_type,
    title: record.title,
    status: record.status,
    content: record.content,
    source: record.source,
    confidence: record.confidence,
    updatedAt: record.updated_at,
  };
}

export async function getProjectGraphOverview(
  repository: RepositoryInfo,
): Promise<ProjectGraphOverview> {
  const latestRun = (await getLatestProjectGraphRun(repository.id)) || null;
  const runId = latestRun?.id;
  const [facts, edges, documents, runs] = await Promise.all([
    listProjectGraphFacts(repository.id, runId),
    listProjectGraphEdges(repository.id, runId),
    listProjectGraphDocuments(repository.id, runId),
    listProjectGraphRuns(repository.id, 20),
  ]);
  return {
    repositoryId: repository.id,
    config: getProjectGraphConfigFromRepository(repository),
    latestRun,
    facts: facts.map(toFactInfo),
    edges: edges.map(toEdgeInfo),
    documents: documents.map(toDocumentInfo),
    runs,
  };
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

export function buildProjectGraphResourceContext(
  overview: ProjectGraphOverview,
): ProjectGraphResourceContext {
  const config = overview.config;
  return {
    repositoryId: overview.repositoryId,
    enabled: config.enabled,
    latestRunStatus: overview.latestRun?.status || 'missing',
    latestRunAt: overview.latestRun?.created_at || null,
    serviceNames: uniqueStrings([
      config.serviceNames.production,
      config.serviceNames.testing,
      ...config.systemAliases,
    ]),
    logServiceNames: uniqueStrings(config.serviceNames.logServiceNames),
    nacosKeys: uniqueStrings(config.serviceNames.nacosKeys),
    owners: uniqueStrings(config.owners),
    businessDomain: config.businessDomain,
    skillIds: uniqueStrings(config.skillIds),
    mcpServerIds: uniqueStrings(config.mcpServerIds),
    downstreamServices: uniqueStrings(
      overview.edges
        .filter((edgeItem) => edgeItem.relation === 'calls')
        .map((edgeItem) => edgeItem.toName),
    ).slice(0, 20),
    tables: overview.facts
      .filter((factItem) => factItem.kind === 'database_table')
      .map((factItem) => ({
        name: factItem.name,
        relation: String(factItem.value.relation || ''),
        confidence: factItem.confidence,
      }))
      .slice(0, 30),
    documents: overview.documents
      .map((documentItem) => ({
        docType: documentItem.docType,
        title: documentItem.title,
        status: documentItem.status,
      }))
      .slice(0, 20),
  };
}

export function formatProjectGraphContextsForAssistant(
  contexts: Array<{
    repositoryName: string;
    context: ProjectGraphResourceContext;
  }>,
): string {
  const enabled = contexts.filter((item) => item.context.enabled);
  if (!enabled.length) return '';
  const lines = [
    'Project graph context is available for bound repositories. Treat these entries as repository-scoped routing, runtime, data, and extension hints. Verify low-confidence code-derived facts before acting.',
  ];
  for (const item of enabled) {
    const context = item.context;
    lines.push(`- Repository: ${item.repositoryName}`);
    if (context.serviceNames.length) {
      lines.push(`  Services: ${context.serviceNames.join(', ')}`);
    }
    if (context.owners.length || context.businessDomain) {
      lines.push(
        `  Ownership: ${[
          context.businessDomain ? `domain=${context.businessDomain}` : '',
          context.owners.length ? `owners=${context.owners.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; ')}`,
      );
    }
    if (context.logServiceNames.length) {
      lines.push(`  Log service names: ${context.logServiceNames.join(', ')}`);
    }
    if (context.nacosKeys.length) {
      lines.push(`  Config keys: ${context.nacosKeys.join(', ')}`);
    }
    if (context.downstreamServices.length) {
      lines.push(
        `  Downstream services: ${context.downstreamServices.join(', ')}`,
      );
    }
    if (context.tables.length) {
      lines.push(
        `  Tables: ${context.tables
          .slice(0, 12)
          .map((table) => `${table.name}(${table.relation || 'related'})`)
          .join(', ')}`,
      );
    }
    if (context.skillIds.length || context.mcpServerIds.length) {
      lines.push(
        `  Suggested extensions: ${[
          context.skillIds.length ? `skills=${context.skillIds.join(', ')}` : '',
          context.mcpServerIds.length
            ? `mcp=${context.mcpServerIds.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('; ')}`,
      );
    }
  }
  return lines.join('\n');
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function fact(input: {
  kind: string;
  name: string;
  value: Record<string, unknown>;
  source: ProjectGraphFactSource;
  confidence: ProjectGraphConfidence;
  locked?: boolean;
  evidence?: ProjectGraphEvidence[];
}): Omit<
  ProjectGraphFactRecord,
  'id' | 'repository_id' | 'run_id' | 'created_at' | 'updated_at'
> {
  return {
    kind: input.kind,
    name: input.name,
    value_json: json(input.value),
    source: input.source,
    confidence: input.confidence,
    locked: input.locked ? 1 : 0,
    evidence_json: json(input.evidence || []),
  };
}

function edge(input: {
  fromKind: string;
  fromName: string;
  relation: string;
  toKind: string;
  toName: string;
  confidence: ProjectGraphConfidence;
  evidence?: ProjectGraphEvidence[];
}): Omit<
  ProjectGraphEdgeRecord,
  'id' | 'repository_id' | 'run_id' | 'created_at'
> {
  return {
    from_kind: input.fromKind,
    from_name: input.fromName,
    relation: input.relation,
    to_kind: input.toKind,
    to_name: input.toName,
    confidence: input.confidence,
    evidence_json: json(input.evidence || []),
  };
}

function document(input: {
  docType: string;
  title: string;
  status: string;
  content: string;
  source: ProjectGraphFactSource;
  confidence: ProjectGraphConfidence;
}): Omit<
  ProjectGraphDocumentRecord,
  'id' | 'repository_id' | 'run_id' | 'created_at' | 'updated_at'
> {
  return {
    doc_type: input.docType,
    title: input.title,
    status: input.status,
    content: input.content,
    source: input.source,
    confidence: input.confidence,
  };
}

function inferTechStack(input: {
  repository: RepositoryInfo;
  filePaths: string[];
}): string[] {
  const stack = new Set<string>();
  if (input.repository.language) stack.add(input.repository.language);
  for (const item of input.repository.techStack || []) stack.add(item);
  const paths = input.filePaths.map((item) => item.toLowerCase());
  if (paths.includes('package.json')) stack.add('Node.js');
  if (paths.includes('vite.config.ts') || paths.includes('vite.config.js'))
    stack.add('Vite');
  if (paths.some((item) => item.endsWith('pom.xml'))) stack.add('Maven');
  if (paths.some((item) => item.includes('build.gradle'))) stack.add('Gradle');
  if (paths.some((item) => item.includes('spring'))) stack.add('Spring');
  if (paths.some((item) => item.endsWith('dockerfile'))) stack.add('Docker');
  return Array.from(stack).filter(Boolean);
}

interface ProjectGraphCandidate {
  name: string;
  relation: string;
  confidence: ProjectGraphConfidence;
  evidence: ProjectGraphEvidence[];
  metadata?: Record<string, unknown>;
}

function normalizeCandidateName(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^\$\{|\}$/g, '')
    .trim();
}

function urlToServiceName(value: string): string {
  const raw = normalizeCandidateName(value);
  try {
    const parsed = new URL(raw);
    return parsed.host || raw;
  } catch {
    return raw;
  }
}

function pushCandidate(
  map: Map<string, ProjectGraphCandidate>,
  input: ProjectGraphCandidate,
): void {
  const key = `${input.relation}\0${input.name}`;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, input);
    return;
  }
  existing.evidence.push(...input.evidence);
}

export function extractServiceDependencyCandidates(
  chunks: CodeIndexChunkRecord[],
): ProjectGraphCandidate[] {
  const candidates = new Map<string, ProjectGraphCandidate>();
  const feignRegex =
    /@FeignClient\s*\([^)]*(?:name|value|contextId)\s*=\s*["']([^"']+)["'][^)]*\)/g;
  const dubboRegex =
    /@(?:DubboReference|Reference)\s*\([^)]*(?:interfaceName|url|group|version|id)\s*=\s*["']([^"']+)["'][^)]*\)/g;
  const httpRegex =
    /\b(?:fetch|axios\.(?:get|post|put|delete|patch)|baseURL\s*:|url\s*:)\s*\(?\s*["'`]((?:https?:\/\/|\/api\/)[^"'`)\s]+)["'`]/g;

  for (const chunk of chunks) {
    const evidence: ProjectGraphEvidence = {
      label: chunk.filePath,
      filePath: chunk.filePath,
      line: chunk.startLine,
      summary: chunk.summary || undefined,
    };
    for (const match of chunk.content.matchAll(feignRegex)) {
      const name = normalizeCandidateName(match[1] || '');
      if (!name) continue;
      pushCandidate(candidates, {
        name,
        relation: 'calls',
        confidence: 'medium',
        evidence: [evidence],
        metadata: { protocol: 'feign' },
      });
    }
    for (const match of chunk.content.matchAll(dubboRegex)) {
      const name = normalizeCandidateName(match[1] || '');
      if (!name) continue;
      pushCandidate(candidates, {
        name,
        relation: 'calls',
        confidence: 'medium',
        evidence: [evidence],
        metadata: { protocol: 'dubbo' },
      });
    }
    for (const match of chunk.content.matchAll(httpRegex)) {
      const name = urlToServiceName(match[1] || '');
      if (!name) continue;
      pushCandidate(candidates, {
        name,
        relation: 'calls',
        confidence: name.startsWith('/api/') ? 'low' : 'medium',
        evidence: [evidence],
        metadata: { protocol: 'http' },
      });
    }
  }

  return Array.from(candidates.values()).slice(0, 50);
}

export function extractDatabaseTableCandidates(
  chunks: CodeIndexChunkRecord[],
): ProjectGraphCandidate[] {
  const candidates = new Map<string, ProjectGraphCandidate>();
  const tableAnnotationRegex =
    /@(?:TableName|Table)\s*\([^)]*(?:name\s*=\s*)?["']([a-zA-Z_][\w.]+)["'][^)]*\)/g;
  const sqlTableRegex =
    /\b(from|join|update|into|table)\s+([a-zA-Z_][\w.]*)/gi;

  for (const chunk of chunks) {
    const evidence: ProjectGraphEvidence = {
      label: chunk.filePath,
      filePath: chunk.filePath,
      line: chunk.startLine,
      summary: chunk.summary || undefined,
    };
    for (const match of chunk.content.matchAll(tableAnnotationRegex)) {
      const name = normalizeCandidateName(match[1] || '');
      if (!name) continue;
      pushCandidate(candidates, {
        name,
        relation: 'owns_table',
        confidence: 'medium',
        evidence: [evidence],
        metadata: { source: 'table_annotation' },
      });
    }
    for (const match of chunk.content.matchAll(sqlTableRegex)) {
      const keyword = String(match[1] || '').toLowerCase();
      const name = normalizeCandidateName(match[2] || '');
      if (!name) continue;
      const relation =
        keyword === 'from' || keyword === 'join'
          ? 'reads_table'
          : keyword === 'table'
            ? 'migrates_table'
            : 'writes_table';
      pushCandidate(candidates, {
        name,
        relation,
        confidence: 'medium',
        evidence: [evidence],
        metadata: { keyword },
      });
    }
  }

  return Array.from(candidates.values()).slice(0, 100);
}

function formatEvidenceFromFiles(
  files: Array<{ relativePath: string; summary: string; rank: number }>,
  limit: number,
): ProjectGraphEvidence[] {
  return files.slice(0, limit).map((file) => ({
    label: file.relativePath,
    filePath: file.relativePath,
    summary: file.summary || undefined,
  }));
}

function buildOverviewDocument(input: {
  repository: RepositoryInfo;
  config: ProjectGraphConfig;
  topFiles: Array<{ relativePath: string; summary: string; rank: number }>;
  techStack: string[];
}): string {
  const repo = input.repository;
  const lines = [
    `# ${repo.name} 项目概览`,
    '',
    `- 业务域: ${input.config.businessDomain || '未配置'}`,
    `- 默认分支: ${repo.defaultTargetBranch || 'main'}`,
    `- 技术栈: ${input.techStack.join(', ') || '待扫描补全'}`,
    `- 生产服务名: ${input.config.serviceNames.production || '未配置'}`,
    `- 测试服务名: ${input.config.serviceNames.testing || '未配置'}`,
    `- 负责人: ${input.config.owners.join(', ') || '未配置'}`,
    '',
    '## 项目职责',
    repo.aiDescription ||
      '当前扫描尚未获得人工维护的项目描述，可在项目图谱配置中补充业务说明。',
    '',
    '## 关键代码入口',
  ];
  for (const file of input.topFiles.slice(0, 8)) {
    lines.push(`- ${file.relativePath}${file.summary ? `: ${file.summary}` : ''}`);
  }
  return lines.join('\n');
}

function buildCodeIndexDocument(input: {
  repository: RepositoryInfo;
  branch: string;
  topFiles: Array<{ relativePath: string; summary: string; rank: number }>;
}): string {
  const lines = [
    `# ${input.repository.name} 代码索引`,
    '',
    `分支: ${input.branch}`,
    '',
    '## 优先阅读入口',
  ];
  for (const file of input.topFiles.slice(0, 12)) {
    lines.push(`- ${file.relativePath}${file.summary ? `: ${file.summary}` : ''}`);
  }
  return lines.join('\n');
}

function buildAiRulesDocument(input: {
  repository: RepositoryInfo;
  config: ProjectGraphConfig;
}): string {
  return [
    `# ${input.repository.name} AI 开发规范`,
    '',
    '- 修改前先阅读项目概览、代码索引和相关模块实现。',
    '- 涉及服务名、配置中心、日志、数据库时，优先使用项目图谱中的人工配置。',
    '- LLM 扫描出的低置信事实只能作为候选，提交结论前必须回到代码或外部系统验证。',
    `- 默认分支为 ${input.repository.defaultTargetBranch || 'main'}。`,
    input.config.owners.length
      ? `- 需要人工确认时优先联系: ${input.config.owners.join(', ')}。`
      : '- 负责人未配置时，不要猜测归属人。',
  ].join('\n');
}

export async function runProjectGraphScan(input: {
  repository: RepositoryInfo;
  config: ProjectGraphConfig;
  userId: string;
}): Promise<ProjectGraphOverview> {
  const branch = input.repository.defaultTargetBranch || 'main';
  const indexData = await loadCodeIndexSnapshot(
    input.repository.id,
    branch,
  );
  const run = await createProjectGraphRun({
    repositoryId: input.repository.id,
    branch,
    scannerVersion: SCANNER_VERSION,
    sourceHeadSha: indexData?.meta.sourceHeadSha || '',
    createdBy: input.userId,
  });

  try {
    const files = indexData?.files || [];
    const chunks = indexData?.chunks || [];
    const topFiles = files
      .slice()
      .sort((left, right) => right.rank - left.rank)
      .slice(0, 20)
      .map((file) => ({
        relativePath: file.relativePath,
        summary: file.summary,
        rank: file.rank,
      }));
    const filePaths = files.map((file) => file.relativePath);
    const techStack = inferTechStack({
      repository: input.repository,
      filePaths,
    });
    const evidence = formatEvidenceFromFiles(topFiles, 8);
    const serviceName =
      input.config.serviceNames.production ||
      input.config.serviceNames.testing ||
      input.repository.name;
    const enabledScanners = new Set(input.config.scanners);
    const serviceDependencies = enabledScanners.has('service_dependencies')
      ? extractServiceDependencyCandidates(chunks)
      : [];
    const databaseTables = enabledScanners.has('database_usage')
      ? extractDatabaseTableCandidates(chunks)
      : [];

    const facts = [
      fact({
        kind: 'project_overview',
        name: input.repository.name,
        value: {
          description: input.repository.aiDescription || '',
          businessDomain: input.config.businessDomain,
          aliases: input.config.systemAliases,
          defaultBranch: branch,
        },
        source: input.repository.aiDescription ? 'manual' : 'code_index',
        confidence: input.repository.aiDescription ? 'high' : 'medium',
        locked: Boolean(input.repository.aiDescription),
        evidence,
      }),
      fact({
        kind: 'tech_stack',
        name: 'detected',
        value: { items: techStack },
        source: 'code_index',
        confidence: techStack.length ? 'medium' : 'low',
        evidence,
      }),
      fact({
        kind: 'ownership',
        name: 'owners',
        value: {
          owners: input.config.owners,
          businessDomain: input.config.businessDomain,
        },
        source: 'manual',
        confidence: input.config.owners.length ? 'high' : 'low',
        locked: input.config.owners.length > 0,
        evidence: [],
      }),
      fact({
        kind: 'runtime_config',
        name: 'service_names',
        value: input.config.serviceNames,
        source: 'manual',
        confidence:
          input.config.serviceNames.production ||
          input.config.serviceNames.testing ||
          input.config.serviceNames.logServiceNames.length
            ? 'high'
            : 'low',
        locked: true,
        evidence: [],
      }),
      fact({
        kind: 'scanner_config',
        name: 'bindings',
        value: {
          scanners: input.config.scanners,
          skillIds: input.config.skillIds,
          mcpServerIds: input.config.mcpServerIds,
          databaseBindings: input.config.databaseBindings,
          logBindings: input.config.logBindings,
        },
        source: 'manual',
        confidence: 'medium',
        locked: true,
        evidence: [],
      }),
      ...serviceDependencies.map((candidate) =>
        fact({
          kind: 'service_dependency',
          name: candidate.name,
          value: {
            relation: candidate.relation,
            ...candidate.metadata,
          },
          source: 'code_index' as const,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        }),
      ),
      ...databaseTables.map((candidate) =>
        fact({
          kind: 'database_table',
          name: candidate.name,
          value: {
            relation: candidate.relation,
            ...candidate.metadata,
          },
          source: 'code_index' as const,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        }),
      ),
    ];

    const edges = [];
    edges.push(
      edge({
        fromKind: 'project',
        fromName: input.repository.name,
        relation: 'runs_as',
        toKind: 'service',
        toName: serviceName,
        confidence: input.config.serviceNames.production ? 'high' : 'medium',
      }),
    );
    for (const name of input.config.serviceNames.logServiceNames) {
      edges.push(
        edge({
          fromKind: 'service',
          fromName: serviceName,
          relation: 'logs_as',
          toKind: 'log_service',
          toName: name,
          confidence: 'high',
        }),
      );
    }
    for (const candidate of serviceDependencies) {
      edges.push(
        edge({
          fromKind: 'service',
          fromName: serviceName,
          relation: candidate.relation,
          toKind: 'service',
          toName: candidate.name,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        }),
      );
    }
    for (const candidate of databaseTables) {
      edges.push(
        edge({
          fromKind: 'service',
          fromName: serviceName,
          relation: candidate.relation,
          toKind: 'table',
          toName: candidate.name,
          confidence: candidate.confidence,
          evidence: candidate.evidence,
        }),
      );
    }
    for (const key of input.config.serviceNames.nacosKeys) {
      edges.push(
        edge({
          fromKind: 'service',
          fromName: serviceName,
          relation: 'configured_by',
          toKind: 'nacos_key',
          toName: key,
          confidence: 'high',
        }),
      );
    }

    const documents = [
      document({
        docType: 'project_overview',
        title: '项目概览',
        status: 'draft',
        content: buildOverviewDocument({
          repository: input.repository,
          config: input.config,
          topFiles,
          techStack,
        }),
        source: 'code_index',
        confidence: indexData ? 'medium' : 'low',
      }),
      document({
        docType: 'code_index',
        title: '代码索引',
        status: indexData ? 'draft' : 'stale',
        content: buildCodeIndexDocument({
          repository: input.repository,
          branch,
          topFiles,
        }),
        source: 'code_index',
        confidence: indexData ? 'medium' : 'low',
      }),
      document({
        docType: 'ai_development_rules',
        title: 'AI 开发规范',
        status: 'draft',
        content: buildAiRulesDocument({
          repository: input.repository,
          config: input.config,
        }),
        source: 'manual',
        confidence: 'medium',
      }),
    ];

    await replaceProjectGraphRunArtifacts({
      repositoryId: input.repository.id,
      runId: run.id,
      facts,
      edges,
      documents,
    });
    await finishProjectGraphRun(run.id, 'completed', run.started_at);
  } catch (err) {
    await finishProjectGraphRun(
      run.id,
      'failed',
      run.started_at,
      err instanceof Error ? err.message : String(err),
    );
  }

  return getProjectGraphOverview(input.repository);
}
