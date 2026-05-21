import { useEffect, useMemo, useState } from 'react';

import type {
  ProjectGraphConfig,
  ProjectGraphDocument,
  ProjectGraphFact,
  ProjectGraphOverview,
} from '../../app-types';
import {
  fetchProjectGraphOverview,
  saveProjectGraphConfig,
  scanProjectGraph,
} from './api';

interface ProjectGraphPanelProps {
  apiBase: string;
  repositoryId: string;
  repositoryName: string;
}

const DEFAULT_CONFIG: ProjectGraphConfig = {
  enabled: true,
  scanners: ['overview', 'docs', 'runtime_config'],
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

function listToText(items: string[]): string {
  return items.join(', ');
}

function textToList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function confidenceLabel(value: string): string {
  switch (value) {
    case 'high':
      return '高置信';
    case 'medium':
      return '中置信';
    case 'low':
      return '低置信';
    default:
      return value;
  }
}

function factDisplayValue(fact: ProjectGraphFact): string {
  if (Array.isArray(fact.value.items)) return fact.value.items.join(', ');
  if (Array.isArray(fact.value.owners)) return fact.value.owners.join(', ');
  if (typeof fact.value.description === 'string' && fact.value.description) {
    return fact.value.description;
  }
  return JSON.stringify(fact.value);
}

function ProjectGraphFactList({ facts }: { facts: ProjectGraphFact[] }) {
  if (!facts.length) {
    return <div className="repo-review-empty-hint">暂无项目事实，先运行一次扫描。</div>;
  }
  return (
    <div className="assistant-validation-list">
      {facts.map((fact) => (
        <div key={fact.id} className="assistant-validation-item">
          <div className="assistant-validation-item-copy">
            <strong>
              {fact.kind} · {fact.name}
            </strong>
            <p>{factDisplayValue(fact)}</p>
            <div className="repo-review-run-meta">
              <span>{confidenceLabel(fact.confidence)}</span>
              <span>{fact.source}</span>
              {fact.locked ? <span>人工锁定</span> : null}
              {fact.evidence[0]?.filePath ? (
                <span>{fact.evidence[0].filePath}</span>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectGraphDocumentList({
  documents,
}: {
  documents: ProjectGraphDocument[];
}) {
  if (!documents.length) {
    return <div className="repo-review-empty-hint">暂无文档草稿。</div>;
  }
  return (
    <div className="repo-review-run-list">
      {documents.map((doc) => (
        <details key={doc.id} className="repo-review-run-card">
          <summary className="repo-review-card-header repo-review-card-header--summary">
            <div className="repo-review-card-header-title">
              <strong>{doc.title}</strong>
              <span className="settings-hint">
                {doc.status} · {doc.source} · {confidenceLabel(doc.confidence)}
              </span>
            </div>
          </summary>
          <pre className="repo-review-run-summary">{doc.content}</pre>
        </details>
      ))}
    </div>
  );
}

export function ProjectGraphPanel({
  apiBase,
  repositoryId,
  repositoryName,
}: ProjectGraphPanelProps) {
  const [overview, setOverview] = useState<ProjectGraphOverview | null>(null);
  const [config, setConfig] = useState<ProjectGraphConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void fetchProjectGraphOverview(apiBase, repositoryId)
      .then((data) => {
        if (cancelled) return;
        setOverview(data);
        setConfig(data.config);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, repositoryId]);

  const groupedFacts = useMemo(() => {
    const facts = overview?.facts || [];
    return {
      profile: facts.filter((fact) =>
        ['project_overview', 'tech_stack', 'ownership', 'runtime_config'].includes(
          fact.kind,
        ),
      ),
      config: facts.filter((fact) => fact.kind === 'scanner_config'),
    };
  }, [overview]);

  const updateConfig = (updates: Partial<ProjectGraphConfig>) => {
    setConfig((current) => ({ ...current, ...updates }));
  };

  const updateServiceNames = (
    updates: Partial<ProjectGraphConfig['serviceNames']>,
  ) => {
    setConfig((current) => ({
      ...current,
      serviceNames: { ...current.serviceNames, ...updates },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const next = await saveProjectGraphConfig(apiBase, repositoryId, config);
      setOverview(next);
      setConfig(next.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    setError('');
    try {
      const next = await scanProjectGraph(apiBase, repositoryId, config);
      setOverview(next);
      setConfig(next.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="repo-review-framework-shell">
      <div className="repo-review-card repo-review-framework-header">
        <div className="repo-review-framework-header-copy">
          <span className="repo-review-overview-kicker">Project Graph</span>
          <h3>{repositoryName}</h3>
          <div className="settings-hint">
            项目画像、服务名、负责人、数据资产和 AI 开发文档的项目级索引。
          </div>
        </div>
        <div className="repo-review-framework-header-actions">
          <button
            type="button"
            className="btn-outline btn-sm"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={handleScan}
            disabled={scanning || loading}
          >
            {scanning ? '扫描中...' : '扫描项目图谱'}
          </button>
        </div>
      </div>

      {error ? <div className="repo-review-progress-error">{error}</div> : null}

      <div className="repo-review-workspace-grid repo-review-workspace-grid--framework">
        <div className="repo-review-workspace-card repo-review-workspace-card--framework">
          <div className="repo-review-workspace-card-topline">
            <span>最近扫描</span>
            <span className="repo-review-source-pill tone-neutral">
              {overview?.latestRun?.status || 'missing'}
            </span>
          </div>
          <strong className="repo-review-workspace-card-value">
            {overview?.latestRun?.created_at
              ? new Date(overview.latestRun.created_at).toLocaleString()
              : '未扫描'}
          </strong>
          <div className="settings-hint">
            {overview?.latestRun?.source_head_sha || '等待生成项目事实'}
          </div>
        </div>
        <div className="repo-review-workspace-card repo-review-workspace-card--framework">
          <div className="repo-review-workspace-card-topline">
            <span>事实</span>
            <span className="repo-review-source-pill tone-success">
              {overview?.facts.length || 0}
            </span>
          </div>
          <strong className="repo-review-workspace-card-value">
            {overview?.edges.length || 0} 条关系
          </strong>
          <div className="settings-hint">服务、配置、负责人、代码证据。</div>
        </div>
        <div className="repo-review-workspace-card repo-review-workspace-card--framework">
          <div className="repo-review-workspace-card-topline">
            <span>文档</span>
            <span className="repo-review-source-pill tone-neutral">
              {overview?.documents.length || 0}
            </span>
          </div>
          <strong className="repo-review-workspace-card-value">
            {overview?.documents[0]?.status || 'draft'}
          </strong>
          <div className="settings-hint">项目概览、代码索引、AI 开发规范。</div>
        </div>
      </div>

      <div className="repo-review-framework-content-grid">
        <div className="repo-review-card">
          <div className="repo-review-card-header">
            <div>
              <h4>项目画像</h4>
              <div className="settings-hint">
                扫描结果保留来源和置信度，人工字段优先。
              </div>
            </div>
          </div>
          {loading ? (
            <div className="repo-review-empty-hint">加载中...</div>
          ) : (
            <ProjectGraphFactList facts={groupedFacts.profile} />
          )}
        </div>

        <div className="repo-review-card">
          <div className="repo-review-card-header">
            <div>
              <h4>项目配置</h4>
              <div className="settings-hint">
                这些字段会进入后续工单诊断上下文。
              </div>
            </div>
          </div>
          <div className="repo-review-form-grid">
            <label>
              <span>业务域</span>
              <input
                value={config.businessDomain}
                onChange={(event) =>
                  updateConfig({ businessDomain: event.target.value })
                }
                placeholder="例如: 交易中台"
              />
            </label>
            <label>
              <span>负责人</span>
              <input
                value={listToText(config.owners)}
                onChange={(event) =>
                  updateConfig({ owners: textToList(event.target.value) })
                }
                placeholder="逗号分隔"
              />
            </label>
            <label>
              <span>生产服务名</span>
              <input
                value={config.serviceNames.production}
                onChange={(event) =>
                  updateServiceNames({ production: event.target.value })
                }
              />
            </label>
            <label>
              <span>测试服务名</span>
              <input
                value={config.serviceNames.testing}
                onChange={(event) =>
                  updateServiceNames({ testing: event.target.value })
                }
              />
            </label>
            <label>
              <span>Nacos Key</span>
              <input
                value={listToText(config.serviceNames.nacosKeys)}
                onChange={(event) =>
                  updateServiceNames({ nacosKeys: textToList(event.target.value) })
                }
                placeholder="逗号分隔"
              />
            </label>
            <label>
              <span>日志服务名</span>
              <input
                value={listToText(config.serviceNames.logServiceNames)}
                onChange={(event) =>
                  updateServiceNames({
                    logServiceNames: textToList(event.target.value),
                  })
                }
                placeholder="逗号分隔"
              />
            </label>
            <label>
              <span>Skill IDs</span>
              <input
                value={listToText(config.skillIds)}
                onChange={(event) =>
                  updateConfig({ skillIds: textToList(event.target.value) })
                }
                placeholder="逗号分隔"
              />
            </label>
            <label>
              <span>MCP IDs</span>
              <input
                value={listToText(config.mcpServerIds)}
                onChange={(event) =>
                  updateConfig({ mcpServerIds: textToList(event.target.value) })
                }
                placeholder="逗号分隔"
              />
            </label>
          </div>
        </div>
      </div>

      <div className="repo-review-card">
        <div className="repo-review-card-header">
          <div>
            <h4>关系图谱</h4>
            <div className="settings-hint">当前 MVP 先沉淀服务名、日志名和配置中心关系。</div>
          </div>
        </div>
        {overview?.edges.length ? (
          <div className="assistant-validation-list">
            {overview.edges.map((edge) => (
              <div key={edge.id} className="assistant-validation-item">
                <div className="assistant-validation-item-copy">
                  <strong>
                    {edge.fromName} -- {edge.relation} -- {edge.toName}
                  </strong>
                  <p>
                    {edge.fromKind} 到 {edge.toKind} · {confidenceLabel(edge.confidence)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="repo-review-empty-hint">暂无关系边。</div>
        )}
      </div>

      <div className="repo-review-card">
        <div className="repo-review-card-header">
          <div>
            <h4>文档资产</h4>
            <div className="settings-hint">扫描会生成项目概览、代码索引和 AI 开发规范草稿。</div>
          </div>
        </div>
        <ProjectGraphDocumentList documents={overview?.documents || []} />
      </div>

      {groupedFacts.config.length ? (
        <div className="repo-review-card">
          <div className="repo-review-card-header">
            <div>
              <h4>扫描器绑定</h4>
              <div className="settings-hint">后续服务依赖和数据库扫描会继续复用这些配置。</div>
            </div>
          </div>
          <ProjectGraphFactList facts={groupedFacts.config} />
        </div>
      ) : null}
    </div>
  );
}
