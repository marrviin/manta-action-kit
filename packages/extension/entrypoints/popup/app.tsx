import { Badge, Button, Menu } from "antd";
import {
  ApiOutlined,
  LinkOutlined,
  MoreOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useRecordingState } from "@/hooks/use-recording-state";
import { RecordControls } from "@/components/recording/record-controls";
import { sidePanelTab, type SidePanelTab } from "@/lib/storage";

/**
 * Toolbar popup — a compact feature menu.
 *
 * The "API recording" row carries inline record/pause/stop controls on its right
 * (shared with the side panel via `RecordControls`); clicking elsewhere on the
 * row opens the side panel's recording tab.
 */
export default function PopupApp() {
  const { t } = useTranslation();
  const state = useRecordingState();

  const openSidePanel = async (selectTab?: SidePanelTab) => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.windowId != null) {
      // Record which feature tab the home page should select on open, then reveal
      // the side panel. The home page consumes and clears this on mount.
      if (selectTab) await sidePanelTab.setValue(selectTab);
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    }
  };

  return (
    <div className="w-[260px] p-2 bg-(--ant-color-bg-layout)">
      <div className="flex items-center justify-between px-2 py-3">
        <div className="flex items-center gap-2">
          <img src="/icon/32.png" alt="Manta Action Kit" className="w-5 h-5" />
          <span className="text-[14px] font-medium text-(--ant-color-text)">
            Manta Action Kit
          </span>
          {state.active && (
            <Badge
              status={state.paused ? "warning" : "processing"}
              text={state.paused ? t("popup.paused") : t("popup.recording")}
            />
          )}
        </div>
        <Button
          type="text"
          size="small"
          icon={<MoreOutlined />}
          onClick={() => openSidePanel()}
        />
      </div>

      <div className="overflow-hidden bg-(--ant-color-bg-elevated) rounded-lg">
        <Menu
          mode="vertical"
          selectable={false}
          className="border-none bg-(--ant-color-bg-elevated)!"
          onClick={({ key }) => {
            if (key === "api-recording") openSidePanel("api-recording");
            else if (key === "mcp") openSidePanel("mcp");
            else if (key === "action") openSidePanel("action");
            else if (key === "sidepanel") openSidePanel();
          }}
          items={[
            {
              key: "mcp",
              icon: <LinkOutlined />,
              label: "MCP",
            },
            {
              key: "action",
              icon: <ThunderboltOutlined />,
              label: t("popup.actions"),
            },
            {
              key: "api-recording",
              icon: <ApiOutlined />,
              label: t("popup.apiRecording"),
              extra: <RecordControls variant="menu" />,
            },
            { type: "divider" },
            {
              key: "sidepanel",
              icon: <SettingOutlined />,
              label: t("popup.settings"),
            },
          ]}
        />
      </div>
    </div>
  );
}
