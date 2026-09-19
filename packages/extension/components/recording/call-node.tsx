import { useState, type ReactNode } from "react";
import { App, Tag, Tooltip, Typography } from "antd";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { MethodBadge, StatusBadge } from "./method-badge";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import { cn, prettyJson } from "@/lib/utils";
import type { ApiCall, FieldDependency } from "@/lib/recording/types";

const { Text } = Typography;

interface Props {
  call: ApiCall;
  /**
   * Field dependencies touching this call (already filtered to this call's seq).
   * Drives the inline flow annotations: what this call consumes from earlier
   * calls and what it produces for later ones. Empty/omitted = no annotations.
   */
  deps?: FieldDependency[];
  /** Delete this call from the recording. When omitted, the context menu is disabled. */
  onDelete?: (call: ApiCall) => void;
}

/** Short human label for where a consumed value lands in the request. */
function locationLabel(
  loc: FieldDependency["toLocation"],
  t: TFunction,
): string {
  switch (loc) {
    case "body":
      return t("flow.locBody");
    case "query":
      return t("flow.locQuery");
    case "header":
      return t("flow.locHeader");
    case "url":
      return t("flow.locUrl");
  }
}

/**
 * Inline "flow" annotations for one call: which earlier steps feed this call's
 * request (consumes), and which later steps reuse this call's response (produces).
 */
function FlowAnnotations({
  call,
  deps,
}: {
  call: ApiCall;
  deps: FieldDependency[];
}) {
  const { t } = useTranslation();
  const consumes = deps.filter((d) => d.toSeq === call.seq);
  const produces = deps.filter((d) => d.fromSeq === call.seq);
  if (consumes.length === 0 && produces.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {consumes.map((d) => (
        <Tooltip key={d.id} title={t("flow.valueTooltip", { value: d.value })}>
          <Tag color="gold" className="w-fit m-0! text-[10px]! font-normal!">
            {t("flow.consumes", {
              target: `${locationLabel(d.toLocation, t)}${d.toPath ? ` · ${d.toPath}` : ""}`,
              fromSeq: d.fromSeq,
              fromField: d.fromPath || t("flow.response"),
            })}
          </Tag>
        </Tooltip>
      ))}
      {produces.map((d) => (
        <Tooltip key={d.id} title={t("flow.valueTooltip", { value: d.value })}>
          <Tag color="blue" className="w-fit m-0! text-[10px]! font-normal!">
            {t("flow.produces", {
              fromPath: d.fromPath || "",
              toSeq: d.toSeq,
              target: locationLabel(d.toLocation, t),
            })}
          </Tag>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * One node in the call chain (used inside an antd Timeline item). Reuses
 * UnifiedListItem so it matches the gateway audit-log rows:
 *   Row 1: path (title) .......... expand toggle
 *   Row 2: method / status badges
 * The expandable detail renders in a light-gray card.
 */
export function CallNode({ call, deps = [], onDelete }: Props) {
  const { modal } = App.useApp();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const confirmDelete = () => {
    modal.confirm({
      title: t("detail.deleteCallTitle"),
      content: (
        <Text ellipsis title={call.url}>
          {t("detail.deleteCallConfirm", { url: call.url })}
        </Text>
      ),
      okText: t("common.delete"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: () => onDelete?.(call),
      centered: true,
    });
  };

  return (
    <UnifiedListItem
      // pt-0! drops the shared list-item top padding so the title row sits
      // flush with the Timeline dot (the rail/dot stay unmoved); px-0! /
      // border-0! remove the shared list separators inside the chain.
      className="pt-0! px-0! border-0!"
      expandable
      expanded={expanded}
      onToggleExpand={() => setExpanded((v) => !v)}
      menu={
        onDelete
          ? [
              {
                key: "delete",
                label: t("common.delete"),
                danger: true,
                onClick: confirmDelete,
              },
            ]
          : undefined
      }
      title={
        <Text ellipsis className="text-sm" title={call.url}>
          {call.url}
        </Text>
      }
      status={
        <>
          <MethodBadge method={call.method} />
          <StatusBadge status={call.status} />
        </>
      }
      detail={
        <div className="flex flex-col gap-2 bg-(--ant-color-fill-quaternary) border border-(--ant-color-border-secondary) rounded-md px-2.5 py-2">
          <FlowAnnotations call={call} deps={deps} />
          <Field label="URL" value={call.url} />
          {Object.keys(call.reqHeaders).length > 0 && (
            <Section
              title={t("detail.reqHeaders")}
              body={headerText(call.reqHeaders)}
            />
          )}
          {call.reqBody && (
            <Section
              title={t("detail.reqBody")}
              body={prettyJson(call.reqBody)}
            />
          )}
          {call.streaming ? (
            <SseEvents call={call} />
          ) : (
            <Section
              title={t("detail.response", {
                status: call.status,
                statusText: call.statusText,
              })}
              body={prettyJson(call.resBody)}
            />
          )}
          {call.errored && (
            <Block title={t("detail.error")}>
              <Text type="danger">{call.errorText}</Text>
            </Block>
          )}
        </div>
      }
    />
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return <Section title={label} body={value} />;
}

export function Block({
  title,
  highlight,
  children,
}: {
  title: string;
  highlight?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      {/* `!` required: antd's unlayered 14px beats a layered utility otherwise. */}
      <Text type="secondary" strong className="text-xs!">
        {title}
      </Text>
      <div
        className={cn(
          "max-h-48 overflow-auto break-all mt-1 p-2 rounded-md text-[12px] leading-normal",
          highlight
            ? "bg-(--ant-color-warning-bg)"
            : "bg-(--ant-color-bg-elevated)",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function Section({
  title,
  body,
  highlight,
}: {
  title: string;
  body: string;
  highlight?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Block title={title} highlight={highlight}>
      <pre className="whitespace-pre-wrap break-all m-0 leading-normal">
        {body || t("common.empty")}
      </pre>
    </Block>
  );
}

export function headerText(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** Render a streaming (SSE) response as its ordered event sequence. */
function SseEvents({ call }: { call: ApiCall }) {
  const { t } = useTranslation();
  const events = call.sseEvents ?? [];
  return (
    <div>
      <Text type="secondary" strong className="text-xs!">
        {t("detail.streamResponse", {
          status: call.status,
          statusText: call.statusText,
          count: events.length,
        })}
      </Text>
      <div className="max-h-64 overflow-auto mt-1 flex flex-col gap-1">
        {events.length === 0 ? (
          <pre className="whitespace-pre-wrap break-all m-0 p-2 rounded-md text-[12px] bg-(--ant-color-bg-elevated)">
            {t("detail.noEvents")}
          </pre>
        ) : (
          events.map((ev, i) => (
            <div key={i} className="flex flex-col">
              <Text type="secondary" className="text-[10px]">
                #{i}
                {ev.event ? ` · ${ev.event}` : ""}
                {ev.id ? ` · id=${ev.id}` : ""}
              </Text>
              <pre className="whitespace-pre-wrap break-all m-0 p-2 rounded-md text-[12px] leading-normal bg-(--ant-color-bg-elevated)">
                {prettyJson(ev.data) || t("common.empty")}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
