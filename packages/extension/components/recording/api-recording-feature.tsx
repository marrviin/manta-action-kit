import { useState } from 'react';
import {
  App,
  Button,
  Dropdown,
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
} from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { RecordingList } from './recording-list';
import { UnifiedListItem } from '@/components/common/unified-list-item';
import { BottomTabBar } from '@/components/common/bottom-tab-bar';
import { useRecordingFilterRules } from '@/hooks/use-recording-filter-rules';
import { toolbarState } from '@/lib/storage';
import type { RecordingFilterRule } from '@/lib/recording/types';

const { Text } = Typography;

/**
 * "接口录制" side-panel feature. Two sub-tabs, mirroring the gateway feature:
 *   - 录制记录: the local recording list (open a recording → its call chain)
 *   - 录制规则: filter rules that control what gets recorded (currently a URL
 *     blacklist — matching calls are dropped while recording).
 * Self-contained; mounts inside the home tab.
 */
type RecordingTab = 'records' | 'rules';

export function ApiRecordingFeature({ onOpen }: { onOpen: (recordingId: string) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RecordingTab>('records');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 flex flex-col relative">
        {tab === 'records' ? <RecordsPanel onOpen={onOpen} /> : <FilterRulesPanel />}
      </div>

      <BottomTabBar
        tabs={[
          { key: 'records' as const, label: t('recording.tabRecords') },
          { key: 'rules' as const, label: t('recording.tabRules') },
        ]}
        active={tab}
        onChange={setTab}
      />
    </div>
  );
}

/** The recording list + the "录制" action button that reveals the in-page toolbar. */
function RecordsPanel({ onOpen }: { onOpen: (recordingId: string) => void }) {
  const { message } = App.useApp();
  const { t } = useTranslation();

  const showToolbar = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      message.warning(t('popup.noActiveTab'));
      return;
    }
    if (!/^https?:/i.test(tab.url)) {
      message.warning(t('popup.unsupportedPage'));
      return;
    }
    await toolbarState.setValue({ tabId: tab.id });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 overflow-auto">
        <RecordingList onOpen={onOpen} />
      </div>
      <div className="shrink-0 border-t border-[#f0f0f0] bg-white px-3 py-2.5">
        <Button type="primary" block onClick={showToolbar}>
          {t('recording.record')}
        </Button>
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
      title={t('recording.addFilterRule')}
      open={open}
      centered
      onCancel={onCancel}
      onOk={handleOk}
      okText={t('common.add')}
      cancelText={t('common.cancel')}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Form form={form} layout="vertical" requiredMark={false} className="mt-6!">
        <Form.Item
          label={
            <span className="inline-flex items-center gap-1">
              {t('recording.urlPattern')}
              <Tooltip title={t('recording.urlPatternTip')}>
                <InfoCircleOutlined className="text-[rgba(0,0,0,0.45)]" />
              </Tooltip>
            </span>
          }
          name="pattern"
          rules={[{ required: true, message: t('recording.urlPatternRequired') }]}
        >
          <Input placeholder={t('recording.urlPatternPlaceholder')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** The filter-rules panel: a URL blacklist. */
function FilterRulesPanel() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const { rules, loading, addRule, updateRule, removeRule } = useRecordingFilterRules();
  const [modalOpen, setModalOpen] = useState(false);

  const onSubmit = async (pattern: string) => {
    if (!pattern) return;
    await addRule(pattern);
    message.success(t('recording.ruleAdded'));
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
                    message.error(err instanceof Error ? err.message : t('common.updateFailed'));
                  }
                }}
                onRemove={() => removeRule(rule.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex-none px-3 py-2.5 border-t border-[rgba(5,5,5,0.06)] bg-white relative z-10">
        <Button type="primary" block onClick={() => setModalOpen(true)}>
          {t('recording.addFilterRule')}
        </Button>
      </div>

      <FilterRuleModal open={modalOpen} onCancel={() => setModalOpen(false)} onSubmit={onSubmit} />
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
      title: t('recording.deleteRuleTitle'),
      content: t('recording.deleteRuleConfirm', { pattern: rule.pattern }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: onRemove,
    });
  };

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items: [
          {
            key: 'delete',
            label: t('common.delete'),
            danger: true,
            onClick: confirmDelete,
          },
        ],
      }}
    >
      <div>
        <UnifiedListItem
          title={
            <Text ellipsis className="text-sm block" title={rule.pattern}>
              {rule.pattern}
            </Text>
          }
          status={
            <Space size={6}>
              <Tag className="me-0 text-xs rounded" color="volcano">
                {t('recording.blacklist')}
              </Tag>
              <Switch size="small" checked={rule.enabled} onChange={onToggle} />
            </Space>
          }
          timestamp={rule.createdAt}
        />
      </div>
    </Dropdown>
  );
}
