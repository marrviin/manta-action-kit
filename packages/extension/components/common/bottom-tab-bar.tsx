import { Segmented } from 'antd';

/**
 * Bottom floating tab bar shared by feature panels (gateway, api-recording) and
 * the recording detail view. Built on antd Segmented (`block` mode fills the
 * width); rendered absolutely so it hovers above the scrolling content. The
 * pill itself is a liquid-glass layer: translucent background + backdrop-filter
 * (see `.manta-action-kit-glass-tabs` in assets/tailwind.css) blurring whatever
 * passes beneath. Requires the parent container to be `relative`.
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
    <div className="absolute bottom-0 inset-x-0 z-10 px-3 pb-3 pt-1 pointer-events-none">
      <Segmented
        block
        // shape="round"
        className="manta-action-kit-glass-tabs pointer-events-auto [&_.ant-segmented-item-label]:text-[14px]! [&_.ant-segmented-group]:gap-1 [&_.ant-segmented-item]:shadow-none!"
        value={active}
        onChange={(key) => onChange(key as K)}
        options={tabs.map((t) => ({ label: t.label, value: t.key }))}
        size="large"
      />
    </div>
  );
}
