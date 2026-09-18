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
import { SearchOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useGatewayLogs } from "@/hooks/use-gateway-logs";
import { useGatewayProxyRules } from "@/hooks/use-gateway-proxy-rules";
import { settings } from "@/lib/storage";
import { MethodBadge, StatusBadge } from "@/components/recording/method-badge";
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
  const [tab, setTab] = useState<GatewayTab>("logs");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Content area: fills remaining space, each panel scrolls internally */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        {tab === "logs" ? <LogsPanel /> : <ProxyRulesPanel />}
        {/* Bottom fade mask: transparent → white, non-interactive */}
        <div className="pointer-events-none absolute left-0 right-0 bottom-0 h-8 z-[5] bg-[linear-gradient(to_bottom,rgba(255,255,255,0),rgba(255,255,255,1))]" />
      </div>

      <BottomTabBar
        tabs={[
          { key: "logs" as const, label: t("gateway.tabLogs") },
          { key: "proxy" as const, label: t("gateway.tabProxy") },
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

/** Human label for a log's authorization source. */
function authSourceLabel(
  source: GatewayLog["authSource"],
  t: TFunction,
): string {
  if (source === "agent") return t("gateway.authAgent");
  if (source === "rule") return t("gateway.authRule");
  return t("gateway.authNone");
}

/**
 * Which entrypoint a call came through, for the list-row tag. `agent` = the
 * agent-driven MCP tool (proxy_fetch); `rule` = the script-driven proxy rules.
 * Returns null when there's nothing meaningful to badge.
 */
function entryTagMeta(
  source: GatewayLog["authSource"],
  t: TFunction,
): { color: string; label: string } | null {
  if (source === "agent")
    return { color: "geekblue", label: t("gateway.entryMcp") };
  if (source === "rule")
    return { color: "purple", label: t("gateway.entryProxy") };
  return null;
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
    {
      key: "export",
      label: t("gateway.exportLogs"),
      onClick: onExport,
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {logs.length > 0 && (
        <div className="p-2">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t("gateway.searchUrl")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
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
              const meta = decisionMeta(log.decision, t);
              const entryMeta = entryTagMeta(log.authSource, t);
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
                      {entryMeta && (
                        <Tag
                          color={entryMeta.color}
                          className="me-0 text-[10px]! font-normal! rounded"
                        >
                          {entryMeta.label}
                        </Tag>
                      )}
                      <Tag
                        color={meta.color}
                        className="me-0 text-[10px]! font-normal! rounded"
                      >
                        {meta.label}
                      </Tag>
                      <MethodBadge method={log.method} />
                      {log.status > 0 && (
                        <StatusBadge status={log.status} />
                      )}
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
 * Modal form for adding or editing a proxy rule. Validation lives in the
 * background too. When `initialValues` is provided the modal switches to edit
 * mode (title/button text change and fields are pre-filled).
 */
function ProxyRuleModal({
  open,
  proxyPort,
  initialValues,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  proxyPort: number;
  initialValues?: ProxyRuleFormValues;
  onCancel: () => void;
  onSubmit: (values: ProxyRuleSubmit) => Promise<void>;
}) {
  const [form] = Form.useForm<ProxyRuleFormValues>();
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = !!initialValues;

  // Reset fields whenever the modal opens, pre-filling the edit draft (if any)
  // so a prior draft doesn't linger. The target address is split into a scheme
  // selector (http/https) + host input, so we decompose an existing targetBase.
  useEffect(() => {
    if (open) {
      form.resetFields();
      if (initialValues) {
        const m = /^(https?):\/\/(.*)$/i.exec(initialValues.targetBase.trim());
        form.setFieldsValue({
          ...initialValues,
          targetScheme: (m?.[1]?.toLowerCase() as "http" | "https") ?? "https",
          targetHost: m ? m[2] : initialValues.targetBase.trim(),
        });
      }
    }
  }, [open, form, initialValues]);

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
      title={isEdit ? t("gateway.editProxyRule") : t("gateway.addProxyRule")}
      open={open}
      centered
      onCancel={onCancel}
      onOk={handleOk}
      okText={isEdit ? t("common.save") : t("common.add")}
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
  const { rules, loading, addRule, updateRule, removeRule } =
    useGatewayProxyRules();

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
  // The rule currently being edited (null = add mode).
  const [editingRule, setEditingRule] = useState<GatewayProxyRule | null>(null);
  // Search box (raw input) + its debounced value used for filtering.
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    settings.proxyPort.getValue().then(setProxyPort);
    const u = settings.proxyPort.watch((v) => setProxyPort(v ?? 8788));
    return () => u();
  }, []);

  // Debounce the search input (300ms) to avoid filtering on every keystroke.
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(search.trim().toLowerCase()),
      300,
    );
    return () => clearTimeout(t);
  }, [search]);

  // Fuzzy match against the sandbox prefix and target base of each rule.
  const filteredRules = useMemo(() => {
    if (!debouncedSearch) return rules;
    return rules.filter((rule) =>
      `${rule.sandboxPrefix} ${rule.targetBase}`
        .toLowerCase()
        .includes(debouncedSearch),
    );
  }, [rules, debouncedSearch]);

  const openAdd = () => {
    setEditingRule(null);
    setModalOpen(true);
  };

  const openEdit = (rule: GatewayProxyRule) => {
    setEditingRule(rule);
    setModalOpen(true);
  };

  const onSubmit = async (values: ProxyRuleSubmit) => {
    try {
      if (editingRule) {
        await updateRule(editingRule.id, values);
        message.success(t("gateway.ruleSaved"));
      } else {
        await addRule(values);
        message.success(t("gateway.ruleAdded"));
      }
      setModalOpen(false);
    } catch (err) {
      message.error(
        err instanceof Error
          ? err.message
          : editingRule
            ? t("gateway.saveFailed")
            : t("gateway.addFailed"),
      );
      throw err; // keep the modal open on failure
    }
  };

  return (
    <div className="flex flex-col h-full">
      {rules.length > 0 && (
        <div className="flex-none px-3 py-2.5 border-b border-(--ant-color-border-secondary)">
          <Input
            allowClear
            prefix={<SearchOutlined className="text-(--ant-color-text-quaternary)" />}
            placeholder={t("gateway.searchRule")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="p-8 text-center">
            <Spin />
          </div>
        ) : rules.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
          </div>
        ) : filteredRules.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("gateway.noMatchRule")}
            />
          </div>
        ) : (
          <div>
            {filteredRules.map((rule) => (
              <UnifiedListItem
                key={rule.id}
                menu={[
                  {
                    key: "edit",
                    label: t("gateway.editRule"),
                    onClick: () => openEdit(rule),
                  },
                  {
                    key: "delete",
                    label: t("common.delete"),
                    danger: true,
                    onClick: () => confirmDelete(rule),
                  },
                ]}
                title={
                  <div className="min-w-0">
                    <Text
                      ellipsis
                      className="text-sm block"
                      title={`${rule.sandboxPrefix} → ${rule.targetBase}`}
                    >
                      {rule.sandboxPrefix} → {rule.targetBase}
                    </Text>
                  </div>
                }
                status={
                  <Space size={6}>
                    <Tag
                      className="me-0 text-[10px]! font-normal! rounded"
                      color={rule.createdBy === "agent" ? "blue" : "green"}
                    >
                      {rule.createdBy === "agent"
                        ? t("gateway.createdByAgent")
                        : t("gateway.createdByUser")}
                    </Tag>
                    <Switch
                      size="small"
                      checked={rule.enabled}
                      onChange={async (v) => {
                        try {
                          await updateRule(rule.id, { enabled: v });
                        } catch (err) {
                          message.error(
                            err instanceof Error
                              ? err.message
                              : t("common.updateFailed"),
                          );
                        }
                      }}
                    />
                  </Space>
                }
                timestamp={rule.createdAt}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom add button: pinned block, raised above the parent fade mask (zIndex:5) so it isn't washed out. */}
      <div className="flex-none px-3 py-2.5 border-t border-(--ant-color-border-secondary) bg-(--ant-color-bg-elevated) relative z-10">
        <Button type="primary" block onClick={openAdd}>
          {t("gateway.addProxyRule")}
        </Button>
      </div>

      <ProxyRuleModal
        open={modalOpen}
        proxyPort={proxyPort}
        initialValues={
          editingRule
            ? {
                sandboxPrefix: editingRule.sandboxPrefix,
                targetBase: editingRule.targetBase,
              }
            : undefined
        }
        onCancel={() => setModalOpen(false)}
        onSubmit={onSubmit}
      />
    </div>
  );
}
