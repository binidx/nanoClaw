import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AiProvider,
  Conversation,
  TavernGlobalConfig,
  TavernPersona,
} from '../app-types';
import { formatTime } from '../app-helpers';
import { AppSelect } from '../components/AppSelect';
import {
  CatalogPageShell,
  Drawer,
  LibraryCard,
  NcCheckbox,
  SearchPill,
  TabBar,
} from '../components/common';
import { useUserMcp } from '../hooks/useUserMcp';
import { useUserSkills } from '../hooks/useUserSkills';
import '../styles/tavern-page.css';

interface TavernPageProps {
  apiBase: string;
  providers: AiProvider[];
  conversations: Conversation[];
  onStartChat: (personaId: string) => Promise<void> | void;
  onOpenConversation: (jid: string) => void;
}

interface TavernEditorState {
  id: string | null;
  name: string;
  summary: string;
  personalityPrompt: string;
  scenario: string;
  firstMessage: string;
  alternateGreetingsText: string;
  exampleDialogues: string;
  systemPrompt: string;
  creatorNotes: string;
  tagsText: string;
  enabled: boolean;
  avatarPath: string | null;
}

type TavernEditorTab = 'basic' | 'setting' | 'dialogue' | 'preview';

function emptyEditor(): TavernEditorState {
  return {
    id: null,
    name: '',
    summary: '',
    personalityPrompt: '',
    scenario: '',
    firstMessage: '',
    alternateGreetingsText: '',
    exampleDialogues: '',
    systemPrompt: '',
    creatorNotes: '',
    tagsText: '',
    enabled: true,
    avatarPath: null,
  };
}

function createDefaultGlobalConfig(): TavernGlobalConfig {
  return {
    skillIds: [],
    mcpServerIds: [],
    providerId: null,
    model: null,
  };
}

function toEditorState(persona: TavernPersona): TavernEditorState {
  return {
    id: persona.id,
    name: persona.name,
    summary: persona.summary || '',
    personalityPrompt: persona.personality_prompt || '',
    scenario: persona.scenario || '',
    firstMessage: persona.first_message || '',
    alternateGreetingsText: (persona.alternate_greetings || []).join('\n'),
    exampleDialogues: persona.example_dialogues || '',
    systemPrompt: persona.system_prompt || '',
    creatorNotes: persona.creator_notes || '',
    tagsText: (persona.tags || []).join(', '),
    enabled: persona.enabled !== 0,
    avatarPath: persona.avatar_path || null,
  };
}

function parseMultiLine(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildPromptPreview(editor: TavernEditorState): string {
  const sections: string[] = [];
  if (editor.name.trim()) {
    sections.push(
      `You are roleplaying as "${editor.name.trim()}". Stay in character and keep your responses consistent with this persona unless a higher-priority system or safety rule requires otherwise.`,
    );
  }
  if (editor.summary.trim()) {
    sections.push(`## Character Summary\n${editor.summary.trim()}`);
  }
  if (editor.personalityPrompt.trim()) {
    sections.push(`## Personality\n${editor.personalityPrompt.trim()}`);
  }
  if (editor.scenario.trim()) {
    sections.push(`## Scenario\n${editor.scenario.trim()}`);
  }
  if (editor.systemPrompt.trim()) {
    sections.push(`## System Notes\n${editor.systemPrompt.trim()}`);
  }
  if (editor.exampleDialogues.trim()) {
    sections.push(`## Example Dialogues\n${editor.exampleDialogues.trim()}`);
  }
  const tags = parseTags(editor.tagsText);
  if (tags.length > 0) {
    sections.push(`## Tags\n${tags.join(', ')}`);
  }
  return sections.join('\n\n').trim();
}

function buildAvatarUrl(apiBase: string, avatarPath: string | null): string | null {
  if (!avatarPath) return null;
  return `${apiBase}/api/tavern/avatar-file?path=${encodeURIComponent(avatarPath)}`;
}

function toggleId(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

export function TavernPage({
  apiBase,
  providers,
  conversations,
  onStartChat,
  onOpenConversation,
}: TavernPageProps) {
  const [personas, setPersonas] = useState<TavernPersona[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<TavernEditorState>(emptyEditor());
  const [globalConfig, setGlobalConfig] = useState<TavernGlobalConfig>(
    createDefaultGlobalConfig(),
  );
  const [loading, setLoading] = useState(true);
  const [savingPersona, setSavingPersona] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [startingPersonaId, setStartingPersonaId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeOverlay, setActiveOverlay] = useState<
    'editor' | 'history' | 'config' | null
  >(null);
  const [editorTab, setEditorTab] = useState<TavernEditorTab>('basic');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const userMcp = useUserMcp(apiBase);
  const userSkills = useUserSkills(apiBase);
  const enabledSkills = useMemo(
    () => userSkills.skills.filter((skill) => skill.enabled),
    [userSkills.skills],
  );
  const enabledMcpServers = useMemo(
    () => userMcp.servers.filter((server) => server.enabled),
    [userMcp.servers],
  );
  const llmProviders = useMemo(
    () => providers.filter((provider) => (provider.capability || 'llm') === 'llm'),
    [providers],
  );
  const providerOptions = useMemo(
    () => [
      { value: '', label: '跟随系统默认 Provider' },
      ...llmProviders.map((provider) => ({
        value: provider.id,
        label: provider.model
          ? `${provider.alias} · ${provider.model}`
          : provider.alias,
      })),
    ],
    [llmProviders],
  );
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options = [{ value: '', label: '跟随 Provider 默认模型' }];
    for (const provider of llmProviders) {
      const model = String(provider.model || '').trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      options.push({
        value: model,
        label: `${model} · ${provider.alias}`,
      });
    }
    return options;
  }, [llmProviders]);

  const loadPageData = useCallback(async () => {
    const [personasRes, configRes] = await Promise.all([
      fetch(`${apiBase}/api/tavern/personas`, { credentials: 'include' }),
      fetch(`${apiBase}/api/tavern/config`, { credentials: 'include' }),
    ]);
    const personasData = await personasRes.json().catch(() => ({}));
    const configData = await configRes.json().catch(() => ({}));
    if (!personasRes.ok || !personasData.ok) {
      throw new Error(
        typeof personasData.error === 'string'
          ? personasData.error
          : 'Failed to load tavern personas',
      );
    }
    if (!configRes.ok || !configData.ok) {
      throw new Error(
        typeof configData.error === 'string'
          ? configData.error
          : 'Failed to load tavern config',
      );
    }
    const nextPersonas = Array.isArray(personasData.personas)
      ? (personasData.personas as TavernPersona[])
      : [];
    const nextConfig =
      configData.config &&
      typeof configData.config === 'object' &&
      !Array.isArray(configData.config)
        ? (configData.config as TavernGlobalConfig)
        : createDefaultGlobalConfig();
    setPersonas(nextPersonas);
    setGlobalConfig({
      skillIds: Array.isArray(nextConfig.skillIds) ? nextConfig.skillIds : [],
      mcpServerIds: Array.isArray(nextConfig.mcpServerIds)
        ? nextConfig.mcpServerIds
        : [],
      providerId: nextConfig.providerId || null,
      model: nextConfig.model || null,
    });
    setSelectedId((current) => {
      if (current && nextPersonas.some((persona) => persona.id === current)) {
        return current;
      }
      return null;
    });
    if (nextPersonas.length === 0) {
      setEditor(emptyEditor());
    }
  }, [apiBase]);

  useEffect(() => {
    loadPageData()
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load tavern page');
      })
      .finally(() => setLoading(false));
  }, [loadPageData]);

  useEffect(() => {
    if (!selectedId) return;
    const selected = personas.find((persona) => persona.id === selectedId);
    if (!selected) return;
    setEditor(toEditorState(selected));
    setMessage('');
    setError('');
  }, [personas, selectedId]);

  const filteredPersonas = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return personas;
    return personas.filter((persona) =>
      [persona.name, persona.summary || '', (persona.tags || []).join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    );
  }, [personas, search]);

  const selectedPersona = useMemo(
    () => (selectedId ? personas.find((persona) => persona.id === selectedId) || null : null),
    [personas, selectedId],
  );

  const personaConversations = useMemo(() => {
    if (!selectedPersona) return [];
    return conversations.filter(
      (conversation) => conversation.tavernPersonaId === selectedPersona.id,
    );
  }, [conversations, selectedPersona]);

  const avatarUrl = buildAvatarUrl(apiBase, editor.avatarPath);
  const previewPrompt = buildPromptPreview(editor);
  const openerPreview =
    editor.firstMessage.trim() || parseMultiLine(editor.alternateGreetingsText)[0] || '';

  const handleCreateNew = useCallback(() => {
    setSelectedId(null);
    setEditor(emptyEditor());
    setMessage('');
    setError('');
  }, []);

  const openNewPersonaEditor = useCallback(() => {
    handleCreateNew();
    setEditorTab('basic');
    setActiveOverlay('editor');
  }, [handleCreateNew]);

  const openPersonaEditor = useCallback((personaId: string) => {
    setSelectedId(personaId);
    setMessage('');
    setError('');
    setEditorTab('basic');
    setActiveOverlay('editor');
  }, []);

  const openPersonaHistory = useCallback((personaId: string) => {
    setSelectedId(personaId);
    setMessage('');
    setError('');
    setActiveOverlay('history');
  }, []);

  const handleSaveGlobalConfig = useCallback(async () => {
    setSavingConfig(true);
    setMessage('');
    setError('');
    try {
      const response = await fetch(`${apiBase}/api/tavern/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          skillIds: globalConfig.skillIds,
          mcpServerIds: globalConfig.mcpServerIds,
          providerId: globalConfig.providerId || null,
          model: globalConfig.model || null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.config) {
        throw new Error(
          typeof data.error === 'string' ? data.error : '保存酒馆底层能力失败',
        );
      }
      setGlobalConfig(data.config as TavernGlobalConfig);
      setMessage('酒馆底层能力已保存');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存酒馆底层能力失败');
    } finally {
      setSavingConfig(false);
    }
  }, [apiBase, globalConfig]);

  const handleSavePersona = useCallback(async () => {
    if (!editor.name.trim()) {
      setError('请先填写人格名称');
      return;
    }
    setSavingPersona(true);
    setMessage('');
    setError('');
    try {
      const payload = {
        name: editor.name.trim(),
        summary: editor.summary.trim() || null,
        personalityPrompt: editor.personalityPrompt.trim() || null,
        scenario: editor.scenario.trim() || null,
        firstMessage: editor.firstMessage.trim() || null,
        alternateGreetings: parseMultiLine(editor.alternateGreetingsText),
        exampleDialogues: editor.exampleDialogues.trim() || null,
        systemPrompt: editor.systemPrompt.trim() || null,
        creatorNotes: editor.creatorNotes.trim() || null,
        tags: parseTags(editor.tagsText),
        enabled: editor.enabled,
      };
      const response = await fetch(
        `${apiBase}/api/tavern/personas${editor.id ? `/${encodeURIComponent(editor.id)}` : ''}`,
        {
          method: editor.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.persona) {
        throw new Error(typeof data.error === 'string' ? data.error : '保存酒馆人格失败');
      }
      const saved = data.persona as TavernPersona;
      setPersonas((current) => {
        const exists = current.some((persona) => persona.id === saved.id);
        return exists
          ? current.map((persona) =>
              persona.id === saved.id ? { ...persona, ...saved } : persona,
            )
          : [saved, ...current];
      });
      setSelectedId(saved.id);
      setEditor(toEditorState(saved));
      setMessage(editor.id ? '酒馆人格已保存' : '酒馆人格已创建');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存酒馆人格失败');
    } finally {
      setSavingPersona(false);
    }
  }, [apiBase, editor]);

  const handleDeletePersona = useCallback(async () => {
    if (!editor.id) {
      handleCreateNew();
      return;
    }
    if (!window.confirm(`确定删除酒馆人格“${editor.name || '未命名人格'}”吗？`)) {
      return;
    }
    setSavingPersona(true);
    setMessage('');
    setError('');
    try {
      const response = await fetch(
        `${apiBase}/api/tavern/personas/${encodeURIComponent(editor.id)}`,
        {
          method: 'DELETE',
          credentials: 'include',
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : '删除酒馆人格失败');
      }
      setPersonas((current) => current.filter((persona) => persona.id !== editor.id));
      setSelectedId((current) => (current === editor.id ? null : current));
      setEditor(emptyEditor());
      setMessage('酒馆人格已删除');
      setActiveOverlay(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除酒馆人格失败');
    } finally {
      setSavingPersona(false);
    }
  }, [apiBase, editor.id, editor.name, handleCreateNew]);

  const handleUploadAvatar = useCallback(async (file: File) => {
    if (!editor.id) {
      setError('请先保存人格，再上传头像');
      return;
    }
    setUploading(true);
    setMessage('');
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(
        `${apiBase}/api/tavern/personas/${encodeURIComponent(editor.id)}/avatar`,
        {
          method: 'POST',
          credentials: 'include',
          body: formData,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.persona) {
        throw new Error(typeof data.error === 'string' ? data.error : '上传头像失败');
      }
      const saved = data.persona as TavernPersona;
      setPersonas((current) =>
        current.map((persona) =>
          persona.id === saved.id ? { ...persona, ...saved } : persona,
        ),
      );
      setEditor(toEditorState(saved));
      setMessage('头像已更新');
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传头像失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [apiBase, editor.id]);

  const handleStartChat = useCallback(async (personaId: string) => {
    setStartingPersonaId(personaId);
    setMessage('');
    setError('');
    try {
      await onStartChat(personaId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建酒馆对话失败');
    } finally {
      setStartingPersonaId(null);
    }
  }, [onStartChat]);

  const listPane = (
    <div className="nc-catalog-stack tavern-library-shell">
      {error ? <div className="tavern-banner error">{error}</div> : null}
      {message && activeOverlay === null ? (
        <div className="tavern-banner info">{message}</div>
      ) : null}

      {loading ? (
        <div className="assistant-empty-state assistant-compact-empty">
          <p>酒馆人格加载中</p>
        </div>
      ) : filteredPersonas.length > 0 ? (
        <div className="nc-catalog-grid tavern-catalog-grid">
          {filteredPersonas.map((persona) => {
            const cardAvatarUrl = buildAvatarUrl(apiBase, persona.avatar_path);
            const isSelected =
              persona.id === selectedId && activeOverlay !== null;
            return (
              <div
                key={persona.id}
                className={`tavern-library-entry${isSelected ? ' tavern-library-entry--selected' : ''}`}
              >
                <div className="tavern-library-meta">
                  <div className="tavern-library-avatar">
                    {cardAvatarUrl ? (
                      <img src={cardAvatarUrl} alt={persona.name} />
                    ) : (
                      <span>{persona.name.slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="tavern-library-tags">
                    {(persona.tags || []).slice(0, 3).map((tag) => (
                      <span key={tag} className="tavern-chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                <LibraryCard
                  heading={persona.name}
                  badge={persona.enabled !== 0 ? '启用中' : '已停用'}
                  rows={[
                    {
                      label: '简介',
                      value: persona.summary || '未填写简介',
                    },
                    {
                      label: '会话',
                      value: String(persona.conversation_count || 0),
                    },
                    {
                      label: '活跃',
                      value: persona.last_conversation_at
                        ? formatTime(persona.last_conversation_at)
                        : '暂无',
                    },
                  ]}
                  className="tavern-library-card"
                  onClick={() => void handleStartChat(persona.id)}
                />

                <div className="tavern-library-actions">
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    onClick={() => void handleStartChat(persona.id)}
                    disabled={startingPersonaId === persona.id}
                  >
                    {startingPersonaId === persona.id ? '创建中…' : '新建对话'}
                  </button>
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    onClick={() => openPersonaHistory(persona.id)}
                  >
                    历史
                  </button>
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    onClick={() => openPersonaEditor(persona.id)}
                  >
                    编辑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  const editorTabs = [
    { key: 'basic', label: '基础' },
    { key: 'setting', label: '设定' },
    { key: 'dialogue', label: '对话' },
    { key: 'preview', label: '预览' },
  ] as const;

  return (
    <CatalogPageShell
      className="tavern-page"
      title="酒馆"
      subtitle="角色卡片库"
      controls={
        <div className="tavern-hero-controls">
          <div className="tavern-hero-actions">
            <button
              type="button"
              className="btn-outline workflow-create-action"
              onClick={() => {
                setMessage('');
                setError('');
                setActiveOverlay('config');
              }}
            >
              全局能力
            </button>
            <button
              type="button"
              className="btn-primary workflow-create-action"
              onClick={openNewPersonaEditor}
            >
              新建人格
            </button>
          </div>
          <SearchPill
            value={search}
            onChange={setSearch}
            placeholder="搜索人格、简介或标签"
            clearLabel="清空搜索"
          />
        </div>
      }
    >
      {listPane}

      {activeOverlay === 'editor' ? (
        <div className="modal-overlay" onClick={() => setActiveOverlay(null)}>
          <div
            className="modal tavern-editor-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h3>{editor.id ? `编辑 · ${editor.name || '未命名人格'}` : '新建酒馆人格'}</h3>
                <p className="settings-hint">维护角色设定、开场与示例对话。</p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setActiveOverlay(null)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            {message ? <div className="test-result ok">{message}</div> : null}
            {error ? <div className="test-result error">{error}</div> : null}

            <div className="tavern-detail-body">
              <section className="tavern-editor-summary">
                <div className="tavern-editor-summary-avatar">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt={editor.name || 'Avatar'} />
                  ) : (
                    <span>
                      {editor.name ? editor.name.slice(0, 1).toUpperCase() : 'T'}
                    </span>
                  )}
                </div>
                <div className="tavern-editor-summary-copy">
                  <strong>{editor.name || '未命名人格'}</strong>
                  <span>
                    {editor.summary.trim() || '给这个人格补一段简短简介，列表里会直接显示。'}
                  </span>
                </div>
                <div className="tavern-editor-summary-actions">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        void handleUploadAvatar(file);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? '上传中…' : '上传头像'}
                  </button>
                  <NcCheckbox
                    checked={editor.enabled}
                    onChange={(event) =>
                      setEditor((current) => ({
                        ...current,
                        enabled: event.target.checked,
                      }))
                    }
                    label="启用"
                  />
                </div>
              </section>

              <div className="tavern-editor-tabbar">
                <TabBar
                  tabs={editorTabs.map((tab) => ({
                    key: tab.key,
                    label: tab.label,
                  }))}
                  activeKey={editorTab}
                  onChange={(key) => setEditorTab(key as TavernEditorTab)}
                  size="small"
                />
              </div>

              <div className="tavern-editor-panel">
                {editorTab === 'basic' ? (
                  <section className="tavern-card tavern-card-basic">
                  <div className="tavern-card-header">基础</div>
                  <label className="config-field soul-field-stack">
                    <span>人格名称</span>
                    <input
                      value={editor.name}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="例如：月下档案馆管理员"
                    />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span>简介</span>
                    <textarea
                      className="soul-textarea-vertical"
                      value={editor.summary}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          summary: event.target.value,
                        }))
                      }
                      placeholder="卡片摘要，会出现在酒馆列表里。"
                    />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span>标签</span>
                    <input
                      value={editor.tagsText}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          tagsText: event.target.value,
                        }))
                      }
                      placeholder="例如：治愈, 傲娇, 生图"
                    />
                  </label>
                  </section>
                ) : null}

                {editorTab === 'setting' ? (
                  <section className="tavern-card tavern-card-setting">
                  <div className="tavern-card-header">设定</div>
                  <label className="config-field soul-field-stack">
                    <span>人格设定</span>
                    <textarea
                      className="soul-textarea-vertical"
                      value={editor.personalityPrompt}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          personalityPrompt: event.target.value,
                        }))
                      }
                      placeholder="只对这个酒馆人格生效的角色规则。"
                    />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span>场景</span>
                    <textarea
                      className="soul-textarea-vertical"
                      value={editor.scenario}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          scenario: event.target.value,
                        }))
                      }
                      placeholder="人物所处环境、剧情切入点、互动世界观。"
                    />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span>系统备注</span>
                    <textarea
                      className="soul-textarea-vertical"
                      value={editor.systemPrompt}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          systemPrompt: event.target.value,
                        }))
                      }
                      placeholder="只在这个人格下追加的系统备注。"
                    />
                  </label>
                  </section>
                ) : null}

                {editorTab === 'dialogue' ? (
                  <section className="tavern-card tavern-card-dialogue">
                  <div className="tavern-card-header">对话</div>
                  <label className="config-field soul-field-stack">
                    <span>默认开场白</span>
                    <textarea
                      className="soul-textarea-vertical"
                      value={editor.firstMessage}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          firstMessage: event.target.value,
                        }))
                      }
                      placeholder="卡片点击后自动发送的第一条消息。"
                    />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span>候选开场白</span>
                    <textarea
                      className="soul-textarea-vertical"
                      value={editor.alternateGreetingsText}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          alternateGreetingsText: event.target.value,
                        }))
                      }
                      placeholder="每行一条，默认开场白为空时按顺序回退。"
                    />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span>示例对话</span>
                    <textarea
                      className="soul-textarea-vertical tavern-example-dialogues"
                      value={editor.exampleDialogues}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          exampleDialogues: event.target.value,
                        }))
                      }
                      placeholder="示例口吻、常见互动节奏、格式参考。"
                    />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span>创作者备注</span>
                    <textarea
                      className="soul-textarea-vertical"
                      value={editor.creatorNotes}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          creatorNotes: event.target.value,
                        }))
                      }
                      placeholder="仅供维护人格卡片时参考。"
                    />
                  </label>
                  </section>
                ) : null}

                {editorTab === 'preview' ? (
                  <section className="tavern-card tavern-card-preview">
                  <div className="tavern-card-header">预览</div>
                  <div className="tavern-preview-block">
                    <div className="tavern-preview-label">最终 Persona Prompt</div>
                    <pre className="tavern-preview-pre">
                      {previewPrompt || '填写设定后，这里会显示最终注入的 persona prompt。'}
                    </pre>
                  </div>
                  <div className="tavern-preview-block">
                    <div className="tavern-preview-label">首条开场白</div>
                    <div className="tavern-opener-preview">
                      {openerPreview ||
                        '填写默认开场白或候选开场白后，这里会显示自动首发内容。'}
                    </div>
                  </div>
                  </section>
                ) : null}
              </div>
            </div>

            <div className="modal-actions tavern-detail-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={handleDeletePersona}
                disabled={savingPersona}
              >
                {editor.id ? '删除人格' : '清空表单'}
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={() => setActiveOverlay(null)}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleSavePersona()}
                disabled={savingPersona}
              >
                {savingPersona ? '保存中…' : editor.id ? '保存人格' : '创建人格'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Drawer
        open={activeOverlay === 'config'}
        onClose={() => setActiveOverlay(null)}
        title="全局底层能力"
        width="min(100vw, 720px)"
        footer={
          <>
            <button
              type="button"
              className="btn-outline"
              onClick={() => setActiveOverlay(null)}
            >
              关闭
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleSaveGlobalConfig()}
              disabled={savingConfig}
            >
              {savingConfig ? '保存中…' : '保存能力'}
            </button>
          </>
        }
      >
        <div className="tavern-aside-body">
          {message ? <div className="test-result ok">{message}</div> : null}
          {error ? <div className="test-result error">{error}</div> : null}

          <div className="settings-hint">
            所有酒馆人格共用这份 skill / MCP / 模型配置，不在单卡片重复维护。
          </div>

          <label className="config-field soul-field-stack">
            <span>默认 Provider</span>
            <AppSelect
              value={globalConfig.providerId || ''}
              onChange={(nextValue: string) =>
                setGlobalConfig((current) => ({
                  ...current,
                  providerId: nextValue || null,
                }))
              }
              ariaLabel="默认 Provider"
              options={providerOptions}
            />
          </label>
          <label className="config-field soul-field-stack">
            <span>模型覆盖（可选）</span>
            <AppSelect
              value={globalConfig.model || ''}
              onChange={(nextValue: string) =>
                setGlobalConfig((current) => ({
                  ...current,
                  model: nextValue || null,
                }))
              }
              ariaLabel="AI 模型"
              options={modelOptions}
            />
          </label>

          {userMcp.error ? (
            <div className="settings-hint tavern-inline-hint">
              MCP 加载失败：{userMcp.error}
            </div>
          ) : null}
          {userSkills.error ? (
            <div className="settings-hint tavern-inline-hint">
              Skill 加载失败：{userSkills.error}
            </div>
          ) : null}

          <div className="tavern-option-block">
            <div className="tavern-option-block-title">默认 Skills</div>
            <div className="tavern-option-list">
              {enabledSkills.length === 0 ? (
                <span className="settings-hint">当前没有启用的 Skill</span>
              ) : (
                enabledSkills.map((skill) => (
                  <NcCheckbox
                    key={skill.id}
                    checked={globalConfig.skillIds.includes(skill.id)}
                    onChange={() =>
                      setGlobalConfig((current) => ({
                        ...current,
                        skillIds: toggleId(current.skillIds, skill.id),
                      }))
                    }
                    label={
                      <span>
                        <strong>{skill.name}</strong>
                        {skill.description ? ` · ${skill.description}` : ''}
                      </span>
                    }
                  />
                ))
              )}
            </div>
          </div>

          <div className="tavern-option-block">
            <div className="tavern-option-block-title">默认 MCP / 工具服务</div>
            <div className="tavern-option-list">
              {enabledMcpServers.length === 0 ? (
                <span className="settings-hint">当前没有启用的 MCP 服务</span>
              ) : (
                enabledMcpServers.map((server) => (
                  <NcCheckbox
                    key={server.id}
                    checked={globalConfig.mcpServerIds.includes(server.id)}
                    onChange={() =>
                      setGlobalConfig((current) => ({
                        ...current,
                        mcpServerIds: toggleId(current.mcpServerIds, server.id),
                      }))
                    }
                    label={
                      <span>
                        <strong>{server.name}</strong>
                        {server.command ? ` · ${server.command}` : ''}
                      </span>
                    }
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={activeOverlay === 'history'}
        onClose={() => setActiveOverlay(null)}
        title={selectedPersona ? `人格历史 · ${selectedPersona.name}` : '人格历史对话'}
        width="min(100vw, 620px)"
        footer={
          <button
            type="button"
            className="tasks-inline-action"
            onClick={() => setActiveOverlay(null)}
          >
            关闭
          </button>
        }
      >
        <div className="tavern-history-body">
          {!selectedPersona ? (
            <div className="assistant-empty-state assistant-compact-empty">
              <p>还没有选中的人格</p>
            </div>
          ) : personaConversations.length === 0 ? (
            <div className="assistant-empty-state assistant-compact-empty">
              <p>这个人格还没有历史会话</p>
            </div>
          ) : (
            <div className="tavern-history-list">
              {personaConversations.slice(0, 12).map((conversation) => (
                <button
                  key={conversation.jid}
                  type="button"
                  className="tavern-history-item"
                  onClick={() => onOpenConversation(conversation.jid)}
                >
                  <strong>
                    {conversation.custom_title ||
                      conversation.display_name ||
                      conversation.name}
                  </strong>
                  <span>{conversation.last_message || '暂无消息'}</span>
                  <em>{formatTime(conversation.last_message_time)}</em>
                </button>
              ))}
            </div>
          )}
        </div>
      </Drawer>
    </CatalogPageShell>
  );
}
