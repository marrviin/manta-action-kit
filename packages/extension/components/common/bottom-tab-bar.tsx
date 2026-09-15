import { Fragment } from 'react';
import { Divider, theme } from 'antd';

/**
 * Bottom sticky tab bar shared by feature panels (gateway, api-recording) and the
 * recording detail view. Renders evenly-spaced tab labels separated by vertical
 * dividers, with the active tab tinted by the primary color.
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
  const { token } = theme.useToken();
  return (
    <div className="flex-none flex border-t border-[rgba(5,5,5,0.06)] bg-white items-center relative z-10">
      {tabs.map((t, i) => {
        const activeTab = active === t.key;
        return (
          <Fragment key={t.key}>
            {i > 0 && <Divider vertical />}
            <div
              onClick={() => onChange(t.key)}
              className="flex-1 text-center py-2 cursor-pointer text-[14px]"
              style={{ color: activeTab ? token.colorPrimary : token.colorText }}
            >
              {t.label}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
