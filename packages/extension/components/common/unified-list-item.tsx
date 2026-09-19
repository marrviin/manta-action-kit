import { type ReactNode } from 'react';
import { Button, Dropdown, Space, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { CaretRightFilled, EllipsisOutlined } from '@ant-design/icons';
import { cn, formatDateTimeShort } from '@/lib/utils';

const { Text } = Typography;

/**
 * Unified list-item layout shared by all feature lists (recordings, gateway
 * logs/domains/endpoints). Enforces a consistent two-row structure:
 *
 *   Row 1: [expand icon?] title ......................... [··· menu]
 *   Row 2: [status tags]  ......................... [date MM-DD HH:mm:ss]
 *
 * Optional expandable detail renders below when `expanded` is true.
 */
export interface UnifiedListItemProps {
  /** Row-1 title (left). Usually a name, URL, or endpoint. */
  title: ReactNode;
  /**
   * Row operations shown in a three-dot dropdown at the far right of Row 1.
   * Replaces the old per-row right-click (contextMenu) menus and hover icon buttons.
   */
  menu?: MenuProps['items'];
  /**
   * Inline icon buttons rendered at the far right of Row 1 (hover-revealed,
   * same spot as the menu button). Replaces the three-dot dropdown; use for
   * direct single actions like delete.
   */
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
  menu,
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
      className={cn(
        'manta-action-kit-list-item group block py-4 mx-2 border-b border-(--ant-color-border-secondary)',
        clickable ? 'cursor-pointer' : 'cursor-default',
        className,
      )}
      onClick={clickable ? onClick : undefined}
    >
      {/* Row 1: title ...... actions [expand] */}
      <div className="flex items-center gap-1.5 w-full">
        {expandable && (
          <Button
            type="text"
            size="small"
            className="flex-none w-5 h-5 p-0 text-sm"
            icon={
              <CaretRightFilled
                className={cn(
                  'transition-transform text-[10px]! text-(--ant-color-text-quaternary)',
                  expanded && 'rotate-90',
                )}
              />
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand?.();
            }}
          />
        )}
        <div
          className={cn('flex-1 min-w-0', expandable && 'cursor-pointer')}
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
        {menu && (
          <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: menu }}>
            <Button
              type="text"
              size="small"
              className="flex-none w-5 h-5 p-0 text-sm opacity-0 group-hover:opacity-100 focus-within:opacity-100"
              icon={<EllipsisOutlined />}
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        )}
        {!menu && actions && (
          <div
            className="flex-none opacity-0 group-hover:opacity-100 focus-within:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        )}
      </div>

      {/* Row 2: status tags ...... date */}
      {hasRow2 && (
        <div className="flex items-center justify-between gap-1.5 mt-1.5">
          <Space size={4} wrap className="min-w-0">
            {status}
          </Space>
          {timestamp != null && (
            <Text type="secondary" className="flex-none text-[10px]!">
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
