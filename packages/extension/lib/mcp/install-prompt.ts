/**
 * Builds the install instruction the user copies and pastes to THEIR agent. The
 * prompt goes straight to the agent, which installs the server into its own MCP
 * config — so no client detection, no tool descriptions (the agent reads those
 * itself after install). The port and the handshake token are injected from the
 * live settings.
 *
 * The MCP server is published as a public package, so every environment runs it
 * via `npx -y <MCP_PACKAGE>`.
 */
import { settings } from '@/lib/storage';

/** Published package name run via `npx -y <pkg>`. */
export const MCP_PACKAGE = '@manta-action-kit/mcp';

/**
 * Return the stored bridge handshake token, generating and persisting one on
 * first use. The token pairs this browser profile with the local MCP process
 * (its MANTA_TOKEN env); both sides prove knowledge of it during the WS
 * handshake without ever sending it (see lib/mcp/auth.ts).
 */
export async function ensureMcpAuthToken(): Promise<string> {
  const existing = await settings.mcpAuthToken.getValue();
  if (existing) return existing;
  const token = crypto.randomUUID();
  await settings.mcpAuthToken.setValue(token);
  return token;
}

export function buildInstallPrompt(
  port: number,
  proxyPort: number,
  token: string,
): string {
  const args = ['-y', MCP_PACKAGE];

  return `Install this MCP service into your MCP config:
- name: manta-action-kit
- command: npx
- args: ${JSON.stringify(args)}
- env: { "MANTA_WS_PORT": "${port}", "MANTA_PROXY_PORT": "${proxyPort}", "MANTA_TOKEN": "${token}" }`;
}
