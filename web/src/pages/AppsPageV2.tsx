import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useNavigatedTab } from '../hooks/useNavigatedTab';
import { useUserMcp } from '../hooks/useUserMcp';
import { useUserSkills } from '../hooks/useUserSkills';
import { usePublicLibrary } from '../hooks/usePublicLibrary';
import { useRegistry } from '../hooks/useRegistry';
import { MyAppsPanel } from '../components/apps/MyAppsPanel';
import { StorePanel } from '../components/apps/StorePanel';
import { SectionNav } from '../components/common/SectionNav';

import './AppsPageV2.css';

type AppsV2Tab = 'my-apps' | 'store';
const VALID_TABS: ReadonlySet<string> = new Set<AppsV2Tab>([
  'my-apps',
  'store',
]);

export interface AppsPageV2Props {
  apiBase: string;
  isAdmin?: boolean;
}

export function AppsPageV2({ apiBase, isAdmin }: AppsPageV2Props) {
  const { t } = useTranslation('apps');
  const [activeTab, setActiveTab] = useNavigatedTab<AppsV2Tab>(
    'apps',
    VALID_TABS,
    'my-apps',
  );

  const mcp = useUserMcp(apiBase);
  const skills = useUserSkills(apiBase);
  const library = usePublicLibrary(apiBase);

  const installedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of mcp.servers) ids.add(s.id);
    for (const s of skills.skills) ids.add(s.id);
    for (const s of mcp.servers) {
      if (s.sourceRef) ids.add(s.sourceRef);
    }
    for (const s of skills.skills) {
      if (s.sourceRef) ids.add(s.sourceRef);
    }
    return ids;
  }, [mcp.servers, skills.skills]);

  const installedRegistrySlugs = useMemo(() => {
    const slugs = new Set<string>();
    for (const s of mcp.servers) {
      if (s.sourceType === 'registry' && s.sourceRef) {
        slugs.add(s.sourceRef.replace(/@.*$/, ''));
      }
    }
    for (const s of skills.skills) {
      if (s.sourceType === 'registry' && s.sourceRef) {
        slugs.add(s.sourceRef.replace(/@.*$/, ''));
      }
    }
    return slugs;
  }, [mcp.servers, skills.skills]);

  const registry = useRegistry(apiBase);

  const [storeRefreshKey, setStoreRefreshKey] = useState(0);

  const myAppsCount = mcp.myServers.length + skills.mySkills.length;
  const managedAppsCount = mcp.servers.length + skills.skills.length;
  const storeItemCount = library.total + registry.items.length;

  const tabs: Array<{ id: AppsV2Tab; label: string; count: string }> = [
    {
      id: 'my-apps',
      label: t('auto.0ecb7b61'),
      count: t('auto.14e79b5c', {
        count: mcp.myServers.length + skills.mySkills.length,
      }),
    },
    {
      id: 'store',
      label: t('auto.d9dd6ba8'),
      count: t('auto.ee709761', { count: storeItemCount }),
    },
  ];

  const handleRegistryInstall = async (slug: string) => {
    const ok = await registry.install(slug);
    if (ok) {
      await mcp.refresh();
      await skills.refresh();
    }
    return ok;
  };

  const handleLibraryInstall = async (
    itemId: string,
    itemType: 'mcp' | 'skill',
  ) => {
    const ok = await library.install(itemId, itemType);
    if (ok) {
      await mcp.refresh();
      await skills.refresh();
      setStoreRefreshKey((k) => k + 1);
    }
    return ok;
  };

  return (
    <div className="page-view apps-v2-page">
      <div className="page-header">
        <div className="page-header-copy">
          <h2>{t('auto.5b0520a9')}</h2>
          <p>{t('auto.9e1a264c')}</p>
        </div>
        <div className="page-header-actions apps-v2-header-stats">
          <div className="apps-v2-stat-card">
            <span>{t('auto.0ecb7b61')}</span>
            <strong>{myAppsCount}</strong>
          </div>
          <div className="apps-v2-stat-card">
            <span>{t('auto.d9dd6ba8')}</span>
            <strong>{storeItemCount}</strong>
          </div>
          <div className="apps-v2-stat-card">
            <span>{t('auto.14e79b5c', { count: managedAppsCount })}</span>
            <strong>{managedAppsCount}</strong>
          </div>
        </div>
      </div>

      <div className="page-body apps-v2-body">
        <div className="apps-v2-stage">
          <div className="apps-v2-stage-header">
            <SectionNav
              className="apps-v2-section-nav"
              ariaLabel={t('auto.5b0520a9')}
              activeKey={activeTab}
              onChange={(key) => setActiveTab(key as AppsV2Tab)}
              items={tabs.map((tab) => ({
                key: tab.id,
                label: tab.label,
                badge: tab.count,
              }))}
            />
            <p className="apps-v2-stage-copy">
              {activeTab === 'my-apps'
                ? t('auto.14e79b5c', { count: myAppsCount })
                : t('auto.ee709761', { count: storeItemCount })}
            </p>
          </div>

          {(() => {
            const errors = [mcp.error, skills.error, library.error].filter(
              Boolean,
            );
            if (errors.length === 0) return null;
            return (
              <div className="apps-v2-error" role="alert">
                {errors.join('；')}
              </div>
            );
          })()}

          <div className="apps-v2-content-surface">
            <div className="apps-v2-content">
              {activeTab === 'my-apps' && (
                <MyAppsPanel
                  mcpServers={mcp.servers}
                  skills={skills.skills}
                  loading={mcp.loading || skills.loading}
                  onCreateMcp={mcp.create}
                  onGenerateMcp={mcp.generateWithAi}
                  onImportMcpJson={mcp.importFromJson}
                  onImportMcp={mcp.importFromPath}
                  onUpdateMcp={mcp.update}
                  onDeleteMcp={mcp.remove}
                  onToggleMcpVisibility={mcp.toggleVisibility}
                  onCreateSkill={skills.create}
                  onImportSkill={skills.importFromPath}
                  onUpdateSkill={skills.update}
                  onDeleteSkill={skills.remove}
                  onToggleSkillVisibility={skills.toggleVisibility}
                />
              )}

              {activeTab === 'store' && (
                <StorePanel
                  key={storeRefreshKey}
                  apiBase={apiBase}
                  isAdmin={isAdmin}
                  library={library}
                  registry={registry}
                  installedIds={installedIds}
                  installedRegistrySlugs={installedRegistrySlugs}
                  onRegistryInstall={handleRegistryInstall}
                  onLibraryInstall={handleLibraryInstall}
                  onLibraryDelete={isAdmin ? library.deleteItem : undefined}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
