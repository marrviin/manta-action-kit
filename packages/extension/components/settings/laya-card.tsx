/**
 * Laya decision-model card for the settings page.
 *
 * Loads the bundled ~800 MB checkpoint into the offscreen runtime (fp16
 * encoder on WebGPU, int8 head on WASM). "Load" here means loading the model
 * files that ship with the extension package into the runtime; no network is
 * involved. Real consumers of the model (e.g. the recording-relevance marks)
 * trigger loads lazily on their first predict — this card is the manual
 * control + status display.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { sendMessage } from '@/lib/messaging';

const { Text } = Typography;

/** Warmup call that forces the lazy model load (the result is discarded). */
const WARMUP = {
  state: 'warmup',
  questions: { ping: { type: 'noul', instructions: 'Is this a warmup call?' } },
} as const;

type LayaStatus = 'idle' | 'loading' | 'ready';

/** True while a load initiated by any hook instance is in flight. */
let loadStarted = false;

/**
 * Model status + load. The card's own state dies with the panel, but the
 * offscreen agent does not (WORKERS-reason offscreen documents have no Chrome
 * lifetime limit) — the mount effect restores the real state: `ready`
 * directly; a load already in flight → poll; gone → load automatically, so
 * opening the panel never requires a click.
 */
function useLayaModel() {
  const [status, setStatus] = useState<LayaStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Load = ensure the offscreen document exists, then run a trivial predict
  // (the runtime loads the model on first call). The prediction result is
  // discarded; only the load outcome matters.
  const load = async (): Promise<boolean> => {
    loadStarted = true;
    setStatus('loading');
    setError(null);
    try {
      await sendMessage('LAYA_ENSURE_RUNTIME', undefined);
      await sendMessage('LAYA_PREDICT', WARMUP);
      setStatus('ready');
      return true;
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : String(err));
      loadStarted = false; // a failed load must be retryable
      return false;
    }
  };
  // A ref keeps the mount effect below dependency-free while always calling
  // the latest closure.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let mode: 'fast' | 'slow' = 'fast';
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    // Fast (1s) while a load converges; slow (5s) once ready, so a runtime
    // that died (offscreen document killed by Chrome, extension reload)
    // flips the card honestly instead of showing a stale 已加载.
    const setMode = (m: 'fast' | 'slow') => {
      if (mode === m && timer) return;
      mode = m;
      stop();
      timer = setInterval(tick, m === 'fast' ? 1000 : 5000);
    };
    // Two consecutive not-ready observations are required before concluding
    // the load died / the runtime vanished: between the offscreen document
    // being created and the model load actually starting there is a short
    // window that reports idle too (the doc may also still be booting its
    // listener). The counter only resets when a probe reports real activity —
    // resetting it on every probe would make two strikes unreachable and
    // strand the card on 加载中 forever once the document died mid-load (its
    // probes then answer {ready:false, loading:false} via the background
    // fallback).
    let idleTicks = 0;
    // Bounded self-heal: when the runtime is concluded gone, restart the load
    // automatically instead of waiting for a click. Bounded so a genuinely
    // broken runtime doesn't retry forever; re-armed after any ready.
    let autoRetries = 0;
    const concludeIdle = () => {
      setStatus('idle');
      loadStarted = false; // retryable
      setMode('slow'); // keep watching in case a lazy load starts
      if (autoRetries < 2) {
        autoRetries += 1;
        void loadRef.current();
      }
    };
    const tick = () => {
      void sendMessage('LAYA_GET_STATUS', {})
        .then((s) => {
          if (s.ready) {
            idleTicks = 0;
            autoRetries = 0;
            setStatus('ready');
            setMode('slow');
            return;
          }
          if (s.loading) {
            // A load in flight (this card's warmup, or a lazy consumer such
            // as the relevance analysis) — track it until it converges.
            idleTicks = 0;
            setStatus('loading');
            setMode('fast');
            return;
          }
          idleTicks += 1;
          if (idleTicks >= 2) concludeIdle();
        })
        .catch(() => {
          // Probe failed (offscreen document gone / SW hiccup): same
          // two-strike rule as above. Two consecutive failures mean the
          // runtime is unreachable — any displayed state (including a
          // `loading` whose document just died) is stale, so fall back to
          // idle; concludeIdle re-triggers the load.
          idleTicks += 1;
          if (idleTicks >= 2) concludeIdle();
        });
    };
    (async () => {
      try {
        const s = await sendMessage('LAYA_GET_STATUS', {});
        if (s.ready) {
          setStatus('ready');
          setMode('slow');
          return;
        }
        setStatus('loading');
        if (!loadStarted) void loadRef.current();
        setMode('fast');
      } catch {
        // Runtime unreachable — leave idle; the load button is the fallback.
        setStatus('idle');
        setMode('slow');
      }
    })();
    return stop;
  }, []);

  return { status, error, load: () => void loadRef.current() };
}

/** The model card: status + load button. */
export function LayaCard() {
  const { t } = useTranslation();
  const { status, error, load } = useLayaModel();

  return (
    <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) overflow-hidden">
      {/* Header: title + status/load button */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Text strong className="text-sm">
              {t('settings.layaTitle')}
            </Text>
            {status === 'ready' && (
              <Tag color="success" className="mr-0 px-1.5! text-xs! leading-4!">
                {t('settings.layaLoaded')}
              </Tag>
            )}
          </div>
          <Text type="secondary" className="text-xs!">
            {t('settings.layaDesc')}
          </Text>
        </div>
        <Button
          size="small"
          loading={status === 'loading'}
          disabled={status === 'ready'}
          onClick={load}
        >
          {status === 'loading' ? t('settings.layaLoading') : t('settings.layaLoad')}
        </Button>
      </div>
      {error && status !== 'ready' && (
        <div className="px-3 pb-2.5">
          <Text type="danger" className="text-xs!">
            {error}
          </Text>
        </div>
      )}
    </section>
  );
}
