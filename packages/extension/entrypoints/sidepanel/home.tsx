import { useEffect, useState } from 'react';
import { Badge, Button, Tabs } from 'antd';
import {
  ApiOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiRecordingFeature } from '@/components/recording/api-recording-feature';
import { GatewayFeature } from '@/components/gateway/gateway-feature';
import { McpFeature } from '@/components/mcp/mcp-feature';
import { SettingsFeature } from '@/components/settings/settings-feature';
import { useRecordingState } from '@/hooks/use-recording-state';
import { sidePanelTab, lastSidePanelTab } from '@/lib/storage';

/**
 * The side panel home page: a top tab bar of features with a gear button pinned
 * to the far right (opens the Settings view — language switch, etc.). Unlike the
 * detail pages, the tab bar lives *inside* this route — those pages are
 * full-screen and replace the whole view, so the bar only shows on home.
 */

type FeatureKey = 'api-recording' | 'gateway' | 'mcp';
/** The active home view: a feature tab, or the gear-opened settings view. */
type ActiveView = FeatureKey | 'settings';

const FEATURES: {
  key: FeatureKey;
  labelKey: 'home.apiRecording' | 'home.gateway' | 'home.mcp';
  icon: React.ReactNode;
}[] = [
  { key: 'mcp', labelKey: 'home.mcp', icon: <DeploymentUnitOutlined /> },
  { key: 'api-recording', labelKey: 'home.apiRecording', icon: <ApiOutlined /> },
  { key: 'gateway', labelKey: 'home.gateway', icon: <CloudServerOutlined /> },
];

export function HomePage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const state = useRecordingState();
  const [active, setActive] = useState<ActiveView>('mcp');

  // On mount decide which tab to open, in priority order:
  //   1. A tab the popup explicitly requested (e.g. picking "MCP") — one-shot,
  //      cleared after use.
  //   2. Otherwise, the tab the user last viewed (persisted across restarts).
  //   3. Otherwise, the default set above (first feature tab).
  useEffect(() => {
    (async () => {
      const requested = await sidePanelTab.getValue();
      if (requested) {
        setActive(requested);
        await sidePanelTab.setValue(null);
        return;
      }
      const last = await lastSidePanelTab.getValue();
      if (last) setActive(last);
    })();
  }, []);

  // Remember the user's current feature tab so the next open restores it. The
  // gear-opened settings view is not a feature tab, so it is not persisted.
  const selectTab = (view: ActiveView) => {
    setActive(view);
    if (view !== 'settings') void lastSidePanelTab.setValue(view);
  };

  const items = FEATURES.map((f) => ({
    key: f.key,
    label: (
      <span>
        {t(f.labelKey)}
        {f.key === 'api-recording' && state.active && (
          <Badge status="processing" className="ml-1.5" />
        )}
      </span>
    ),
  }));

  return (
    <div className="flex flex-col h-full">
      <Tabs
        // When the settings view is open no feature tab is active; passing a key
        // that matches no item leaves the bar with nothing highlighted.
        activeKey={active === 'settings' ? '' : active}
        onChange={(k) => selectTab(k as FeatureKey)}
        items={items}
        tabBarStyle={{ margin: 0, padding: '0 8px' }}
        tabBarExtraContent={{
          right: (
            <Button
              type="text"
              size="small"
              aria-label={t('settings.title')}
              icon={<SettingOutlined />}
              onClick={() => selectTab(active === 'settings' ? 'mcp' : 'settings')}
            />
          ),
        }}
        indicator={{ size: 24, align: 'center' }}
        animated={false}
      />

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {active === 'api-recording' ? (
          <ApiRecordingFeature onOpen={(id) => navigate(`/detail/${id}`)} />
        ) : active === 'gateway' ? (
          <GatewayFeature />
        ) : active === 'mcp' ? (
          <McpFeature />
        ) : (
          <SettingsFeature />
        )}
      </div>
    </div>
  );
}
