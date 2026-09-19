import { useEffect, useMemo, useState } from "react";
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useGatewayLogs } from "@/hooks/use-gateway-logs";
import { useGatewayProxyRules } from "@/hooks/use-gateway-proxy-rules";
import { useStorage } from "@/hooks/use-storage";
import { settings } from "@/lib/storage";
import { normalizeDomain } from "@/lib/gateway/authorize";
import {
  Block,
  Field,
  Section,
  headerText,
} from "@/components/recording/call-node";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import { BottomTabBar } from "@/components/common/bottom-tab-bar";
import {
  formatDateTimeShort,
  shortPath,
  schemeOf,
  prettyJson,
} from "@/lib/utils";
import type {
  GatewayDecision,
  GatewayLog,
  GatewayProxyRule,
} from "@/lib/gateway/types";

const { Text } = Typography;

/**
 * "Sandbox proxy" side-panel feature. Two sub-tabs:
 *   - Audit logs: every gateway call, with decision/status and expandable detail
 *   - Proxy rules: the script-driven gateway entry (sandbox prefix → target base).
 * Self-contained; mounts inside the home tab.
 */
type GatewayTab = "logs" | "proxy";

export function GatewayFeature() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<GatewayTab>("proxy");

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Content area: fills remaining space, each panel scrolls internally */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        {tab === "logs" ? <LogsPanel /> : <ProxyRulesPanel />}
        {/* Bottom fade mask: transparent → white, non-interactive */}
        <div className="pointer-events-none absolute left-0 right-0 bottom-0 h-8 z-[5] bg-[linear-gradient(to_bottom,rgba(255,255,255,0),rgba(255,255,255,1))]" />
      </div>

      <BottomTabBar
        tabs={[
          { key: "proxy" as const, label: t("gateway.tabProxy") },
          { key: "logs" as const, label: t("gateway.tabLogs") },
        ]}
        active={tab}
        onChange={setTab}
      />
    </div>
  );
}

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

function LogsPanel() {
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

/**
 * The proxy-rule panel: the script-driven gateway entry. Each rule maps a local
 * sandbox prefix (http://127.0.0.1:<proxyPort><prefix>) to a real target base. A
 * script points its baseURL at the sandbox URL; the extension rewrites + forwards
 * with cookies injected. Authorization here is simply that the rule exists and is
 * enabled — there's no per-call prompt (no agent), so the per-rule switch is the
 * kill switch. Requests to a disabled/unknown prefix are refused (404).
 */
interface ProxyRuleFormValues {
  sandboxPrefix: string;
  /** Stored target base; decomposed into scheme + host for the form fields. */
  targetBase: string;
  /** Form-only: target scheme selector (http/https). */
  targetScheme?: "http" | "https";
  /** Form-only: target host + optional base path (no scheme). */
  targetHost?: string;
}

/** Resolved payload handed to onSubmit. */
interface ProxyRuleSubmit {
  sandboxPrefix: string;
  targetBase: string;
}

/**
 * Modal form for adding a proxy rule. Validation lives in the background too.
 */
function ProxyRuleModal({
  open,
  proxyPort,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  proxyPort: number;
  onCancel: () => void;
  onSubmit: (values: ProxyRuleSubmit) => Promise<void>;
}) {
  const [form] = Form.useForm<ProxyRuleFormValues>();
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);

  // Reset fields whenever the modal opens so a prior draft doesn't linger.
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  const handleOk = async () => {
    let values: ProxyRuleFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // antd shows the field errors
    }
    setSubmitting(true);
    try {
      const sandboxPrefix = values.sandboxPrefix.trim();
      const targetBase = `${values.targetScheme ?? "https"}://${(values.targetHost ?? "").trim()}`;
      await onSubmit({
        sandboxPrefix,
        targetBase,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("gateway.addProxyRule")}
      open={open}
      centered
      onCancel={onCancel}
      onOk={handleOk}
      okText={t("common.add")}
      cancelText={t("common.cancel")}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        className="mt-6!"
        initialValues={{ targetScheme: "https" }}
      >
        <Form.Item
          label={t("gateway.pathPrefix")}
          name="sandboxPrefix"
          rules={[{ required: true, message: t("gateway.pathPrefixRequired") }]}
          className="mb-4!"
        >
          <Input
            addonBefore={`http://127.0.0.1:${proxyPort}`}
            placeholder={t("gateway.pathPrefixPlaceholder")}
          />
        </Form.Item>
        <Form.Item
          label={t("gateway.targetAddress")}
          name="targetHost"
          rules={[
            { required: true, message: t("gateway.targetAddressRequired") },
          ]}
        >
          <Input
            addonBefore={
              <Form.Item name="targetScheme" noStyle>
                <Select
                  className="w-[100px]"
                  options={[
                    { label: "https://", value: "https" },
                    { label: "http://", value: "http" },
                  ]}
                />
              </Form.Item>
            }
            placeholder="api.com"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ProxyRulesPanel() {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const { rules, loading, addRule, removeRule } = useGatewayProxyRules();

  const confirmDelete = (rule: GatewayProxyRule) => {
    modal.confirm({
      title: t("gateway.deleteProxyRuleTitle"),
      content: t("gateway.deleteProxyRuleConfirm", {
        prefix: rule.sandboxPrefix,
        target: rule.targetBase,
      }),
      okText: t("common.delete"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: () => removeRule(rule.id),
      centered: true,
    });
  };
  const [proxyPort, setProxyPort] = useState(8788);
  const [modalOpen, setModalOpen] = useState(false);
  // Sandbox domain policy: per-call confirmation switch + allow/deny lists.
  // User-managed only — no agent-facing tool can read or mutate them.
  const [confirmRequired, setConfirmRequired] = useStorage(
    settings.gatewayConfirmRequired,
  );
  const [allowDomains, setAllowDomains] = useStorage(
    settings.gatewayAllowDomains,
  );
  const [denyDomains, setDenyDomains] = useStorage(settings.gatewayDenyDomains);

  useEffect(() => {
    settings.proxyPort.getValue().then(setProxyPort);
    const u = settings.proxyPort.watch((v) => setProxyPort(v ?? 8788));
    return () => u();
  }, []);

  const openAdd = () => setModalOpen(true);

  const onSubmit = async (values: ProxyRuleSubmit) => {
    try {
      await addRule(values);
      message.success(t("gateway.ruleAdded"));
      setModalOpen(false);
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t("gateway.addFailed"),
      );
      throw err; // keep the modal open on failure
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto pb-14 flex flex-col gap-3 p-3">
        {/* Per-call confirmation switch — the master human-in-the-loop gate. */}
        <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <Text strong className="text-sm block">
                {t("gateway.confirmRequiredTitle")}
              </Text>
              <Text type="secondary" className="text-xs!">
                {t("gateway.confirmRequiredDesc")}
              </Text>
            </div>
            <Switch
              checked={confirmRequired}
              onChange={(v) => void setConfirmRequired(v)}
            />
          </div>
        </section>

        {/* Allow / deny domain management (user-only; deny wins over allow). */}
        <DomainListCard
          title={t("gateway.allowDomainsTitle")}
          description={t("gateway.allowDomainsDesc")}
          domains={allowDomains}
          onChange={(next) => void setAllowDomains(next)}
        />
        <DomainListCard
          title={t("gateway.denyDomainsTitle")}
          description={t("gateway.denyDomainsDesc")}
          domains={denyDomains}
          onChange={(next) => void setDenyDomains(next)}
        />

        {/* Proxy rules (script-driven gateway entry) */}
        <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) overflow-hidden">
          {/* Header mirrors DomainListCard: title + description + add button */}
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-(--ant-color-border-secondary)">
            <div className="min-w-0">
              <Text strong className="text-sm block">
                {t("gateway.proxyRulesTitle")}
              </Text>
              <Text type="secondary" className="text-xs!">
                {t("gateway.proxyRulesDesc")}
              </Text>
            </div>
            <Button className="flex-none" onClick={openAdd}>
              {t("common.add")}
            </Button>
          </div>
          {loading ? (
            <div className="p-8 text-center">
              <Spin />
            </div>
          ) : rules.length === 0 ? null : (
          <div>
            {rules.map((rule) => (
              <UnifiedListItem
                key={rule.id}
                // Hover-revealed direct delete (no three-dot menu, no edit).
                actions={
                  <Button
                    type="text"
                    size="small"
                    className="w-5 h-5 p-0 text-xs"
                    icon={<DeleteOutlined />}
                    onClick={() => confirmDelete(rule)}
                  />
                }
                title={
                  // User-created rules render plain — only agent-created ones
                  // carry the source tag.
                  <div className="flex items-center gap-2 min-w-0">
                    <Text
                      ellipsis
                      className="text-sm min-w-0"
                      title={`${rule.sandboxPrefix} → ${rule.targetBase}`}
                    >
                      {rule.sandboxPrefix} → {rule.targetBase}
                    </Text>
                    {rule.createdBy === "agent" && (
                      <Tag className="flex-none me-0 text-[10px]! font-normal! rounded">
                        {t("gateway.createdByAgent")}
                      </Tag>
                    )}
                  </div>
                }
              />
            ))}
          </div>
        )}
        </section>
      </div>

      <ProxyRuleModal
        open={modalOpen}
        proxyPort={proxyPort}
        onCancel={() => setModalOpen(false)}
        onSubmit={onSubmit}
      />
    </div>
  );
}

/**
 * Allow/deny domain management card. Inline add row (input + confirm/cancel,
 * validated with normalizeDomain) over a list of domain rows with a hover
 * delete menu — same visual system as the rest of the panel. Domains match
 * themselves and all their subdomains (see matchesDomain in authorize.ts).
 * Empty state is a collapsed card (header only); the list area appears once
 * content exists.
 */
function DomainListCard({
  title,
  description,
  domains,
  onChange,
}: {
  title: string;
  description: string;
  domains: string[];
  onChange: (next: string[]) => void;
}) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const domain = normalizeDomain(draft);
    if (!domain) {
      message.error(t("gateway.domainInvalid"));
      return;
    }
    if (domains.some((d) => d === domain)) {
      message.error(t("gateway.domainDuplicate"));
      return;
    }
    onChange([...domains, domain].sort());
    setDraft("");
    setAdding(false);
    message.success(t("gateway.domainAdded"));
  };

  return (
    <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-(--ant-color-border-secondary)">
        <div className="min-w-0">
          <Text strong className="text-sm block">
            {title}
          </Text>
          <Text type="secondary" className="text-xs!">
            {description}
          </Text>
        </div>
        <Button className="flex-none" onClick={() => setAdding(true)}>
          {t("common.add")}
        </Button>
      </div>

      {adding && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-(--ant-color-border-secondary)">
          <Input
            autoFocus
            allowClear
            placeholder={t("gateway.addDomainPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={submit}
            className="flex-1 min-w-0"
          />
          <Button
            type="text"
            size="small"
            className="flex-none w-6 h-6 p-0"
            disabled={!draft.trim()}
            icon={<CheckOutlined className="text-(--ant-color-success)" />}
            onClick={submit}
          />
          <Button
            type="text"
            size="small"
            className="flex-none w-6 h-6 p-0"
            icon={<CloseOutlined className="text-(--ant-color-text-quaternary)" />}
            onClick={() => {
              setAdding(false);
              setDraft("");
            }}
          />
        </div>
      )}

      {domains.length > 0 &&
        domains.map((domain) => (
          <UnifiedListItem
            key={domain}
            // Hover-revealed direct delete (no three-dot menu).
            actions={
              <Button
                type="text"
                size="small"
                className="w-5 h-5 p-0 text-xs"
                icon={<DeleteOutlined />}
                onClick={() => onChange(domains.filter((d) => d !== domain))}
              />
            }
            title={
              <Text ellipsis className="text-sm block" title={domain}>
                {domain}
              </Text>
            }
          />
        ))}
    </section>
  );
}
