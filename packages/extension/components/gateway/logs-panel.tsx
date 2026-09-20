import { useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, Spin, Tag, Typography } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useGatewayLogs } from "@/hooks/use-gateway-logs";
import {
  Block,
  Field,
  Section,
  headerText,
} from "@/components/recording/call-node";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import {
  formatDateTimeShort,
  shortPath,
  schemeOf,
  prettyJson,
} from "@/lib/utils";
import type { GatewayDecision, GatewayLog } from "@/lib/gateway/types";

const { Text } = Typography;

const DECISION_COLOR: Record<GatewayDecision, string> = {
  auto: "blue",
  allowed: "green",
  blocked: "red",
};

const DECISION_LABEL_KEY = {
  auto: "gateway.decisionAuto",
  allowed: "gateway.decisionAllowed",
  blocked: "gateway.decisionBlocked",
} as const;

function decisionMeta(
  decision: GatewayDecision,
  t: TFunction,
): { color: string; label: string } {
  const key = DECISION_LABEL_KEY[decision];
  return {
    color: DECISION_COLOR[decision] ?? "default",
    label: key ? t(key) : t("gateway.decisionUnknown"),
  };
}

/**
 * Tag-1 (来源·确认状态) for the list row. Color carries the decision (green =
 * user-approved, blue = auto-allowed, red = blocked); the label packs the
 * entrypoint (MCP / 代理规则) with the authorization outcome — e.g.
 * "MCP·已确认"、"代理·白名单"、"已拦截" (no entrypoint recorded on old rows).
 */
function sourceTagMeta(
  log: GatewayLog,
  t: TFunction,
): { color: string; label: string } {
  const via = log.via
    ? log.via === "agent"
      ? t("gateway.entryMcp")
      : t("gateway.entryProxy")
    : null;
  let confirm: string;
  if (log.decision === "allowed") confirm = t("gateway.decisionAllowed");
  else if (log.decision === "auto")
    confirm =
      log.authSource === "allowlist"
        ? t("gateway.authAllowlist")
        : t("gateway.decisionAuto");
  else if (log.decision === "blocked")
    // Distinguish the refusal reason: denylist hit vs the other blocks
    // (SSRF guard, bad URL, user denied at the popup).
    confirm =
      log.authSource === "denylist"
        ? t("gateway.authDenylist")
        : t("gateway.decisionBlocked");
  else confirm = t("gateway.decisionUnknown");
  return {
    // Allowlist hits are as trustworthy as an explicit allow — render green
    // instead of the default "auto" blue.
    color:
      log.decision === "auto" && log.authSource === "allowlist"
        ? "green"
        : (DECISION_COLOR[log.decision] ?? "default"),
    label: via ? `${via} · ${confirm}` : confirm,
  };
}

/**
 * Tag-2 (方法·状态码): one tag like "GET · 200" — blue normally, red on 4xx/5xx
 * or a transport error so failing rows still stand out.
 */
function requestTagMeta(log: GatewayLog): { color: string; label: string } {
  const failed = log.status >= 400 || log.errored;
  return {
    color: failed ? "red" : "blue",
    label: log.status > 0 ? `${log.method} · ${log.status}` : log.method,
  };
}

/** Human label for a log's authorization source. */
function authSourceLabel(
  source: GatewayLog["authSource"],
  t: TFunction,
): string {
  if (source === "prompt") return t("gateway.authPrompt");
  if (source === "allowlist") return t("gateway.authAllowlist");
  if (source === "agent") return t("gateway.authAgent");
  if (source === "rule") return t("gateway.authRule");
  if (source === "denylist") return t("gateway.authDenylist");
  return t("gateway.authNone");
}

/**
 * Render one audit-log row as a plain-text block for the exported .log file.
 * Includes the summary line plus request/response detail, mirroring the UI's
 * expanded view. Cookie values are never present in the log data itself.
 */
function formatLogEntry(log: GatewayLog, t: TFunction): string {
  const meta = decisionMeta(log.decision, t);
  const lines: string[] = [];
  lines.push(`[${formatDateTimeShort(log.at)}] ${log.method} ${log.url}`);
  lines.push(
    `  ${t("gateway.logDecision")}: ${meta.label} | ${t("gateway.logStatus")}: ${log.status} ${log.statusText} | ${t("gateway.logKind")}: ${log.kind} | ${t("gateway.logDuration")}: ${log.durationMs}ms`,
  );
  lines.push(
    `  ${t("gateway.logAuthSource")}: ${authSourceLabel(log.authSource, t)}`,
  );
  lines.push(
    `  ${t("gateway.logInjectedCookie")}: ${
      log.injectedCookieNames.length > 0
        ? t("gateway.injectedCookieValue", {
            names: log.injectedCookieNames.join(", "),
            domain: log.cookieDomain,
          })
        : t("common.none")
    }`,
  );
  if (Object.keys(log.reqHeaders).length > 0) {
    lines.push(
      `  ${t("gateway.logReqHeaders")}: ${JSON.stringify(log.reqHeaders)}`,
    );
  }
  if (log.reqBodyPreview)
    lines.push(`  ${t("gateway.logReqBody")}: ${log.reqBodyPreview}`);
  if (Object.keys(log.resHeadersSafe).length > 0) {
    lines.push(
      `  ${t("gateway.logResHeaders")}: ${JSON.stringify(log.resHeadersSafe)}`,
    );
  }
  if (log.resBodyPreview)
    lines.push(`  ${t("gateway.logResBody")}: ${log.resBodyPreview}`);
  if (log.kind === "sse")
    lines.push(`  ${t("gateway.logSseCount")}: ${log.sseEventCount ?? 0}`);
  if (log.errored)
    lines.push(`  ${t("gateway.logError")}: ${log.errorText ?? ""}`);
  return lines.join("\n");
}

/**
 * Build a runnable cURL command from an audit-log row. Cookie values are never
 * stored, so the injected cookies can't be reproduced here — we add a comment
 * listing the names so it's clear the extension injected them at forward time.
 */
function buildCurlCommand(log: GatewayLog, t: TFunction): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts: string[] = [`curl -X ${log.method} ${quote(log.url)}`];
  for (const [name, value] of Object.entries(log.reqHeaders)) {
    parts.push(`  -H ${quote(`${name}: ${value}`)}`);
  }
  if (log.reqBodyPreview) {
    parts.push(`  --data-raw ${quote(log.reqBodyPreview)}`);
  }
  const cmd = parts.join(" \\\n");
  if (log.injectedCookieNames.length > 0) {
    const comment = t("gateway.curlCookieComment", {
      names: log.injectedCookieNames.join(", "),
      domain: log.cookieDomain,
    });
    return `# ${comment}\n${cmd}`;
  }
  return cmd;
}

/** Serialize all audit logs and trigger a browser download as a .log text file. */
function exportLogsToFile(logs: GatewayLog[], t: TFunction) {
  const header = `# ${t("gateway.exportHeaderTitle")}\n# ${t("gateway.exportHeaderTime")}: ${formatDateTimeShort(Date.now())}\n# ${t("gateway.exportHeaderCount")}: ${logs.length}\n`;
  const content =
    header +
    "\n" +
    logs.map((log) => formatLogEntry(log, t)).join("\n\n") +
    "\n";
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  a.download = `gateway-audit-${stamp}.log`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Audit-log panel: every gateway call with decision/status tags, URL search,
 * .log export, and per-row copy actions (URL / response / cURL).
 */
export function LogsPanel() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const { logs, loading, error } = useGatewayLogs();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(search.trim().toLowerCase()),
      300,
    );
    return () => clearTimeout(timer);
  }, [search]);

  const filteredLogs = useMemo(() => {
    if (!debouncedSearch) return logs;
    return logs.filter((log) =>
      log.url.toLowerCase().includes(debouncedSearch),
    );
  }, [logs, debouncedSearch]);

  const onExport = () => {
    if (logs.length === 0) {
      message.warning(t("gateway.noLogsToExport"));
      return;
    }
    try {
      exportLogsToFile(logs, t);
      message.success(t("gateway.exported", { count: logs.length }));
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t("gateway.exportFailed"),
      );
    }
  };

  const copyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(okMsg);
    } catch {
      message.error(t("common.copyFailed"));
    }
  };

  const buildRowMenu = (log: GatewayLog): MenuProps["items"] => [
    {
      key: "copy",
      label: t("common.copy"),
      children: [
        {
          key: "copy-url",
          label: t("common.copyUrl"),
          onClick: () => copyText(log.url, t("common.copied")),
        },
        {
          key: "copy-response",
          label: t("gateway.copyResponse"),
          onClick: () => copyText(log.resBodyPreview ?? "", t("common.copied")),
        },
        {
          key: "copy-curl",
          label: t("gateway.copyCurl"),
          onClick: () => copyText(buildCurlCommand(log, t), t("common.copied")),
        },
      ],
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {logs.length > 0 && (
        <div className="p-2 flex items-center gap-2">
          <Input
            allowClear
            className="flex-1"
            prefix={<SearchOutlined />}
            placeholder={t("gateway.searchUrl")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button onClick={onExport}>
            {t("gateway.export")}
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto pb-14">
        {loading ? (
          <div className="p-8 text-center">
            <Spin />
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("gateway.loadFailed", { error })}
            />
          </div>
        ) : logs.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("gateway.noMatchRequest")}
            />
          </div>
        ) : (
          <div>
            {filteredLogs.map((log) => {
              const sourceMeta = sourceTagMeta(log, t);
              const requestMeta = requestTagMeta(log);
              return (
                <UnifiedListItem
                  key={log.id}
                  expandable
                  expanded={expandedId === log.id}
                  onToggleExpand={() =>
                    setExpandedId((id) => (id === log.id ? null : log.id))
                  }
                  menu={buildRowMenu(log)}
                  title={
                    <Text ellipsis className="text-sm" title={log.url}>
                      {schemeOf(log.url)}
                      {log.host}
                      {shortPath(log.url)}
                    </Text>
                  }
                  status={
                    <>
                      <Tag
                        color={sourceMeta.color}
                        className="me-0 text-[10px]! font-normal! rounded"
                      >
                        {sourceMeta.label}
                      </Tag>
                      <Tag
                        color={requestMeta.color}
                        className="me-0 text-[10px]! font-normal! rounded"
                      >
                        {requestMeta.label}
                      </Tag>
                    </>
                  }
                  timestamp={log.at}
                  detail={<LogDetail log={log} />}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function LogDetail({ log }: { log: GatewayLog }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 bg-(--ant-color-fill-quaternary) border border-(--ant-color-border-secondary) rounded-md px-2.5 py-2">
      <Block title={t("gateway.summary")}>
        <Text type="secondary" className="text-xs">
          {formatDateTimeShort(log.at)} · {log.durationMs}ms ·{" "}
          {t("gateway.logAuthSource")}：{authSourceLabel(log.authSource, t)}
        </Text>
      </Block>

      <Field label="URL" value={log.url} />

      <Field
        label={t("gateway.injectedCookie")}
        value={
          log.injectedCookieNames.length > 0
            ? t("gateway.injectedCookieValue", {
                names: log.injectedCookieNames.join(", "),
                domain: log.cookieDomain,
              })
            : t("common.none")
        }
      />

      {Object.keys(log.reqHeaders).length > 0 && (
        <Section
          title={t("gateway.reqHeaders")}
          body={headerText(log.reqHeaders)}
        />
      )}
      {log.reqBodyPreview && (
        <Section
          title={t("gateway.reqBody")}
          body={prettyJson(log.reqBodyPreview)}
        />
      )}
      {Object.keys(log.resHeadersSafe).length > 0 && (
        <Section
          title={t("gateway.resHeaders")}
          body={headerText(log.resHeadersSafe)}
        />
      )}
      <Section
        title={
          log.kind === "sse"
            ? t("gateway.streamResponse", {
                status: log.status,
                statusText: log.statusText,
                count: log.sseEventCount ?? 0,
              })
            : t("gateway.response", {
                status: log.status,
                statusText: log.statusText,
              })
        }
        body={prettyJson(log.resBodyPreview)}
      />
      {log.errored && (
        <Block title={t("gateway.error")}>
          <Text type="danger">{log.errorText}</Text>
        </Block>
      )}
    </div>
  );
}
