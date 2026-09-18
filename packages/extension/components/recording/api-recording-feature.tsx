import { useState } from "react";
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { RecordingList } from "./recording-list";
import { RecordControls } from "./record-controls";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import { BottomTabBar } from "@/components/common/bottom-tab-bar";
import { useRecordingFilterRules } from "@/hooks/use-recording-filter-rules";
import type { RecordingFilterRule } from "@/lib/recording/types";

const { Text } = Typography;

/**
 * "API recording" side-panel feature. Two sub-tabs, mirroring the gateway feature:
 *   - Records: the local recording list (open a recording → its call chain)
 *   - Rules: filter rules that control what gets recorded (currently a URL
 *     blacklist — matching calls are dropped while recording).
 * Self-contained; mounts inside the home tab.
 */
type RecordingTab = "records" | "rules";

export function ApiRecordingFeature({
  onOpen,
}: {
  onOpen: (recordingId: string) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RecordingTab>("records");

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 flex flex-col relative">
        {tab === "records" ? (
          <RecordsPanel onOpen={onOpen} />
        ) : (
          <FilterRulesPanel />
        )}
      </div>

      <BottomTabBar
        tabs={[
          { key: "records" as const, label: t("recording.tabRecords") },
          { key: "rules" as const, label: t("recording.tabRules") },
        ]}
        active={tab}
        onChange={setTab}
      />
    </div>
  );
}

/** The recording list + the shared start/pause/stop recording controls. */
function RecordsPanel({ onOpen }: { onOpen: (recordingId: string) => void }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 overflow-auto">
        <RecordingList onOpen={onOpen} />
      </div>
      <div className="shrink-0 border-t border-(--ant-color-border-secondary) bg-(--ant-color-bg-elevated) px-3 py-2.5">
        <RecordControls variant="block" />
      </div>
    </div>
  );
}

/** Add-rule modal: a single wildcard URL pattern. */
function FilterRuleModal({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (pattern: string) => Promise<void>;
}) {
  const [form] = Form.useForm<{ pattern: string }>();
  const [submitting, setSubmitting] = useState(false);
  const { t } = useTranslation();

  const handleOk = async () => {
    let values: { pattern: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(values.pattern.trim());
      form.resetFields();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("recording.addFilterRule")}
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
      >
        <Form.Item
          label={
            <span className="inline-flex items-center gap-1">
              {t("recording.urlPattern")}
              <Tooltip title={t("recording.urlPatternTip")}>
                <InfoCircleOutlined className="text-(--ant-color-text-tertiary)" />
              </Tooltip>
            </span>
          }
          name="pattern"
          rules={[
            { required: true, message: t("recording.urlPatternRequired") },
          ]}
        >
          <Input placeholder={t("recording.urlPatternPlaceholder")} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** The filter-rules panel: a URL blacklist. */
function FilterRulesPanel() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const { rules, loading, addRule, updateRule, removeRule } =
    useRecordingFilterRules();
  const [modalOpen, setModalOpen] = useState(false);

  const onSubmit = async (pattern: string) => {
    if (!pattern) return;
    await addRule(pattern);
    message.success(t("recording.ruleAdded"));
    setModalOpen(false);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="p-8 text-center">
            <Spin />
          </div>
        ) : rules.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
          </div>
        ) : (
          <div>
            {rules.map((rule) => (
              <FilterRuleRow
                key={rule.id}
                rule={rule}
                onToggle={async (v) => {
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
                onRemove={() => removeRule(rule.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex-none px-3 py-2.5 border-t border-(--ant-color-border-secondary) bg-(--ant-color-bg-elevated) relative z-10">
        <Button type="primary" block onClick={() => setModalOpen(true)}>
          {t("recording.addFilterRule")}
        </Button>
      </div>

      <FilterRuleModal
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSubmit={onSubmit}
      />
    </div>
  );
}

function FilterRuleRow({
  rule,
  onToggle,
  onRemove,
}: {
  rule: RecordingFilterRule;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { modal } = App.useApp();
  const { t } = useTranslation();

  const confirmDelete = () => {
    modal.confirm({
      title: t("recording.deleteRuleTitle"),
      content: t("recording.deleteRuleConfirm", { pattern: rule.pattern }),
      okText: t("common.delete"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: onRemove,
      centered: true,
    });
  };

  return (
    <UnifiedListItem
      menu={[
        {
          key: "delete",
          label: t("common.delete"),
          danger: true,
          onClick: confirmDelete,
        },
      ]}
      title={
        <Text ellipsis className="text-sm block" title={rule.pattern}>
          {rule.pattern}
        </Text>
      }
      status={
        <Space size={6}>
          <Tag className="me-0 text-[10px]! font-normal! rounded" color="volcano">
            {t("recording.blacklist")}
          </Tag>
          <Switch size="small" checked={rule.enabled} onChange={onToggle} />
        </Space>
      }
      timestamp={rule.createdAt}
    />
  );
}
