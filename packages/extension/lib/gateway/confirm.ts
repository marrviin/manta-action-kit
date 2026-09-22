/**
 * Extension-side human confirmation for sandbox gateway calls.
 *
 * The single human-in-the-loop gate for EVERY call leaving the sandbox (agent
 * proxy_fetch/proxy_sse, action replay steps, and the script-driven proxy path
 * alike). When a call needs confirmation, the background opens a small
 * always-on-top popup window (entrypoints/confirm) showing method + URL + body
 * preview; the user allows or denies. Fail-closed: closing the window or the
 * timeout both count as a deny.
 *
 * Why a popup window: MV3 service workers cannot block on native UI, and the
 * previous gate (the MCP tool's `requiresUserInteraction` native prompt) only
 * existed on the agent path and depended on the MCP client honoring it. This
 * gate lives in the extension, covers the script path too, and works with any
 * MCP client.
 *
 * MV3 gotcha: the SW can idle-terminate after ~30s with no events, which would
 * drop the pending promise and hang the RPC. The confirm page therefore pings
 * every PING_INTERVAL_MS; each inbound message resets the SW idle timer.
 * A backstop timer here denies the call if the page never answers.
 */
import { uuid } from '@/lib/utils';

/** Auto-deny after this long without a user decision (ms). */
export const CONFIRM_TIMEOUT_MS = 120_000;
/** The confirm page pings this often to keep the SW alive (ms). */
export const PING_INTERVAL_MS = 15_000;
/** Max body-preview chars passed through the popup URL (URL length hygiene). */
const BODY_PREVIEW_URL_CAP = 400;

export interface GatewayConfirmInfo {
  method: string;
  url: string;
  /** Truncated request-body preview (already capped upstream); may be null. */
  bodyPreview: string | null;
  /** Which entrypoint produced the call — shown as a source tag in the popup. */
  via: 'agent' | 'rule';
}

const pending = new Map<
  string,
  { resolve: (approved: boolean) => void; windowId?: number; notificationId: string }
>();

/**
 * Open the confirmation popup and resolve once the user decides (true),
 * denies (false), closes the window (false), or the timeout hits (false).
 *
 * Also fires a system notification (macOS Notification Center et al.) so the
 * user notices the request even when the popup window opens behind other
 * windows. Clicking the notification focuses the popup window.
 */
export function requestGatewayConfirmation(info: GatewayConfirmInfo): Promise<boolean> {
  const id = uuid();
  const notificationId = `gateway-confirm-${id}`;
  const params = new URLSearchParams({
    id,
    via: info.via,
    method: info.method,
    url: info.url,
  });
  if (info.bodyPreview) {
    params.set('body', info.bodyPreview.slice(0, BODY_PREVIEW_URL_CAP));
  }
  const popupUrl = `${chrome.runtime.getURL('/confirm.html')}?${params.toString()}`;

  return (async () => {
    let windowId: number | undefined;
    try {
      const win = await chrome.windows.create({
        url: popupUrl,
        type: 'popup',
        width: 480,
        height: 300,
        focused: true,
      });
      if (!win?.id) return false; // unexpected resolve shape — fail closed
      windowId = win.id;
    } catch (err) {
      // No window → no confirmation possible. Fail closed.
      console.error('[gateway-confirm] failed to open confirm window', err);
      return false;
    }

    // Non-blocking heads-up next to the popup window. Cleared when settled.
    try {
      const host = new URL(info.url).host || info.url;
      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('/icon/128.png'),
        title: browser.i18n.getMessage('notifyConfirmTitle') ?? 'Sandbox request confirmation',
        message:
          browser.i18n.getMessage('notifyConfirmMessage', [info.method, host]) ??
          `${info.method} ${host} is waiting for your confirmation`,
        requireInteraction: true,
      });
    } catch (err) {
      // Notification failure must not block the popup itself.
      console.warn('[gateway-confirm] failed to show notification', err);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS);
      pending.set(id, { resolve: settle, windowId, notificationId });

      function settle(approved: boolean) {
        clearTimeout(timer);
        pending.delete(id);
        chrome.notifications.clear(notificationId).catch(() => {});
        if (windowId !== undefined) {
          chrome.windows.remove(windowId).catch(() => {});
        }
        resolve(approved);
      }
    });
  })();
}

/**
 * Deliver the page's decision. Returns false when the id is unknown (e.g. the
 * SW restarted and lost the pending map) — the page treats that as expired.
 */
export function resolveGatewayConfirmation(id: string, approved: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve(approved);
  return true;
}

/**
 * Whether a pending confirmation exists (the confirm page pings to keep the SW
 * alive and to learn whether its request is still live).
 */
export function isPendingConfirmation(id: string): boolean {
  return pending.has(id);
}

/**
 * Resize a pending confirmation's popup window so it hugs its content. The
 * page measures its document and asks for the OUTER height it needs (content
 * height + window chrome); clamped to a sane range before applying.
 */
export function resizeGatewayConfirmation(id: string, height: number): boolean {
  const entry = pending.get(id);
  if (!entry || entry.windowId === undefined) return false;
  const clamped = Math.round(Math.max(200, Math.min(600, height)));
  chrome.windows.update(entry.windowId, { height: clamped }).catch(() => {});
  return true;
}

/**
 * Register the listeners that let a manually-closed window deny its call.
 * Call once from the background at startup.
 */
export function initGatewayConfirm(): void {
  chrome.windows.onRemoved.addListener((windowId) => {
    for (const [id, entry] of pending) {
      if (entry.windowId === windowId) {
        // Window closed without a decision → deny (fail-closed).
        pending.delete(id);
        entry.resolve(false);
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
