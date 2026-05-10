import { useCallback, type Dispatch, type SetStateAction } from 'react';

import i18n from '../i18n/index.ts';

import type { AiProvider, NativeDialogLike, TestResult } from '../app-types';

type UseProviderActionsParams = {
  apiBase: string;
  providers: AiProvider[];
  editingProvider: Partial<AiProvider> | null;
  setEditingProvider: Dispatch<SetStateAction<Partial<AiProvider> | null>>;
  setTestingId: Dispatch<SetStateAction<string | null>>;
  setTestResults: Dispatch<SetStateAction<Record<string, TestResult>>>;
  showNativeConfirm: (dialog: NativeDialogLike) => Promise<boolean>;
  loadProviders: () => Promise<void> | void;
  loadStatus: () => Promise<void> | void;
  loadDoctorReport: () => Promise<void> | void;
};

export function useProviderActions({
  apiBase,
  providers,
  editingProvider,
  setEditingProvider,
  setTestingId,
  setTestResults,
  showNativeConfirm,
  loadProviders,
  loadStatus,
  loadDoctorReport,
}: UseProviderActionsParams) {
  const hasEmbeddingMaterialChange = useCallback(
    (nextProvider: Partial<AiProvider>, currentProvider: AiProvider | undefined): boolean => {
      if (!currentProvider) return false;
      const nextCapability = nextProvider.capability || currentProvider.capability || 'llm';
      return (
        nextCapability !== (currentProvider.capability || 'llm') ||
        (nextProvider.type !== undefined && nextProvider.type !== currentProvider.type) ||
        (nextProvider.api_key !== undefined && nextProvider.api_key !== currentProvider.api_key) ||
        (nextProvider.base_url !== undefined && nextProvider.base_url !== currentProvider.base_url) ||
        (nextProvider.model !== undefined && nextProvider.model !== currentProvider.model) ||
        (nextProvider.dimensions !== undefined && nextProvider.dimensions !== currentProvider.dimensions)
      );
    },
    [],
  );

  const saveProvider = useCallback(async () => {
    if (!editingProvider) return;
    const isNew = !editingProvider.id;
    let customHeaders: Record<string, string> | null | undefined =
      editingProvider.custom_headers;
    const customHeadersText = String(
      editingProvider.custom_headers_text ?? '',
    ).trim();
    if (customHeadersText) {
      try {
        const parsed = JSON.parse(customHeadersText) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          window.alert(i18n.t('hooks.providerActions.customHeadersMustBeObject'));
          return;
        }
        customHeaders = Object.fromEntries(
          Object.entries(parsed)
            .map(([key, value]) => [
              String(key || '').trim(),
              String(value ?? '').trim(),
            ])
            .filter(([key, value]) => key && value),
        );
      } catch {
        window.alert(i18n.t('hooks.providerActions.customHeadersParseFailed'));
        return;
      }
    } else {
      customHeaders = null;
    }
    try {
      const isSystemProvider = editingProvider.source === 'system';
      const basePath = isSystemProvider
        ? `${apiBase}/api/ai-providers`
        : `${apiBase}/api/user/providers`;
      const currentProvider = editingProvider.id
        ? providers.find((entry) => entry.id === editingProvider.id)
        : undefined;
      const nextCapability = editingProvider.capability || currentProvider?.capability || 'llm';
      const shouldConfirmEmbeddingImpact =
        !isNew &&
        editingProvider.id &&
        nextCapability === 'embedding' &&
        hasEmbeddingMaterialChange(editingProvider, currentProvider);
      if (shouldConfirmEmbeddingImpact) {
        const usageUrl = isSystemProvider
          ? `${apiBase}/api/ai-providers/${editingProvider.id}/knowledge-usage`
          : `${apiBase}/api/user/providers/${editingProvider.id}/knowledge-usage`;
        try {
          const usageRes = await fetch(usageUrl);
          if (usageRes.ok) {
            const usage = await usageRes.json() as { embeddingRefs?: number };
            if ((usage.embeddingRefs || 0) > 0) {
              const confirmed = await showNativeConfirm({
                title: i18n.t('hooks.providerActions.modifyEmbeddingTitle'),
                message: i18n.t('hooks.providerActions.modifyEmbeddingConfirm', { count: usage.embeddingRefs || 0 }),
                confirmLabel: i18n.t('hooks.providerActions.continueSave'),
              });
              if (!confirmed) return;
            }
          }
        } catch {
          /* ignore usage lookup failure */
        }
      }
      const url = isNew ? basePath : `${basePath}/${editingProvider.id}`;
      const payload = {
        ...editingProvider,
        custom_headers: customHeaders,
      };
      delete payload.custom_headers_text;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as {
          requiresKnowledgeReembed?: boolean;
          knowledgeBaseRefs?: number;
        };
        setEditingProvider(null);
        await Promise.resolve(loadProviders());
        void loadDoctorReport();
        if (data.requiresKnowledgeReembed) {
          const confirmed = await showNativeConfirm({
            title: i18n.t('hooks.providerActions.rebuildEmbeddingsTitle'),
            message: i18n.t('hooks.providerActions.rebuildEmbeddingsConfirm', { count: data.knowledgeBaseRefs || 0 }),
            confirmLabel: i18n.t('hooks.providerActions.rebuildNow'),
          });
          if (confirmed) {
            await fetch(`${apiBase}/api/knowledge/rebuild-embeddings`, {
              method: 'POST',
              credentials: 'include',
            });
          }
        }
      }
    } catch {
      /* offline */
    }
  }, [
    apiBase,
    editingProvider,
    hasEmbeddingMaterialChange,
    loadDoctorReport,
    loadProviders,
    providers,
    setEditingProvider,
    showNativeConfirm,
  ]);

  const deleteProviderById = useCallback(
    async (id: string) => {
      const confirmed = await showNativeConfirm({
        title: i18n.t('hooks.providerActions.deleteProviderTitle'),
        message: i18n.t('hooks.providerActions.deleteProviderConfirm'),
        confirmLabel: i18n.t('hooks.providerActions.confirmDelete'),
      });
      if (!confirmed) return;
      try {
        const provider = providers.find((entry) => entry.id === id);
        const url = provider?.source === 'system'
          ? `${apiBase}/api/ai-providers/${id}`
          : `${apiBase}/api/user/providers/${id}`;
        await fetch(url, { method: 'DELETE' });
        await Promise.resolve(loadProviders());
        void loadDoctorReport();
      } catch {
        /* offline */
      }
    },
    [apiBase, loadDoctorReport, loadProviders, providers, showNativeConfirm],
  );

  const activateProvider = useCallback(
    async (id: string) => {
      try {
        await fetch(`${apiBase}/api/user/providers/default`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: id }),
        });
        await Promise.resolve(loadProviders());
        void loadStatus();
        void loadDoctorReport();
      } catch {
        /* offline */
      }
    },
    [apiBase, loadDoctorReport, loadProviders, loadStatus],
  );

  const activateGlobalProvider = useCallback(
    async (id: string) => {
      try {
        await fetch(`${apiBase}/api/ai-providers/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_default: true }),
        });
        await Promise.resolve(loadProviders());
        void loadStatus();
        void loadDoctorReport();
      } catch {
        /* offline */
      }
    },
    [apiBase, loadDoctorReport, loadProviders, loadStatus],
  );

  const clearDefaultProvider = useCallback(async () => {
    try {
      await fetch(`${apiBase}/api/user/providers/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: null }),
      });
      await Promise.resolve(loadProviders());
      void loadStatus();
      void loadDoctorReport();
    } catch {
      /* offline */
    }
  }, [apiBase, loadDoctorReport, loadProviders, loadStatus]);

  const testProvider = useCallback(
    async (id: string) => {
      setTestingId(id);
      try {
        const provider = providers.find((entry) => entry.id === id);
        const url = provider?.source === 'system'
          ? `${apiBase}/api/ai-providers/${id}/test`
          : `${apiBase}/api/user/providers/${id}/test`;
        const res = await fetch(url, {
          method: 'POST',
        });
        if (res.ok) {
          const result: TestResult = await res.json();
          setTestResults((prev) => ({ ...prev, [id]: result }));
        }
      } catch {
        setTestResults((prev) => ({
          ...prev,
          [id]: { ok: false, message: i18n.t('hooks.providerActions.networkError') },
        }));
      }
      setTestingId(null);
    },
    [apiBase, providers, setTestResults, setTestingId],
  );

  return {
    activateProvider,
    activateGlobalProvider,
    clearDefaultProvider,
    deleteProviderById,
    saveProvider,
    testProvider,
  };
}
