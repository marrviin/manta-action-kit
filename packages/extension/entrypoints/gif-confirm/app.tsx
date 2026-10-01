import { useEffect, useRef, useState } from 'react';
import { App, Button, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { sendMessage } from '@/lib/messaging';
import {
  GIF_CONFIRM_TIMEOUT_MS,
  GIF_PING_INTERVAL_MS,
} from '@/lib/gif-confirm';

const { Text } = Typography;

/** scheme + host, for the one-line target display. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The tab-recording confirmation popup (opened by lib/gif-confirm.ts for the
 * agent-driven start_gif_recording RPC).
 *
 * Chrome only mints a tabCapture streamId inside a real user gesture — the
 * popup's Record-GIF click was the only gesture surface, which an agent cannot
 * produce. The Allow button here IS the gesture: clicking it calls
 * chrome.tabCapture.getMediaStreamId({ targetTabId }) directly (this page runs
 * in the extension origin, so chrome.* is available) and hands the minted
 * streamId to the background, which forwards it to the same offscreen-recorder
 * flow the popup uses.
 *
 * Fail-closed like the sandbox confirm: deny, closing the window, the
 * countdown expiring, or the background losing the pending request all resolve
 * as refused. While visible it pings the background every GIF_PING_INTERVAL_MS
 * so the MV3 service worker (which owns the awaiting promise) doesn't
 * idle-terminate; an `ok:false` ping means the request is gone.
 */
export default function GifConfirmApp() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [expired, setExpired] = useState(false);
  const [remaining, setRemaining] = useState(
    Math.round(GIF_CONFIRM_TIMEOUT_MS / 1000),
  );
  const [minting, setMinting] = useState(false);
  const decidingRef = useRef(false);

  // Query params written by gif-confirm.ts when it opened this window.
  const query = new URLSearchParams(window.location.search);
  const id = query.get('id') ?? '';
  const tabId = Number(query.get('tabId') ?? '') || 0;
  const title = query.get('title') ?? '';
  const url = query.get('url') ?? '';

  const host = hostOf(url);

  // Keepalive ping + countdown tick (same mechanism as the sandbox confirm).
  useEffect(() => {
    if (!id) return;
    const ping = setInterval(async () => {
      try {
        const res = await sendMessage('GIF_CONFIRM_PING', { id });
        if (!res.ok) setExpired(true);
      } catch {
        // Background unreachable (e.g. restarting) — the next tick retries.
      }
    }, GIF_PING_INTERVAL_MS);
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

  const decide = async (approved: boolean) => {
    if (decidingRef.current || expired) return;
    decidingRef.current = true;
    try {
      // The Allow click is the user gesture Chrome requires: mint the
      // streamId right here (with the explicit targetTabId — this window has
      // no implicit "current tab" the way the popup click does), then hand it
      // to the background. A mint failure reports approved:false with the
      // error so the agent sees why.
      let streamId: string | undefined;
      let error: string | undefined;
      if (approved) {
        setMinting(true);
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: tabId,
          });
        } catch (err) {
          error = String(err);
        } finally {
          setMinting(false);
        }
        if (!streamId) approved = false;
      }
      const res = await sendMessage('GIF_CONFIRM_DECISION', {
        id,
        approved,
        streamId,
        error,
      });
      if (!res.ok) {
        setExpired(true);
        decidingRef.current = false;
        return;
      }
      window.close();
    } catch (err) {
      decidingRef.current = false;
      message.error(
        t('gifConfirm.decisionFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <div className="flex flex-col h-screen bg-white">
      <div className="flex-1 min-h-0 overflow-auto px-6 pt-5">
        <Text strong className="text-[18px]!">
          {t('gifConfirm.title')}
        </Text>
        <Text type="secondary" className="text-sm block mt-1">
          {t('gifConfirm.desc', { host })}
        </Text>

        <div className="mt-3 rounded-lg border border-(--ant-color-border-secondary) bg-(--ant-color-fill-quaternary) px-3 py-2.5 flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2">
            <Tag className="me-0 text-[10px]! font-normal! rounded" color="geekblue">
              {t('gifConfirm.sourceAgent')}
            </Tag>
            {!expired && (
              <Tag className="me-0 text-[10px]! font-normal! rounded" color="warning">
                {t('gifConfirm.countdown', { s: remaining })}
              </Tag>
            )}
          </div>
          <Text ellipsis className="text-sm" title={title}>
            {title || host}
          </Text>
          <Text ellipsis type="secondary" className="text-xs!" title={url}>
            {url}
          </Text>
          <Text type="secondary" className="text-xs!">
            {t('gifConfirm.captureBarHint')}
          </Text>
          {expired && (
            <Text type="danger" className="text-xs!">
              {t('gifConfirm.expired')}
            </Text>
          )}
        </div>
      </div>

      <div className="flex-none flex items-center justify-end gap-2 px-6 pt-3 pb-5">
        <Button disabled={expired || minting} onClick={() => void decide(false)} className="flex-1">
          {t('gifConfirm.deny')}
        </Button>
        <Button
          type="primary"
          disabled={expired}
          loading={minting}
          onClick={() => void decide(true)}
          className="flex-1"
        >
          {t('gifConfirm.allow')}
        </Button>
      </div>
    </div>
  );
}
