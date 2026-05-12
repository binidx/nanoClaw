import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExtensionMetadata, UserMcpServerView } from '../../app-types';
import { Drawer, NcSelect } from '../common';

export interface McpCreateDrawerProps {
  editing: UserMcpServerView | null;
  onImportJson: (input: {
    json: string;
    visibility?: 'private' | 'shared';
  }) => Promise<UserMcpServerView[] | null>;
  onSave: (input: {
    name: string;
    transport?: 'stdio' | 'streamable-http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    cwd?: string;
    description?: string;
    visibility?: 'private' | 'shared';
    metadata?: ExtensionMetadata;
  }) => Promise<void>;
  onClose: () => void;
}

function parseMetadataText(text: string): ExtensionMetadata | undefined {
  if (!text.trim()) return undefined;
  return JSON.parse(text) as ExtensionMetadata;
}

function metadataToText(metadata: ExtensionMetadata | undefined): string {
  if (!metadata) return '';
  return JSON.stringify(metadata, null, 2);
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf('=');
    if (sep <= 0) continue;
    env[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
  }
  return env;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function McpCreateDrawer({ editing, onImportJson, onSave, onClose }: McpCreateDrawerProps) {
  const { t } = useTranslation('apps');
  const [name, setName] = useState(editing?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'streamable-http' | 'sse'>(
    editing?.transport ?? 'stdio',
  );
  const [command, setCommand] = useState(editing?.command ?? '');
  const [argsText, setArgsText] = useState(editing?.args?.join('\n') ?? '');
  const [envText, setEnvText] = useState(editing?.env ? envToText(editing.env) : '');
  const [url, setUrl] = useState(editing?.url ?? '');
  const [cwd, setCwd] = useState(editing?.cwd ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [metadataText, setMetadataText] = useState(
    metadataToText(editing?.metadata),
  );
  const [metadataError, setMetadataError] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'shared'>(editing?.visibility ?? 'private');
  const [saving, setSaving] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonDraft, setJsonDraft] = useState('');

  const handleSave = async () => {
    if (!name.trim()) return;
    let metadata: ExtensionMetadata | undefined;
    try {
      metadata = parseMetadataText(metadataText);
      setMetadataError('');
    } catch {
      setMetadataError(t('mcp.invalidJson'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        transport,
        ...(transport === 'stdio' ? { command: command.trim() } : {}),
        ...(transport === 'stdio'
          ? {
              args: argsText.split('\n').map((a) => a.trim()).filter(Boolean),
            }
          : {}),
        env: parseEnvText(envText),
        ...(transport !== 'stdio' ? { url: url.trim() } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        description: description.trim() || undefined,
        visibility,
        metadata,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleJsonImport = async () => {
    setSaving(true);
    try {
      const result = await onImportJson({
        json: jsonDraft.trim(),
        visibility,
      });
      if (result !== null) {
        setJsonDraft('');
        setJsonMode(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={editing ? t('mcp.edit') : t('mcp.create')}
      width={420}
      footer={
        !jsonMode ? (
          <>
            <button type="button" className="btn-outline" onClick={onClose}>
              {t('action.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSave}
              disabled={
                saving ||
                !name.trim() ||
                (transport === 'stdio' ? !command.trim() : !url.trim())
              }
            >
              {saving ? t('mcp.saving') : (editing ? t('mcp.saveChanges') : t('mcp.save'))}
            </button>
          </>
        ) : undefined
      }
    >
      {!jsonMode ? (
        <>
          <div className="form-group">
            <label>{t('mcp.nameRequired')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-translator" />
          </div>
          <div className="form-group">
            <label>Transport</label>
            <select value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'streamable-http' | 'sse')}>
              <option value="stdio">stdio</option>
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
            </select>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="form-group">
                <label>{t('mcp.commandRequired')}</label>
                <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
              </div>
              <div className="form-group">
                <label>{t('mcp.args')}</label>
                <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={3} placeholder="-y&#10;@modelcontextprotocol/server-everything" />
              </div>
              <div className="form-group">
                <label>{t('mcp.envVars')}</label>
                <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={3} placeholder="API_KEY=xxx" />
              </div>
              <div className="form-group">
                <label>CWD</label>
                <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/workspace" />
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label>URL</label>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
              </div>
              <div className="form-group">
                <label>CWD</label>
                <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/workspace" />
              </div>
            </>
          )}
          <div className="form-group">
            <label>{t('mcp.description')}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="form-group">
            <label>Metadata JSON</label>
            <textarea
              value={metadataText}
              onChange={(e) => {
                setMetadataText(e.target.value);
                if (metadataError) setMetadataError('');
              }}
              rows={8}
              placeholder={'{\n  "capabilities": ["image.generate"],\n  "requirements": {\n    "env": [{ "key": "API_KEY", "secret": true }]\n  }\n}'}
            />
            {metadataError ? (
              <div className="form-help form-help--blocked">{metadataError}</div>
            ) : null}
            {editing?.healthStatus ? (
              <div className={`form-help form-help--${editing.healthStatus.state}`}>
                {t('mcp.currentStatus', { status: editing.healthStatus.summary })}
              </div>
            ) : null}
          </div>
          <div className="form-group">
            <label>{t('common.visibility')}</label>
            <NcSelect value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'shared')}>
              <option value="private">{t('visibility.private')}</option>
              <option value="shared">{t('visibility.shared')}</option>
            </NcSelect>
          </div>
          <div className="form-group">
            <button type="button" className="btn-outline btn-sm" onClick={() => setJsonMode(true)}>
              {t('mcp.importJson')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-group">
            <label>{t('mcp.importJsonLabel')}</label>
            <textarea
              value={jsonDraft}
              onChange={(e) => setJsonDraft(e.target.value)}
              rows={10}
              placeholder='{ "command": "npx", "args": ["-y", "@mcp/server"] }'
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-outline btn-sm" onClick={() => setJsonMode(false)}>
              {t('mcp.backToForm')}
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={() => void handleJsonImport()} disabled={saving || !jsonDraft.trim()}>
              {t('mcp.importBtn')}
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}
