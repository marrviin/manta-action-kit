import { API_CALL_EVENT, type CapturedCall } from '@/lib/recording/types';
import { sendMessage } from '@/lib/messaging';

/**
 * Content script (ISOLATED world).
 *
 * Responsibilities:
 *  1. Inject the MAIN-world API hook at document_start so it patches fetch/XHR
 *     before the page's own scripts run.
 *  2. Relay captured API calls from the page to the background service worker.
 *
 * There is no in-page UI: recording is driven entirely from the popup / side
 * panel, so page navigations and reloads never interrupt a session.
 * The background decides whether recording is active and whether to keep each
 * call (tab + API-only filtering), so the capture relay stays thin.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main(ctx) {
    const { script } = await injectScript('/injected-api-hook.js', {
      keepInDom: true,
    });

    const onCall = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const call = event.detail as CapturedCall;
      // Fire-and-forget; background ignores it when not recording this tab.
      sendMessage('API_CALL_CAPTURED', call).catch(() => {
        /* background may be asleep or not recording; safe to drop */
      });
    };

    // The hook dispatches on its own <script> element; fall back to window.
    script.addEventListener(API_CALL_EVENT, onCall);
    window.addEventListener(API_CALL_EVENT, onCall);
    ctx.onInvalidated(() => {
      script.removeEventListener(API_CALL_EVENT, onCall);
      window.removeEventListener(API_CALL_EVENT, onCall);
    });
  },
});
