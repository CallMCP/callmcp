/**
 * @callmcp/driver-kaicalls — public entry point.
 *
 * Re-exports:
 * - `KaiCallsClient` and its supporting types/errors from `./client.js`.
 * - The x402 self-provisioning helpers from `./provisioning.js`.
 * - `KaiCallsDriver` (the `Driver` implementation) and `KaiCallsDriverError`
 *   from `./driver.js`.
 * - `KAICALLS_MANIFEST` (the static SPEC §6.1 capability manifest) from
 *   `./manifest.js`.
 */

export * from "./client.js";
export * from "./provisioning.js";
export * from "./driver.js";
export * from "./manifest.js";
