import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { App, Button, Empty, Spin, Timeline, Tooltip, Typography } from "antd";
import {
  AimOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  EditOutlined,
  FormOutlined,
  LeftOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { CallNode } from "./call-node";
import { EndpointsPanel } from "./endpoints-panel";
import { BottomTabBar } from "@/components/common/bottom-tab-bar";
import { deleteCall, getCalls, getRecording } from "@/lib/db";
import { cn, formatGap } from "@/lib/utils";
import type {
  ApiCall,
  CapturedInteraction,
  FieldDependency,
  Recording,
} from "@/lib/recording/types";

const { Text, Paragraph } = Typography;

/** Stable empty array so CallNode's memo never sees a fresh [] identity. */
const EMPTY_DEPS: FieldDependency[] = [];

type DetailTab = "result" | "endpoints";

interface Props {
  recordingId: string;
  onBack: () => void;
  /** Which bottom tab to open on mount (default 'result'). */
  initialTab?: DetailTab;
}

/**
 * A recording's detail view (full-screen route). Two bottom tabs:
 *   - Result: the pure recorded call chain.
 *   - Endpoints: aggregated endpoint contracts.
 */
export function RecordingDetail({ recordingId, onBack, initialTab }: Props) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [calls, setCalls] = useState<ApiCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>(initialTab ?? "result");
  const reload = useCallback(() => {
    let active = true;
    Promise.all([getRecording(recordingId), getCalls(recordingId)]).then(
      ([rec, cs]) => {
        if (!active) return;
        setRecording(rec ?? null);
        setCalls(cs);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [recordingId]);

  useEffect(() => reload(), [reload]);

  // Stable identity: memoized CallNode rows bail on re-render unless a prop
  // actually changed, so the delete callback must not be recreated per render.
  const handleDelete = useCallback(
    async (call: ApiCall) => {
      try {
        await deleteCall(recordingId, call.id);
        // Only drop the deleted call; other calls keep their original startedAt,
        // so the inter-call wait times shown stay unchanged.
        setCalls((prev) => prev.filter((c) => c.id !== call.id));
        setRecording((prev) =>
          prev ? { ...prev, callCount: Math.max(0, prev.callCount - 1) } : prev,
        );
        message.success(t("common.deleted"));
      } catch {
        message.error(t("common.deleteFailed"));
      }
    },
    [recordingId, message, t],
  );

  if (loading) {
    return (
      <div className="p-8 text-center">
        <Spin />
      </div>
    );
  }

  if (!recording) {
    return (
      <div className="h-full flex items-center justify-center">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 h-[48px] box-border px-3 border-b border-(--ant-color-border-secondary)">
        <Button icon={<LeftOutlined />} onClick={onBack} />
        <div className="min-w-0 flex-1">
          <Text strong ellipsis className="block">
            {t("detail.titleWithCount", {
              name: recording.name,
              count: recording.callCount,
            })}
          </Text>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {tab === "result" && (
          <ResultPanel
            recordingId={recordingId}
            calls={calls}
            deps={recording.deps}
            description={recording.description}
            interactions={recording.interactions}
            onDeleteCall={handleDelete}
          />
        )}
        {tab === "endpoints" && (
          <EndpointsPanel calls={calls} deps={recording.deps} />
        )}
      </div>

      <BottomTabBar
        tabs={[
          { key: "result" as const, label: t("detail.tabResult") },
          { key: "endpoints" as const, label: t("detail.tabEndpoints") },
        ]}
        active={tab}
        onChange={setTab}
      />
    </div>
  );
}

/** Recording description card: height-capped when collapsed, with an expand/collapse action bar (icon toggle) at the bottom. */
function DescriptionCard({ description }: { description: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const contentRef = useRef<HTMLParagraphElement>(null);

  // When collapsed, cap at ~5 lines (text-xs=12px, leading-relaxed≈1.625 → ~19.5px per line).
  const collapsedMaxHeight = 98;

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setOverflow(el.scrollHeight > collapsedMaxHeight + 1);
  }, [description]);

  return (
    <div className="mb-3 rounded bg-(--ant-color-fill-quaternary) border border-(--ant-color-border-secondary) overflow-hidden">
      <Paragraph
        ref={contentRef}
        type="secondary"
        className={cn(
          "mb-0! whitespace-pre-wrap text-xs leading-relaxed py-2 px-3 overflow-hidden",
          expanded ? "max-h-none" : "max-h-[98px]",
        )}
      >
        {description}
      </Paragraph>
      {overflow && (
        <div
          role="button"
          tabIndex={0}
          aria-label={
            expanded ? t("detail.descCollapse") : t("detail.descExpand")
          }
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          className="mt-1 flex items-center justify-center gap-1 py-1 text-xs text-(--ant-color-text-tertiary) cursor-pointer border-t border-(--ant-color-border-secondary) hover:text-(--ant-color-text) transition-colors select-none"
        >
          {expanded ? <CaretUpOutlined /> : <CaretDownOutlined />}
        </div>
      )}
    </div>
  );
}

/** The recorded call chain (pure recorded view). */
function ResultPanel({
  recordingId,
  calls,
  deps,
  description,
  interactions,
  onDeleteCall,
}: {
  recordingId: string;
  calls: ApiCall[];
  deps?: FieldDependency[];
  description?: string;
  interactions?: CapturedInteraction[];
  onDeleteCall: (call: ApiCall) => void;
}) {
  const { t } = useTranslation();

  // Human-readable one-liner for a captured interaction.
  const interactionLabel = (it: CapturedInteraction): string => {
    if (it.kind === "change" && it.value) {
      return t("detail.interactionChange", { value: it.value });
    }
    if (it.text) {
      return it.kind === "click"
        ? t("detail.interactionClick", { text: it.text })
        : it.kind === "submit"
          ? t("detail.interactionSubmit", { text: it.text })
          : t("detail.interactionChange", { value: it.text });
    }
    return t("detail.interactionUnlabeled");
  };
  const interactionIcon = (kind: CapturedInteraction["kind"]) =>
    kind === "click" ? <AimOutlined /> : kind === "submit" ? <FormOutlined /> : <EditOutlined />;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto pt-4 pb-14 px-3">
        {description && <DescriptionCard description={description} />}
        {calls.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              {/* leading-6 pins the title's line box to the 24px small-button
                  height, so the row centers on one line box. */}
              <Text type="secondary" className="text-sm leading-6!">
                {t("detail.callChainTitle")}
              </Text>
            </div>
            <Timeline
              items={(() => {
                // Merge calls and captured interactions into one time-sorted
                // timeline; ties put the interaction first, since it is what
                // triggered the call that follows.
                type Entry = { at: number; call?: ApiCall; interaction?: CapturedInteraction };
                const merged: Entry[] = [
                  ...calls.map((call) => ({ at: call.startedAt, call })),
                  ...(interactions ?? []).map((it) => ({ at: it.at, interaction: it })),
                ];
                const entries = merged.sort(
                  (a, b) => a.at - b.at || (a.interaction ? -1 : 1),
                );
                let callIdx = -1;
                return entries.map((entry) => {
                  if (entry.interaction) {
                    const it = entry.interaction;
                    return {
                      color: "gray",
                      children: (
                        <div className="flex items-center gap-1.5 text-[12px]! text-(--ant-color-text-tertiary) opacity-80">
                          {interactionIcon(it.kind)}
                          <span className="truncate">
                            {interactionLabel(it)}
                          </span>
                          <Text type="secondary" className="text-[11px]! shrink-0">
                            {it.page.path}
                          </Text>
                        </div>
                      ),
                    };
                  }
                  const call = entry.call!;
                  callIdx += 1;
                  const next = calls[callIdx + 1];
                  const gap = next ? next.startedAt - call.startedAt : null;
                  return {
                    color: call.errored ? "red" : "blue",
                    children: (
                      <>
                        <CallNode
                          call={call}
                          deps={deps ?? EMPTY_DEPS}
                          onDelete={onDeleteCall}
                        />
                        {gap != null && gap > 0 && (
                          <Text
                            type="secondary"
                            className="block text-[12px]! mt-2"
                          >
                            {t("detail.waitGap", { gap: formatGap(gap) })}
                          </Text>
                        )}
                      </>
                    ),
                  };
                });
              })()}
            />
          </div>
        )}
      </div>
    </div>
  );
}
