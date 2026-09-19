import { Segmented } from 'antd';
import { cn } from '@/lib/utils';

/**
 * Bottom floating tab bar shared by feature panels (gateway, api-recording) and
 * the recording detail view. Built on antd Segmented (`block` mode fills the
 * width); rendered absolutely so it hovers above the scrolling content. The
 * pill itself is a liquid-glass layer: translucent background + backdrop-filter
 * (arbitrary variants below) blurring whatever passes beneath. Requires the
 * parent container to be `relative`.
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
        className={cn(
          'pointer-events-auto [&_.ant-segmented-item-label]:text-[14px]! [&_.ant-segmented-group]:gap-1 [&_.ant-segmented-item]:shadow-none!',
          // Glass container: translucent bg + blur/saturate, hairline border,
          // specular top-edge inset highlight, soft drop shadow for lift.
          // Rules competing with antd on the same property are pinned with `!`
          // (antd is injected unlayered).
          'bg-[color:color-mix(in_srgb,var(--ant-color-bg-container)_58%,transparent)]! backdrop-blur-[18px] backdrop-saturate-[1.8] select-none',
          'border border-[color:color-mix(in_srgb,var(--ant-color-border)_60%,transparent)]',
          'shadow-[0_8px_24px_color-mix(in_srgb,var(--ant-color-text)_12%,transparent),inset_0_1px_0_rgba(255,255,255,0.55)]',
          // Moving thumb gets its own glass layer. During the slide motion the
          // thumb paints the active fill, then the selected item takes over.
          '[&_.ant-segmented-thumb]:backdrop-blur-[8px] [&_.ant-segmented-thumb]:backdrop-saturate-[1.5]',
          '[&_.ant-segmented-thumb]:shadow-[0_2px_8px_color-mix(in_srgb,var(--ant-color-text)_14%,transparent),inset_0_1px_0_rgba(255,255,255,0.45)]!',
        )}
        value={active}
        onChange={(key) => onChange(key as K)}
        options={tabs.map((t) => ({ label: t.label, value: t.key }))}
        size="large"
      />
    </div>
  );
}
