import { App, Button, ConfigProvider, Menu, Segmented, Tag, Tooltip, theme } from "antd";

import {
  AimOutlined,
  ApiOutlined,
  CameraOutlined,
  MoreOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import {
  PauseIcon,
  RecordControls,
  RecordIcon,
  StopIcon,
} from "@/components/recording/record-controls";
import { toggleInspectorCaptureOnTab } from "@/lib/inspector/capture";
import { sendMessage } from "@/lib/messaging";
import type {
  GifRecordingErrorCode,
  GifRecordingState,
} from "@/lib/gif-recording/types";
import type {
  ScreenshotErrorCode,
  ScreenshotMode,
} from "@/lib/screenshot/types";
import {
  gifRecordingState,
  screenshotMode as screenshotModeItem,
  sidePanelTab,
  type SidePanelTabRequest,
} from "@/lib/storage";
import { useStorage } from "@/hooks/use-storage";
import { cn, isCapturableUrl } from "@/lib/utils";

/** Map a background "screenshot:<code>" error onto a popup i18n key. */
type ScreenshotErrorKey =
  | "popup.screenshotUnsupportedPage"
  | "popup.screenshotDebuggerConflict"
  | "popup.screenshotFailed";
const screenshotErrorKey = (message: string): ScreenshotErrorKey => {
  if (!message.startsWith("screenshot:")) return "popup.screenshotFailed";
  const code = message.slice(11).split(" ")[0] as ScreenshotErrorCode;
  if (code === "unsupported-page") return "popup.screenshotUnsupportedPage";
  if (code === "debugger-conflict") return "popup.screenshotDebuggerConflict";
  return "popup.screenshotFailed";
};

/** Map a background "gif:<code>" error onto a popup i18n key. */
type GifErrorKey =
  | "popup.gifUnsupportedPage"
  | "popup.gifStartFailed"
  | "popup.gifNotRecording"
  | "popup.gifFailed";
const gifErrorKey = (message: string): GifErrorKey => {
  if (!message.startsWith("gif:")) return "popup.gifFailed";
  const code = message.slice(4).split(" ")[0] as GifRecordingErrorCode;
  if (code === "unsupported-page") return "popup.gifUnsupportedPage";
  if (code === "start-failed") return "popup.gifStartFailed";
  if (code === "not-recording") return "popup.gifNotRecording";
  return "popup.gifFailed";
};

/** file:// pages need the "Allow access to file URLs" toggle before captures work. */
const isFileUrl = (url: string | undefined) => !!url && /^file:/i.test(url);

/**
 * Toolbar popup — a compact feature menu.
 *
 * The "API recording" row carries inline record/pause/stop controls on its right
 * (shared with the side panel via `RecordControls`); clicking elsewhere on the
 * row opens the side panel's recording tab.
 */
export default function PopupApp({
  initialScreenshotMode,
}: {
  /** Pre-read persisted screenshot mode (main.tsx awaits storage before
   * mounting) so the Segmented renders the saved choice on the first frame. */
  initialScreenshotMode?: ScreenshotMode;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  // GIF recording state (null = idle, 'recording', 'encoding'), written by the
  // background and watched reactively so the row re-renders as REC/stop.
  const [gifState] = useStorage(gifRecordingState);
  // Screenshot mode picked via the row's Segmented control; the row itself
  // captures with it. Persisted in local storage so the choice survives
  // popup close and browser restart.
  const [screenshotMode, setScreenshotMode] = useStorage(
    screenshotModeItem,
    initialScreenshotMode,
  );
  // Resolved colors of the CURRENT theme — fed into the local Segmented
  // ConfigProvider below so it follows light/dark like the rest of the popup.
  const { token } = theme.useToken();

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
    if (!isCapturableUrl(tab.url)) {
      message.warning(t("popup.captureUnsupportedPage"));
      return;
    }
    try {
      await toggleInspectorCaptureOnTab(tab.id);
      window.close();
    } catch {
      // No receiver: content script not injectable/injected on this page.
      const text = isFileUrl(tab.url)
        ? `${t("popup.captureUnsupportedPage")} ${t("popup.fileAccessHint")}`
        : t("popup.captureUnsupportedPage");
      message.warning(text);
    }
  };

  /**
   * "Screenshot" entry (visible area / full page). The background captures and
   * opens a preview tab — copy/download happen there, with the image in front
   * of the user; nothing is saved automatically. The popup just closes.
   */
  const runScreenshot = async (mode: ScreenshotMode) => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url) {
      message.warning(t("popup.noActiveTab"));
      return;
    }
    if (!isCapturableUrl(tab.url)) {
      message.warning(t("popup.screenshotUnsupportedPage"));
      return;
    }
    // Background replies { __error: "screenshot:<code> ..." } on failure
    // (resolve, not reject — see the shared catch-all in background.ts).
    const res = await sendMessage("CAPTURE_SCREENSHOT", { mode });
    if ("__error" in res) {
      const text = t(screenshotErrorKey((res as { __error: string }).__error));
      message.warning(
        isFileUrl(tab.url) ? `${text} ${t("popup.fileAccessHint")}` : text,
      );
      return;
    }
    window.close();
  };

  /**
   * "Record GIF" entry: records the active tab via tabCapture + an offscreen
   * document. Idle: the row (or its record button) starts a recording. While
   * recording the row carries pause/resume + stop icon controls — the same
   * idiom as the API-recording row. Stopping hands the recording to the
   * preview tab (?mode=gif), where the user converts it to a GIF on demand.
   */
  const startGifRecording = async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url) {
      message.warning(t("popup.noActiveTab"));
      return;
    }
    if (!isCapturableUrl(tab.url)) {
      message.warning(t("popup.gifUnsupportedPage"));
      return;
    }
    // The streamId must be minted inside this click's user gesture — the
    // offscreen document consumes it right after via getUserMedia.
    let streamId: string;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId();
    } catch {
      // Capture refused (chrome:// page, another capture active, …).
      const text = isFileUrl(tab.url)
        ? `${t("popup.gifUnsupportedPage")} ${t("popup.fileAccessHint")}`
        : t("popup.gifUnsupportedPage");
      message.warning(text);
      return;
    }
    const res = await sendMessage("START_GIF_RECORDING", { streamId });
    if ("__error" in res) {
      message.warning(t(gifErrorKey((res as { __error: string }).__error)));
      return;
    }
    window.close();
  };

  /** @param gifState reactive recording state; no-op when already idle. */
  const stopGifRecording = async (gifState: GifRecordingState | null) => {
    if (!gifState) return;
    const res = await sendMessage("STOP_GIF_RECORDING", undefined);
    if ("__error" in res) {
      message.warning(t(gifErrorKey((res as { __error: string }).__error)));
      return;
    }
    window.close();
  };

  const toggleGifPause = async () => {
    const res = await sendMessage(
      gifState?.status === "paused" ? "RESUME_GIF_RECORDING" : "PAUSE_GIF_RECORDING",
      undefined,
    );
    if ("__error" in res) {
      message.warning(t(gifErrorKey((res as { __error: string }).__error)));
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
            else if (key === "screenshot") runScreenshot(screenshotMode);
            else if (key === "gif-recording" && !gifState) void startGifRecording();
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
              extra: (
                // Stopping from the popup reveals the side panel's recording
                // tab, so the user lands on the fresh recording (openSidePanel
                // writes the one-shot tab request consumed by the home page).
                <RecordControls
                  variant="menu"
                  onStopped={() => void openSidePanel("api-recording")}
                />
              ),
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
            {
              key: "screenshot",
              icon: <CameraOutlined />,
              label: t("popup.screenshot"),
              // Row click captures with the mode selected on the right; the
              // Segmented only switches the mode (stopPropagation, same idiom
              // as RecordControls).
              extra: (
                <span
                  className="inline-flex items-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Restyled as a compact pill: gray track, white selected
                      thumb (elevated over the menu row). Local ConfigProvider
                      so the overrides stay scoped to this control. */}
                  <ConfigProvider
                    theme={{
                      components: {
                        Segmented: {
                          trackBg: token.colorFillTertiary,
                          // Gap between the items and the pill's edge.
                          trackPadding: 3,
                          itemColor: token.colorTextDescription,
                          itemHoverBg: "transparent",
                          itemHoverColor: token.colorText,
                          // No pressed highlight either (antd defaults to a
                          // blue fill on mousedown).
                          itemActiveBg: "transparent",
                          itemSelectedBg: token.colorBgElevated,
                          itemSelectedColor: token.colorText,
                        },
                      },
                    }}
                  >
                    <Segmented
                      size="small"
                      className={cn(
                        // Compact the two-option control so it fits the 260px
                        // popup row: trim the default label padding + font.
                        // `!` needed: antd's runtime <style> lands after the
                        // Tailwind sheet and wins equal-specificity ties.
                        "[&_.ant-segmented-item-label]:py-0.5! [&_.ant-segmented-item]:rounded-[4px]!",
                        "[&_.ant-segmented-item-label]:text-xs",
                        '[&_.ant-segmented-group]:gap-1!'
                      )}
                      options={[
                        { value: "visible", label: t("popup.screenshotViewport") },
                        { value: "fullPage", label: t("popup.screenshotFullPage") },
                      ]}
                      value={screenshotMode}
                      onChange={(value) =>
                        setScreenshotMode(value as ScreenshotMode)
                      }
                    />
                  </ConfigProvider>
                </span>
              ),
            },
            {
              key: "gif-recording",
              icon: <VideoCameraOutlined />,
              label: t(
                gifState
                  ? gifState.status === "paused"
                    ? "popup.gifStatusPaused"
                    : "popup.gifStatusRecording"
                  : "popup.recordGif",
              ),
              extra: (
                // Same interaction as the API-recording row: idle → record
                // button; recording → pause/resume + stop controls.
                <span
                  className="inline-flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!gifState ? (
                    <Tooltip title={t("popup.recordGif")}>
                      <Button
                        size="small"
                        // Keep the default gray border on hover (antd would turn it primary blue).
                        className="hover:border-(--ant-color-border)!"
                        icon={<RecordIcon className="text-(--ant-color-error)!" />}
                        onClick={startGifRecording}
                      />
                    </Tooltip>
                  ) : (
                    <>
                      <Tooltip
                        title={t(
                          gifState.status === "paused"
                            ? "popup.gifResumeRecording"
                            : "popup.gifPauseRecording",
                        )}
                      >
                        <Button
                          size="small"
                          // Same red record dot + gray border as the idle start button.
                          className="hover:border-(--ant-color-border)!"
                          icon={
                            gifState.status === "paused" ? (
                              <RecordIcon className="text-(--ant-color-error)!" />
                            ) : (
                              <PauseIcon />
                            )
                          }
                          onClick={toggleGifPause}
                        />
                      </Tooltip>
                      <Tooltip title={t("popup.gifStopRecording")}>
                        {/* Keep the light-red fill constant (antd would only show it on hover). */}
                        <Button
                          type="text"
                          size="small"
                          danger
                          className="bg-(--ant-color-error-bg)!"
                          icon={<StopIcon />}
                          onClick={() => void stopGifRecording(gifState)}
                        />
                      </Tooltip>
                    </>
                  )}
                </span>
              ),
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
