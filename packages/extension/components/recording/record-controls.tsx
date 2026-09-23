import { useCallback } from "react";
import { App, Button, Tooltip, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useRecordingState } from "@/hooks/use-recording-state";
import { sendMessage } from "@/lib/messaging";
import { cn, originOf } from "@/lib/utils";

const { Text } = Typography;

/**
 * Shared recording controls (start -> pause/resume + stop), used by both the
 * popup menu row and the side panel's records panel footer. All actions go
 * through the background via typed messages; live state is read reactively from
 * `recordingState`, so every surface mirrors the same session automatically.
 *
 * Variants:
 *  - "menu": compact icon-only buttons (popup menu row).
 *  - "block": header-row controls (side panel records top bar). Inactive: a
 *    primary start button that sits next to the search input. Active: status
 *    readout (pulse dot + captured-call count) on the left, icon pause/stop on
 *    the right — the search input is hidden by the caller while recording.
 */
export function RecordControls({
  variant,
  onStopped,
}: {
  variant: "menu" | "block";
  /** Fired after STOP_RECORDING resolves (recording already persisted). */
  onStopped?: () => void;
}) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const state = useRecordingState();
  const active = state.active;

  /** Resolve the active tab and make sure it's a recordable http(s) page. */
  const requirePage = useCallback(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab.url) {
      message.warning(t("popup.noActiveTab"));
      return null;
    }
    if (!/^https?:/i.test(tab.url)) {
      message.warning(t("popup.unsupportedPage"));
      return null;
    }
    return { tabId: tab.id, url: tab.url };
  }, [message, t]);

  const start = useCallback(async () => {
    const page = await requirePage();
    if (!page) return;
    await sendMessage("START_RECORDING", {
      tabId: page.tabId,
      origin: originOf(page.url),
      url: page.url,
    });
  }, [requirePage]);

  const togglePause = useCallback(async () => {
    await sendMessage("SET_PAUSED", { paused: !state.paused });
  }, [state.paused]);

  const stop = useCallback(async () => {
    await sendMessage("STOP_RECORDING", undefined);
    onStopped?.();
  }, [onStopped]);

  if (variant === "menu") {
    // Inside an antd Menu item (`extra`): swallow clicks so pressing the
    // controls doesn't also trigger the row's menu onClick.
    return (
      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {!active ? (
          <Tooltip title={t("recording.startRecording")}>
            <Button
              size="small"
              // Keep the default gray border on hover (antd would turn it primary blue).
              className="hover:border-(--ant-color-border)!"
              icon={<RecordIcon className="text-(--ant-color-error)!" />}
              onClick={start}
            />
          </Tooltip>
        ) : (
          <>
            <Tooltip title={state.paused ? t("recording.resumeRecording") : t("recording.pauseRecording")}>
              <Button
                size="small"
                // Same red record dot + gray border as the GIF row's resume button.
                className="hover:border-(--ant-color-border)!"
                icon={state.paused ? <RecordIcon className="text-(--ant-color-error)!" /> : <PauseIcon />}
                onClick={togglePause}
              />
            </Tooltip>
            <Tooltip title={t("recording.stopAndSave")}>
              {/* Keep the light-red fill constant (antd would only show it on hover). */}
              <Button
                type="text"
                size="small"
                danger
                className="bg-(--ant-color-error-bg)!"
                icon={<StopIcon />}
                onClick={stop}
              />
            </Tooltip>
          </>
        )}
      </span>
    );
  }

  if (!active) {
    return (
      <Button
        type="primary"
        onClick={start}
        // `!` required: antd's unlayered `.ant-btn-icon > svg { color: inherit }`
        // beats any layered (Tailwind) utility — only an important one wins.
        icon={<RecordIcon className="text-(--ant-color-error)!" />}
        className="gap-1!"
      >
        {t("recording.startRecording")}
      </Button>
    );
  }
  // Active: status readout on the left (pulse dot + captured-call count),
  // icon pause/stop controls on the right. Default-size buttons (32px) keep
  // the header row the same height as the idle search-input row.
  return (
    <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 min-w-0 text-[13px] text-(--ant-color-text)">
        <span
          className={cn(
            "w-2 h-2 rounded-full shrink-0",
            state.paused ? "bg-amber-500" : "bg-red-500 animate-pulse",
          )}
        />
        <Text ellipsis className="min-w-0">
          {state.paused
            ? t("recording.statusPaused", { count: state.count })
            : t("recording.statusRecording", { count: state.count })}
        </Text>
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          // Same red record dot + gray border as the menu variant's resume button.
          className="hover:border-(--ant-color-border)!"
          icon={state.paused ? <RecordIcon className="text-(--ant-color-error)!" /> : <PauseIcon />}
          onClick={togglePause}
        />
        {/* Keep the light-red fill constant (antd would only show it on hover). */}
        <Button
          danger
          className="bg-(--ant-color-error-bg)!"
          icon={<StopIcon />}
          onClick={stop}
        />
      </div>
    </div>
  );
}

/**
 * Minimal SVG icons (antd has no record/stop glyphs that read well at 14px).
 * Exported for reuse — the GIF recording row mirrors the same controls.
 */
const ICON = { width: 14, height: 14, fill: "currentColor" } as const;

export function RecordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" {...ICON} className={className}>
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}
export function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" {...ICON} >
      <rect x="4" y="3" width="3" height="10" rx="1" />
      <rect x="9" y="3" width="3" height="10" rx="1" />
    </svg>
  );
}
export function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" {...ICON} >
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}
