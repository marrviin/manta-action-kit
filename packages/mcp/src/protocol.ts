/**
 * Wire protocol — re-export of the shared package.
 *
 * The wire types, RPC map, frame definitions, and tool registry live in
 * @manta-action-kit/protocol (the single source of truth, shared with the
 * extension). This module re-exports them so the package-internal imports
 * (`./protocol.js`) keep working unchanged.
 */
export * from "@manta-action-kit/protocol";
