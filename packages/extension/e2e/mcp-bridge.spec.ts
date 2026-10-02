import { expect, test } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  connectMcpAgent,
  freePort,
  launchExtension,
  openExtensionPage,
  callTool,
  startFixtureServer,
} from "./fixtures";

/**
 * E2E: the full agent chain — a REAL MCP server process (packages/mcp dist,
 * stdio) ↔ WebSocket bridge ↔ extension background ↔ IndexedDB. Requires
 * `pnpm build:mcp` (the e2e script chains it) and `pnpm build` for the
 * extension bundle.
 *
 * The extension dials ws://127.0.0.1:<port> on its own (always-on bridge with
 * backoff reconnect): the test seeds `sync:mcpPort` with a free port — the
 * bridge watches that setting and re-dials — and spawns the server with the
 * extension's generated handshake token as MANTA_TOKEN.
 */

test.describe("MCP bridge (real server + WS handshake)", () => {
  test("agent sees a UI-recorded flow end to end", async () => {
    test.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const wsPort = await freePort();
    const proxyPort = await freePort();
    const { context, extensionId } = await launchExtension();
    let client: Client | undefined;
    try {
      client = await connectMcpAgent(context, extensionId, {
        wsPort,
        proxyPort,
      });

      // Tool surface is intact over the real server.
      const toolNames = (await client.listTools()).tools.map((t) => t.name);
      for (const name of [
        "list_recordings",
        "get_recording",
        "get_flow",
        "get_endpoints",
        "health",
      ]) {
        expect(toolNames).toContain(name);
      }

      const health = await callTool(client, "health");
      expect(health).toMatchObject({ wsPort, proxyPort });

      // Record a flow through the real UI, then the agent must see it.
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/`);
      const panel = await openExtensionPage(context, extensionId, "sidepanel.html");
      await page.bringToFront();
      await panel.getByTestId("record-start").click();
      await expect(panel.getByText(/Recording · 0/)).toBeVisible();
      await page.click("#load");
      await expect(panel.getByText(/Recording · 2/)).toBeVisible({
        timeout: 15_000,
      });
      await panel.getByTestId("record-stop").click();
      await expect(panel.getByTestId("record-start")).toBeVisible();

      const recordings = await callTool(client, "list_recordings");
      expect(recordings).toHaveLength(1);
      const [recording] = recordings;
      expect(recording).toMatchObject({
        origin: fixture.baseUrl,
        callCount: 2,
      });

      // Full chain detail: calls in order with method/status.
      const detail = await callTool(client, "get_recording", {
        id: recording.id,
      });
      const calls = detail.calls ?? detail.recording?.calls ?? detail;
      expect(calls.length ?? 2).toBe(2);

      const flow = await callTool(client, "get_flow", { id: recording.id });
      const steps = flow.steps ?? flow.flow?.steps ?? flow;
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBe(2);
    } finally {
      await client?.close();
      await context.close();
      await fixture.close();
    }
  });

  test("a token mismatch stays disconnected (fail closed)", async () => {
    test.setTimeout(120_000);
    const wsPort = await freePort();
    const proxyPort = await freePort();
    const { context, extensionId } = await launchExtension();
    let client: Client | undefined;
    try {
      // The server holds the WRONG token — the handshake must never succeed,
      // so we can't use connectMcpAgent (it would poll for connected forever).
      const popup = await openExtensionPage(context, extensionId, "popup.html");
      await popup.evaluate(async (port) => {
        await chrome.storage.sync.set({ mcpPort: port });
      }, wsPort);
      await popup.close();

      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      const { Client } = await import(
        "@modelcontextprotocol/sdk/client/index.js"
      );
      const { MCP_DIST } = await import("./fixtures");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_DIST],
        env: {
          ...process.env,
          MANTA_WS_PORT: String(wsPort),
          MANTA_PROXY_PORT: String(proxyPort),
          MANTA_TOKEN: "00000000-0000-0000-0000-000000000000",
        } as Record<string, string>,
        stderr: "pipe",
      });
      client = new Client({ name: "manta-e2e", version: "0.0.0" });
      await client.connect(transport);

      const health = await callTool(client, "health");
      expect(health).toMatchObject({ wsPort });

      // Give the bridge's reconnect cycle ample time to "succeed" if the
      // handshake were broken, then assert it never reports connected.
      await new Promise((r) => setTimeout(r, 20_000));
      const after = await callTool(client, "health");
      expect(after.extensionConnected).toBe(false);
    } finally {
      await client?.close();
      await context.close();
    }
  });
});
