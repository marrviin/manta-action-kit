/**
 * RPC handlers: execute an agent-invoked method against the extension's
 * IndexedDB. Runs in the background service worker. Pure data access — no socket
 * concerns here (see bridge.ts for transport).
 */
import {
  getCalls,
  getRecording,
  listGatewayProxyRules,
  listRecordings,
  updateRecordingDescription,
} from '@/lib/db';
import { runGatewayFetch, runGatewaySse } from '@/lib/gateway/run';
import { resolveProxyRule } from '@/lib/gateway/proxy-rule';
import { addProxyRule, updateProxyRuleContent } from '@/lib/gateway/manage-rules';
import { settings } from '@/lib/storage';
import type { ApiCall } from '@/lib/recording/types';
import { inferDependencies } from '@/lib/recording/infer-deps';
import { aggregateEndpoints, attachDependencies } from '@/lib/recording/aggregate';
import type { GatewayRequest } from '@/lib/gateway/types';
import { isToolEnabled, type RpcMap, type RpcMethod } from './protocol';

/** Dispatch one RPC method to its result. Throws on unknown method / bad params. */
export async function handleRpc<M extends RpcMethod>(
  method: M,
  params: RpcMap[M]['params'],
): Promise<RpcMap[M]['result']> {
  // Single choke point for the per-tool kill switches. A tool is on unless the
  // user explicitly disabled it in the MCP tab (default = all on). `proxy_rule` is
  // NOT an agent-facing tool (it's the internal script-proxy tunnel), so it isn't in
  // the registry and is gated by each proxy rule's own `enabled` flag instead.
  // `set_proxy_port` is likewise internal (server→extension port sync on rebind).
  const INTERNAL_METHODS: RpcMethod[] = ['proxy_rule', 'set_proxy_port'];
  if (!INTERNAL_METHODS.includes(method)) {
    const disabledMap = await settings.mcpToolEnabled.getValue();
    if (!isToolEnabled(disabledMap, method)) {
      throw new Error(`Tool "${method}" has been disabled by the user in the extension`);
    }
  }

  switch (method) {
    case 'list_recordings': {
      const recordings = await listRecordings();
      return { recordings } as RpcMap[M]['result'];
    }

    case 'get_recording': {
      const { id } = params as RpcMap['get_recording']['params'];
      if (!id) throw new Error('get_recording: missing "id"');
      const recording = (await getRecording(id)) ?? null;
      const calls = recording ? await getCalls(id) : [];
      // When the recording exists but has no description, nudge the agent to author
      // one (there is no server-side text generation — the agent supplies the
      // semantics via set_recording_description). Omitted once a description exists.
      const descriptionHint =
        recording && !recording.description
          ? 'This recording has no description yet. If it would help downstream steps, use get_flow/get_endpoints to understand the flow, then call set_recording_description with a business-level summary: what task this whole flow accomplishes, what you can do with it, how the steps chain, and caveats for reuse. Do NOT restate per-endpoint field/schema contracts — that already lives in get_endpoints/get_flow.'
          : undefined;
      return { recording, calls, descriptionHint } as RpcMap[M]['result'];
    }

    case 'set_recording_description': {
      const { id, description } = params as RpcMap['set_recording_description']['params'];
      if (!id) throw new Error('set_recording_description: missing "id"');
      if (typeof description !== 'string' || !description.trim()) {
        throw new Error('set_recording_description: "description" must be a non-empty string');
      }
      const existing = await getRecording(id);
      if (!existing) throw new Error(`set_recording_description: no recording with id "${id}"`);
      // Dedicated write path: only touches description/descriptionUpdatedAt, so the
      // agent can never mutate other recording fields.
      await updateRecordingDescription(id, description);
      const recording = (await getRecording(id)) ?? null;
      return { recording } as RpcMap[M]['result'];
    }

    case 'get_call': {
      const { callId } = params as RpcMap['get_call']['params'];
      if (!callId) throw new Error('get_call: missing "callId"');
      const call = await findCall(callId);
      return { call } as RpcMap[M]['result'];
    }

    case 'get_flow': {
      const { id } = params as RpcMap['get_flow']['params'];
      if (!id) throw new Error('get_flow: missing "id"');
      const recording = await getRecording(id);
      if (!recording) return { flow: null } as RpcMap[M]['result'];
      const calls = await getCalls(id);
      // Prefer stored deps; fall back to on-the-fly inference for recordings
      // captured before the flow feature (deps === undefined).
      const deps = recording.deps ?? inferDependencies(calls);
      const flow = {
        recordingId: recording.id,
        name: recording.name,
        steps: [...calls]
          .sort((a, b) => a.seq - b.seq)
          .map((c) => ({ seq: c.seq, method: c.method, url: c.url, status: c.status })),
        deps,
      };
      return { flow } as RpcMap[M]['result'];
    }

    case 'get_endpoints': {
      const { id } = params as RpcMap['get_endpoints']['params'];
      if (!id) throw new Error('get_endpoints: missing "id"');
      const recording = await getRecording(id);
      if (!recording) return { endpoints: [] } as RpcMap[M]['result'];
      const calls = await getCalls(id);
      // Attach the flow's field dependencies re-keyed onto endpoints (inputsFrom), so
      // the agent gets shape + value provenance in one read. Same dep source as
      // get_flow: prefer stored deps, fall back to on-the-fly inference for pre-flow
      // recordings (deps === undefined).
      const deps = recording.deps ?? inferDependencies(calls);
      const endpoints = attachDependencies(aggregateEndpoints(calls), calls, deps);
      return { endpoints } as RpcMap[M]['result'];
    }

    case 'proxy_fetch': {
      const { req } = params as RpcMap['proxy_fetch']['params'];
      if (!req?.url) throw new Error('proxy_fetch: missing "url"');
      if (!req?.method) throw new Error('proxy_fetch: missing "method"');
      const res = await runGatewayFetch(req);
      return res as RpcMap[M]['result'];
    }

    case 'proxy_sse': {
      const { req } = params as RpcMap['proxy_sse']['params'];
      if (!req?.url) throw new Error('proxy_sse: missing "url"');
      if (!req?.method) throw new Error('proxy_sse: missing "method"');
      const res = await runGatewaySse(req);
      return res as RpcMap[M]['result'];
    }

    case 'proxy_rule': {
      const { req } = params as RpcMap['proxy_rule']['params'];
      if (!req?.rawPath) throw new Error('proxy_rule: missing "rawPath"');
      if (!req?.method) throw new Error('proxy_rule: missing "method"');
      const rules = await listGatewayProxyRules();
      const resolved = resolveProxyRule(rules, req.method, req.rawPath);
      if (!resolved.ok) {
        // No forward: return an unmatched result the proxy turns into an HTTP status.
        return {
          matched: false,
          error: resolved.error,
          status: resolved.status,
          statusText: '',
          headers: {},
          body: null,
          truncated: false,
        } as RpcMap[M]['result'];
      }
      const res = await runGatewayFetch(
        {
          method: req.method as GatewayRequest['method'],
          url: resolved.url,
          headers: req.headers,
          body: req.body,
        },
        { via: 'rule' },
      );
      return { ...res, matched: true } as RpcMap[M]['result'];
    }

    case 'list_proxy_rules': {
      const rules = await listGatewayProxyRules();
      return { rules } as RpcMap[M]['result'];
    }

    case 'add_proxy_rule': {
      const input = params as RpcMap['add_proxy_rule']['params'];
      if (!input?.sandboxPrefix) throw new Error('add_proxy_rule: missing "sandboxPrefix"');
      if (!input?.targetBase) throw new Error('add_proxy_rule: missing "targetBase"');
      // Enabled immediately, because reaching here means the user approved the native
      // confirmation prompt (add_proxy_rule carries requiresUserInteraction, like
      // proxy_fetch) — that approval IS what enables the rule. The agent still can
      // never set/flip `enabled` itself: the input shape omits it.
      const rule = await addProxyRule(input, true, 'agent');
      return { rule } as RpcMap[M]['result'];
    }

    case 'update_proxy_rule': {
      const { id, patch } = params as RpcMap['update_proxy_rule']['params'];
      if (!id) throw new Error('update_proxy_rule: missing "id"');
      // updateProxyRuleContent only accepts content fields — there is no way for the
      // agent to reach the `enabled` kill switch through here.
      const rule = await updateProxyRuleContent(id, patch ?? {});
      return { rule } as RpcMap[M]['result'];
    }

    case 'set_proxy_port': {
      const { proxyPort } = params as RpcMap['set_proxy_port']['params'];
      if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        throw new Error('set_proxy_port: "proxyPort" must be an integer 1-65535');
      }
      // Persist so proxy-rule scripts' baseURL (http://127.0.0.1:<proxyPort>) tracks
      // the MCP server's rebound HTTP proxy. Settings watchers pick this up live.
      await settings.proxyPort.setValue(proxyPort);
      return { proxyPort } as RpcMap[M]['result'];
    }

    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

/**
 * Look up a single call by its id. The `calls` store is keyed by id but the db
 * helpers only expose per-recording reads, so scan recordings until found. Fine
 * for local recording volumes; revisit with a direct get if this grows.
 */
async function findCall(callId: string): Promise<ApiCall | null> {
  const recordings = await listRecordings();
  for (const rec of recordings) {
    const calls = await getCalls(rec.id);
    const hit = calls.find((c) => c.id === callId);
    if (hit) return hit;
  }
  return null;
}
