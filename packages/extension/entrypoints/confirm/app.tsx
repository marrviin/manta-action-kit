import { useEffect, useRef, useState } from 'react';
import { App, Button, Checkbox, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { sendMessage } from '@/lib/messaging';
import { schemeOf, shortPath, prettyJson } from '@/lib/utils';
import { settings } from '@/lib/storage';
import { normalizeDomain } from '@/lib/gateway/authorize';
import { UnifiedListItem } from '@/components/common/unified-list-item';
import { Field, Section } from '@/components/recording/call-node';
import {
  CONFIRM_TIMEOUT_MS,
  PING_INTERVAL_MS,
} from '@/lib/gateway/confirm';

const { Text } = Typography;

/** scheme + host + short path, like the audit-log item title. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The sandbox-call confirmation popup (opened by lib/gateway/confirm.ts).
 *
 * Laid out like an antd Modal.confirm: title + description, a request-info
 * card that mirrors the audit-log item (click the title to expand URL / body
 * details), and right-aligned actions in the footer. Everything is fail-closed:
 * denying, closing the window, the countdown expiring, or the background
 * losing the pending request all resolve the call as refused. While visible it
 * pings the background every PING_INTERVAL_MS so the MV3 service worker (which
 * owns the awaiting promise) doesn't idle-terminate; an `ok:false` ping means
 * the request is gone.
 */
export default function ConfirmApp() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [expired, setExpired] = useState(false);
  const [remaining, setRemaining] = useState(Math.round(CONFIRM_TIMEOUT_MS / 1000));
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [allowNextTime, setAllowNextTime] = useState(false);
  const [inDenyList, setInDenyList] = useState(false);
  const decidingRef = useRef(false);

  // Query params written by confirm.ts when it opened this window.
  const query = new URLSearchParams(window.location.search);
  const id = query.get('id') ?? '';
  const via = query.get('via') === 'rule' ? 'rule' : 'agent';
  const method = query.get('method') ?? '';
  const url = query.get('url') ?? '';
  const body = query.get('body') ?? '';

  const host = hostOf(url);

  // The "skip next time" option is meaningless for denylisted hosts (deny wins
  // over allow), so hide it there.
  useEffect(() => {
    (async () => {
      const domain = normalizeDomain(host);
      if (!domain) return;
      const deny = (await settings.gatewayDenyDomains.getValue()) ?? [];
      setInDenyList(deny.includes(domain));
    })();
  }, [host]);

  // Keepalive ping + countdown tick.
  useEffect(() => {
    if (!id) return;
    const ping = setInterval(async () => {
      try {
        const res = await sendMessage('GATEWAY_CONFIRM_PING', { id });
        if (!res.ok) setExpired(true);
      } catch {
        // Background unreachable (e.g. restarting) — the next tick retries.
      }
    }, PING_INTERVAL_MS);
    const tick = setInterval(() => {
      setRemaining((s) => {
        if (s <= 1) {
          clearInterval(tick);
          setExpired(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      clearInterval(ping);
      clearInterval(tick);
    };
  }, [id]);

  // Keep the popup window hugging its content: when the layout changes (e.g.
  // the info card expands), ask the background to resize the window. The
  // page knows the outer-size delta (titlebar etc.) via outer/innerHeight.
  useEffect(() => {
    if (!id) return;
    const el = document.documentElement;
    const resize = () => {
      const chromeHeight = window.outerHeight - window.innerHeight;
      const height = Math.round(el.offsetHeight + chromeHeight);
      void sendMessage('GATEWAY_CONFIRM_RESIZE', { id, height }).catch(() => {});
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [id]);

  const decide = async (approved: boolean) => {
    if (decidingRef.current || expired) return;
    decidingRef.current = true;
    try {
      // Opted-in allowlisting: persist the host before the decision resolves so
      // subsequent calls skip the confirmation (deny list still wins).
      if (approved && allowNextTime) {
        try {
          const domain = normalizeDomain(host);
          if (domain) {
            const domains = (await settings.gatewayAllowDomains.getValue()) ?? [];
            if (!domains.includes(domain)) {
              await settings.gatewayAllowDomains.setValue([...domains, domain]);
            }
          }
        } catch {
          // Non-fatal: the decision still goes through.
        }
      }
      const res = await sendMessage('GATEWAY_CONFIRM_DECISION', { id, approved });
      if (!res.ok) {
        setExpired(true);
        decidingRef.current = false;
        return;
      }
      window.close();
    } catch (err) {
      decidingRef.current = false;
      message.error(
        t('gateway.confirmDecisionFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  const methodColor: Record<string, string> = {
    GET: 'green',
    POST: 'blue',
    PUT: 'orange',
    PATCH: 'purple',
    DELETE: 'red',
  };

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Modal.confirm-style body: title/description, then request info */}
      <div className="flex-1 min-h-0 overflow-auto px-6 pt-5">
        <div className="min-w-0">
          <Text strong className="text-[18px]!">
            {t('gateway.confirmTitle')}
          </Text>
          <Text type="secondary" className="text-sm block mt-1">
            {t('gateway.confirmDesc')}
          </Text>

          {/* Request info card: same collapsed/expandable layout as the
              audit-log items in the sandbox panel. Click the title to expand
              URL + body details (pretty-printed when JSON). */}
          <div className="mt-3 rounded-lg border border-(--ant-color-border-secondary) bg-(--ant-color-fill-quaternary) overflow-hidden">
            <UnifiedListItem
              className="border-b-0!"
              expandable
              expanded={infoExpanded}
              onToggleExpand={() => setInfoExpanded((v) => !v)}
              title={
                <Text ellipsis className="text-sm" title={url}>
                  {schemeOf(url)}
                  {hostOf(url)}
                  {shortPath(url)}
                </Text>
              }
              status={
                <>
                  <Tag
                    color={methodColor[method.toUpperCase()] ?? 'default'}
                    className="me-0 text-[10px]! font-normal! rounded"
                  >
                    {method.toUpperCase()}
                  </Tag>
                  <Tag
                    className="me-0 text-[10px]! font-normal! rounded"
                    color={via === 'agent' ? 'geekblue' : 'purple'}
                  >
                    {via === 'agent'
                      ? t('gateway.confirmSourceMcp')
                      : t('gateway.confirmSourceScript')}
                  </Tag>
                  {!expired && (
                    <Tag className="me-0 flex-none text-[10px]! font-normal! rounded" color="warning">
                      {t('gateway.confirmCountdown', { s: remaining })}
                    </Tag>
                  )}
                </>
              }
              detail={
                <div className="flex flex-col gap-2 pt-4 border-t border-(--ant-color-border-secondary) -mx-3 px-3">
                  <Field label={t('gateway.confirmUrl')} value={url} />
                  {body && (
                    <Section
                      title={t('gateway.confirmBodyPreview')}
                      body={prettyJson(body)}
                    />
                  )}
                </div>
              }
            />
            {expired && (
              <Text type="danger" className="text-xs! block px-3 pb-2">
                {t('gateway.confirmExpired')}
              </Text>
            )}
          </div>

          {/* Opt-in allowlisting: checking this (then allowing) adds the host
              to the allow-domain list so future calls skip confirmation. */}
          {!expired && !inDenyList && (
            <Checkbox
              className="mt-3!"
              checked={allowNextTime}
              onChange={(e) => setAllowNextTime(e.target.checked)}
            >
              <Text type="secondary" className="text-xs!">
                {t('gateway.confirmAddAllowDomain', { host })}
              </Text>
            </Checkbox>
          )}
        </div>
      </div>

      {/* Modal.confirm-style footer: right-aligned actions, no divider */}
      <div className="flex-none flex items-center justify-end gap-2 px-6 pt-3 pb-5">
        <Button disabled={expired} onClick={() => void decide(false)} className="flex-1">
          {t('gateway.confirmDeny')}
        </Button>
        <Button type="primary" disabled={expired} onClick={() => void decide(true)} className="flex-1">
          {t('gateway.confirmAllow')}
        </Button>
      </div>
    </div>
  );
}
