import { App, Badge, Button, Menu } from "antd";
import {
  ApiOutlined,
  LinkOutlined,
  MoreOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useRecordingState } from "@/hooks/use-recording-state";
import { toolbarState, sidePanelTab, type SidePanelTab } from "@/lib/storage";

/**
 * Toolbar popup — a compact feature menu.
 *
 * Picking "API recording" reveals the draggable recording toolbar inside the active tab
 * (the content script mounts it when `toolbarState.tabId` matches). The popup itself
 * no longer drives start/stop; the in-page toolbar owns those controls.
 */
export default function PopupApp() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const state = useRecordingState();

  const showToolbar = async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url) {
      message.warning(t("popup.noActiveTab"));
      return;
    }
    if (!/^https?:/i.test(tab.url)) {
      message.warning(t("popup.unsupportedPage"));
      return;
    }
    await toolbarState.setValue({ tabId: tab.id });
    window.close();
  };

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
    <div className="w-[260px] p-2 bg-[#f7f8fa]">
      <div className="flex items-center justify-between px-2 py-3">
        <div className="flex items-center gap-2">
          <img src="/icon/32.png" alt="Manta Action Kit" className="w-5 h-5" />
          <span className="text-[14px] font-medium text-[#333]">
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

      <div className="overflow-hidden bg-white rounded-lg">
        <Menu
          mode="vertical"
          selectable={false}
          className="border-none bg-white!"
          onClick={({ key }) => {
            if (key === "api-recording") showToolbar();
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
              label: (
                <span>
                  {t("popup.apiRecording")}
                  {state.active && (
                    <Badge
                      status={state.paused ? "warning" : "processing"}
                      className="ml-2"
                    />
                  )}
                </span>
              ),
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
