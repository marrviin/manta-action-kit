import { Fragment } from 'react';
import { cn } from '@/lib/utils';

/**
 * Bottom sticky tab bar shared by feature panels (gateway, api-recording) and the
 * recording detail view. Renders evenly-spaced tab labels separated by vertical
 * dividers, with the active tab tinted by the text color (vs secondary).
 */
export interface BottomTab<K extends string> {
  key: K;
  label: string;
}

export function BottomTabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: BottomTab<K>[];
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="flex-none flex border-t-[2px] border-(--ant-color-border) items-center relative z-10 bg-(--ant-color-bg-container)">
      {tabs.map((t, i) => {
        const activeTab = active === t.key;
        return (
          <Fragment key={t.key}>
            {i > 0 && <span className="w-px h-6 bg-(--ant-color-border)" />}
            <div
              onClick={() => onChange(t.key)}
              className={cn(
                'flex-1 text-center py-2 cursor-pointer text-[14px]',
                activeTab
                  ? 'text-(--ant-color-text) font-semibold'
                  : 'text-(--ant-color-text-secondary)',
              )}
            >
              {t.label}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
