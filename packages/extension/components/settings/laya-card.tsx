/**
 * Laya decision-model card for the settings page (demo scope for now).
 *
 * Two parts:
 *  1. Model card — loads the bundled ~1.6 GB laya checkpoint into the offscreen
 *     runtime (WebGPU with WASM fallback). "Download" here means loading the
 *     model files that ship with the extension package into the runtime; no
 *     network is involved. Unload drops the session to free the memory.
 *  2. Try-it — a free-text state fed through the official triage questions
 *     (intent / urgency / frustration / refund / churn), answers rendered with
 *     their calibrated probabilities. Everything runs on-device.
 */
import { useState } from 'react';
import { Button, Input, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { sendMessage } from '@/lib/messaging';
import { triageQuestions } from '@/lib/ai/presets';
import type {
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
} from '@/lib/ai/agent';

const { Text } = Typography;

/** One answer row as returned by the offscreen runtime (JSON over messaging). */
export type LayaAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export function LayaCard() {
  const { t } = useTranslation();
  // Model status: idle → loading (first load takes tens of seconds: ~1.6 GB
  // from the package into a WebGPU session) → ready.
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [answers, setAnswers] = useState<Record<string, LayaAnswer> | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load = ensure the offscreen document exists, then run a trivial predict
  // (the runtime loads the model on first call). The prediction result is
  // discarded; only the load outcome matters.
  const onLoad = async () => {
    setStatus('loading');
    setError(null);
    try {
      await sendMessage('LAYA_ENSURE_RUNTIME', undefined);
      await sendMessage('LAYA_PREDICT', {
        state: 'warmup',
        questions: {
          ping: { type: 'noul', instructions: 'Is this a warmup call?' },
        },
      });
      setStatus('ready');
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRun = async () => {
    if (!text.trim() || status !== 'ready') return;
    setRunning(true);
    setError(null);
    setAnswers(null);
    try {
      const res = await sendMessage('LAYA_PREDICT', {
        state: { body: text.trim() },
        questions: triageQuestions(),
      });
      if (!res.ok) throw new Error('laya: predict failed');
      setAnswers(res.answers as Record<string, LayaAnswer>);
      setElapsedMs(res.elapsedMs ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

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
          onClick={() => void onLoad()}
        >
          {status === 'loading' ? t('settings.layaLoading') : t('settings.layaLoad')}
        </Button>
      </div>

      {/* Try-it: input + run (only meaningful once the model is loaded) */}
      {status === 'ready' && (
        <div className="px-3 py-2.5 border-t border-(--ant-color-border-secondary) flex flex-col gap-2">
          <Text type="secondary" className="text-xs!">
            {t('settings.layaTryItDesc')}
          </Text>
          <div className="flex gap-2">
            <Input.TextArea
              rows={2}
              value={text}
              placeholder={t('settings.layaPlaceholder')}
              onChange={(e) => setText(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void onRun();
                }
              }}
            />
            <Button
              type="primary"
              loading={running}
              disabled={!text.trim()}
              onClick={() => void onRun()}
            >
              {running ? t('settings.layaRunning') : t('settings.layaRun')}
            </Button>
          </div>

          {error && (
            <Text type="danger" className="text-xs!">
              {error}
            </Text>
          )}

          {answers && (
            <div className="flex flex-col gap-1.5" data-testid="laya-answers">
              {Object.entries(answers).map(([qid, a]) => (
                <AnswerRow key={qid} qid={qid} answer={a} />
              ))}
              {elapsedMs !== null && (
                <Text type="secondary" className="text-xs!">
                  {elapsedMs} ms · on-device
                </Text>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Human labels for the triage question ids (matches lib/ai/presets.ts). */
const TRIAGE_LABELS: Record<string, string> = {
  intent: 'Intent',
  is_urgent: 'Urgent',
  frustration: 'Frustration',
  refund_requested: 'Refund asked',
  churn_risk: 'Churn risk',
};

/** One question → answer line: label, value, calibrated confidence. */
function AnswerRow({ qid, answer }: { qid: string; answer: LayaAnswer }) {
  const label = TRIAGE_LABELS[qid] ?? qid;
  return (
    <div className="flex items-center gap-2 text-xs">
      <Text type="secondary" className="w-24 shrink-0">
        {label}
      </Text>
      <Text strong className="shrink-0">
        {answer.type === 'choice'
          ? answer.choice
          : answer.type === 'score'
            ? `${answer.score} · ${answer.legend[String(answer.score)] ?? ''}`
            : `${answer.noul >= 0.5 ? 'yes' : 'no'} ${(answer.noul * 100).toFixed(0)}%`}
      </Text>
      <Text type="secondary" className="ml-auto shrink-0">
        conf {(answer.confidence * 100).toFixed(0)}%
      </Text>
    </div>
  );
}
