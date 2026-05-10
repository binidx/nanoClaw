import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';

interface TrashItem {
  id: string;
  name: string | null;
  deleted_at: string;
  deleted_by: string | null;
}

function getTrashTypes(t: (k: string) => string) {
  return [
    { key: 'assistants', label: t('settings.trash.typeAssistants') },
    { key: 'knowledge_bases', label: t('settings.trash.typeKnowledgeBases') },
    { key: 'ai_providers', label: t('settings.trash.typeAiProviders') },
    { key: 'users', label: t('settings.trash.typeUsers') },
    { key: 'workteams', label: t('settings.trash.typeWorkteams') },
    { key: 'user_skills', label: t('settings.trash.typeUserSkills') },
    { key: 'user_mcp_servers', label: t('settings.trash.typeUserMcpServers') },
    { key: 'scheduled_tasks', label: t('settings.trash.typeScheduledTasks') },
    { key: 'channel_instances', label: t('settings.trash.typeChannelInstances') },
    { key: 'ssh_keys', label: t('settings.trash.typeSshKeys') },
    { key: 'review_repositories', label: t('settings.trash.typeReviewRepositories') },
    { key: 'live2d_models', label: t('settings.trash.typeLive2dModels') },
    { key: 'marketplace_sources', label: t('settings.trash.typeMarketplaceSources') },
  ] as const;
}

export function SettingsTrashTab({ apiBase }: { apiBase: string }) {
  const { t } = useTranslation('settings');
  const TRASH_TYPES = getTrashTypes(t);
  const [activeType, setActiveType] = useState<string>(TRASH_TYPES[0].key);
  const [items, setItems] = useState<TrashItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const loadItems = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const res = await fetch(`${apiBase}/api/admin/trash/${activeType}?pageSize=50`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase, activeType]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const handleRestore = async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/admin/trash/${activeType}/${id}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setMsg(t('settings.trash.restored'));
      loadItems();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePurge = async (id: string) => {
    if (!confirm(t('settings.trash.confirmPurge'))) return;
    try {
      const res = await fetch(`${apiBase}/api/admin/trash/${activeType}/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      setMsg(t('settings.trash.purged'));
      loadItems();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="settings-section">
      <h3>{t('settings.trash.title')}</h3>
      <p className="settings-note">{t('settings.trash.description')}</p>
      <div className="settings-tabs" style={{ marginBottom: 12 }}>
        {TRASH_TYPES.map((type) => (
          <button
            key={type.key}
            className={`settings-tab ${activeType === type.key ? 'active' : ''}`}
            onClick={() => setActiveType(type.key)}
          >
            {type.label}
          </button>
        ))}
      </div>
      {msg && <div className="settings-message">{msg}</div>}
      {loading ? (
        <div className="provider-empty">{t('settings.trash.loading')}</div>
      ) : items.length === 0 ? (
        <div className="provider-empty">{t('settings.trash.noDeletedOfType', { type: TRASH_TYPES.find((type) => type.key === activeType)?.label })}</div>
      ) : (
        <>
          <div className="settings-note">{t('settings.trash.totalRecords', { total })}</div>
          <table className="settings-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.trash.columnName')}</th>
                <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.trash.columnDeletedAt')}</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('settings.trash.columnActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderTop: '1px solid var(--border-color, #333)' }}>
                  <td style={{ padding: '6px 8px' }}>{item.name || item.id}</td>
                  <td style={{ padding: '6px 8px', opacity: 0.7 }}>
                    {item.deleted_at ? new Date(item.deleted_at).toLocaleString() : '-'}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <button className="btn btn-sm" onClick={() => handleRestore(item.id)}>{t('settings.trash.restore')}</button>
                    <button className="btn btn-sm btn-danger" style={{ marginLeft: 6 }} onClick={() => handlePurge(item.id)}>{t('settings.trash.purge')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
