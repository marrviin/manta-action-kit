// Exports the tool contract (name, description, inputSchema, _meta) of every
// tool the Node MCP server registers — via the REAL registration path
// (dist/index.js), through an in-memory MCP client, so nothing is duplicated
// or hand-maintained.
//
// The fixture is the sync anchor for the Python port:
// packages/mcp-py/tests/test_tool_contract.py compares its own tool surface
// against this file. When a Node-side tool changes, regenerate:
//
//   pnpm --filter @manta-action-kit/mcp contract:export
//
// Output goes to stdout; the package script redirects it into the Python
// tests' fixtures directory.
//
// Requires dist/ to be built first (pnpm --filter @manta-action-kit/mcp build).
process.env.MCP_NO_AUTORUN = "1";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { _test } = await import("../dist/index.js");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "tool-contract-export", version: "0.0.0" });
await Promise.all([_test.server.connect(serverTransport), client.connect(clientTransport)]);

const { tools } = await client.listTools();
process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
process.exit(0);
