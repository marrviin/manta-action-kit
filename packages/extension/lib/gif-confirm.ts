/**
 * Human confirmation for agent-requested GIF recordings.
 *
 * Chrome only mints a tabCapture streamId inside a real user gesture, and the
 * only existing gesture surface is the popup's Record-GIF click — unreachable
 * for an agent. Mirroring the gateway confirm pattern (lib/gateway/confirm.ts):
 * the background opens a small always-on-top popup window
 * (entrypoints/gif-confirm) describing the target tab; the user's Allow click
 * inside that extension page IS the gesture — the page calls
 * chrome.tabCapture.getMediaStreamId({ targetTabId }) itself and hands the
 * minted streamId back. Fail-closed: closing the window or the timeout both
 * count as a deny.
 *
 * Deliberately a separate module from the gateway confirm (not a parameterized
 * mode): the gateway popup is the security-critical sandbox gate with
 * allowlist/denylist logic; grafting a second flow into it risks that. The
 * pattern is ~100 lines to duplicate with the gateway-specific bits removed.
 *
 * MV3 gotcha (same as the gateway confirm): the SW can idle-terminate after
 * ~30s with no events, dropping the pending promise and hanging the RPC. The
 * confirm page pings every PING_INTERVAL_MS; each inbound message resets the
 * SW idle timer. A backstop timer here denies the call if the page never
 * answers.
 */
import { uuid } from '@/lib/utils';

/** Auto-deny after this long without a user decision (ms). */
export const GIF_CONFIRM_TIMEOUT_MS = 120_000;
/** The confirm page pings this often to keep the SW alive (ms). */
export const GIF_PING_INTERVAL_MS = 15_000;

export interface GifConfirmTarget {
  tabId: number;
  /** Tab title shown in the popup. */
  title: string;
  /** Tab URL — the host is shown; the full URL is encoded into the page URL. */
  url: string;
}

export interface GifConfirmDecision {
  approved: boolean;
  /** Present only when approved — the gesture-minted tabCapture streamId. */
  streamId?: string;
  /** Mint failure when the user allowed but getMediaStreamId threw. */
  error?: string;
}

const pending = new Map<
  string,
  {
    resolve: (decision: GifConfirmDecision) => void;
    windowId?: number;
    notificationId: string;
  }
>();

/**
 * Open the confirmation popup and resolve once the user allows (with the
 * gesture-minted streamId), denies, closes the window (deny), or the timeout
 * hits (deny).
 *
 * Also fires a requireInteraction system notification so the request is
 * noticed even when the popup opens behind other windows; clicking it focuses
 * the popup.
 */
export function requestGifConfirmation(
  target: GifConfirmTarget,
): Promise<GifConfirmDecision> {
  const id = uuid();
  const notificationId = `gif-confirm-${id}`;
  const params = new URLSearchParams({
    id,
    tabId: String(target.tabId),
    title: target.title.slice(0, 200),
    url: target.url.slice(0, 500),
  });
  const popupUrl = `${chrome.runtime.getURL('/gif-confirm.html')}?${params.toString()}`;

  return (async () => {
    let windowId: number | undefined;
    try {
      const win = await chrome.windows.create({
        url: popupUrl,
        type: 'popup',
        width: 460,
        height: 260,
        focused: true,
      });
      // No window → no gesture surface possible. Fail closed.
      if (!win?.id) return { approved: false, error: 'could not open confirm window' };
      windowId = win.id;
    } catch (err) {
      console.error('[gif-confirm] failed to open confirm window', err);
      return { approved: false, error: `could not open confirm window: ${String(err)}` };
    }

    // Non-blocking heads-up next to the popup window. Cleared when settled.
    try {
      const host = new URL(target.url).host || target.url;
      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('/icon/128.png'),
        title:
          browser.i18n.getMessage('notifyGifConfirmTitle') ??
          'Tab recording confirmation',
        message:
          browser.i18n.getMessage('notifyGifConfirmMessage', [host]) ??
          `An agent wants to record ${host} — click Allow in the popup window`,
        requireInteraction: true,
      });
    } catch (err) {
      // Notification failure must not block the popup itself.
      console.warn('[gif-confirm] failed to show notification', err);
    }

    return new Promise<GifConfirmDecision>((resolve) => {
      const timer = setTimeout(
        () => settle({ approved: false, error: 'confirmation timed out' }),
        GIF_CONFIRM_TIMEOUT_MS,
      );
      pending.set(id, { resolve: settle, windowId, notificationId });

      function settle(decision: GifConfirmDecision) {
        clearTimeout(timer);
        pending.delete(id);
        chrome.notifications.clear(notificationId).catch(() => {});
        if (windowId !== undefined) {
          chrome.windows.remove(windowId).catch(() => {});
        }
        resolve(decision);
      }
    });
  })();
}

/**
 * Deliver the page's decision. Returns false when the id is unknown (e.g. the
 * SW restarted and lost the pending map) — the page treats that as expired.
 */
export function resolveGifConfirmation(
  id: string,
  approved: boolean,
  streamId?: string,
  error?: string,
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve({ approved, streamId, error });
  return true;
}

/**
 * Whether a pending confirmation exists (the confirm page pings to keep the SW
 * alive and to learn whether its request is still live).
 */
export function isPendingGifConfirmation(id: string): boolean {
  return pending.has(id);
}

/**
 * Register the listeners that let a manually-closed window deny its request.
 * Call once from the background at startup.
 */
export function initGifConfirm(): void {
  chrome.windows.onRemoved.addListener((windowId) => {
    for (const [id, entry] of pending) {
      if (entry.windowId === windowId) {
        // Window closed without a decision → deny (fail-closed).
        pending.delete(id);
        entry.resolve({ approved: false, error: 'confirm window was closed' });
      }
    }
  });

  // Clicking the system notification brings the popup window to the front.
  chrome.notifications.onClicked.addListener((notificationId) => {
    for (const entry of pending.values()) {
      if (entry.notificationId === notificationId) {
        if (entry.windowId !== undefined) {
          chrome.windows.update(entry.windowId, { focused: true }).catch(() => {});
        }
        break;
      }
    }
  });
}
