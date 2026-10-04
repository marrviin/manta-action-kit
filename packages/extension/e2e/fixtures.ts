import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The production MV3 bundle (run `pnpm build` before the suite). */
export const EXTENSION_PATH = path.resolve(here, "..", ".output", "chrome-mv3");

export const MCP_DIST = path.resolve(here, "../../mcp/dist/index.js");

/**
 * A non-loopback hostname for the fixture server, mapped to 127.0.0.1 in the
 * browser via `--host-resolver-rules`. The gateway's SSRF gate blocks loopback
 * by hostname (`isBlockedHost` is string-based, it never resolves DNS), so
 * tests that exercise the cookie-injecting forward path must call the fixture
 * through this host to get past it — while it still actually lands on our
 * in-process server. No network egress, fully hermetic.
 */
export const FIXTURE_HOST = "e2e.fixture";
export const FIXTURE_HOST_RESOLVER = `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`;

/**
 * Launches a persistent Chrome profile with the extension side-loaded.
 * `channel: 'chromium'` + headless uses the new headless mode, which (unlike
 * the headless shell) supports MV3 extensions and service workers.
 */
export async function launchExtension(extraArgs: string[] = []): Promise<{
  context: BrowserContext;
  extensionId: string;
}> {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...extraArgs,
    ],
  });
  // The MV3 background service worker is the extension's entrypoint — its
  // URL host is the extension id (stable per profile, generated per launch).
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  }
  const extensionId = new URL(sw.url()).host;
  return { context, extensionId };
}

/** Opens an extension page (popup.html / sidepanel.html) as an ordinary tab. */
export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  file: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return page;
}

export interface FixtureRequest {
  method: string;
  url: string;
  body?: string;
  /** Request headers, lowercased keys (e.g. `cookie`, `content-type`). */
  headers: Record<string, string>;
}

export interface FixtureServer {
  /** e.g. http://127.0.0.1:51234 — loopback, so the SSRF gate and the
   * recording API filter both see it like any other site. */
  baseUrl: string;
  requests: FixtureRequest[];
  close: () => Promise<void>;
}

/** The fixture's URL through the host-resolver mapping (see FIXTURE_HOST). */
export function fixtureHostUrl(fixture: FixtureServer): string {
  return `http://${FIXTURE_HOST}:${new URL(fixture.baseUrl).port}`;
}

/**
 * Local origin whose page fires two API calls on load (a GET and a POST) —
 * the minimal real-world surface the recording pipeline must capture through
 * the injected hook → content script → background chain.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8") || undefined;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : (value ?? "");
      }
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        headers,
      });
      if (req.url === "/api/list") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, items: ["a", "b", "c"] }));
      } else if (req.url === "/api/save") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, id: 7 }));
      } else {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html><body>
          <input id="name" />
          <button id="load">load</button>
          <script>
            document.getElementById('load').addEventListener('click', () => {
              fetch('/api/list').then(r => r.json()).catch(() => {});
              fetch('/api/save', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ hello: 'world' }),
              }).catch(() => {});
            });
          </script>
        </body></html>`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Reads the extension's recording stores straight out of IndexedDB — ground
 * truth for what the pipeline persisted, independent of any UI.
 */
export async function readRecordingStores(page: Page): Promise<{
  recordings: Array<Record<string, unknown>>;
  calls: Array<Record<string, unknown>>;
}> {
  const { recordings, calls } = await readIdbStores(page, [
    "recordings",
    "calls",
  ]);
  return { recordings, calls };
}

/** Reads any of the extension's IndexedDB stores (same database). */
export async function readIdbStores(
  page: Page,
  stores: string[],
): Promise<Record<string, Array<Record<string, unknown>>>> {
  return page.evaluate(async (names) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("manta-action-kit");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const read = (store: string) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
        req.onerror = () => reject(req.error);
      });
    const entries = await Promise.all(
      names.map(async (name) => [name, await read(name)] as const),
    );
    db.close();
    return Object.fromEntries(entries);
  }, stores);
}

/** Grabs a free loopback port by briefly binding port 0. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Wires the extension's always-on bridge to a local MCP server process and
 * completes the agent side of the connection:
 * 1. read the handshake token the background generated on startup,
 * 2. seed `sync:mcpPort` (the bridge watches it and re-dials),
 * 3. spawn `packages/mcp/dist/index.js` over stdio with that token,
 * 4. poll `health.extensionConnected` until the WS + challenge-response
 *    handshake lands (bridge backoff is ≤ 15s).
 */
export async function connectMcpAgent(
  context: BrowserContext,
  extensionId: string,
  opts: { wsPort: number; proxyPort: number; token?: string },
): Promise<Client> {
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const token =
    opts.token ??
    (await popup.evaluate(async () => {
      const got = await chrome.storage.local.get("mcpAuthToken");
      return (got as { mcpAuthToken?: string }).mcpAuthToken ?? "";
    }));
  await popup.evaluate(async (port) => {
    await chrome.storage.sync.set({ mcpPort: port });
  }, opts.wsPort);
  await popup.close();

  const client = new Client({ name: "manta-e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP_DIST],
      env: {
        ...process.env,
        MANTA_WS_PORT: String(opts.wsPort),
        MANTA_PROXY_PORT: String(opts.proxyPort),
        MANTA_TOKEN: token,
      } as Record<string, string>,
      stderr: "pipe",
    }),
  );
  await expect
    .poll(() => callToolRaw(client, "health").then((r) => JSON.parse(r.text).extensionConnected), {
      timeout: 40_000,
      intervals: [2_000],
    })
    .toBe(true);
  return client;
}

/** Tool results come back as text content carrying JSON — raw, errors included. */
export async function callToolRaw(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = await client.callTool({ name, arguments: args ?? {} });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("");
  return { isError: res.isError === true, text };
}

/** callTool that parses the JSON payload and throws on isError results. */
export async function callTool(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<any> {
  const raw = await callToolRaw(client, name, args);
  if (raw.isError) throw new Error(raw.text);
  return JSON.parse(raw.text);
}

/**
 * Waits for the gateway's human-in-the-loop confirmation popup (the main gate,
 * a `chrome.windows.create({type:'popup'})` page) and returns its Page.
 */
export async function waitForConfirmWindow(
  context: BrowserContext,
  timeout = 20_000,
): Promise<Page> {
  await expect
    .poll(() => context.pages().some((p) => p.url().includes("confirm.html")), {
      timeout,
      intervals: [200],
    })
    .toBe(true);
  const confirm = context.pages().find((p) => p.url().includes("confirm.html"));
  if (!confirm) throw new Error("confirm window disappeared before it was found");
  return confirm;
}
