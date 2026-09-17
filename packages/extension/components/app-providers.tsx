import {
  App as AntdApp,
  ConfigProvider,
  theme as antdTheme,
  type ThemeConfig,
} from "antd";
import type { Locale as AntdLocale } from "antd/es/locale";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { type ReactNode } from "react";
import { useSyncLocale } from "@/lib/i18n/sync";
import type { Locale } from "@/lib/i18n";

/** Map the app's UI language to antd's locale bundle. */
const ANTD_LOCALES: Record<Locale, AntdLocale> = {
  en: enUS,
  "zh-CN": zhCN,
};

/**
 * Shared antd providers for every React entrypoint (popup / side panel).
 *
 * - ConfigProvider: brand theme tokens + a locale that follows `settings.locale`
 *   (drives antd's built-in copy — pagination, Popconfirm buttons, etc.).
 * - App: enables antd's context-aware message/modal/notification via App.useApp().
 *
 * The UI language is reconciled from storage via `useSyncLocale()`, which also
 * pushes it into react-i18next. First paint is gated on the stored value
 * resolving so the UI never flashes the default language then switches
 * (see [[popup-dev-flicker]]).
 *
 * Visual style is aligned with the desktop app theme:
 * a two-part config — brand seed color (#3768fa blue) plus a fixed set of
 * neutral / functional tokens and per-component tweaks that don't vary with the
 * accent. Light-only: antd's defaultAlgorithm, no OS dark-mode following, so the
 * fixed light surfaces (#f2f2f2 / #fafafa) render as intended everywhere.
 *
 * antd v6 supports React 19 natively — no compatibility patch required.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const { locale, ready } = useSyncLocale();
  // Gate first paint until the stored locale resolves, so text renders once in
  // the right language rather than flashing English then switching.
  if (!ready) return null;
  return (
    <ConfigProvider locale={ANTD_LOCALES[locale]} theme={THEME}>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

/**
 * Brand + neutral theme, ported from the desktop app's default preset (BASE_TOKEN +
 * BASE_COMPONENTS). The seed `colorPrimary` drives buttons / focus rings / menu
 * selection; the functional colors align with the brand palette instead of
 * antd's default green/gold/red; the rest are neutral surface / border / radius
 * tweaks that reproduce the desktop app's calmer, denser look.
 */
const THEME: ThemeConfig = {
  cssVar: { key: "manta-action-kit" },
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: "#3768fa",
    // Functional colors aligned to the brand palette (antd's default
    // green/gold/red clash with charts and file-type icons).
    colorSuccess: "#00b26f",
    colorWarning: "#f08433",
    colorError: "#f33b50",
    // Softer border than antd's default #d9d9d9.
    colorBorder: "#e8e8ea",
    borderRadius: 8,
    colorBgLayout: "#f2f2f2",
    colorBgContainer: "#fafafa",
    controlItemBgActive: "rgba(0,0,0,0.06)",
  },
  components: {
    // Flat buttons — drop antd's default primary/default/danger shadows.
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
    },
    // Tabs — all states (rest / hover / mousedown / selected) stay neutral:
    // antd's defaults derive hover/active/selected from the blue colorPrimary
    // (colorPrimaryHover / colorPrimaryActive / colorPrimary), which flashes
    // blue while switching tabs before the capsule CSS settles.
    Tabs: {
      itemColor: "#595959",
      itemHoverColor: "#1f1f1f",
      itemActiveColor: "#1f1f1f",
      itemSelectedColor: "#1f1f1f",
      titleFontSize: 13,
      horizontalItemGutter: 16,
    },
    // Select dropdown — restrained neutral-grey selected row.
    Select: {
      optionSelectedBg: "#f0f0f2",
      optionSelectedColor: "#1f1f1f",
    },
    // Neutral hover border on inputs (default hover tints with the accent).
    Input: { hoverBorderColor: "#d9d9d9" },
    InputNumber: { hoverBorderColor: "#d9d9d9" },
    // Denser table cells for the workspace lists.
    Table: { cellFontSize: 12, cellFontSizeSM: 12 },
  },
};
