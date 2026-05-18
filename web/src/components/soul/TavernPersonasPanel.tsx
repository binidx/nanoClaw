import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TavernPersona {
  id: string;
  user_id: string;
  name: string;
  avatar_path: string | null;
  summary: string | null;
  personality_prompt: string | null;
  scenario: string | null;
  first_message: string | null;
  alternate_greetings: string[];
  example_dialogues: string | null;
  system_prompt: string | null;
  creator_notes: string | null;
  tags: string[];
  enabled: number;
  created_at: string;
  updated_at: string;
  prompt_preview: string;
  opener_preview: string;
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

interface TavernPersonasPanelProps {
  apiBase: string;
}

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

export function TavernPersonasPanel({ apiBase }: TavernPersonasPanelProps) {
  const { t } = useTranslation('soul');
  const [personas, setPersonas] = useState<TavernPersona[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<TavernEditorState>(emptyEditor());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadPersonas = useCallback(async () => {
    const response = await fetch(`${apiBase}/api/tavern/personas`, {
      credentials: 'include',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(
        typeof data.error === 'string' ? data.error : 'Failed to load tavern personas',
      );
    }
    const nextPersonas = Array.isArray(data.personas) ? data.personas : [];
    setPersonas(nextPersonas);
    setSelectedId((current) => {
      if (current && nextPersonas.some((persona: TavernPersona) => persona.id === current)) {
        return current;
      }
      return nextPersonas[0]?.id || null;
    });
    if (nextPersonas.length === 0) {
      setEditor(emptyEditor());
    }
  }, [apiBase]);

  useEffect(() => {
    loadPersonas()
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load tavern personas');
      })
      .finally(() => setLoading(false));
  }, [loadPersonas]);

  useEffect(() => {
    if (!selectedId) return;
    const selected = personas.find((persona) => persona.id === selectedId);
    if (selected) {
      setEditor(toEditorState(selected));
      setError('');
      setMessage('');
    }
  }, [personas, selectedId]);

  const selectedPersona = useMemo(
    () => personas.find((persona) => persona.id === selectedId) || null,
    [personas, selectedId],
  );

  const avatarUrl = buildAvatarUrl(apiBase, editor.avatarPath);
  const previewPrompt = buildPromptPreview(editor);
  const openerPreview =
    editor.firstMessage.trim() || parseMultiLine(editor.alternateGreetingsText)[0] || '';

  const handleCreateNew = () => {
    setSelectedId(null);
    setEditor(emptyEditor());
    setError('');
    setMessage('');
  };

  const handleSave = async () => {
    if (!editor.name.trim()) {
      setError('请先填写人格名称');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
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
          ? current.map((persona) => (persona.id === saved.id ? saved : persona))
          : [saved, ...current];
      });
      setSelectedId(saved.id);
      setEditor(toEditorState(saved));
      setMessage(editor.id ? '酒馆人格已保存' : '酒馆人格已创建');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存酒馆人格失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editor.id) {
      handleCreateNew();
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
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
      const removedId = editor.id;
      setPersonas((current) => current.filter((persona) => persona.id !== removedId));
      setSelectedId(null);
      setEditor(emptyEditor());
      setMessage('酒馆人格已删除');
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除酒馆人格失败');
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarPick = async (file: File | null) => {
    if (!file || !editor.id) return;
    setUploading(true);
    setError('');
    setMessage('');
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(
        `${apiBase}/api/tavern/personas/${encodeURIComponent(editor.id)}/avatar`,
        {
          method: 'POST',
          credentials: 'include',
          body: form,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.persona) {
        throw new Error(typeof data.error === 'string' ? data.error : '头像上传失败');
      }
      const saved = data.persona as TavernPersona;
      setPersonas((current) =>
        current.map((persona) => (persona.id === saved.id ? saved : persona)),
      );
      setEditor(toEditorState(saved));
      setMessage('头像已上传');
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  if (loading) {
    return <div className="page-body soul-page-body"><p className="soul-loading-text">{t('加载中')}...</p></div>;
  }

  return (
    <div className="page-body soul-page-body">
      <div className="settings-section settings-general-panel soul-panel-mb">
        <div className="settings-general-panel-header">
          <div>
            <div className="settings-section-title">酒馆人格</div>
            <div className="settings-section-subtitle">
              这里的人格只用于新建酒馆会话，不会替代你的主灵魂或记忆系统。
            </div>
          </div>
          <div className="page-header-actions">
            <button className="btn btn-secondary" onClick={handleCreateNew}>
              新建人格
            </button>
            <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? '保存中…' : editor.id ? '保存修改' : '创建人格'}
            </button>
          </div>
        </div>

        {message ? <div className="soul-notice soul-notice--success">{message}</div> : null}
        {error ? <div className="soul-notice soul-notice--error">{error}</div> : null}

        <div className="tavern-layout">
          <aside className="tavern-sidebar">
            {personas.length === 0 ? (
              <div className="soul-empty-hint">还没有酒馆人格，先创建一个吧。</div>
            ) : (
              <div className="tavern-persona-list">
                {personas.map((persona) => {
                  const itemAvatarUrl = buildAvatarUrl(apiBase, persona.avatar_path);
                  return (
                    <button
                      key={persona.id}
                      type="button"
                      className={`tavern-persona-item${persona.id === selectedId ? ' active' : ''}`}
                      onClick={() => setSelectedId(persona.id)}
                    >
                      <div className="tavern-persona-item-avatar">
                        {itemAvatarUrl ? (
                          <img src={itemAvatarUrl} alt={persona.name} />
                        ) : (
                          <span>{persona.name.slice(0, 1).toUpperCase()}</span>
                        )}
                      </div>
                      <div className="tavern-persona-item-copy">
                        <strong>{persona.name}</strong>
                        <span>{persona.summary || '未填写简介'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          <div className="tavern-editor">
            <div className="tavern-editor-grid">
              <section className="tavern-card">
                <div className="tavern-card-header">基础</div>
                <div className="tavern-avatar-row">
                  <div className="tavern-avatar-preview">
                    {avatarUrl ? <img src={avatarUrl} alt={editor.name || 'avatar'} /> : <span>{editor.name.trim().slice(0, 1).toUpperCase() || 'T'}</span>}
                  </div>
                  <div className="tavern-avatar-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!editor.id || uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploading ? '上传中…' : '上传头像'}
                    </button>
                    {!editor.id ? <span className="settings-hint">先保存人格，再上传头像。</span> : null}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      hidden
                      onChange={(event) => void handleAvatarPick(event.target.files?.[0] || null)}
                    />
                  </div>
                </div>

                <label className="config-field soul-field-stack">
                  <span>名称</span>
                  <input value={editor.name} onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))} placeholder="例如：月港侦探、偏执魔导师、舰桥顾问" />
                </label>
                <label className="config-field soul-field-stack">
                  <span>标签</span>
                  <input value={editor.tagsText} onChange={(event) => setEditor((current) => ({ ...current, tagsText: event.target.value }))} placeholder="悬疑, 成熟, 慢热, 细腻" />
                </label>
                <label className="config-field soul-field-stack">
                  <span>简介</span>
                  <textarea className="soul-textarea-vertical" value={editor.summary} onChange={(event) => setEditor((current) => ({ ...current, summary: event.target.value }))} placeholder="给创建会话时看的简短介绍。" />
                </label>
                <label className="config-field soul-field-stack">
                  <span className="soul-checkbox-label-text">
                    <input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor((current) => ({ ...current, enabled: event.target.checked }))} />
                    启用此人格
                  </span>
                </label>
              </section>

              <section className="tavern-card">
                <div className="tavern-card-header">设定</div>
                <label className="config-field soul-field-stack">
                  <span>人格描述</span>
                  <textarea className="soul-textarea-vertical" value={editor.personalityPrompt} onChange={(event) => setEditor((current) => ({ ...current, personalityPrompt: event.target.value }))} placeholder="性格、表达方式、价值观、情绪习惯。" />
                </label>
                <label className="config-field soul-field-stack">
                  <span>场景</span>
                  <textarea className="soul-textarea-vertical" value={editor.scenario} onChange={(event) => setEditor((current) => ({ ...current, scenario: event.target.value }))} placeholder="角色与你所在的情境、关系、环境设定。" />
                </label>
                <label className="config-field soul-field-stack">
                  <span>系统附加指令</span>
                  <textarea className="soul-textarea-vertical" value={editor.systemPrompt} onChange={(event) => setEditor((current) => ({ ...current, systemPrompt: event.target.value }))} placeholder="只对这个酒馆人格生效的角色规则。" />
                </label>
                <label className="config-field soul-field-stack">
                  <span>作者备注</span>
                  <textarea className="soul-textarea-vertical" value={editor.creatorNotes} onChange={(event) => setEditor((current) => ({ ...current, creatorNotes: event.target.value }))} placeholder="给自己看的维护备注，不会单独显示在会话里。" />
                </label>
              </section>

              <section className="tavern-card">
                <div className="tavern-card-header">对话</div>
                <label className="config-field soul-field-stack">
                  <span>默认开场白</span>
                  <textarea className="soul-textarea-vertical" value={editor.firstMessage} onChange={(event) => setEditor((current) => ({ ...current, firstMessage: event.target.value }))} placeholder="创建新会话后自动发送的第一句。" />
                </label>
                <label className="config-field soul-field-stack">
                  <span>候选开场白</span>
                  <textarea className="soul-textarea-vertical" value={editor.alternateGreetingsText} onChange={(event) => setEditor((current) => ({ ...current, alternateGreetingsText: event.target.value }))} placeholder="每行一条，用作额外候选。" />
                </label>
                <label className="config-field soul-field-stack">
                  <span>示例对话</span>
                  <textarea className="soul-textarea-vertical tavern-example-dialogues" value={editor.exampleDialogues} onChange={(event) => setEditor((current) => ({ ...current, exampleDialogues: event.target.value }))} placeholder="示例口吻、常见互动节奏、对话格式参考。" />
                </label>
              </section>

              <section className="tavern-card tavern-card-preview">
                <div className="tavern-card-header">预览</div>
                <div className="tavern-preview-block">
                  <div className="tavern-preview-label">最终 Persona Prompt</div>
                  <pre className="tavern-preview-pre">{previewPrompt || '填写设定后，这里会显示最终注入的 persona prompt。'}</pre>
                </div>
                <div className="tavern-preview-block">
                  <div className="tavern-preview-label">首条开场白</div>
                  <div className="tavern-opener-preview">{openerPreview || '填写默认开场白或候选开场白后，这里会显示自动首发内容。'}</div>
                </div>
                {selectedPersona ? (
                  <button className="btn btn-danger tavern-delete-btn" onClick={() => void handleDelete()} disabled={saving}>
                    删除当前人格
                  </button>
                ) : null}
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

