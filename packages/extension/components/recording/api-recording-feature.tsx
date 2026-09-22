import { useState } from "react";
import {
  App,
  Button,
  Empty,
  Input,
  Spin,
  Typography,
} from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { RecordingList } from "./recording-list";
import { RecordControls } from "./record-controls";
import { useRecordingState } from "@/hooks/use-recording-state";
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
    <div className="relative flex flex-col h-full min-h-0">
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

/**
 * The recording list with a top bar: search input + start button when idle;
 * hidden while recording, replaced by status + pause/stop controls.
 */
function RecordsPanel({ onOpen }: { onOpen: (recordingId: string) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const { active } = useRecordingState();

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-(--ant-color-border-secondary)">
        {!active && (
          <Input
            allowClear
            className="flex-1"
            prefix={<SearchOutlined />}
            placeholder={t("recording.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <RecordControls variant="block" />
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <RecordingList onOpen={onOpen} search={search} />
      </div>
    </div>
  );
}

/**
 * The filter-rules panel: a URL blacklist, presented as a card mirroring the
 * gateway's deny-domains card — header (title + description + add button that
 * expands an inline add row), then one row per rule with a hover delete menu.
 * Empty state is a collapsed card (header only).
 */
function FilterRulesPanel() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const { rules, loading, addRule, removeRule } = useRecordingFilterRules();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = async () => {
    const pattern = draft.trim();
    if (!pattern) return;
    if (rules.some((rule) => rule.pattern === pattern)) {
      message.error(t("recording.ruleDuplicate"));
      return;
    }
    await addRule(pattern);
    message.success(t("recording.ruleAdded"));
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto pb-14 flex flex-col gap-3 p-3">
      <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) overflow-hidden">
        {/* Header: title + description + add button (expands the inline add row) */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-(--ant-color-border-secondary)">
          <div className="min-w-0">
            <Text strong className="text-sm block">
              {t("recording.filterRulesTitle")}
            </Text>
            <Text type="secondary" className="text-xs!">
              {t("recording.filterRulesDesc")}
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
              placeholder={t("recording.urlPatternPlaceholder")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPressEnter={() => void submit()}
              className="flex-1 min-w-0"
            />
            <Button
              type="text"
              size="small"
              className="flex-none w-6 h-6 p-0"
              disabled={!draft.trim()}
              icon={<CheckOutlined className="text-(--ant-color-success)" />}
              onClick={() => void submit()}
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

        {loading ? (
          <div className="p-8 text-center">
            <Spin />
          </div>
        ) : (
          rules.map((rule) => (
            <FilterRuleRow
              key={rule.id}
              rule={rule}
              onRemove={() => removeRule(rule.id)}
            />
          ))
        )}
      </section>
    </div>
  );
}

function FilterRuleRow({
  rule,
  onRemove,
}: {
  rule: RecordingFilterRule;
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
      actions={
        <Button
          type="text"
          size="small"
          className="w-5 h-5 p-0 text-sm"
          icon={<DeleteOutlined />}
          onClick={confirmDelete}
        />
      }
      title={
        <Text ellipsis className="text-sm block" title={rule.pattern}>
          {rule.pattern}
        </Text>
      }
    />
  );
}
