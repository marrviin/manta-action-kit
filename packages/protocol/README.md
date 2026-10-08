# @manta-action-kit/protocol

Shared wire-protocol and domain types for the Manta Action Kit WebSocket bridge — the single
source of truth for the Chrome extension (WS client) and the MCP server (WS server).

## Install

```bash
npm install @manta-action-kit/protocol
```

## Usage

```ts
import { /* frame + domain types */ } from '@manta-action-kit/protocol';
```

This package is a build artifact of the [manta-action-kit](https://github.com/marrviin/manta-action-kit)
monorepo — you normally don't install it directly; it's a runtime dependency of
[@manta-action-kit/mcp](https://www.npmjs.com/package/@manta-action-kit/mcp). Import it only if
you're implementing your own client or server against the same bridge protocol.

## License

MIT
