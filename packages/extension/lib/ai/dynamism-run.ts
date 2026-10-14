/**
 * Background-side orchestration for the field-dynamism pass: compute the
 * statistical marks for one recording and persist them. Purely deterministic
 * and fast (no model, no offscreen document) — fired fire-and-forget when a
 * recording is saved.
 */
import { getCalls, getRecording, updateFieldDynamism } from '@/lib/db';
import { computeDynamism } from './field-dynamism';

export async function analyzeRecordingDynamism(recordingId: string): Promise<void> {
  const recording = await getRecording(recordingId);
  if (!recording) return;
  const calls = await getCalls(recordingId);
  if (calls.length === 0) return;
  await updateFieldDynamism(recordingId, computeDynamism(calls));
}
