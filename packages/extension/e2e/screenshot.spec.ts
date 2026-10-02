import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  launchExtension,
  openExtensionPage,
  readIdbStores,
  startFixtureServer,
} from "./fixtures";

/**
 * E2E: the screenshot pipeline driven through the real popup UI — menu row →
 * CAPTURE_SCREENSHOT → background capture (captureVisibleTab / scroll-stitch)
 * → IDB history → preview tab. Runs headless (new headless supports both
 * captureVisibleTab and content-script scrolling). GIF recording stays a
 * manual check: tabCapture has no headless support.
 */

/** Waits for the post-capture preview tab and returns it. */
async function waitForPreview(context: BrowserContext): Promise<Page> {
  await expect
    .poll(
      () =>
        context.pages().some((p) => p.url().includes("preview.html") &&
          p.url().includes("mode=screenshot")),
      { timeout: 20_000, intervals: [300] },
    )
    .toBe(true);
  const preview = context
    .pages()
    .find((p) => p.url().includes("preview.html") && p.url().includes("mode=screenshot"));
  if (!preview) throw new Error("preview page vanished");
  return preview;
}

/** Clicks the popup's screenshot row (mode preselected by the caller). */
async function triggerScreenshot(popup: Page) {
  // Click the row's LABEL, not the li center — the center lands on the
  // Segmented control, which stopPropagation()s (it only switches mode).
  await popup.getByText("Screenshot", { exact: true }).click();
  // The popup closes itself right after dispatching the message.
  await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
}

test.describe("screenshot (popup → background → history → preview)", () => {
  test("visible mode captures the viewport", async () => {
    const fixture = await startFixtureServer();
    const { context, extensionId } = await launchExtension();
    try {
      const popup = await openExtensionPage(context, extensionId, "popup.html");
      const page = await context.newPage();
      await page.goto(fixture.baseUrl);
      await page.bringToFront();
      await triggerScreenshot(popup);

      const preview = await waitForPreview(context);
      const img = preview.locator("img").first();
      await expect(img).toBeVisible({ timeout: 10_000 });
      // Viewport-sized render (default 1280×720, DPR 1): not a full-page tall shot.
      const box = await img.evaluate((el: HTMLImageElement) => ({
        w: el.naturalWidth,
        h: el.naturalHeight,
      }));
      expect(box.w).toBeGreaterThan(500);
      expect(box.h).toBeLessThan(1_500);

      // Ground truth: exactly one history entry with a real payload.
      const reader = await openExtensionPage(context, extensionId, "popup.html");
      const { screenshotHistory } = await readIdbStores(reader, ["screenshotHistory"]);
      expect(screenshotHistory).toHaveLength(1);
      const entry = screenshotHistory[0] as { dataUrl: string; id: string };
      expect(entry.dataUrl).toMatch(/^data:image\/(png|jpeg);base64,/);
      // A blank page still compresses to a few KB — just prove real pixel data.
      expect(entry.dataUrl.length).toBeGreaterThan(1_000);
    } finally {
      await context.close();
      await fixture.close();
    }
  });

  test("fullPage mode stitches beyond the viewport", async () => {
    const fixture = await startFixtureServer();
    const { context, extensionId } = await launchExtension();
    try {
      const popup = await openExtensionPage(context, extensionId, "popup.html");
      // Switch the row's Segmented to "Full page" (persisted mode).
      await popup.getByText("Full page", { exact: true }).click();

      const page = await context.newPage();
      await page.goto(fixture.baseUrl);
      // Make the document 3× the viewport tall so stitch must scroll.
      await page.evaluate(() => {
        const tall = document.createElement("div");
        tall.style.height = "2600px";
        tall.textContent = "tall section";
        document.body.appendChild(tall);
      });
      await page.bringToFront();
      await triggerScreenshot(popup);

      const preview = await waitForPreview(context);
      const img = preview.locator("img").first();
      await expect(img).toBeVisible({ timeout: 15_000 });
      const box = await img.evaluate((el: HTMLImageElement) => ({
        w: el.naturalWidth,
        h: el.naturalHeight,
      }));
      // Stitched output covers the whole document, far beyond one viewport.
      expect(box.h).toBeGreaterThan(1_500);

      const reader = await openExtensionPage(context, extensionId, "popup.html");
      const { screenshotHistory } = await readIdbStores(reader, ["screenshotHistory"]);
      expect(screenshotHistory).toHaveLength(1);
      const entry = screenshotHistory[0] as { dataUrl: string };
      // A blank page still compresses to a few KB — just prove real pixel data.
      expect(entry.dataUrl.length).toBeGreaterThan(1_000);
    } finally {
      await context.close();
      await fixture.close();
    }
  });
});
