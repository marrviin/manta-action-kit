/**
 * utils tests: the shared pure helpers (className join, url helpers, display
 * formatters). isCapturableUrl relies on the chrome.runtime stub from
 * test/setup.ts (getURL → chrome-extension://test…).
 */
import { describe, expect, it } from "vitest";

import {
  cn,
  formatDateTimeShort,
  formatGap,
  isCapturableUrl,
  originOf,
  prettyJson,
  schemeOf,
  shortPath,
  uuid,
} from "@/lib/utils";

describe("cn", () => {
  it("joins truthy class names and drops falsy ones", () => {
    // Typed, not literal `false`, so the && operand isn't a compile-time
    // constant (no-constant-binary-expression) — the falsy branch still
    // exercises cn's filtering.
    const maybe: string | false = false;
    expect(cn("a", maybe && "b", "c", undefined, null, 0, "d")).toBe("a c d");
  });

  it("supports conditional object and array forms", () => {
    expect(cn({ active: true, hidden: false }, ["x", ""])).toBe("active x");
  });

  it("returns an empty string for nothing truthy", () => {
    expect(cn(false, undefined)).toBe("");
  });
});

describe("uuid", () => {
  it("returns a UUID-shaped string", () => {
    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 50 }, () => uuid()));
    expect(seen.size).toBe(50);
  });
});

describe("originOf", () => {
  it("extracts the origin from an absolute URL", () => {
    expect(originOf("https://example.com/a/b?c=1")).toBe("https://example.com");
  });

  it("resolves relative URLs against the base", () => {
    expect(originOf("/api/list", "https://example.com/page")).toBe(
      "https://example.com",
    );
  });

  it("returns empty for unparseable input", () => {
    expect(originOf("::not a url::")).toBe("");
  });
});

describe("isCapturableUrl", () => {
  it("allows http/https and file pages", () => {
    expect(isCapturableUrl("https://example.com")).toBe(true);
    expect(isCapturableUrl("http://localhost:3000/x")).toBe(true);
    expect(isCapturableUrl("file:///home/u/page.html")).toBe(true);
  });

  it("allows the extension’s OWN pages but not other extensions’", () => {
    expect(isCapturableUrl("chrome-extension://test/preview.html")).toBe(true);
    expect(isCapturableUrl("chrome-extension://anotherext/popup.html")).toBe(
      false,
    );
  });

  it("rejects browser-internal and missing urls", () => {
    expect(isCapturableUrl("chrome://settings")).toBe(false);
    expect(isCapturableUrl("about:blank")).toBe(false);
    expect(isCapturableUrl(undefined)).toBe(false);
    expect(isCapturableUrl("")).toBe(false);
  });
});

describe("schemeOf", () => {
  it("returns the scheme prefix including //", () => {
    expect(schemeOf("https://example.com/x")).toBe("https://");
    expect(schemeOf("file:///tmp/a")).toBe("file://");
  });

  it("returns empty for unparseable input", () => {
    expect(schemeOf("nope")).toBe("");
  });
});

describe("shortPath", () => {
  it("keeps path + query, drops the origin", () => {
    expect(shortPath("https://example.com/api/users?page=2")).toBe(
      "/api/users?page=2",
    );
  });

  it("falls back to the raw string when it is not a URL", () => {
    expect(shortPath("just text")).toBe("just text");
  });
});

describe("formatDateTimeShort", () => {
  it("formats as MM-DD HH:mm:ss in local time", () => {
    // 2026-01-05 07:08:09 local — built from components so the assertion is
    // timezone-independent.
    const at = new Date(2026, 0, 5, 7, 8, 9).getTime();
    expect(formatDateTimeShort(at)).toBe("01-05 07:08:09");
  });
});

describe("prettyJson", () => {
  it("pretty-prints valid JSON", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("passes through non-JSON text unchanged", () => {
    expect(prettyJson("<html>not json</html>")).toBe("<html>not json</html>");
  });

  it("maps null to the empty string", () => {
    expect(prettyJson(null)).toBe("");
  });
});

describe("formatGap", () => {
  it("renders sub-second gaps as integer ms", () => {
    expect(formatGap(0)).toBe("0ms");
    expect(formatGap(120.6)).toBe("121ms");
    expect(formatGap(999)).toBe("999ms");
  });

  it("renders sub-minute gaps with one decimal", () => {
    expect(formatGap(1000)).toBe("1.0s");
    expect(formatGap(1460)).toBe("1.5s");
    expect(formatGap(59_900)).toBe("59.9s");
  });

  it("renders minute-plus gaps as m s", () => {
    expect(formatGap(60_000)).toBe("1m 0s");
    expect(formatGap(125_000)).toBe("2m 5s");
  });
});
