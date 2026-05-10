import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSelect, type AppSelectOption } from '../AppSelect';
import { Pagination } from '../common/Pagination';
import { Drawer } from '../common/Drawer';
import { NcToggle } from '../common';
import { ensureCubismSDK } from './cubism-sdk';
import type {
  Live2DModelInfo,
  Live2DPreferences,
  Live2DEmotionProvider,
} from '../../app-types';
import './live2d.css';

const MODEL_PAGE_SIZE = 8;

let _cachedPIXI: any = null;
let _cachedLive2D: any = null;
async function getThumbnailModules() {
  if (!_cachedPIXI) _cachedPIXI = await import('pixi.js');
  if (!_cachedLive2D) _cachedLive2D = await import('pixi-live2d-display/cubism4');
  return { PIXI: _cachedPIXI, Live2DModel: _cachedLive2D.Live2DModel };
}

function patchLive2DEvents(model: any): void {
  model.eventMode = 'none';
  model.interactiveChildren = false;
  if (typeof model.isInteractive !== 'function') {
    model.isInteractive = () => false;
  }
}

const THUMB_W = 400;
const THUMB_H = 520;

async function captureThumbnail(modelId: string, entryFile: string): Promise<string | null> {
  let canvas: HTMLCanvasElement | null = null;
  let app: any = null;
  try {
    await ensureCubismSDK();
    const { PIXI, Live2DModel } = await getThumbnailModules();
    canvas = document.createElement('canvas');
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    canvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(canvas);

    app = new PIXI.Application({
      view: canvas,
      width: THUMB_W,
      height: THUMB_H,
      backgroundAlpha: 0,
      preserveDrawingBuffer: true,
      autoStart: false,
    });

    const url = `/api/live2d/models/${modelId}/files/${entryFile}`;
    const model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: false });

    const scale = Math.min((THUMB_W - 20) / model.width, (THUMB_H - 20) / model.height);
    model.scale.set(scale);
    model.x = THUMB_W / 2;
    model.y = THUMB_H;
    model.anchor.set(0.5, 1);
    patchLive2DEvents(model);
    app.stage.addChild(model as any);

    model.update(16);
    app.render();
    await new Promise((r) => setTimeout(r, 600));
    model.update(16);
    app.render();

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    if (!base64 || base64.length < 200) {
      console.warn('[Live2D thumbnail] captured image too small, skipping');
      return null;
    }
    return base64;
  } catch (err) {
    console.warn('[Live2D thumbnail] capture failed:', err);
    return null;
  } finally {
    try { app?.destroy(true); } catch { /* ignore */ }
    try { canvas?.remove(); } catch { /* ignore */ }
  }
}


interface Live2DSettingsTabProps {
  globalEnabled: boolean;
  isAdmin: boolean;
  canManage: boolean;
  onGlobalToggled: (enabled: boolean) => void;
}

export function Live2DSettingsTab({
  globalEnabled,
  isAdmin,
  canManage,
  onGlobalToggled,
}: Live2DSettingsTabProps) {
  const { t } = useTranslation('live2d');
  const [models, setModels] = useState<Live2DModelInfo[]>([]);
  const [preferences, setPreferences] = useState<Live2DPreferences | null>(null);
  const [emotionProviders, setEmotionProviders] = useState<Live2DEmotionProvider[]>([]);
  const [uploadName, setUploadName] = useState('');
  const [uploadVisibility, setUploadVisibility] = useState('private');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' }>({ text: '', type: 'success' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingGlobal, setTogglingGlobal] = useState(false);
  const [thumbMissing, setThumbMissing] = useState<Set<string>>(new Set());
  const [capturingThumb, setCapturingThumb] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewModel, setPreviewModel] = useState<Live2DModelInfo | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [modelPage, setModelPage] = useState(1);

  const [localScale, setLocalScale] = useState<number | null>(null);
  const [localOffsetY, setLocalOffsetY] = useState<number | null>(null);

  function flash(text: string, type: 'success' | 'error' = 'success') {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: '', type: 'success' }), 3000);
  }

  const fetchData = useCallback(async () => {
    setLoadError(null);
    try {
      const [modelsRes, prefsRes, providersRes] = await Promise.all([
        fetch('/api/live2d/models'),
        fetch('/api/live2d/preferences'),
        fetch('/api/live2d/emotion-providers'),
      ]);
      if (modelsRes.status === 403 || prefsRes.status === 403) {
        setLoadError(t('settings.noPermission'));
        return;
      }
      if (modelsRes.ok) setModels(await modelsRes.json());
      if (prefsRes.ok) setPreferences(await prefsRes.json());
      if (providersRes.ok) setEmotionProviders(await providersRes.json());
    } catch {
      setLoadError(t('settings.loadFailed'));
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (preferences) {
      setLocalScale(preferences.modelScale ?? 1.0);
      setLocalOffsetY(preferences.modelOffsetY ?? 0);
    }
  }, [preferences]);

  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models;
    const q = searchQuery.toLowerCase();
    return models.filter((m) => m.name.toLowerCase().includes(q));
  }, [models, searchQuery]);

  async function toggleGlobal(enabled: boolean) {
    setTogglingGlobal(true);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ LIVE2D_ENABLED: String(enabled) }),
      });
      if (res.ok) {
        onGlobalToggled(enabled);
        flash(enabled ? t('settings.enabled') : t('settings.disabled'));
      } else if (res.status === 403) {
        flash(t('settings.noPermSwitch'), 'error');
      } else {
        flash(t('settings.saveFailed'), 'error');
      }
    } catch {
      flash(t('settings.networkError'), 'error');
    } finally {
      setTogglingGlobal(false);
    }
  }

  async function savePreferences(updates: Partial<Live2DPreferences>) {
    try {
      const res = await fetch('/api/live2d/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const updated = await res.json();
        setPreferences(updated);
        flash(t('settings.saved'));
      } else if (res.status === 403) {
        flash(t('settings.noPermSave'), 'error');
      } else {
        const err = await res.json().catch(() => ({ error: t('settings.saveFailed') }));
        flash(t('settings.saveFailedDetail', { error: err.error }), 'error');
      }
    } catch {
      flash(t('settings.saveNetworkError'), 'error');
    }
  }

  async function handleUpload() {
    if (!uploadFile || !uploadName.trim()) return;
    setUploading(true);
    try {
      const buffer = await uploadFile.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
      );
      const res = await fetch('/api/live2d/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: uploadName.trim(),
          visibility: uploadVisibility,
          format: 'cubism4',
          zipData: base64,
        }),
      });
      if (res.ok) {
        const created = await res.json();
        setUploadName('');
        setUploadFile(null);
        flash(t('settings.uploadSuccess'));
        fetchData();
        if (created.id && created.entryFile) {
          const thumb = await captureThumbnail(created.id, created.entryFile);
          if (thumb) {
            const patchRes = await fetch(`/api/live2d/models/${created.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ thumbnail: thumb }),
            });
            if (!patchRes.ok) console.warn('[Live2D thumbnail] PATCH failed:', patchRes.status);
            fetchData();
          } else {
            console.warn('[Live2D thumbnail] capture returned null for', created.id);
          }
        }
      } else {
        const err = await res.json().catch(() => ({ error: t('settings.uploadFailed', { error: '' }) }));
        flash(t('settings.uploadFailed', { error: err.error }), 'error');
      }
    } catch (e) {
      flash(t('settings.uploadFailed', { error: (e as Error).message }), 'error');
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteModel(id: string) {
    if (!confirm(t('settings.deleteConfirm'))) return;
    try {
      const res = await fetch(`/api/live2d/models/${id}`, { method: 'DELETE' });
      if (res.ok) {
        flash(t('settings.deleted'));
        fetchData();
      }
    } catch { /* ignore */ }
  }

  async function handleRegenThumb(m: Live2DModelInfo) {
    if (!m.entryFile || capturingThumb) return;
    setCapturingThumb(m.id);
    const thumb = await captureThumbnail(m.id, m.entryFile);
    if (thumb) {
      await fetch(`/api/live2d/models/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbnail: thumb }),
      });
      setThumbMissing((prev) => { const next = new Set(prev); next.delete(m.id); return next; });
      fetchData();
      flash(t('settings.thumbnailUpdated'));
    } else {
      flash(t('settings.thumbnailFailed'), 'error');
    }
    setCapturingThumb(null);
  }

  const booleanField = (key: string, label: string, hint: string | null, checked: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <div key={key} className="form-group channel-boolean-field">
      <div className="settings-boolean-row">
        <div className="settings-boolean-copy">
          <label>{label}</label>
          {hint ? <div className="settings-hint">{hint}</div> : null}
        </div>
        <div className="channel-boolean-control"><NcToggle checked={checked} onChange={onChange} disabled={disabled} /></div>
      </div>
    </div>
  );

  const msgBanner = message.text ? (
    <div className="config-info" style={message.type === 'error' ? { borderColor: 'var(--error-color, #f38ba8)', color: 'var(--error-color, #f38ba8)' } : undefined}>
      {message.text}
    </div>
  ) : null;

  const modelOptions: AppSelectOption[] = [
    { value: '', label: t('settings.selectModel') },
    ...models.map((m) => ({ value: m.id, label: `${m.name} (${m.visibility === 'private' ? t('settings.visibility.private') : t('settings.visibility.public')})` })),
  ];
  const positionOptions: AppSelectOption[] = [{ value: 'right', label: t('settings.position.right') }, { value: 'left', label: t('settings.position.left') }];
  const emotionProviderOptions: AppSelectOption[] = [
    { value: '', label: t('settings.defaultModel') },
    ...emotionProviders.map((p) => ({ value: p.id, label: `${p.alias} (${p.type}${p.model ? ` / ${p.model}` : ''})` })),
  ];
  const visibilityOptions: AppSelectOption[] = [{ value: 'private', label: t('settings.visibility.private') }, { value: 'public', label: t('settings.visibility.public') }];

  if (!globalEnabled) {
    return (
      <section className="settings-section live2d-settings">
        <h3>{t('settings.title')}</h3>
        {msgBanner}
        {loadError && <div className="config-info" style={{ color: 'var(--error-color, #f38ba8)' }}>{loadError}</div>}
        <p className="settings-hint" style={{ margin: '12px 0' }}>{t('config.disabled')}</p>
        {isAdmin && (
          <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn-primary btn-sm" onClick={() => toggleGlobal(true)} disabled={togglingGlobal}>
              {togglingGlobal ? t('settings.enabling', '...') : t('settings.enableNow')}
            </button>
          </div>
        )}
      </section>
    );
  }

  const renderModelCard = (m: Live2DModelInfo) => {
    const isSelected = preferences?.selectedModelId === m.id;
    const isMissing = thumbMissing.has(m.id);
    return (
      <div key={m.id} className={`live2d-card${isSelected ? ' is-selected' : ''}`}>
        <div className="live2d-card-thumb" onClick={() => !isMissing && setPreviewModel(m)}>
          {isMissing ? (
            <button
              type="button"
              className="live2d-thumb-gen-btn"
              title={t('settings.genPreview', 'Generate preview')}
              disabled={capturingThumb === m.id || !m.entryFile}
              onClick={(e) => { e.stopPropagation(); handleRegenThumb(m); }}
            >
              {capturingThumb === m.id ? (
                <span className="live2d-thumb-spinner" />
              ) : (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
              )}
            </button>
          ) : (
            <img
              src={`/api/live2d/models/${m.id}/thumbnail`}
              alt={m.name}
              draggable={false}
              onError={() => setThumbMissing((prev) => new Set(prev).add(m.id))}
            />
          )}
        </div>
        <div className="live2d-card-info">
          <div className="live2d-card-name" title={m.name}>{m.name}</div>
          <div className="live2d-card-meta">
            <span className={`provider-type-tag ${m.format}`}>{m.format}</span>
            <span>{(m.fileSize / 1024 / 1024).toFixed(1)} MB</span>
            <span>{m.visibility === 'private' ? t('settings.visibility.private') : t('settings.visibility.public')}</span>
          </div>
        </div>
        <div className="live2d-card-actions">
          <button className={`btn-sm ${isSelected ? 'btn-outline' : 'btn-primary'}`} onClick={() => savePreferences({ selectedModelId: m.id })} disabled={isSelected}>
            {isSelected ? t('settings.inUse') : t('settings.use')}
          </button>
          {canManage && (
            <button className="btn-danger btn-sm" onClick={() => handleDeleteModel(m.id)}>{t('settings.delete')}</button>
          )}
        </div>
      </div>
    );
  };

  const pagedModels = filteredModels.slice((modelPage - 1) * MODEL_PAGE_SIZE, modelPage * MODEL_PAGE_SIZE);

  return (
    <section className="settings-section live2d-settings">
      <div className="section-header">
        <h3>{t('settings.title')}</h3>
        {msgBanner}
        {loadError && <div className="config-info" style={{ color: 'var(--error-color, #f38ba8)' }}>{loadError}</div>}
      </div>

      {/* Toolbar: search + actions */}
      <div className="live2d-toolbar">
        <div className="live2d-toolbar-row">
          {models.length > 5 && (
            <div className="live2d-search live2d-search--wide">
              <input type="text" placeholder={t('settings.searchPlaceholder')} value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setModelPage(1); }} />
            </div>
          )}
          <div className="live2d-toolbar-actions">
            {canManage && (
              <button className="btn-primary btn-sm" onClick={() => setUploadDialogOpen(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {t('settings.uploadModel')}
              </button>
            )}
            <button className="btn-secondary btn-sm" onClick={() => setConfigDrawerOpen(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              {t('settings.configure')}
            </button>
          </div>
        </div>
        <div className="live2d-toolbar-meta">
          <span className="live2d-model-count">{t('settings.modelLibrary', { count: filteredModels.length })}</span>
          {filteredModels.length > MODEL_PAGE_SIZE && (
            <Pagination page={modelPage} pageSize={MODEL_PAGE_SIZE} total={filteredModels.length} onPageChange={setModelPage} />
          )}
        </div>
      </div>

      {/* Model Card Grid */}
      {filteredModels.length === 0 ? (
        <div className="live2d-empty-hint">
          {models.length === 0 ? t('settings.noModels') : t('settings.noMatch')}
        </div>
      ) : (
        <div className="live2d-card-grid">
          {pagedModels.map(renderModelCard)}
        </div>
      )}

      {/* ── Upload dialog ─────────────────────────────────── */}
      {uploadDialogOpen && (
        <div className="live2d-preview-overlay" onClick={() => setUploadDialogOpen(false)}>
          <div className="live2d-upload-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="live2d-upload-dialog-header">
              <h4>{t('settings.uploadTitle')}</h4>
              <button type="button" className="live2d-preview-close" onClick={() => setUploadDialogOpen(false)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
            <div className="settings-hint" style={{ marginBottom: 12 }}>
              {t('settings.uploadHint')}
            </div>
            <div className="form-group">
              <label>{t('settings.modelName')}</label>
              <input type="text" placeholder={t('settings.modelNamePlaceholder')} value={uploadName} onChange={(e) => setUploadName(e.target.value)} />
            </div>
            <div className="form-group">
              <label>{t('settings.visibility.label')}</label>
              <AppSelect value={uploadVisibility} options={visibilityOptions} onChange={setUploadVisibility} />
            </div>
            <div className="form-group">
              <label>{t('settings.modelFile')}</label>
              <div className="live2d-file-upload">
                <input ref={fileInputRef} type="file" accept=".zip" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
                <button type="button" className="live2d-file-upload-btn" onClick={() => fileInputRef.current?.click()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  {t('settings.chooseFile')}
                </button>
                {uploadFile && <span className="live2d-file-upload-name">{uploadFile.name}</span>}
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setUploadDialogOpen(false)}>{t('settings.cancel')}</button>
              <button className="btn-primary" onClick={async () => { await handleUpload(); setUploadDialogOpen(false); }} disabled={uploading || !uploadFile || !uploadName.trim()}>
                {uploading ? t('settings.uploading') : t('settings.upload')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Config drawer ─────────────────────────────────── */}
      <Drawer open={configDrawerOpen} onClose={() => setConfigDrawerOpen(false)} title={t('settings.configDrawerTitle')} width={420}>
        <div className="live2d-config-panel">
          {isAdmin && booleanField('live2d-global', t('settings.globalSwitch'), t('settings.globalSwitchHint'), globalEnabled, (v) => toggleGlobal(v), togglingGlobal)}
          {booleanField('live2d-personal', t('settings.personalSwitch'), t('settings.personalSwitchHint'), preferences?.enabled ?? false, (v) => savePreferences({ enabled: v }))}

          <div className="form-group">
            <label>{t('config.currentModel')}</label>
            <AppSelect value={preferences?.selectedModelId || ''} options={modelOptions} onChange={(v) => savePreferences({ selectedModelId: v || null })} placeholder={t('config.selectModel')} />
          </div>
          <div className="form-group">
            <label>{t('config.position')}</label>
            <AppSelect value={preferences?.position || 'right'} options={positionOptions} onChange={(v) => savePreferences({ position: v })} />
          </div>
          <div className="form-group">
            <label>{t('config.scale', { value: (localScale ?? preferences?.modelScale ?? 1.0).toFixed(1) })}</label>
            <div className="settings-hint">{t('settings.scaleHint')}</div>
            <input
              type="range" min={0.5} max={3.0} step={0.1}
              value={localScale ?? preferences?.modelScale ?? 1.0}
              onChange={(e) => setLocalScale(parseFloat(e.target.value) || 1.0)}
              onPointerUp={() => { if (localScale != null) void savePreferences({ modelScale: localScale }); }}
              onTouchEnd={() => { if (localScale != null) void savePreferences({ modelScale: localScale }); }}
            />
          </div>
          <div className="form-group">
            <label>{t('config.offsetY', { value: localOffsetY ?? preferences?.modelOffsetY ?? 0 })}</label>
            <div className="settings-hint">{t('settings.offsetHint')}</div>
            <input
              type="range" min={-200} max={200} step={5}
              value={localOffsetY ?? preferences?.modelOffsetY ?? 0}
              onChange={(e) => setLocalOffsetY(parseInt(e.target.value) || 0)}
              onPointerUp={() => { if (localOffsetY != null) void savePreferences({ modelOffsetY: localOffsetY }); }}
              onTouchEnd={() => { if (localOffsetY != null) void savePreferences({ modelOffsetY: localOffsetY }); }}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.emotionModel')}</label>
            <div className="settings-hint">{t('settings.emotionModelHint')}</div>
            <AppSelect value={preferences?.emotionProviderId || ''} options={emotionProviderOptions} onChange={(v) => savePreferences({ emotionProviderId: v || null })} placeholder={t('settings.defaultModel')} />
          </div>
        </div>
      </Drawer>

      {/* ── Preview modal ─────────────────────────────────── */}
      {previewModel && (
        <div className="live2d-preview-overlay" onClick={() => setPreviewModel(null)}>
          <div className="live2d-preview-modal" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="live2d-preview-close" onClick={() => setPreviewModel(null)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
            <img src={`/api/live2d/models/${previewModel.id}/thumbnail`} alt={previewModel.name} className="live2d-preview-img" />
            <div className="live2d-preview-info">
              <div className="live2d-preview-name">{previewModel.name}</div>
              <div className="live2d-preview-meta">
                <span className={`provider-type-tag ${previewModel.format}`}>{previewModel.format}</span>
                <span>{(previewModel.fileSize / 1024 / 1024).toFixed(1)} MB</span>
                <span>{previewModel.visibility === 'private' ? t('settings.visibility.private') : t('settings.visibility.public')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
