import { useEffect, useRef, useState } from 'react';
import { App, Button, Segmented, Switch, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useStorage } from '@/hooks/use-storage';
import { useMcpConnStatus } from '@/hooks/use-mcp-conn-status';
import { settings, type McpConnStatus } from '@/lib/storage';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';
import { sendMessage } from '@/lib/messaging';
import { cn } from '@/lib/utils';
import { McpToolList } from '@/components/mcp/tool-list';

const { Text } = Typography;

/** Gap (ms) under which two taps on the version tag still count as consecutive. */
const TAP_GAP_MS = 1500;
/** Number of consecutive taps on the version tag that unlocks developer mode. */
const TAPS_TO_UNLOCK = 5;

/** Static extension identity for the about card (name/description already
 * resolved from _locales by the browser). */
const MANIFEST = browser.runtime.getManifest();

/** The companion MCP service package, linked in the about card. */
const MCP_NPM_URL = 'https://www.npmjs.com/package/@manta-action-kit/mcp';

/** This extension's Chrome Web Store listing. Pinned to the published store id
 * (a dev build's runtime id differs, so deriving it live would dead-link). */
const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel';

/** Map a connection status to the antd Tag color + i18n label key in the card header. */
const CONN_META = {
  connected: { tagColor: 'success', labelKey: 'mcp.connected' },
  connecting: { tagColor: 'processing', labelKey: 'mcp.connecting' },
  disconnected: { tagColor: 'default', labelKey: 'mcp.disconnected' },
  unauthorized: { tagColor: 'error', labelKey: 'mcp.unauthorized' },
} as const satisfies Record<
  McpConnStatus,
  { tagColor: 'success' | 'processing' | 'default' | 'error'; labelKey: string }
>;

/**
 * The gear-opened "Settings" view inside the side-panel home: language switch +
 * a connector (MCP) status card. Cards reuse the Secure Sandbox tab's section
 * style (rounded border + container background). The connector card collapses
 * to just its header — connection status tag + a tools toggle button — and the
 * tool kill-switch list expands on demand. The selected locale is stored in
 * `settings.locale`, which drives both react-i18next and antd's ConfigProvider
 * locale (see app-providers.tsx).
 */
export function SettingsFeature() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [locale, setLocale] = useStorage(settings.locale);
  const connStatus = useMcpConnStatus();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [devMode, setDevMode] = useStorage(settings.devMode);
  // Companion npm package version, resolved from the registry (null = hidden).
  const [mcpVersion, setMcpVersion] = useState<string | null>(null);
  // Easter-egg state: consecutive taps on the version tag (not persisted).
  const tapRef = useRef({ count: 0, timer: 0 });

  useEffect(() => {
    fetch('https://registry.npmjs.org/@manta-action-kit/mcp/latest')
      .then((res) => res.json())
      .then((data) => {
        if (typeof data?.version === 'string') setMcpVersion(data.version);
      })
      .catch(() => {}); // offline / registry unreachable — just hide the tag
  }, []);

  const options = SUPPORTED_LOCALES.map((loc) => ({
    label: loc === 'zh-CN' ? t('settings.languageChinese') : t('settings.languageEnglish'),
    value: loc,
  }));

  // Tap the version tag 5 times in a row (pauses > TAP_GAP_MS reset the run) to
  // reveal the developer-mode card. Works whenever the card is hidden.
  const onTapVersion = () => {
    if (devMode) return;
    const tap = tapRef.current;
    window.clearTimeout(tap.timer);
    tap.count += 1;
    if (tap.count >= TAPS_TO_UNLOCK) {
      tap.count = 0;
      void (async () => {
        await setDevMode(true);
        message.success(t('settings.devModeUnlockToast'));
      })();
    } else {
      tap.timer = window.setTimeout(() => (tap.count = 0), TAP_GAP_MS);
    }
  };

  // Pop the confirmation window with a fake request — debug only, nothing is
  // forwarded. The resolved decision is surfaced as a toast.
  const onConfirmTest = async () => {
    setTesting(true);
    try {
      const { approved } = await sendMessage('GATEWAY_CONFIRM_TEST', undefined);
      message.info(approved ? t('settings.confirmTestAllowed') : t('settings.confirmTestDenied'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3 pt-4">
      {/* About card: extension identity + companion MCP npm package, each as an
          icon-left / title+description+version-right row. Whole rows are
          clickable: extension → its Web Store listing, npm → the package page. */}
      <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) px-3 py-2.5 flex flex-col">
        <div
          className="flex items-center gap-2.5 cursor-pointer"
          onClick={() => window.open(CHROME_WEB_STORE_URL, '_blank', 'noopener')}
        >
          <img src="/icon/128.png" alt="" className="size-10 rounded-lg shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Text strong className="text-sm truncate">
                {MANIFEST.name}
              </Text>
              <Tag
                // Version taps unlock dev mode; swallow the click so the row's
                // store-link handler doesn't fire on every tap.
                onClick={(e) => {
                  e.stopPropagation();
                  if (!devMode) onTapVersion();
                }}
                className={cn(
                  'mr-0 px-1.5! text-xs! leading-4! shrink-0 select-none',
                  !devMode && 'cursor-default',
                )}
              >
                v{MANIFEST.version}
              </Tag>
            </div>
            <Text type="secondary" className="text-xs! line-clamp-2">
              {MANIFEST.description}
            </Text>
          </div>
        </div>
        {/* Companion MCP npm package — same row anatomy, version fetched live
            from the npm registry (tag hidden until it resolves). Title styled
            as a link (not a real <a>) so the row's single click handler opens
            the page exactly once. */}
        <div
          className="mt-2.5 pt-2.5 border-t border-(--ant-color-border-secondary) flex items-center gap-2.5 cursor-pointer"
          onClick={() => window.open(MCP_NPM_URL, '_blank', 'noopener')}
        >
          {/* Official npm mark on white — the logo is white-bg by design, so it
              stays authentic in both themes. */}
          <div className="size-10 rounded-lg shrink-0 bg-white border border-(--ant-color-border-secondary) flex items-center justify-center">
            <NpmLogo className="w-7 h-7" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Text className="text-sm! font-medium truncate text-(--ant-color-link)">
                @manta-action-kit/mcp
              </Text>
              {mcpVersion && (
                <Tag className="mr-0 ml-auto px-1.5! text-xs! leading-4! shrink-0">
                  v{mcpVersion}
                </Tag>
              )}
            </div>
            <Text type="secondary" className="text-xs! line-clamp-2">
              {t('settings.mcpPackageDesc')}
            </Text>
          </div>
        </div>
      </section>

      <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <Text strong className="text-sm block">
            {t('settings.language')}
          </Text>
          <Segmented<Locale>
            options={options}
            value={locale}
            onChange={(v) => void setLocale(v)}
            className="[&_.ant-segmented-group]:gap-1 [&_.ant-segmented-item]:shadow-none!"
          />
        </div>
      </section>

      {/* Connector (MCP) card: header-only by default (status tag + tools
          toggle); expanding reveals the same tool kill-switch list as the
          connector tab. */}
      <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Text strong className="text-sm">
                {t('settings.connectorTitle')}
              </Text>
              <Tag
                color={CONN_META[connStatus].tagColor}
                className="mr-0 px-1.5! text-xs! leading-4!"
              >
                {t(CONN_META[connStatus].labelKey)}
              </Tag>
            </div>
            <Text type="secondary" className="text-xs!">
              {t('settings.connectorDesc')}
            </Text>
          </div>
          <Button onClick={() => setToolsOpen((v) => !v)}>
            {t('mcp.tools')}
          </Button>
        </div>
        {toolsOpen && (
          <div className="px-3 py-2.5 border-t border-(--ant-color-border-secondary)">
            <McpToolList />
          </div>
        )}
      </section>

      {/* Developer-mode card: hidden by default; revealed by tapping the
          version tag 5 times, hidden again by the header Switch. The tools list
          below (confirm test first) is always expanded while visible. */}
      {devMode && (
        <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <Text strong className="text-sm block">
                {t('settings.devModeTitle')}
              </Text>
              <Text type="secondary" className="text-xs!">
                {t('settings.devModeDesc')}
              </Text>
            </div>
            <Switch checked onChange={(v) => void setDevMode(v)} />
          </div>
          <div className="px-3 py-2.5 border-t border-(--ant-color-border-secondary)">
            <div className="flex flex-col gap-3">
              {/* Confirmation test: pops the sandbox confirm window with a
                  fake request so the gate's UI can be debugged without a
                  real call. */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Text className="text-sm">{t('settings.confirmTestTitle')}</Text>
                  <div>
                    <Text type="secondary" className="text-xs!">
                      {t('settings.confirmTestDesc')}
                    </Text>
                  </div>
                </div>
                <Button loading={testing} onClick={() => void onConfirmTest()}>
                  {t('settings.confirmTestButton')}
                </Button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Official npm logo (from Simple Icons): the wordmark is negative space, so a
 * single red fill on the white tile reads correctly in both themes. */
function NpmLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#CB3837" aria-hidden="true">
      <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.001-.001 13.836h-3.694V11.45h-3.694v7.714h-7.75z" />
    </svg>
  );
}
