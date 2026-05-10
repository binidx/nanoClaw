import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ExtensionHealthStatus,
  UserMcpServerView,
  UserSkillView,
} from '../../app-types';
import { AppCard, type AppCardSource } from './AppCard';
import { AppCardGrid } from './AppCardGrid';
import { McpAiCreateDrawer } from './McpAiCreateDrawer';
import { McpCreateDrawer } from './McpCreateDrawer';
import { McpImportDrawer } from './McpImportDrawer';
import { SkillCreateDrawer } from './SkillCreateDrawer';
import { SkillImportDrawer } from './SkillImportDrawer';

type StatusFilter = 'all' | 'enabled' | 'disabled';
type TypeFilter = 'all' | 'mcp' | 'skill';

export interface MyAppsPanelProps {
  mcpServers: UserMcpServerView[];
  skills: UserSkillView[];
  loading: boolean;
  onCreateMcp: (input: {
    name: string;
    transport?: 'stdio' | 'streamable-http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    cwd?: string;
    description?: string;
    visibility?: 'private' | 'shared';
    metadata?: UserMcpServerView['metadata'];
  }) => Promise<unknown>;
  onGenerateMcp: (input: {
    request: string;
    docsText?: string;
    name?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<unknown>;
  onImportMcp: (input: {
    sourcePath: string;
    name?: string;
    entryFile?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<unknown>;
  onImportMcpJson: (input: {
    json: string;
    visibility?: 'private' | 'shared';
  }) => Promise<unknown>;
  onUpdateMcp: (id: string, input: Partial<{
    name: string;
    transport: 'stdio' | 'streamable-http' | 'sse';
    command?: string;
    args: string[];
    env: Record<string, string>;
    url: string;
    cwd: string;
    enabled: boolean;
    description: string;
    metadata: UserMcpServerView['metadata'];
  }>) => Promise<unknown>;
  onDeleteMcp: (id: string) => Promise<boolean>;
  onToggleMcpVisibility: (id: string) => Promise<unknown>;
  onCreateSkill: (input: {
    name: string;
    description?: string;
    skillContent?: string;
    visibility?: 'private' | 'shared';
    metadata?: UserSkillView['metadata'];
  }) => Promise<unknown>;
  onImportSkill: (input: {
    sourcePath: string;
    name?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<unknown>;
  onUpdateSkill: (id: string, input: Partial<{
    name: string;
    description: string;
    skillContent: string;
    enabled: boolean;
    metadata: UserSkillView['metadata'];
  }>) => Promise<unknown>;
  onDeleteSkill: (id: string) => Promise<boolean>;
  onToggleSkillVisibility: (id: string) => Promise<unknown>;
}

function getSource(visibility: string, sourceType: string): AppCardSource {
  if (sourceType === 'builtin') return 'builtin';
  if (sourceType === 'marketplace') return 'marketplace';
  return visibility === 'shared' ? 'shared' : 'private';
}

function buildExtensionExtra(input: {
  capabilities: string[];
  transport?: string;
  healthStatus: ExtensionHealthStatus;
}, t: (key: string) => string) {
  return (
    <div className="app-card__extra">
      {input.transport ? (
        <div className="app-card__tags">
          <span className="app-card__tag">{input.transport}</span>
        </div>
      ) : null}
      {input.capabilities.length > 0 ? (
        <div className="app-card__tags">
          {input.capabilities.slice(0, 4).map((capability) => (
            <span key={capability} className="app-card__tag">
              {capability}
            </span>
          ))}
        </div>
      ) : null}
      <div className={`app-card__health app-card__health--${input.healthStatus.state}`}>
        {t('health.' + input.healthStatus.state)}: {input.healthStatus.summary}
      </div>
    </div>
  );
}

export function MyAppsPanel({
  mcpServers,
  skills,
  loading,
  onCreateMcp,
  onGenerateMcp,
  onImportMcp,
  onImportMcpJson,
  onUpdateMcp,
  onDeleteMcp,
  onToggleMcpVisibility,
  onCreateSkill,
  onImportSkill,
  onUpdateSkill,
  onDeleteSkill,
  onToggleSkillVisibility,
}: MyAppsPanelProps) {
  const { t } = useTranslation('apps');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [showMcpDrawer, setShowMcpDrawer] = useState(false);
  const [showAiMcpDrawer, setShowAiMcpDrawer] = useState(false);
  const [showMcpImportDrawer, setShowMcpImportDrawer] = useState(false);
  const [showSkillDrawer, setShowSkillDrawer] = useState(false);
  const [showSkillImportDrawer, setShowSkillImportDrawer] = useState(false);
  const [editingMcp, setEditingMcp] = useState<UserMcpServerView | null>(null);
  const [editingSkill, setEditingSkill] = useState<UserSkillView | null>(null);

  const myMcp = mcpServers.filter((s) => s.isOwner);
  const mySkills = skills.filter((s) => s.isOwner);

  const filteredMcp = myMcp.filter((s) => {
    if (statusFilter === 'enabled' && !s.enabled) return false;
    if (statusFilter === 'disabled' && s.enabled) return false;
    return true;
  });

  const filteredSkills = mySkills.filter((s) => {
    if (statusFilter === 'enabled' && !s.enabled) return false;
    if (statusFilter === 'disabled' && s.enabled) return false;
    return true;
  });

  const showMcp = typeFilter === 'all' || typeFilter === 'mcp';
  const showSkills = typeFilter === 'all' || typeFilter === 'skill';

  return (
    <div className="my-apps-panel">
      <div className="my-apps-panel__toolbar">
        <div className="my-apps-panel__filters">
          <div className="filter-group" role="group" aria-label={t('filter.status')}>
            {(['all', 'enabled', 'disabled'] as StatusFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`filter-btn ${statusFilter === f ? 'active' : ''}`}
                onClick={() => setStatusFilter(f)}
              >
                {f === 'all' ? t('filter.all') : f === 'enabled' ? t('filter.enabled') : t('filter.disabled')}
              </button>
            ))}
          </div>
          <div className="filter-group" role="group" aria-label={t('filter.type')}>
            {(['all', 'mcp', 'skill'] as TypeFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`filter-btn ${typeFilter === f ? 'active' : ''}`}
                onClick={() => setTypeFilter(f)}
              >
                {f === 'all' ? t('filter.all') : f === 'mcp' ? 'MCP' : 'Skill'}
              </button>
            ))}
          </div>
        </div>
        <div className="my-apps-panel__actions">
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => { setEditingMcp(null); setShowMcpDrawer(true); }}
          >
            + MCP
          </button>
          <button
            type="button"
            className="btn-outline btn-sm"
            onClick={() => setShowMcpImportDrawer(true)}
          >
            {t('mcp.import')}
          </button>
          <button
            type="button"
            className="btn-outline btn-sm"
            onClick={() => setShowAiMcpDrawer(true)}
          >
            {t('mcp.aiGenerate')}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => { setEditingSkill(null); setShowSkillDrawer(true); }}
          >
            + Skill
          </button>
          <button
            type="button"
            className="btn-outline btn-sm"
            onClick={() => setShowSkillImportDrawer(true)}
          >
            {t('skill.import')}
          </button>
        </div>
      </div>

      <AppCardGrid loading={loading} empty={t('empty.noApps')}>
        {showMcp &&
          filteredMcp.map((server) => (
            <AppCard
              key={server.id}
              id={server.id}
              name={server.name}
              description={server.description}
              variant="mcp"
              source={getSource(server.visibility, server.sourceType)}
              enabled={server.enabled}
              tags={server.tags}
              isOwner
              extra={buildExtensionExtra({
                capabilities: server.metadata?.capabilities || [],
                transport: server.transport,
                healthStatus: server.healthStatus,
              }, t)}
              onToggleEnabled={() =>
                onUpdateMcp(server.id, { enabled: !server.enabled })
              }
              onEdit={() => { setEditingMcp(server); setShowMcpDrawer(true); }}
              onDelete={() => {
                if (window.confirm(t('confirm.deleteMcp', { name: server.name }))) onDeleteMcp(server.id);
              }}
              onToggleVisibility={() => onToggleMcpVisibility(server.id)}
            />
          ))}
        {showSkills &&
          filteredSkills.map((skill) => (
            <AppCard
              key={skill.id}
              id={skill.id}
              name={skill.name}
              description={skill.description}
              variant="skill"
              source={getSource(skill.visibility, skill.sourceType)}
              enabled={skill.enabled}
              tags={skill.tags}
              isOwner
              extra={buildExtensionExtra({
                capabilities: skill.metadata?.capabilities || [],
                healthStatus: skill.healthStatus,
              }, t)}
              onToggleEnabled={() =>
                onUpdateSkill(skill.id, { enabled: !skill.enabled })
              }
              onEdit={() => { setEditingSkill(skill); setShowSkillDrawer(true); }}
              onDelete={() => {
                if (window.confirm(t('confirm.deleteSkill', { name: skill.name }))) onDeleteSkill(skill.id);
              }}
              onToggleVisibility={() => onToggleSkillVisibility(skill.id)}
            />
          ))}
      </AppCardGrid>

      {showMcpDrawer && (
        <McpCreateDrawer
          editing={editingMcp}
          onImportJson={async (input) => {
            await onImportMcpJson(input);
            setShowMcpDrawer(false);
            setEditingMcp(null);
          }}
          onSave={async (input) => {
            if (editingMcp) {
              await onUpdateMcp(editingMcp.id, input);
            } else {
              await onCreateMcp(input);
            }
            setShowMcpDrawer(false);
            setEditingMcp(null);
          }}
          onClose={() => { setShowMcpDrawer(false); setEditingMcp(null); }}
        />
      )}

      {showAiMcpDrawer && (
        <McpAiCreateDrawer
          onGenerate={async (input) => {
            await onGenerateMcp(input);
            setShowAiMcpDrawer(false);
          }}
          onClose={() => setShowAiMcpDrawer(false)}
        />
      )}

      {showMcpImportDrawer && (
        <McpImportDrawer
          onImport={async (input) => {
            await onImportMcp(input);
            setShowMcpImportDrawer(false);
          }}
          onClose={() => setShowMcpImportDrawer(false)}
        />
      )}

      {showSkillDrawer && (
        <SkillCreateDrawer
          editing={editingSkill}
          onSave={async (input) => {
            if (editingSkill) {
              await onUpdateSkill(editingSkill.id, input);
            } else {
              await onCreateSkill(input);
            }
            setShowSkillDrawer(false);
            setEditingSkill(null);
          }}
          onClose={() => { setShowSkillDrawer(false); setEditingSkill(null); }}
        />
      )}

      {showSkillImportDrawer && (
        <SkillImportDrawer
          onImport={async (input) => {
            await onImportSkill(input);
            setShowSkillImportDrawer(false);
          }}
          onClose={() => setShowSkillImportDrawer(false)}
        />
      )}
    </div>
  );
}
