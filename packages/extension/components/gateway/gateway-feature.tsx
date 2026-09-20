import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LogsPanel } from "./logs-panel";
import { ProxyRulesPanel } from "./proxy-rules-panel";
import { BottomTabBar } from "@/components/common/bottom-tab-bar";

/**
 * "Sandbox proxy" side-panel feature. Two sub-tabs:
 *   - Proxy rules: the script-driven gateway entry (sandbox prefix → target base)
 *   - Audit logs: every gateway call, with decision/status and expandable detail
 * Self-contained; mounts inside the home tab.
 */
type GatewayTab = "logs" | "proxy";

export function GatewayFeature() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<GatewayTab>("proxy");

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Content area: fills remaining space, each panel scrolls internally */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        {tab === "logs" ? <LogsPanel /> : <ProxyRulesPanel />}
        {/* Bottom fade mask: transparent → white, non-interactive */}
        <div className="pointer-events-none absolute left-0 right-0 bottom-0 h-8 z-5 bg-[linear-gradient(to_bottom,rgba(255,255,255,0),rgba(255,255,255,1))]" />
      </div>

      <BottomTabBar
        tabs={[
          { key: "proxy" as const, label: t("gateway.tabProxy") },
          { key: "logs" as const, label: t("gateway.tabLogs") },
        ]}
        active={tab}
        onChange={setTab}
      />
    </div>
  );
}
