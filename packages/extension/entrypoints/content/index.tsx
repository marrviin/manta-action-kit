import ReactDOM from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { API_CALL_EVENT, type CapturedCall } from '@/lib/recording/types';
import { sendMessage } from '@/lib/messaging';
import { toolbarState } from '@/lib/storage';
import { RecordingToolbar, TOOLBAR_CSS } from './toolbar';

/**
 * Content script (ISOLATED world).
 *
 * Responsibilities:
 *  1. Inject the MAIN-world API hook at document_start so it patches fetch/XHR
 *     before the page's own scripts run.
 *  2. Relay captured API calls from the page to the background service worker.
 *  3. Mount/unmount the in-page recording toolbar (a shadow-root React UI) based on
 *     `toolbarState`, which the popup sets when the user picks "接口录制".
 *
 * The background decides whether recording is active and whether to keep each call
 * (API-only filtering), so the capture relay stays thin.
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

    // ---- In-page toolbar --------------------------------------------------
    // Resolve our own tab id so we only show the toolbar on the targeted tab.
    const { tabId } = await sendMessage('GET_TAB_ID', undefined).catch(() => ({ tabId: null }));
    if (tabId == null) return;

    let root: ReactDOM.Root | null = null;
    const ui = await createShadowRootUi(ctx, {
      name: 'manta-action-kit-toolbar',
      position: 'overlay',
      zIndex: 2147483647,
      css: TOOLBAR_CSS,
      onMount(container) {
        root = ReactDOM.createRoot(container);
        root.render(<RecordingToolbar tabId={tabId} />);
        return root;
      },
      onRemove() {
        root?.unmount();
        root = null;
      },
    });

    const sync = (visibleTabId: number | null) => {
      if (visibleTabId === tabId) ui.mount();
      else ui.remove();
    };

    sync((await toolbarState.getValue()).tabId);
    const unwatch = toolbarState.watch((v) => sync(v?.tabId ?? null));
    ctx.onInvalidated(() => unwatch());
  },
});
