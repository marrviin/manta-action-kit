import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { App, Button, Empty, Spin, Timeline, Typography } from 'antd';
import { CaretDownOutlined, CaretUpOutlined, LeftOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { CallNode } from './call-node';
import { EndpointsPanel } from './endpoints-panel';
import { BottomTabBar } from '@/components/common/bottom-tab-bar';
import { deleteCall, getCalls, getRecording } from '@/lib/db';
import { formatGap } from '@/lib/utils';
import type { ApiCall, FieldDependency, Recording } from '@/lib/recording/types';

const { Text, Paragraph } = Typography;

type DetailTab = 'result' | 'endpoints';

interface Props {
  recordingId: string;
  onBack: () => void;
  /** Which bottom tab to open on mount (default 'result'). */
  initialTab?: DetailTab;
}

/**
 * A recording's detail view (full-screen route). Two bottom tabs:
 *   - 录制结果: the pure recorded call chain.
 *   - 接口契约: aggregated endpoint contracts.
 */
export function RecordingDetail({ recordingId, onBack, initialTab }: Props) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [calls, setCalls] = useState<ApiCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>(initialTab ?? 'result');

  useEffect(() => {
    let active = true;
    Promise.all([getRecording(recordingId), getCalls(recordingId)]).then(([rec, cs]) => {
      if (!active) return;
      setRecording(rec ?? null);
      setCalls(cs);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [recordingId]);

  const handleDelete = async (call: ApiCall) => {
    try {
      await deleteCall(recordingId, call.id);
      // Only drop the deleted call; other calls keep their original startedAt,
      // so the inter-call wait times shown stay unchanged.
      setCalls((prev) => prev.filter((c) => c.id !== call.id));
      setRecording((prev) =>
        prev ? { ...prev, callCount: Math.max(0, prev.callCount - 1) } : prev,
      );
      message.success(t('common.deleted'));
    } catch {
      message.error(t('common.deleteFailed'));
    }
  };

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
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 py-2 px-3 border-b border-[rgba(5,5,5,0.06)]">
        <Button icon={<LeftOutlined />} onClick={onBack} />
        <div className="min-w-0 flex-1">
          <Text strong ellipsis className="block">
            {t('detail.titleWithCount', { name: recording.name, count: recording.callCount })}
          </Text>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'result' && (
          <ResultPanel
            calls={calls}
            deps={recording.deps}
            description={recording.description}
            onDeleteCall={handleDelete}
          />
        )}
        {tab === 'endpoints' && <EndpointsPanel calls={calls} deps={recording.deps} />}
      </div>

      <BottomTabBar
        tabs={[
          { key: 'result' as const, label: t('detail.tabResult') },
          { key: 'endpoints' as const, label: t('detail.tabEndpoints') },
        ]}
        active={tab}
        onChange={setTab}
      />
    </div>
  );
}

/** 录制描述卡片：折叠时限制高度，底部提供一条展开/收起操作条（图标切换）。 */
function DescriptionCard({ description }: { description: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const contentRef = useRef<HTMLParagraphElement>(null);

  // 折叠状态下限制最多 5 行的高度（text-xs=12px，leading-relaxed≈1.625 → 单行约 19.5px）。
  const collapsedMaxHeight = 98;

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setOverflow(el.scrollHeight > collapsedMaxHeight + 1);
  }, [description]);

  return (
    <div className="mb-3 rounded bg-[rgba(5,5,5,0.02)] border border-[rgba(5,5,5,0.06)] overflow-hidden">
      <Paragraph
        ref={contentRef}
        type="secondary"
        className="mb-0! whitespace-pre-wrap text-xs leading-relaxed py-2 px-3 overflow-hidden"
        style={{
          maxHeight: expanded ? undefined : collapsedMaxHeight,
        }}
      >
        {description}
      </Paragraph>
      {overflow && (
        <div
          role="button"
          tabIndex={0}
          aria-label={expanded ? t('detail.descCollapse') : t('detail.descExpand')}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          className="mt-1 flex items-center justify-center gap-1 py-1 text-xs text-[rgba(5,5,5,0.45)] cursor-pointer border-t border-[rgba(5,5,5,0.06)] hover:text-[rgba(5,5,5,0.88)] transition-colors select-none"
        >
          {expanded ? <CaretUpOutlined /> : <CaretDownOutlined />}
        </div>
      )}
    </div>
  );
}

/** The recorded call chain (pure recorded view). */
function ResultPanel({
  calls,
  deps,
  description,
  onDeleteCall,
}: {
  calls: ApiCall[];
  deps?: FieldDependency[];
  description?: string;
  onDeleteCall: (call: ApiCall) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto py-4 px-3">
        {description && <DescriptionCard description={description} />}
        {calls.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
          </div>
        ) : (
          <div className="manta-action-kit-call-timeline">
            <Text type="secondary" className="block mb-3 text-sm">
              {t('detail.callChainTitle')}
            </Text>
            <Timeline
              items={calls.map((call, index) => {
                const next = calls[index + 1];
                const gap = next ? next.startedAt - call.startedAt : null;
                return {
                  color: call.errored ? 'red' : 'blue',
                  children: (
                    <>
                      <CallNode call={call} deps={deps} onDelete={onDeleteCall} />
                      {gap != null && gap > 0 && (
                        <Text type="secondary" className="block text-[12px]! mt-2">
                          {t('detail.waitGap', { gap: formatGap(gap) })}
                        </Text>
                      )}
                    </>
                  ),
                };
              })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
