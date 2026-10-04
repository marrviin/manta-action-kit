import { expect, test } from "@playwright/test";
import {
  launchExtension,
  openExtensionPage,
  readRecordingStores,
  startFixtureServer,
} from "./fixtures";

/**
 * E2E: the core recording pipeline, exercised through the real UI:
 * start → fixture page fires fetch/XHR → injected hook → content script →
 * background buffer → stop → IndexedDB persistence.
 * Run `pnpm build` first (specs load .output/chrome-mv3).
 *
 * RecordControls.start() resolves the ACTIVE tab and refuses non-http(s)
 * origins, so every test brings the fixture tab to the front before
 * clicking start (CDP clicks work on background tabs).
 */

test.describe("API recording flow", () => {
  test("captures fixture-page API calls end to end (side panel)", async () => {
    test.setTimeout(90_000);
    const fixture = await startFixtureServer();
    const { context, extensionId } = await launchExtension();
    try {
      // The fixture page first (it's the tab whose origin gets recorded).
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/`);
      // The side panel hosts the block-variant controls with the live
      // status readout (pulse dot + captured-call count).
      const panel = await openExtensionPage(context, extensionId, "sidepanel.html");
      await page.bringToFront();

      const start = panel.getByTestId("record-start");
      await expect(start).toBeVisible({ timeout: 20_000 });
      await start.click();
      await expect(panel.getByText(/Recording · 0/)).toBeVisible({
        timeout: 10_000,
      });

      // Trigger GET /api/list + POST /api/save on the recorded page.
      await page.click("#load");

      // The readout mirrors the background session (reactive
      // storage.session watch) — both calls must land there.
      await expect(panel.getByText(/Recording · 2/)).toBeVisible({
        timeout: 15_000,
      });

      // User-interaction capture: type via real (CDP) keyboard events and Tab
      // away, so the browser fires its native change event on blur —
      // programmatic fill() does not. The click on #load above is captured as
      // a click interaction.
      await page.locator("#name").pressSequentially("hello");
      await page.locator("#name").press("Tab");

      // Pause hides the counter behind "Paused"; resume restores it.
      await panel.getByTestId("record-pause").click();
      await expect(panel.getByText(/Paused · 2/)).toBeVisible();
      await panel.getByTestId("record-pause").click();
      await expect(panel.getByText(/Recording · 2/)).toBeVisible();

      // Stop persists the session to IndexedDB and resets the controls.
      await panel.getByTestId("record-stop").click();
      await expect(panel.getByTestId("record-start")).toBeVisible({
        timeout: 15_000,
      });

      // Ground truth: one recording, two calls, correct request/response
      // shapes captured through the injected hook.
      const { recordings, calls } = await readRecordingStores(panel);
      expect(recordings).toHaveLength(1);
      const [recording] = recordings;
      expect(recording.origin).toBe(fixture.baseUrl);
      expect(recording.callCount).toBe(2);

      expect(calls).toHaveLength(2);
      const byUrl = new Map(
        calls.map((c) => [String(c.url).replace(fixture.baseUrl, ""), c]),
      );
      const list = byUrl.get("/api/list");
      expect(list).toMatchObject({ method: "GET", status: 200 });
      expect(list!.resBody).toContain('"items"');
      const save = byUrl.get("/api/save");
      expect(save).toMatchObject({ method: "POST", status: 200 });
      expect(save!.reqBody).toContain("hello");
      // Every call belongs to the saved recording.
      for (const call of calls) {
        expect(call.recordingId).toBe(recording.id);
      }

      // User interactions were captured alongside the calls: the click on
      // #load and the input change, each redacted/capped by the pipeline.
      const interactions = recording.interactions as
        | Array<Record<string, unknown>>
        | undefined;
      expect(Array.isArray(interactions)).toBe(true);
      const click = interactions!.find((i) => i.kind === "click");
      expect(click).toMatchObject({ kind: "click", text: "load" });
      const change = interactions!.find((i) => i.kind === "change");
      expect(change).toMatchObject({ kind: "change", value: "hello" });
      // The click is linked to the call it triggered (nearest within ~2s).
      expect(
        calls.some(
          (c) =>
            (c.precedingInteraction as { text?: string } | undefined)?.text ===
            "load",
        ),
      ).toBe(true);
    } finally {
      await context.close();
      await fixture.close();
    }
  });

  test("start/stop from the popup menu row persists a recording", async () => {
    test.setTimeout(90_000);
    const fixture = await startFixtureServer();
    const { context, extensionId } = await launchExtension();
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/`);
      const popup = await openExtensionPage(context, extensionId, "popup.html");
      await page.bringToFront();

      // The popup row uses the compact menu variant (icon-only buttons).
      await expect(popup.getByTestId("record-start-menu")).toBeVisible({
        timeout: 20_000,
      });
      await popup.getByTestId("record-start-menu").click();
      // Active state swaps in the pause/stop icon buttons.
      await expect(popup.getByTestId("record-stop-menu")).toBeVisible();

      await page.click("#load");

      await popup.getByTestId("record-stop-menu").click();
      // Stopping from the popup reveals the side panel and closes the popup
      // (window.close()) — reopen it for the ground-truth read.
      const popup2 = await openExtensionPage(context, extensionId, "popup.html");
      await expect(popup2.getByTestId("record-start-menu")).toBeVisible({
        timeout: 15_000,
      });

      const { recordings, calls } = await readRecordingStores(popup2);
      expect(recordings).toHaveLength(1);
      expect(recordings[0]!.callCount).toBe(2);
      expect(calls).toHaveLength(2);
    } finally {
      await context.close();
      await fixture.close();
    }
  });

  test("consecutive sessions land as separate recordings", async () => {
    test.setTimeout(90_000);
    const fixture = await startFixtureServer();
    const { context, extensionId } = await launchExtension();
    try {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/`);
      const panel = await openExtensionPage(context, extensionId, "sidepanel.html");
      await page.bringToFront();
      await expect(panel.getByTestId("record-start")).toBeVisible({
        timeout: 20_000,
      });

      // Session 1
      await panel.getByTestId("record-start").click();
      await expect(panel.getByText(/Recording · 0/)).toBeVisible();
      await page.click("#load");
      await expect(panel.getByText(/Recording · 2/)).toBeVisible({
        timeout: 15_000,
      });
      await panel.getByTestId("record-stop").click();
      await expect(panel.getByTestId("record-start")).toBeVisible();

      // Session 2 on the same origin
      await panel.getByTestId("record-start").click();
      await expect(panel.getByText(/Recording · 0/)).toBeVisible();
      await page.click("#load");
      await expect(panel.getByText(/Recording · 2/)).toBeVisible({
        timeout: 15_000,
      });
      await panel.getByTestId("record-stop").click();

      const { recordings, calls } = await readRecordingStores(panel);
      expect(recordings).toHaveLength(2);
      expect(calls).toHaveLength(4);
      const ids = new Set(recordings.map((r) => r.id));
      expect(ids.size).toBe(2);
      for (const call of calls) {
        expect(ids.has(call.recordingId)).toBe(true);
      }
    } finally {
      await context.close();
      await fixture.close();
    }
  });
});
