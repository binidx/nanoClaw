import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SshKeyInfo } from '../../app-types';

export function SettingsSshKeysTab({ apiBase }: { apiBase: string }) {
  const { t } = useTranslation('settings');
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/settings/ssh-keys`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(t('settings.sshKeys.loadFailed'));
      setKeys(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.sshKeys.loadFailedDetail'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const handleSave = async () => {
    if (!name.trim() || !privateKey.trim()) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/settings/ssh-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim(), privateKey: privateKey.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('settings.sshKeys.saveFailed'));
      }
      setName('');
      setPrivateKey('');
      setAdding(false);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.sshKeys.saveFailedDetail'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('settings.sshKeys.confirmDelete'))) return;
    try {
      await fetch(`${apiBase}/api/settings/ssh-keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await loadKeys();
    } catch {
      setError(t('settings.sshKeys.deleteFailed'));
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await fetch(`${apiBase}/api/settings/ssh-keys/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isDefault: true }),
      });
      await loadKeys();
    } catch {
      setError(t('settings.sshKeys.setDefaultFailed'));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setPrivateKey(reader.result as string);
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ''));
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h3>{t('settings.sshKeys.title')}</h3>
        <p className="settings-hint ssh-keys-hint-tight">
          {t('settings.sshKeys.description')}
        </p>
      </div>

      {error && <div className="settings-error">{error}</div>}

      {loading && keys.length === 0 ? (
        <div className="settings-hint">{t('settings.sshKeys.loading')}</div>
      ) : (
        <div className="ssh-keys-list">
          {keys.map((k) => (
            <div key={k.id} className="ssh-keys-card">
              <div className="ssh-keys-card-main">
                <div className="ssh-keys-card-title">
                  {k.name}
                  {k.isDefault && (
                    <span className="ssh-keys-badge-default">
                      {t('settings.sshKeys.defaultBadge')}
                    </span>
                  )}
                </div>
                <div className="ssh-keys-card-meta">
                  {k.keyType || t('settings.sshKeys.unknownType')}
                  {k.fingerprint ? ` · ${k.fingerprint}` : ''}
                  {' · '}
                  {new Date(k.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div className="ssh-keys-card-actions">
                {!k.isDefault && (
                  <button
                    className="btn btn-sm"
                    onClick={() => handleSetDefault(k.id)}
                  >
                    {t('settings.sshKeys.setDefault')}
                  </button>
                )}
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => handleDelete(k.id)}
                >
                  {t('settings.sshKeys.delete')}
                </button>
              </div>
            </div>
          ))}

          {!adding ? (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              {t('settings.sshKeys.addKey')}
            </button>
          ) : (
            <div className="ssh-keys-add-panel">
              <div className="form-group">
                <label>{t('settings.sshKeys.nameLabel')}</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('settings.sshKeys.namePlaceholder')}
                />
              </div>
              <div className="form-group">
                <label>{t('settings.sshKeys.privateKeyLabel')}</label>
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder={t('settings.sshKeys.privateKeyPlaceholder')}
                  rows={6}
                  className="ssh-keys-private-textarea"
                />
                <div className="ssh-keys-import-row">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pem,.key,id_*"
                    onChange={handleFileUpload}
                    className="ssh-keys-file-input-hidden"
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => fileRef.current?.click()}
                  >
                    {t('settings.sshKeys.importFromFile')}
                  </button>
                </div>
              </div>
              <div className="ssh-keys-form-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !name.trim() || !privateKey.trim()}
                >
                  {saving ? t('settings.sshKeys.saving') : t('settings.sshKeys.save')}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setAdding(false);
                    setName('');
                    setPrivateKey('');
                  }}
                >
                  {t('settings.sshKeys.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
