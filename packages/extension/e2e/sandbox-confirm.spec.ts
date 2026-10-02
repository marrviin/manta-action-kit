import { expect, test } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  FIXTURE_HOST_RESOLVER,
  callTool,
  callToolRaw,
  connectMcpAgent,
  fixtureHostUrl,
  freePort,
  launchExtension,
  readIdbStores,
  startFixtureServer,
  waitForConfirmWindow,
} from "./fixtures";

/**
 * E2E: the sandbox gateway's gates, driven through the real proxy_fetch tool
 * (MCP server process ↔ WS bridge ↔ extension background ↔ DNR cookie
 * injection ↔ in-process fixture server).
 *
 * The fixture is reached via `--host-resolver-rules=MAP e2e.fixture
 * 127.0.0.1`: the SSRF gate blocks loopback *by hostname* without resolving
 * DNS, so the flow must go through a non-loopback name that still lands on our
 * hermetic in-process server.
 */

test.describe("sandbox gateway (proxy_fetch gates)", () => {
  test("confirm popup allow → forwarded with the user's cookies", async () => {
    test.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const hostUrl = fixtureHostUrl(fixture);
    const wsPort = await freePort();
    const proxyPort = await freePort();
    const { context, extensionId } = await launchExtension([FIXTURE_HOST_RESOLVER]);
    let client: Client | undefined;
    try {
      // A browser cookie for the fixture host — the agent never sees it, but
      // the DNR injection must attach it to the forwarded request.
      await context.addCookies([
        { name: "e2e", value: "secret-cookie", url: `${hostUrl}/` },
      ]);

      client = await connectMcpAgent(context, extensionId, { wsPort, proxyPort });

      // proxy_fetch blocks on the confirm popup; click Allow when it appears.
      const fetchPromise = callToolRaw(client, "proxy_fetch", {
        method: "GET",
        url: `${hostUrl}/api/list`,
      });
      const confirm = await waitForConfirmWindow(context);
      await confirm.getByRole("button", { name: "Allow" }).click();
      const raw = await fetchPromise;
      expect(raw.isError, raw.text).toBe(false);
      const result = JSON.parse(raw.text);
      expect(result.status).toBe(200);
      expect(result.body).toContain('"items"');

      // Ground truth: the fixture saw the injected Cookie header.
      const forwarded = fixture.requests.at(-1);
      expect(forwarded?.method).toBe("GET");
      expect(forwarded?.url).toBe("/api/list");
      expect(forwarded?.headers["cookie"]).toContain("e2e=secret-cookie");

      // Audit log: authSource 'prompt', cookie names only — never values.
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const { gatewayLogs } = await readIdbStores(popup, ["gatewayLogs"]);
      const log = gatewayLogs.find(
        (l) => l.authSource === "prompt" && l.url === `${hostUrl}/api/list`,
      );
      expect(log).toBeTruthy();
      expect((log as any).injectedCookieNames).toEqual(["e2e"]);
      expect(JSON.stringify(log)).not.toContain("secret-cookie");
      await popup.close();
    } finally {
      await client?.close();
      await context.close();
      await fixture.close();
    }
  });

  test("confirm popup deny → refused, nothing forwarded", async () => {
    test.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const hostUrl = fixtureHostUrl(fixture);
    const wsPort = await freePort();
    const proxyPort = await freePort();
    const { context, extensionId } = await launchExtension([FIXTURE_HOST_RESOLVER]);
    let client: Client | undefined;
    try {
      client = await connectMcpAgent(context, extensionId, { wsPort, proxyPort });

      const fetchPromise = callToolRaw(client, "proxy_fetch", {
        method: "GET",
        url: `${hostUrl}/api/list`,
      });
      const confirm = await waitForConfirmWindow(context);
      await confirm.getByRole("button", { name: "Deny" }).click();
      const raw = await fetchPromise;
      expect(raw.isError).toBe(true);
      expect(raw.text).toMatch(/refused|denied/i);

      // Nothing reached the fixture, and the refusal was still audited.
      expect(fixture.requests).toHaveLength(0);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const { gatewayLogs } = await readIdbStores(popup, ["gatewayLogs"]);
      const log = gatewayLogs.find(
        (l) =>
          l.url === `${hostUrl}/api/list` &&
          l.decision === "blocked" &&
          l.status === 0,
      );
      expect(log).toBeTruthy();
      await popup.close();
    } finally {
      await client?.close();
      await context.close();
      await fixture.close();
    }
  });

  test("allowlisted host skips the popup entirely", async () => {
    test.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const hostUrl = fixtureHostUrl(fixture);
    const wsPort = await freePort();
    const proxyPort = await freePort();
    const { context, extensionId } = await launchExtension([FIXTURE_HOST_RESOLVER]);
    let client: Client | undefined;
    try {
      client = await connectMcpAgent(context, extensionId, { wsPort, proxyPort });

      // Allowlist e2e.fixture BEFORE the call — chrome.storage.local, raw key
      // (WXT `local:gatewayAllowDomains` item).
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.evaluate(async () => {
        await chrome.storage.local.set({ gatewayAllowDomains: ["e2e.fixture"] });
      });

      const result = await callTool(client, "proxy_fetch", {
        method: "GET",
        url: `${hostUrl}/api/list`,
      });
      expect(result.status).toBe(200);
      expect(result.body).toContain('"items"');
      expect(result.injectedCookieCount).toBe(0);

      // No confirm window was ever opened, and the log says allowlist.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(
        context.pages().filter((p) => p.url().includes("confirm.html")),
      ).toHaveLength(0);
      const { gatewayLogs } = await readIdbStores(popup, ["gatewayLogs"]);
      const log = gatewayLogs.find(
        (l) => l.authSource === "allowlist" && l.url === `${hostUrl}/api/list`,
      );
      expect(log).toBeTruthy();
      await popup.close();
    } finally {
      await client?.close();
      await context.close();
      await fixture.close();
    }
  });
});
