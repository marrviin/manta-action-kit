/**
 * Add / update orchestration for proxy rules, shared by the two callers that
 * mutate them:
 *   - the side-panel message handlers (background.ts), driven by the user, and
 *   - the agent-facing MCP tools (add_proxy_rule / update_proxy_rule), driven by
 *     an agent over the WS bridge.
 *
 * Both go through the same list → validate → build → upsert path so the rules
 * store has a single set of invariants (well-formed prefix/target, unique prefix).
 *
 * SECURITY: the agent path must NEVER be able to flip a rule's `enabled` flag —
 * that's the sole kill switch for the credential-injecting script proxy, and it
 * belongs to the human. `updateProxyRule` therefore takes a patch that structurally
 * cannot carry `enabled`; the caller decides whether to allow it (the UI does, the
 * agent tool does not).
 */
import { listGatewayProxyRules, upsertGatewayProxyRule } from '@/lib/db';
import { normalizePrefix, validateProxyRuleInput } from './proxy-rule';
import { uuid } from '@/lib/utils';
import type { GatewayProxyRule } from './types';

/** Fields an add accepts. `enabled` is decided by the caller, not the input. */
export interface AddProxyRuleInput {
  sandboxPrefix: string;
  targetBase: string;
}

/** Fields an update may patch. `enabled` is intentionally excluded here — the UI
 *  toggles it via a dedicated call; the agent must not touch it at all. */
export interface ProxyRuleContentPatch {
  sandboxPrefix?: string;
  targetBase?: string;
}

/**
 * Create a proxy rule. `enabled` is supplied by the caller (UI: true; agent tool:
 * per product decision). `createdBy` records the author (UI: 'user'; agent tool:
 * 'agent') and, like `enabled`, is decided by the caller — never by the input —
 * so an agent cannot pass itself off as a human-authored rule. Throws with a
 * user-facing message on invalid input.
 */
export async function addProxyRule(
  input: AddProxyRuleInput,
  enabled: boolean,
  createdBy: GatewayProxyRule['createdBy'],
): Promise<GatewayProxyRule> {
  const existing = await listGatewayProxyRules();
  const err = validateProxyRuleInput(input, existing);
  if (err) throw new Error(err);
  const rule: GatewayProxyRule = {
    id: uuid(),
    sandboxPrefix: normalizePrefix(input.sandboxPrefix),
    targetBase: input.targetBase.trim(),
    enabled,
    createdBy,
    createdAt: Date.now(),
  };
  await upsertGatewayProxyRule(rule);
  return rule;
}

/**
 * Patch an existing rule's CONTENT (never its `enabled` flag). Re-validates when
 * the prefix or target changed. Throws if the rule is missing or the patch is
 * invalid. Returns the saved rule.
 */
export async function updateProxyRuleContent(
  id: string,
  patch: ProxyRuleContentPatch,
): Promise<GatewayProxyRule> {
  const rules = await listGatewayProxyRules();
  const existing = rules.find((r) => r.id === id);
  if (!existing) throw new Error('Rule not found');
  // Keep undefined-as-no-change semantics for each patchable content field.
  const next: GatewayProxyRule = {
    ...existing,
    ...(patch.sandboxPrefix !== undefined ? { sandboxPrefix: patch.sandboxPrefix } : {}),
    ...(patch.targetBase !== undefined ? { targetBase: patch.targetBase.trim() } : {}),
    id: existing.id,
  };
  if (patch.sandboxPrefix !== undefined || patch.targetBase !== undefined) {
    const verr = validateProxyRuleInput(next, rules, existing.id);
    if (verr) throw new Error(verr);
    next.sandboxPrefix = normalizePrefix(next.sandboxPrefix);
  }
  await upsertGatewayProxyRule(next);
  return next;
}
