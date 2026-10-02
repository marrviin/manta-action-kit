import { expect, test } from "@playwright/test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  FIXTURE_HOST_RESOLVER,
  callTool,
  connectMcpAgent,
  fixtureHostUrl,
  freePort,
  launchExtension,
  openExtensionPage,
  startFixtureServer,
} from "./fixtures";

/**
 * E2E: the Action pipeline — UI-recorded calls → create_action (distill a
 * parameterized flow from the recording) → execute_action (replay through the
 * same cookie-injecting gateway as proxy_fetch). Ground truth is the fixture
 * server's request log: the replayed requests must actually arrive, with the
 * {{param}} templates applied.
 *
 * Uses the `e2e.fixture` host-resolver mapping so the replayed URLs pass the
 * gateway's hostname-based SSRF gate; the host is allowlisted first so the
 * run doesn't block on the confirm popup.
 */

test.describe("Action (record → distill → replay)", () => {
  test("a UI-recorded flow replays with params templated in", async () => {
    test.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const hostUrl = fixtureHostUrl(fixture);
    const wsPort = await freePort();
    const proxyPort = await freePort();
    const { context, extensionId } = await launchExtension([FIXTURE_HOST_RESOLVER]);
    let client: Client | undefined;
    try {
      client = await connectMcpAgent(context, extensionId, { wsPort, proxyPort });

      // Allowlist the fixture host up front — execute_action would otherwise
      // open the confirm popup (once per host per run).
      const setup = await openExtensionPage(context, extensionId, "popup.html");
      await setup.evaluate(async () => {
        await chrome.storage.local.set({ gatewayAllowDomains: ["e2e.fixture"] });
      });
      await setup.close();

      // ---- Record a flow through the real UI on the fixture host.
      const page = await context.newPage();
      await page.goto(`${hostUrl}/`);
      const panel = await openExtensionPage(context, extensionId, "sidepanel.html");
      await page.bringToFront();
      await panel.getByTestId("record-start").click();
      await expect(panel.getByText(/Recording · 0/)).toBeVisible();
      await page.click("#load");
      await expect(panel.getByText(/Recording · 2/)).toBeVisible({
        timeout: 15_000,
      });
      await panel.getByTestId("record-stop").click();
      // (the fixture also sees the page GET / + favicon; count API calls only)
      const apiRequests = () => fixture.requests.filter((r) => r.url.startsWith("/api/"));
      expect(apiRequests()).toHaveLength(2);

      // ---- Distill the recording into an Action via the MCP tools.
      const [recording] = await callTool(client, "list_recordings");
      const detail = await callTool(client, "get_recording", { id: recording.id });
      const calls: Array<Record<string, any>> = detail.calls ?? detail;
      const listCall = calls.find((c) => c.url.endsWith("/api/list"))!;
      const saveCall = calls.find((c) => c.url.endsWith("/api/save"))!;
      expect(listCall.id).toBeTruthy();
      expect(saveCall.id).toBeTruthy();

      const action = await callTool(client, "create_action", {
        name: "e2e-flow",
        description: "Distilled from the e2e fixture recording",
        recordingId: recording.id,
        params: [
          {
            name: "who",
            description: "Value stamped into the replayed calls",
            type: "string",
            required: true,
          },
        ],
        steps: [
          {
            callId: listCall.id,
            kind: "fetch",
            overrides: [{ toLocation: "query", toPath: "tag", value: "{{who}}" }],
          },
          {
            callId: saveCall.id,
            kind: "fetch",
            overrides: [{ toLocation: "body", toPath: "hello", value: "{{who}}" }],
          },
        ],
      });
      expect(action.id).toBeTruthy();

      const actions = await callTool(client, "list_actions");
      expect(actions.map((a: any) => a.id)).toContain(action.id);

      // ---- Replay it end to end through the gateway.
      const run = await callTool(client, "execute_action", {
        id: action.id,
        params: { who: "e2e-replay" },
      });
      expect(run.steps).toHaveLength(2);
      for (const step of run.steps) {
        expect(step.status).toBe(200);
      }

      // Ground truth: the replayed requests hit the fixture with templates
      // resolved — the recorded calls themselves were not re-sent verbatim.
      const replayed = apiRequests().slice(2);
      expect(replayed).toHaveLength(2);
      const [replayedGet, replayedPost] = replayed;
      expect(replayedGet.method).toBe("GET");
      expect(replayedGet.url).toBe("/api/list?tag=e2e-replay");
      expect(replayedPost.method).toBe("POST");
      expect(replayedPost.body).toBe(JSON.stringify({ hello: "e2e-replay" }));
    } finally {
      await client?.close();
      await context.close();
      await fixture.close();
    }
  });
});
