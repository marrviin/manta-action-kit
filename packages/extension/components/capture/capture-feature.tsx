import { useState } from "react";
import { App, Empty, Spin, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { BottomTabBar } from "@/components/common/bottom-tab-bar";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import { useCaptureHistory } from "@/hooks/use-capture-history";
import type { InspectorHistoryEntry } from "@/lib/db";

const { Text } = Typography;

/**
 * "Page capture" side-panel feature: the history of the three capture flows —
 * element captures (inspector), screenshots and GIF recordings — behind a
 * bottom segmented bar. Each row re-opens its preview tab by record id; rows
 * are deleted right here. Read-only lists otherwise: capture/record controls
 * live in the popup and feature tabs where the flows start.
 */
type CaptureTab = "captures" | "screenshots" | "gif";

export function CaptureFeature() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CaptureTab>("captures");
  const history = useCaptureHistory();

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Content area: fills remaining space, each panel scrolls internally */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        {tab === "captures" ? (
          <CapturesPanel history={history} />
        ) : tab === "screenshots" ? (
          <ScreenshotsPanel history={history} />
        ) : (
          <GifPanel history={history} />
        )}
      </div>

      <BottomTabBar
        tabs={[
          { key: "captures" as const, label: t("capture.tabCaptures") },
          { key: "screenshots" as const, label: t("capture.tabScreenshots") },
          { key: "gif" as const, label: t("capture.tabGif") },
        ]}
        active={tab}
        onChange={setTab}
      />
    </div>
  );
}

type History = ReturnType<typeof useCaptureHistory>;

/** Open a preview tab addressed by record id. */
function openPreview(path: string) {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

function PanelSpinner() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Spin />
    </div>
  );
}

function PanelEmpty() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
    </div>
  );
}

function CapturesPanel({ history }: { history: History }) {
  const { t } = useTranslation();
  if (history.loading) return <PanelSpinner />;
  if (!history.captures.length) return <PanelEmpty />;
  return (
    <div className="flex-1 min-h-0 overflow-auto pb-14">
      {history.captures.map((c) => (
        <CaptureRow
          key={c.id}
          capture={c}
          onOpen={() => openPreview(`/preview.html?mode=element&id=${c.id}`)}
          onRemove={() => history.removeCapture(c.id)}
        />
      ))}
    </div>
  );
}

function CaptureRow({
  capture,
  onOpen,
  onRemove,
}: {
  capture: InspectorHistoryEntry;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { modal } = App.useApp();
  const { t } = useTranslation();
  // `page` was added to InspectorCapturePayload after the history store
  // existed — older IndexedDB records lack it (and elementCount/selection),
  // so every access must tolerate absence or one stale row whites out the
  // whole panel.
  const p = capture.payload;
  const title = p.page?.title || p.page?.url || t("capture.untitledCapture");

  return (
    <UnifiedListItem
      clickable
      onClick={onOpen}
      title={title}
      status={
        <>
          {typeof p.elementCount === "number" && (
            <Tag>{t("capture.elementCount", { count: p.elementCount })}</Tag>
          )}
          {p.selection && p.selection !== "click" && (
            <Tag>{t("capture.boxSelect")}</Tag>
          )}
        </>
      }
      timestamp={Date.parse(p.capturedAt)}
      menu={[
        { key: "open", label: t("capture.openPreview"), onClick: onOpen },
        {
          key: "delete",
          label: t("common.delete"),
          danger: true,
          onClick: () =>
            modal.confirm({
              title: t("capture.deleteTitle"),
              content: <Text type="secondary">{title}</Text>,
              okText: t("common.delete"),
              okButtonProps: { danger: true },
              cancelText: t("common.cancel"),
              onOk: onRemove,
              centered: true,
            }),
        },
      ]}
    />
  );
}

function ScreenshotsPanel({ history }: { history: History }) {
  const { t } = useTranslation();
  if (history.loading) return <PanelSpinner />;
  if (!history.screenshots.length) return <PanelEmpty />;
  return (
    <div className="flex-1 min-h-0 overflow-auto pb-14">
      {history.screenshots.map((s) => (
        <UnifiedListItem
          key={s.id}
          clickable
          onClick={() =>
            openPreview(`/preview.html?mode=screenshot&id=${s.id}`)
          }
          title={s.filename}
          timestamp={s.createdAt}
          menu={[
            {
              key: "delete",
              label: t("common.delete"),
              danger: true,
              onClick: () => history.removeScreenshot(s.id),
            },
          ]}
        />
      ))}
    </div>
  );
}

function GifPanel({ history }: { history: History }) {
  const { t } = useTranslation();
  if (history.loading) return <PanelSpinner />;
  if (!history.gifs.length) return <PanelEmpty />;
  return (
    <div className="flex-1 min-h-0 overflow-auto pb-14">
      {history.gifs.map((g) => (
        <UnifiedListItem
          key={g.id}
          clickable
          onClick={() => openPreview(`/preview.html?mode=gif&id=${g.id}`)}
          title={g.filename}
          timestamp={g.createdAt}
          menu={[
            {
              key: "delete",
              label: t("common.delete"),
              danger: true,
              onClick: () => history.removeGif(g.id),
            },
          ]}
        />
      ))}
    </div>
  );
}
