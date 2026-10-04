import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { App, Button, Dropdown, Empty, Spin, Timeline, Tooltip, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  AimOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  EditOutlined,
  FilterOutlined,
  FormOutlined,
  LeftOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { CallNode } from "./call-node";
import { EndpointsPanel } from "./endpoints-panel";
import { BottomTabBar } from "@/components/common/bottom-tab-bar";
import { sendMessage } from "@/lib/messaging";
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

/** Relevance dropdown filter: everything, or exactly one verdict. */
type RelevanceFilter = "all" | "relevant" | "uncertain" | "irrelevant";

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
  // Live lifecycle of the relevance analysis (persisted on the Recording and
  // broadcast on every transition). Undefined = never ran.
  const [relStatus, setRelStatus] = useState<Recording["relevanceStatus"]>(
    undefined,
  );
  const [relStatusAt, setRelStatusAt] = useState<number | undefined>(undefined);

  const reload = useCallback(() => {
    let active = true;
    Promise.all([getRecording(recordingId), getCalls(recordingId)]).then(
      ([rec, cs]) => {
        if (!active) return;
        setRecording(rec ?? null);
        setCalls(cs);
        setRelStatus(rec?.relevanceStatus);
        setRelStatusAt(rec?.relevanceStatusAt);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [recordingId]);

  useEffect(() => reload(), [reload]);
  // The background broadcasts every analysis phase transition (and a final
  // update when marks land), possibly while the user is already reading this
  // detail view. No reply is expected (another listener or none answers).
  useEffect(() => {
    const onMessage = (
      raw:
        | { type?: string; data?: { recordingId?: string; status?: Recording["relevanceStatus"] } }
        | undefined,
    ) => {
      if (raw?.data?.recordingId !== recordingId) return;
      if (raw.type === "RECORDING_RELEVANCE_STATUS") {
        setRelStatus(raw.data.status);
        setRelStatusAt(Date.now());
      } else if (raw.type === "RECORDING_RELEVANCE_UPDATED") {
        reload();
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [recordingId, reload]);

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
            relStatus={relStatus}
            relStatusAt={relStatusAt}
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

/** After this long in `analyzing` without a transition, the run is presumed
 * dead (SW killed mid-analysis) and the UI falls back to the failed state. */
const ANALYZING_STALE_MS = 3 * 60_000;

/** The recorded call chain (pure recorded view). */
function ResultPanel({
  recordingId,
  calls,
  deps,
  description,
  interactions,
  relStatus,
  relStatusAt,
  onDeleteCall,
}: {
  recordingId: string;
  calls: ApiCall[];
  deps?: FieldDependency[];
  description?: string;
  interactions?: CapturedInteraction[];
  relStatus?: Recording["relevanceStatus"];
  relStatusAt?: number;
  onDeleteCall: (call: ApiCall) => void;
}) {
  const { t } = useTranslation();
  // A persisted `analyzing` older than the stale window is a dead run.
  const analyzing =
    relStatus === "analyzing" &&
    Date.now() - (relStatusAt ?? 0) < ANALYZING_STALE_MS;
  const failed = relStatus === "failed" || (relStatus === "analyzing" && !analyzing);

  // Relevance filter (dropdown on the filter icon button): all / one verdict.
  const [filter, setFilter] = useState<RelevanceFilter>("all");
  const countOf = (v: RelevanceFilter) =>
    v === "all" ? calls.length : calls.filter((c) => c.relevance?.verdict === v).length;
  const shown = filter === "all" ? calls : calls.filter((c) => c.relevance?.verdict === filter);

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

  // Manual (re-)run of the relevance analysis: covers recordings saved before
  // this feature, failed model loads, and OOM retries. The real completion
  // signals through RECORDING_RELEVANCE_STATUS / _UPDATED (listener above).
  const rerunRelevance = async () => {
    await sendMessage("RUN_RECORDING_RELEVANCE", { recordingId }).catch(() => {});
  };

  const filterMenu: MenuProps = {
    selectable: true,
    selectedKeys: [filter],
    onClick: ({ key }) => setFilter(key as RelevanceFilter),
    items: (
      ["all", "relevant", "uncertain", "irrelevant"] as const
    ).map((v) => ({
      key: v,
      label: `${t(
        v === "all"
          ? "detail.filterAll"
          : v === "relevant"
            ? "detail.filterRelevant"
            : v === "uncertain"
              ? "detail.filterUncertain"
              : "detail.filterIrrelevant",
      )} (${countOf(v)})`,
    })),
  };

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
              <div className="flex items-center gap-1">
                {failed && (
                  <Text type="danger" className="text-xs! leading-6!">
                    {t("detail.relevanceFailed")}
                  </Text>
                )}
                {calls.length >= 3 && (
                  <Tooltip title={t("detail.rerunRelevance")}>
                    <Button
                      size="small"
                      type="text"
                      loading={analyzing}
                      onClick={() => void rerunRelevance()}
                      icon={analyzing ? undefined : <ReloadOutlined />}
                    />
                  </Tooltip>
                )}
                <Dropdown
                  menu={filterMenu}
                  trigger={["click"]}
                  placement="bottomRight"
                >
                  <Button
                    size="small"
                    type="text"
                    title={t("detail.filterTitle")}
                    icon={
                      <FilterOutlined
                        className={
                          filter !== "all" ? "text-(--ant-color-primary)" : undefined
                        }
                      />
                    }
                  />
                </Dropdown>
              </div>
            </div>
            {shown.length === 0 ? (
              <div className="py-10 text-center">
                <Text type="secondary" className="text-xs">
                  {t("detail.filterEmpty")}
                </Text>
              </div>
            ) : (
              <Timeline
                items={(() => {
                  // Merge calls and (when unfiltered) captured interactions
                  // into one time-sorted timeline; ties put the interaction
                  // first, since it is what triggered the call that follows.
                  type Entry = { at: number; call?: ApiCall; interaction?: CapturedInteraction };
                  const merged: Entry[] = [
                    ...shown.map((call) => ({ at: call.startedAt, call })),
                    ...(filter === "all"
                      ? (interactions ?? []).map((it) => ({ at: it.at, interaction: it }))
                      : []),
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
                    const next = shown[callIdx + 1];
                    const gap = next ? next.startedAt - call.startedAt : null;
                    return {
                      // A model-flagged call dims to gray — the mark is advisory,
                      // not an error like `errored` (red).
                      color: call.errored
                        ? "red"
                        : call.relevance?.verdict === "irrelevant"
                          ? "gray"
                          : "blue",
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}
