import { useEffect, useState } from "react";
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  Typography,
} from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useGatewayProxyRules } from "@/hooks/use-gateway-proxy-rules";
import { useStorage } from "@/hooks/use-storage";
import { settings } from "@/lib/storage";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import { DomainListCard } from "./domain-list-card";
import type { GatewayProxyRule } from "@/lib/gateway/types";

const { Text } = Typography;

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

export function ProxyRulesPanel() {
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
