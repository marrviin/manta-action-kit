/**
 * capture-flow tests: the shared capture pipeline's mode routing — fullPage
 * prefers the scroll-and-stitch path and falls back to CDP when the stitcher
 * declines; visible goes straight to captureVisibleTab. The browser-only
 * collaborators (stitch/capture) are mocked; only the routing logic runs.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/screenshot/stitch", () => ({
  captureFullPageStitched: vi.fn(),
}));

vi.mock("@/lib/screenshot/capture", () => ({
  captureScreenshot: vi.fn(),
  fileHost: vi.fn((url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }),
  timestamp: vi.fn(() => "20260101-000000"),
}));

import {
  captureTabScreenshot,
  shotFilename,
} from "@/lib/screenshot/capture-flow";
import { captureFullPageStitched } from "@/lib/screenshot/stitch";
import { captureScreenshot } from "@/lib/screenshot/capture";

const tab = {
  id: 1,
  url: "https://example.com/page",
} as unknown as chrome.tabs.Tab;

beforeEach(() => {
  vi.clearAllMocks();
  (captureScreenshot as Mock).mockResolvedValue({
    dataUrl: "data:image/jpeg;base64,AAA",
    filename: "screenshot-example.com-x.jpg",
  });
});

describe("captureTabScreenshot", () => {
  it("fullPage prefers the stitched path and marks the shot as stitched", async () => {
    (captureFullPageStitched as Mock).mockResolvedValue({
      dataUrl: "data:image/png;base64,BBB",
      type: "png",
    });

    const shot = await captureTabScreenshot(tab, "fullPage");

    expect(captureFullPageStitched).toHaveBeenCalledWith(tab);
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(shot).toEqual({
      dataUrl: "data:image/png;base64,BBB",
      type: "png",
      stitched: true,
    });
  });

  it("fullPage falls back to the CDP single render when stitching declines", async () => {
    (captureFullPageStitched as Mock).mockResolvedValue(null);

    const shot = await captureTabScreenshot(tab, "fullPage");

    expect(captureScreenshot).toHaveBeenCalledWith(tab, "fullPage");
    expect(shot).toEqual({
      dataUrl: "data:image/jpeg;base64,AAA",
      filename: "screenshot-example.com-x.jpg",
      stitched: false,
    });
  });

  it("visible mode goes straight to captureScreenshot without stitching", async () => {
    const shot = await captureTabScreenshot(tab, "visible");

    expect(captureFullPageStitched).not.toHaveBeenCalled();
    expect(captureScreenshot).toHaveBeenCalledWith(tab, "visible");
    expect(shot.stitched).toBe(false);
  });
});

describe("shotFilename", () => {
  it("builds screenshot-<host>-<timestamp>.png", () => {
    expect(shotFilename("https://example.com/a?b=1")).toBe(
      "screenshot-example.com-20260101-000000.png",
    );
  });

  it("tolerates a missing url (empty host segment)", () => {
    expect(shotFilename("")).toBe("screenshot--20260101-000000.png");
  });
});
