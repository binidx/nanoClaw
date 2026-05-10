import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface AuditLogEntry {
  id: string;
  user_id: string;
  username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  details_json: string | null;
  ip_address: string | null;
  created_at: string;
}

export function SettingsAuditLogTab({ apiBase }: { apiBase: string }) {
  const { t } = useTranslation('settings');

  const ACTION_LABELS: Record<string, string> = {
    'provider.create': t('settings.auditLog.创建模型'),
    'provider.update': t('settings.auditLog.修改模型'),
    'provider.delete': t('settings.auditLog.删除模型'),
    'user.create': t('settings.auditLog.创建用户'),
    'user.update': t('settings.auditLog.修改用户'),
    'user.delete': t('settings.auditLog.删除用户'),
    'user.role.assign': t('settings.auditLog.分配角色'),
    'user.role.remove': t('settings.auditLog.移除角色'),
    'role.create': t('settings.auditLog.创建角色'),
    'role.update': t('settings.auditLog.修改角色'),
    'role.delete': t('settings.auditLog.删除角色'),
    'assistant.create': t('settings.auditLog.创建助手'),
    'assistant.update': t('settings.auditLog.修改助手'),
    'assistant.delete': t('settings.auditLog.删除助手'),
    'knowledge_base.create': t('settings.auditLog.创建知识库'),
    'knowledge_base.delete': t('settings.auditLog.删除知识库'),
    'channel.create': t('settings.auditLog.创建渠道'),
    'channel.delete': t('settings.auditLog.删除渠道'),
    'trash.restore': t('settings.auditLog.恢复资源'),
    'trash.purge': t('settings.auditLog.永久删除'),
  };
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [actionFilter, setActionFilter] = useState('');
  const pageSize = 30;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (actionFilter) params.set('action', actionFilter);
      const res = await fetch(`${apiBase}/api/admin/audit-logs?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [apiBase, page, actionFilter]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="settings-section">
      <h3>{t('settings.auditLog.423b06')}</h3>
      <p className="settings-note">{t('settings.auditLog.f07492')}</p>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
          className="nc-select"
        >
          <option value="">{t('settings.auditLog.68b9b4')}</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <span style={{ opacity: 0.6, fontSize: 13 }}>{t('settings.auditLog.totalCount', { total })}</span>
      </div>
      {loading ? (
        <div className="provider-empty">{t('settings.extensions.26b5bd')}</div>
      ) : items.length === 0 ? (
        <div className="provider-empty">{t('settings.auditLog.4351f8')}</div>
      ) : (
        <table className="settings-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.auditLog.19fcb9')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.auditLog.6b0bc6')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.auditLog.2b6bc0')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.auditLog.73e825')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>IP</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ borderTop: '1px solid var(--border-color, #333)' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', opacity: 0.7 }}>
                  {new Date(item.created_at).toLocaleString()}
                </td>
                <td style={{ padding: '6px 8px' }}>{item.username || item.user_id}</td>
                <td style={{ padding: '6px 8px' }}>
                  {ACTION_LABELS[item.action] || item.action}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  {item.target_name || item.target_id || '-'}
                  {item.target_type && <span style={{ opacity: 0.5, marginLeft: 4 }}>({item.target_type})</span>}
                </td>
                <td style={{ padding: '6px 8px', opacity: 0.5 }}>{item.ip_address || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('settings.auditLog.4a34b2')}</button>
          <span style={{ lineHeight: '28px', opacity: 0.6 }}>{page} / {totalPages}</span>
          <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>{t('settings.auditLog.4c40d7')}</button>
        </div>
      )}
    </div>
  );
}
