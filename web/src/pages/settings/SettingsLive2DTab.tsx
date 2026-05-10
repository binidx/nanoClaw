
import type { Dispatch, SetStateAction } from 'react';
import { Live2DSettingsTab } from '../../components/live2d/Live2DSettingsTab';
import type { BasicConfigState } from '../../app-types';

export type SettingsLive2DTabProps = {
  basicConfig: BasicConfigState;
  setBasicConfig: Dispatch<SetStateAction<BasicConfigState>>;
  hasSystemSettings?: boolean;
  hasLive2dManage?: boolean;
};

export function SettingsLive2DTab(props: SettingsLive2DTabProps) {
  const { basicConfig, setBasicConfig, hasSystemSettings, hasLive2dManage } = props;
  return (
  <Live2DSettingsTab
    globalEnabled={basicConfig.LIVE2D_ENABLED === true || basicConfig.LIVE2D_ENABLED === 'true'}
    isAdmin={hasSystemSettings ?? false}
    canManage={hasLive2dManage ?? false}
    onGlobalToggled={(enabled) => {
      setBasicConfig((prev) => ({ ...prev, LIVE2D_ENABLED: String(enabled) }));
    }}
  />

  );
}
