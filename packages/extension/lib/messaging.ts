/**
 * Typed messaging helpers between extension contexts (popup / side panel /
 * content script <-> background).
 *
 * Keep the ProtocolMap as the single source of truth for message shapes. Extend it
 * as your business logic grows.
 */
import type { CapturedCall, RecordingState } from './recording/types';
import type { GatewayLog, GatewayProxyRule } from './gateway/types';

export interface ProtocolMap {
  PING: {
    request: void;
    response: { type: 'PONG'; at: number };
  };

  /** Popup -> background: begin recording the given (or active) tab. */
  START_RECORDING: {
    request: { tabId: number; origin: string; url: string };
    response: RecordingState;
  };

  /** Popup -> background: stop recording and persist. Returns saved recording id. */
  STOP_RECORDING: {
    request: void;
    response: { recordingId: string | null; state: RecordingState };
  };

  /** Toolbar -> background: pause/resume capture without ending the session. */
  SET_PAUSED: {
    request: { paused: boolean };
    response: RecordingState;
  };

  /** Content script -> background: resolve the caller's own tab id (from sender). */
  GET_TAB_ID: {
    request: void;
    response: { tabId: number | null };
  };

  /** Any context -> background: read current recording state. */
  GET_RECORDING_STATE: {
    request: void;
    response: RecordingState;
  };

  /** Content script -> background: a captured API call from the page. */
  API_CALL_CAPTURED: {
    request: CapturedCall;
    response: { ok: boolean; count: number };
  };

  /** Side panel -> background: read the gateway audit log (newest first). */
  LIST_GATEWAY_LOGS: {
    request: void;
    response: { logs: GatewayLog[] };
  };

  /** Side panel -> background: clear the whole gateway audit log. */
  CLEAR_GATEWAY_LOGS: {
    request: void;
    response: { ok: boolean };
  };

  /** Side panel -> background: list proxy rules (script-driven gateway entry). */
  LIST_GATEWAY_PROXY_RULES: {
    request: void;
    response: { rules: GatewayProxyRule[] };
  };

  /**
   * Side panel -> background: add a proxy rule. The background validates the prefix
   * (leading "/", unique) and target (http(s) absolute URL). Returns `{ __error }`
   * on invalid input.
   */
  ADD_GATEWAY_PROXY_RULE: {
    request: {
      sandboxPrefix: string;
      targetBase: string;
    };
    response: { rule: GatewayProxyRule };
  };

  /** Side panel -> background: patch a proxy rule (e.g. toggle enabled). */
  UPDATE_GATEWAY_PROXY_RULE: {
    request: { id: string; patch: Partial<Omit<GatewayProxyRule, 'id' | 'createdAt'>> };
    response: { rule: GatewayProxyRule };
  };

  /** Side panel -> background: delete a proxy rule. */
  DELETE_GATEWAY_PROXY_RULE: {
    request: { id: string };
    response: { ok: boolean };
  };
}

export type MessageType = keyof ProtocolMap;

/** Discriminated union of all messages — enables `switch (msg.type)` narrowing. */
export type Message = {
  [T in MessageType]: { type: T; data: ProtocolMap[T]['request'] };
}[MessageType];

/** Send a typed message to the background service worker. */
export async function sendMessage<T extends MessageType>(
  type: T,
  data: ProtocolMap[T]['request'],
): Promise<ProtocolMap[T]['response']> {
  return browser.runtime.sendMessage({ type, data });
}
