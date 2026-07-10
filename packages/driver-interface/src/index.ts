/**
 * @callmcp/driver-interface — public entry point.
 *
 * Re-exports:
 * - Every type/interface from `./types.js` (the `Driver` contract, all
 *   per-tool params/result types, the capability manifest, approval types,
 *   the error taxonomy, and `UnsupportedCapabilityError`).
 * - `runConformanceSuite` and its result types from `./conformance.js`.
 * - `MockDriver` and `MOCK_DRIVER_MANIFEST` from `./mockDriver.js`.
 */

export * from "./types.js";
export * from "./conformance.js";
export * from "./mockDriver.js";
