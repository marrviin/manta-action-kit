import { useCallback, useEffect, useRef, useState } from 'react';
import { sendMessage } from '@/lib/messaging';
import { toolbarState } from '@/lib/storage';
import { useRecordingState } from '@/hooks/use-recording-state';
import { originOf } from '@/lib/utils';
import i18n from '@/lib/i18n';
import { initLocaleFromStorage } from '@/lib/i18n/sync';

/**
 * In-page recording toolbar (mounted in a shadow root by the content script).
 *
 * Self-contained: no antd / Tailwind so it stays cheap in the content bundle and
 * immune to the host page's styles (shadow root isolates it further). Offers
 * record / pause-resume / stop plus a drag grip to reposition, and a close button
 * that hides the toolbar (stopping any active recording first).
 *
 * All recording actions go through the background via typed messages; live state
 * is read reactively from storage so the toolbar mirrors popup/side-panel changes.
 */
export function RecordingToolbar({ tabId }: { tabId: number }) {
  const state = useRecordingState();
  const mine = state.active && state.tabId === tabId;

  // The toolbar lives in a shadow root with no antd/i18n provider, so drive
  // translations off the shared i18n instance directly. Sync the language from
  // storage and force a rerender whenever it changes so copy updates live.
  const [, forceRerender] = useState(0);
  const t = i18n.t.bind(i18n);
  useEffect(() => {
    const unwatch = initLocaleFromStorage();
    const onChange = () => forceRerender((n) => n + 1);
    i18n.on('languageChanged', onChange);
    return () => {
      unwatch();
      i18n.off('languageChanged', onChange);
    };
  }, []);

  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 24, y: 24 });
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  /** Keep the bar fully on-screen given its current (content-dependent) size. */
  const clamp = useCallback((x: number, y: number) => {
    const el = barRef.current;
    const w = el?.offsetWidth ?? 300;
    const h = el?.offsetHeight ?? 48;
    return {
      x: Math.max(0, Math.min(window.innerWidth - w, x)),
      y: Math.max(0, Math.min(window.innerHeight - h, y)),
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // When the button set changes (record <-> pause/stop), the bar's width changes;
  // re-clamp so a right-anchored bar doesn't spill off-screen.
  useEffect(() => {
    setPos((p) => clamp(p.x, p.y));
  }, [mine, state.paused, clamp]);

  const start = useCallback(async () => {
    await sendMessage('START_RECORDING', {
      tabId,
      origin: originOf(location.href),
      url: location.href,
    });
  }, [tabId]);

  const togglePause = useCallback(async () => {
    await sendMessage('SET_PAUSED', { paused: !state.paused });
  }, [state.paused]);

  const stop = useCallback(async () => {
    await sendMessage('STOP_RECORDING', undefined);
  }, []);

  const close = useCallback(async () => {
    if (mine) await sendMessage('STOP_RECORDING', undefined);
    await toolbarState.setValue({ tabId: null });
  }, [mine]);

  const dotColor = !mine ? '#94a3b8' : state.paused ? '#f59e0b' : '#ef4444';
  const statusText = !mine
    ? t('toolbar.idle')
    : state.paused
      ? t('toolbar.paused', { count: state.count })
      : t('toolbar.recording', { count: state.count });

  return (
    <div
      ref={barRef}
      className="dnd-toolbar"
      style={{ left: pos.x, top: pos.y }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="dnd-grip" onPointerDown={onPointerDown} title={t('toolbar.dragToMove')}>
        <GripIcon />
      </div>

      <span className="dnd-dot" style={{ background: dotColor, animation: mine && !state.paused ? 'dnd-pulse 1.2s ease-in-out infinite' : 'none' }} />
      <span className="dnd-label">{statusText}</span>

      <div className="dnd-sep" />

      {!mine ? (
        <button className="dnd-btn dnd-primary" onClick={start} title={t('toolbar.startRecording')}>
          <RecordIcon />
          <span>{t('toolbar.record')}</span>
        </button>
      ) : (
        <>
          <button
            className="dnd-btn"
            onClick={togglePause}
            title={state.paused ? t('toolbar.resumeRecording') : t('toolbar.pauseRecording')}
          >
            {state.paused ? <RecordIcon /> : <PauseIcon />}
            <span>{state.paused ? t('toolbar.resume') : t('toolbar.pause')}</span>
          </button>
          <button className="dnd-btn dnd-danger" onClick={stop} title={t('toolbar.stopAndSave')}>
            <StopIcon />
            <span>{t('toolbar.stop')}</span>
          </button>
        </>
      )}

      <button className="dnd-close" onClick={close} title={t('toolbar.closeToolbar')}>
        <CloseIcon />
      </button>
    </div>
  );
}

/** Styles for the shadow-root UI. Kept as a string so it lives inside the shadow DOM. */
export const TOOLBAR_CSS = `
:host { all: initial; }
.dnd-toolbar {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 8px;
  width: max-content;
  max-width: none;
  padding: 6px 8px;
  border-radius: 10px;
  background: #1e293b;
  color: #e2e8f0;
  box-shadow: 0 8px 24px rgba(0,0,0,0.28);
  font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  user-select: none;
}
.dnd-grip {
  display: flex;
  align-items: center;
  padding: 4px 2px;
  cursor: grab;
  color: #94a3b8;
}
.dnd-grip:active { cursor: grabbing; }
.dnd-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dnd-label { white-space: nowrap; min-width: 76px; flex: none; }
.dnd-sep { width: 1px; align-self: stretch; margin: 2px 2px; background: rgba(148,163,184,0.3); }
.dnd-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  white-space: nowrap;
  padding: 5px 10px;
  border: none;
  border-radius: 7px;
  background: #334155;
  color: #e2e8f0;
  cursor: pointer;
  font: inherit;
  transition: background 0.15s;
}
.dnd-btn:hover { background: #475569; }
.dnd-primary { background: #4f46e5; }
.dnd-primary:hover { background: #4338ca; }
.dnd-danger { background: #dc2626; }
.dnd-danger:hover { background: #b91c1c; }
.dnd-close {
  display: inline-flex;
  align-items: center;
  padding: 5px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
}
.dnd-close:hover { background: rgba(148,163,184,0.2); color: #e2e8f0; }
@keyframes dnd-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
`;

const ICON = { width: 14, height: 14, fill: 'currentColor' } as const;

function RecordIcon() {
  return (
    <svg viewBox="0 0 16 16" {...ICON}>
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" {...ICON}>
      <rect x="4" y="3" width="3" height="10" rx="1" />
      <rect x="9" y="3" width="3" height="10" rx="1" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" {...ICON}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" {...ICON}>
      <circle cx="5.5" cy="4" r="1.3" />
      <circle cx="10.5" cy="4" r="1.3" />
      <circle cx="5.5" cy="8" r="1.3" />
      <circle cx="10.5" cy="8" r="1.3" />
      <circle cx="5.5" cy="12" r="1.3" />
      <circle cx="10.5" cy="12" r="1.3" />
    </svg>
  );
}
