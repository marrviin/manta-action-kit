import { type ReactNode } from 'react';
import { Button, Space, Typography } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { formatDateTimeShort } from '@/lib/utils';

const { Text } = Typography;

/**
 * Unified list-item layout shared by all feature lists (recordings, gateway
 * logs/domains/endpoints). Enforces a consistent two-row structure:
 *
 *   Row 1: [expand icon?] title .................... [action buttons]
 *   Row 2: [status tags]  ......................... [date MM-DD HH:mm:ss]
 *
 * Optional expandable detail renders below when `expanded` is true.
 */
export interface UnifiedListItemProps {
  /** Row-1 title (left). Usually a name, URL, or endpoint. */
  title: ReactNode;
  /** Row-1 action icon buttons (right). */
  actions?: ReactNode;
  /** Row-2 status tags (left). E.g. method / status / decision badges. */
  status?: ReactNode;
  /** Row-2 timestamp (right), epoch ms — rendered as MM-DD HH:mm:ss. */
  timestamp?: number;
  /** Whether this row supports an expand/collapse toggle. */
  expandable?: boolean;
  /** Current expanded state (controlled). */
  expanded?: boolean;
  /** Toggle handler for the expand icon. */
  onToggleExpand?: () => void;
  /** Detail content rendered under the two rows when expanded. */
  detail?: ReactNode;
  /** Row click handler (ignored when clicking actions/expand). */
  onClick?: () => void;
  clickable?: boolean;
  /**
   * Extra class(es) appended to the outer row container. Each feature list
   * should pass its own scoped class (e.g. `manta-action-kit-recording-item`,
   * `manta-action-kit-gateway-item`, `manta-action-kit-call-node`) so per-list style
   * tweaks stay isolated and never leak across lists.
   */
  className?: string;
}

export function UnifiedListItem({
  title,
  actions,
  status,
  timestamp,
  expandable = false,
  expanded = false,
  onToggleExpand,
  detail,
  onClick,
  clickable = false,
  className = '',
}: UnifiedListItemProps) {
  const hasRow2 = status != null || timestamp != null;

  return (
    <div
      className={`manta-action-kit-list-item group block py-2 px-3 border-b border-[rgba(5,5,5,0.06)] ${
        clickable ? 'cursor-pointer' : 'cursor-default'
      } ${className}`}
      onClick={clickable ? onClick : undefined}
    >
      {/* Row 1: title ...... actions [expand] */}
      <div className="flex items-center gap-1.5 w-full">
        <div
          className={`flex-1 min-w-0 ${expandable ? 'cursor-pointer' : ''}`}
          onClick={
            expandable
              ? (e) => {
                  e.stopPropagation();
                  onToggleExpand?.();
                }
              : undefined
          }
        >
          {title}
        </div>
        {actions && (
          <Space
            size={4}
            className="flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 text-sm"
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </Space>
        )}
        {expandable && (
          <Button
            type="text"
            size="small"
            className="flex-none w-5 h-5 p-0 text-sm"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand?.();
            }}
          />
        )}
      </div>

      {/* Row 2: status tags ...... date */}
      {hasRow2 && (
        <div className="flex items-center justify-between gap-1.5 mt-1.5">
          <Space size={4} wrap className="min-w-0">
            {status}
          </Space>
          {timestamp != null && (
            <Text type="secondary" className="flex-none text-xs">
              {formatDateTimeShort(timestamp)}
            </Text>
          )}
        </div>
      )}

      {/* Expandable detail */}
      {expandable && expanded && detail && <div className="mt-2">{detail}</div>}
    </div>
  );
}
