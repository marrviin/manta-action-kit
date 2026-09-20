import { App, Button, Menu } from "antd";

import {
  AimOutlined,
  ApiOutlined,
  MoreOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { RecordControls } from "@/components/recording/record-controls";
import { toggleInspectorCaptureOnTab } from "@/lib/inspector/capture";
import { sidePanelTab, type SidePanelTabRequest } from "@/lib/storage";

/**
 * Toolbar popup — a compact feature menu.
 *
 * The "API recording" row carries inline record/pause/stop controls on its right
 * (shared with the side panel via `RecordControls`); clicking elsewhere on the
 * row opens the side panel's recording tab.
 */
export default function PopupApp() {
  const { t } = useTranslation();
  const { message } = App.useApp();

  /**
   * "Element capture" entry: toggles in-page inspector mode on the active tab
   * (box-select / click-pick elements; the content script copies the JSON
   * description to the clipboard). Unlike other rows it never opens the side
   * panel — the interaction belongs to the page itself, so the popup closes
   * right after handing over.
   */
  const startInspectorCapture = async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url) {
      message.warning(t("popup.noActiveTab"));
      return;
    }
    if (!/^https?:/i.test(tab.url)) {
      message.warning(t("popup.captureUnsupportedPage"));
      return;
    }
    try {
      await toggleInspectorCaptureOnTab(tab.id);
      window.close();
    } catch {
      // No receiver: content script not injectable/injected on this page.
      message.warning(t("popup.captureUnsupportedPage"));
    }
  };

  const openSidePanel = async (selectTab?: SidePanelTabRequest) => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.windowId != null) {
      // Record which view the home page should select on open, then reveal the
      // side panel. Consumed and cleared on mount, or live via watcher if the
      // panel is already open.
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
            else if (key === "inspector-capture") startInspectorCapture();
            else if (key === "action") openSidePanel("action");
            else if (key === "gateway") openSidePanel("gateway");
            else if (key === "settings") openSidePanel("settings");
          }}
          items={[
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
            {
              key: "gateway",
              icon: <SafetyCertificateOutlined />,
              label: t("popup.gateway"),
            },
            { type: "divider" },
            {
              key: "inspector-capture",
              icon: <AimOutlined />,
              label: t("popup.elementCapture"),
            },
            { type: "divider" },
            {
              key: "settings",
              icon: <SettingOutlined />,
              label: t("popup.settings"),
            },
          ]}
        />
      </div>
    </div>
  );
}
