/**
 * Builds the install instruction the user copies and pastes to THEIR agent. The
 * prompt goes straight to the agent, which installs the server into its own MCP
 * config — so no client detection, no tool descriptions (the agent reads those
 * itself after install). The port is injected from the live setting.
 *
 * The MCP server is published as a public package, so every environment runs it
 * via `npx -y <MCP_PACKAGE>`.
 */

/** Published package name run via `npx -y <pkg>`. */
export const MCP_PACKAGE = 'manta-action-kit-mcp';

export function buildInstallPrompt(port: number, proxyPort: number): string {
  const args = ['-y', MCP_PACKAGE];

  return `Install this MCP service into your MCP config:
- name: manta-action-kit
- command: npx
- args: ${JSON.stringify(args)}
- env: { "MANTA_WS_PORT": "${port}", "MANTA_PROXY_PORT": "${proxyPort}" }`;
}
