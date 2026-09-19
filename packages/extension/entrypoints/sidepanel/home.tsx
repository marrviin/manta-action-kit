import { useEffect, useState } from "react";
import { Badge, Button, Tabs } from "antd";
import {
  ApiOutlined,
  CloudServerOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ApiRecordingFeature } from "@/components/recording/api-recording-feature";
import { ActionFeature } from "@/components/action/action-feature";
import { GatewayFeature } from "@/components/gateway/gateway-feature";
import { SettingsFeature } from "@/components/settings/settings-feature";
import { useRecordingState } from "@/hooks/use-recording-state";
import { sidePanelTab, lastSidePanelTab } from "@/lib/storage";

/**
 * The side panel home page: a top tab bar of features with a gear button pinned
 * to the far right (opens the Settings view — language switch, etc.). Unlike the
 * detail pages, the tab bar lives *inside* this route — those pages are
 * full-screen and replace the whole view, so the bar only shows on home.
 */

type FeatureKey = "api-recording" | "action" | "gateway";
/** The active home view: a feature tab, or the gear-opened settings view. */
type ActiveView = FeatureKey | "settings";

const FEATURES: {
  key: FeatureKey;
  labelKey: "home.apiRecording" | "home.actions" | "home.gateway";
  icon: React.ReactNode;
}[] = [
  { key: "action", labelKey: "home.actions", icon: <ThunderboltOutlined /> },
  {
    key: "api-recording",
    labelKey: "home.apiRecording",
    icon: <ApiOutlined />,
  },
  { key: "gateway", labelKey: "home.gateway", icon: <CloudServerOutlined /> },
];

export function HomePage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const state = useRecordingState();
  // null = still resolving the initial tab (popup request → last tab → default).
  // Stay unrendered until resolved so returning from a detail page doesn't flash
  // the default tab before the persisted one activates.
  const [active, setActive] = useState<ActiveView | null>(null);

  // Is this a home view we know how to render? Guards against stale persisted
  // values (e.g. the removed "mcp" tab) stored before this version.
  const isKnownView = (view: string): view is ActiveView =>
    view === "settings" || FEATURES.some((f) => f.key === view);

  // On mount decide which tab to open, in priority order:
  //   1. A tab the popup explicitly requested — one-shot, cleared after use.
  //   2. Otherwise, the tab the user last viewed (persisted across restarts).
  //   3. Otherwise, the default set below.
  useEffect(() => {
    (async () => {
      const requested = await sidePanelTab.getValue();
      if (requested && isKnownView(requested)) {
        setActive(requested);
        await sidePanelTab.setValue(null);
        return;
      }
      const last = await lastSidePanelTab.getValue();
      // Sanitize: a persisted tab that is no longer a feature key (e.g. the
      // removed "mcp" tab) falls back to the default.
      setActive(
        last && FEATURES.some((f) => f.key === last) ? last : "api-recording",
      );
    })();

    // The side panel may already be open when the popup requests a view — the
    // mount-time read above can't see that. Watch the request slot too and
    // consume it one-shot (null = nothing to do).
    const unwatch = sidePanelTab.watch((requested) => {
      if (!requested || !isKnownView(requested)) return;
      setActive(requested);
      // The gear-opened settings view is transient — not a persisted feature tab.
      if (requested !== "settings") void lastSidePanelTab.setValue(requested);
      void sidePanelTab.setValue(null);
    });
    return () => unwatch();
  }, []);

  // Remember the user's current feature tab so the next open restores it. The
  // gear-opened settings view is not a feature tab, so it is not persisted.
  const selectTab = (view: ActiveView) => {
    setActive(view);
    if (view !== "settings") void lastSidePanelTab.setValue(view);
  };

  const items = FEATURES.map((f) => {
    const showBadge = f.key === "api-recording" && state.active;
    const content = (
      <>
        {t(f.labelKey)}
        {showBadge && <Badge status="processing" className="ml-[5px]!" />}
      </>
    );
    return {
      key: f.key,
      label: (
        <span className="relative inline-block">
          {/* Bold ghost — an invisible always-bold copy that reserves the
              active tab's (bold) width, so switching tabs never shifts the
              bar. The visible layer sits absolutely on top and only goes
              bold when active (CSS in assets/tailwind.css). */}
          <span className="manta-home-tab-ghost" aria-hidden="true">
            {content}
          </span>
          <span className="manta-home-tab-view">{content}</span>
        </span>
      ),
    };
  });

  if (active === null) return null;

  return (
    <div className="flex flex-col h-full">
      <Tabs
        // Capsule-styled tab bar — see `.manta-action-kit-home-tabs` in
        // assets/tailwind.css (gray pill + black text when active, gray pill on
        // hover when inactive; no bottom border / ink bar).
        className="manta-action-kit-home-tabs"
        // When the settings view is open no feature tab is active; passing a key
        // that matches no item leaves the bar with nothing highlighted.
        activeKey={active === "settings" ? "" : active}
        onChange={(k) => selectTab(k as FeatureKey)}
        items={items}
        tabBarStyle={{ margin: 0, padding: "0 6px" }}
        tabBarExtraContent={{
          right: (
            <Button
              type="text"
              size="small"
              aria-label={t("settings.title")}
              icon={<SettingOutlined />}
              onClick={() =>
                selectTab(active === "settings" ? "api-recording" : "settings")
              }
            />
          ),
        }}
        animated={false}
      />

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {active === "api-recording" ? (
          <ApiRecordingFeature onOpen={(id) => navigate(`/detail/${id}`)} />
        ) : active === "action" ? (
          <ActionFeature />
        ) : active === "gateway" ? (
          <GatewayFeature />
        ) : (
          <SettingsFeature />
        )}
      </div>
    </div>
  );
}
