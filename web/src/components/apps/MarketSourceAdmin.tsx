import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NcCheckbox } from '../common';

import type { MarketplaceSourceView } from '../../app-types';

export interface MarketSourceAdminProps {
  apiBase: string;
}

export function MarketSourceAdmin({ apiBase }: MarketSourceAdminProps) {
  const { t } = useTranslation('apps');
  const [sources, setSources] = useState<MarketplaceSourceView[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formSource, setFormSource] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/admin/marketplace-sources`);
      if (res.ok) setSources(await res.json());
    } catch {
      setMessage(t('admin.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  const resetForm = () => {
    setFormName('');
    setFormSource('');
    setFormDescription('');
    setFormEnabled(true);
    setEditingId(null);
    setShowForm(false);
  };

  const startEdit = (source: MarketplaceSourceView) => {
    setFormName(source.name);
    setFormSource(source.source);
    setFormDescription(source.description || '');
    setFormEnabled(source.enabled);
    setEditingId(source.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formSource.trim()) {
      setMessage(t('admin.nameRequired'));
      return;
    }
    const body = {
      name: formName.trim(),
      source: formSource.trim(),
      description: formDescription.trim() || undefined,
      enabled: formEnabled,
    };
    try {
      const url = editingId
        ? `${apiBase}/api/admin/marketplace-sources/${encodeURIComponent(editingId)}`
        : `${apiBase}/api/admin/marketplace-sources`;
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setMessage(t('admin.saveFailed'));
        return;
      }
      resetForm();
      setMessage(t('admin.saved'));
      await refresh();
    } catch {
      setMessage(t('admin.saveFailed'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/admin/marketplace-sources/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setMessage(t('admin.deleted'));
        await refresh();
      }
    } catch {
      setMessage(t('admin.deleteFailed'));
    }
  };

  return (
    <div className="market-source-admin">
      <div className="market-source-admin__header">
        <h3>{t('admin.title')}</h3>
        <button type="button" className="btn-primary btn-sm" onClick={() => { resetForm(); setShowForm(true); }}>
          {t('admin.addSource')}
        </button>
      </div>

      {message && <div className="test-result info">{message}</div>}

      {showForm && (
        <div className="market-source-admin__form">
          <div className="form-group">
            <label>{t('admin.name')}</label>
            <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="official-marketplace" />
          </div>
          <div className="form-group">
            <label>{t('admin.source')}</label>
            <input value={formSource} onChange={(e) => setFormSource(e.target.value)} placeholder="owner/repo" />
          </div>
          <div className="form-group">
            <label>{t('admin.description')}</label>
            <input value={formDescription} onChange={(e) => setFormDescription(e.target.value)} />
          </div>
          <NcCheckbox
            className="apps-check-row"
            checked={formEnabled}
            onChange={(e) => setFormEnabled(e.target.checked)}
            label={t('admin.enabled')}
          />
          <div className="modal-actions">
            <button type="button" className="btn-outline btn-sm" onClick={resetForm}>{t('action.cancel')}</button>
            <button type="button" className="btn-primary btn-sm" onClick={handleSave}>
              {editingId ? t('admin.saveChanges') : t('admin.save')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="market-source-admin__loading">{t('admin.loading')}</div>
      ) : sources.length === 0 ? (
        <div className="market-source-admin__empty">{t('admin.empty')}</div>
      ) : (
        <div className="market-source-admin__list">
          {sources.map((source) => (
            <div key={source.id} className="market-source-admin__item">
              <div className="market-source-admin__item-info">
                <div className="market-source-admin__item-name">
                  {source.name}
                  {!source.enabled && (
                    <span className="app-badge app-badge--disabled">{t('admin.disabled')}</span>
                  )}
                </div>
                <div className="market-source-admin__item-source">{source.source}</div>
                {source.description && (
                  <div className="market-source-admin__item-desc">{source.description}</div>
                )}
              </div>
              <div className="market-source-admin__item-actions">
                <button type="button" className="btn-outline btn-xs" onClick={() => startEdit(source)}>
                  {t('action.edit')}
                </button>
                <button type="button" className="btn-outline btn-xs btn-danger" onClick={() => handleDelete(source.id)}>
                  {t('action.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
