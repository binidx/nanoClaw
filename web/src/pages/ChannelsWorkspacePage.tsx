import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DoctorReport, StatusInfo } from '../app-types';
import { SectionNav } from '../components/common/SectionNav';
import { SettingsPage, type SettingsPageProps } from './settings';
import { ChannelsPage } from './ChannelsPage';

type ChannelsWorkspaceTab = 'overview' | 'instances' | 'diagnostics';

export interface ChannelsWorkspacePageProps {
  status: StatusInfo | null;
  doctorReport: DoctorReport | null;
  formatUptime: (seconds: number) => string;
  refreshDoctorReport: () => void;
  openGlobalSettings: () => void;
  channelSettingsProps: SettingsPageProps;
}

export function ChannelsWorkspacePage({
  status,
  doctorReport,
  formatUptime,
  refreshDoctorReport,
  openGlobalSettings,
  channelSettingsProps,
}: ChannelsWorkspacePageProps) {
  const { t } = useTranslation('channels');
  const [activeTab, setActiveTab] = useState<ChannelsWorkspaceTab>('overview');
  const totalChannels = status?.channels.length ?? 0;
  const disconnectedChannels =
    totalChannels -
    (status?.channels.filter((channel) => channel.connected).length ?? 0);

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-header-copy">
          <h2>{t('channels.page.title')}</h2>
          <p>把运行概览、实例配置和诊断放回同一个域里，避免在设置页和状态页之间来回跳转。</p>
        </div>
        <div className="page-header-actions">
          <button
            className="btn-outline btn-sm"
            onClick={refreshDoctorReport}
            type="button"
          >
            {t('channels.page.refreshDiagnostics')}
          </button>
          <button
            className="btn-outline btn-sm"
            onClick={openGlobalSettings}
            type="button"
          >
            打开全局设置
          </button>
        </div>
      </div>

      <div className="page-body">
        <SectionNav
          className="settings-section-nav"
          ariaLabel={t('channels.page.title')}
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as ChannelsWorkspaceTab)}
          items={[
            {
              key: 'overview',
              label: '概览',
              badge: `${totalChannels}`,
            },
            {
              key: 'instances',
              label: '实例',
              badge: `${channelSettingsProps.channelInstances.length}`,
            },
            {
              key: 'diagnostics',
              label: '诊断',
              badge: `${doctorReport?.checks.length ?? disconnectedChannels}`,
              tone:
                (doctorReport?.counts.error ?? 0) > 0
                  ? 'danger'
                  : (doctorReport?.counts.warn ?? 0) > 0
                    ? 'warning'
                    : 'default',
            },
          ]}
        />

        {activeTab === 'overview' ? (
          <ChannelsPage
            status={status}
            doctorReport={doctorReport}
            formatUptime={formatUptime}
            openSettings={openGlobalSettings}
            refreshDoctorReport={refreshDoctorReport}
            section="overview"
            showHeader={false}
          />
        ) : null}

        {activeTab === 'instances' ? (
          <div className="channel-settings-panel">
            <div className="section-header">
              <div>
                <h3>实例配置</h3>
                <p className="settings-hint">
                  实例 CRUD 从 `Settings` 中移回 `Channels` 域，保持对象列表和配置表单同域处理。
                </p>
              </div>
            </div>
            <SettingsPage
              {...channelSettingsProps}
              embedded
              hideSettingsTabs
              pageTitle="频道实例"
              visibleTabs={['channels']}
            />
          </div>
        ) : null}

        {activeTab === 'diagnostics' ? (
          <ChannelsPage
            status={status}
            doctorReport={doctorReport}
            formatUptime={formatUptime}
            openSettings={openGlobalSettings}
            refreshDoctorReport={refreshDoctorReport}
            section="diagnostics"
            showHeader={false}
          />
        ) : null}
      </div>
    </div>
  );
}
