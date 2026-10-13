/**
 * Recording session — extension-bound wiring for the state machine in
 * session-core.ts (runs in the background service worker).
 *
 * session-core holds all the logic (queueing, buffer persistence/restore,
 * filtering, IndexedDB save) parameterized by injected dependencies; this module
 * just binds the real ones: WXT storage items, uuid/Date.now, and IndexedDB.
 * Kept separate so the core can be unit-tested without extension APIs.
 */
import {
  interactionBuffer,
  recordingBuffer,
  recordingFilterRules,
  recordingState,
} from '@/lib/storage';
import { saveRecording } from '@/lib/db';
import { collectCookiesForUrl } from '@/lib/gateway/dnr';
import { uuid } from '@/lib/utils';
import { createSession } from './session-core';

const session = createSession({
  state: recordingState,
  buffer: recordingBuffer,
  filterRules: recordingFilterRules,
  interactions: interactionBuffer,
  saveRecording,
  newId: uuid,
  now: Date.now,
  // Cookie-source dependency detection at stop(): map chrome.cookies results to
  // the minimal {name, value} the pure pass needs. Best-effort — the pass
  // tolerates lookup failures per URL.
  cookieLookup: async (url) =>
    (await collectCookiesForUrl(url)).map((c) => ({ name: c.name, value: c.value })),
});

export const getState = session.getState;
export const start = session.start;
export const setPaused = session.setPaused;
export const push = session.push;
export const pushInteraction = session.pushInteraction;
export const stop = session.stop;
