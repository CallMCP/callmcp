/**
 * CallMCP driver-interface — conformance harness
 *
 * Implements the SPEC §6.2 "For every capability the manifest claims
 * true/false" checks at the `Driver` object level (in-process, no MCP
 * transport involved). This is the fast unit-test-level check a driver
 * author runs locally; the full SPEC §6.2 conformance suite additionally
 * exercises the live MCP `tools/list` surface and real sandbox
 * calls/numbers, which is out of scope for this package.
 *
 * What this module asserts, per SPEC §0.1.2 / §6.2:
 * - For every capability flag the manifest claims `true`, the corresponding
 *   `Driver` method(s) MUST exist and be callable (a function).
 * - For every capability flag the manifest claims `false` (or omits), the
 *   corresponding method MUST be `undefined` (preferred — mirrors the tool's
 *   absence from a live `tools/list`) OR, if present, MUST throw
 *   `UNSUPPORTED_CAPABILITY` (SPEC §5.1) when invoked.
 */

import type { CapabilityFlags, CapabilityManifest, Driver, ToolName } from "./types.js";
import { UnsupportedCapabilityError } from "./types.js";

/** A capability-gate predicate over the manifest's capability flags. */
type GatePredicate = (capabilities: CapabilityFlags) => boolean;

/** Methods on `Driver` that correspond to a spec tool (excludes `id`/`getManifest`). */
type DriverToolMethod = Exclude<keyof Driver, "id" | "getManifest">;

interface ToolGate {
  tool: ToolName;
  method: DriverToolMethod;
  /**
   * `true` means this tool is baseline (every driver implements it,
   * regardless of capability flags — SPEC §1.4/§1.6/§1.7/§1.13/§1.14).
   * A function means the tool is capability-gated; it receives the
   * manifest's `capabilities` object and returns whether support is claimed.
   */
  required: true | GatePredicate;
}

/**
 * Tool → capability gating, mirroring SPEC §1 and the degradation appendix
 * (§7). Tools not gated by any single flag (`make_call`, `get_call_status`,
 * `get_transcript`'s baseline/non-realtime form, `list_numbers`,
 * `list_calls`) are baseline: every `Driver` MUST implement them regardless
 * of capability flags. `search_numbers` is treated as gated by
 * `supports_number_purchase` since a driver with no purchase capability at
 * all (SPEC §7: Synthflow, ElevenLabs, Dograh, Phonely) has nothing
 * purchasable to search for either — the spec does not define a separate
 * "search-only" capability flag.
 */
const TOOL_GATES: readonly ToolGate[] = [
  { tool: "make_call", method: "makeCall", required: true },
  { tool: "get_call_status", method: "getCallStatus", required: true },
  { tool: "get_transcript", method: "getTranscript", required: true },
  { tool: "list_numbers", method: "listNumbers", required: true },
  { tool: "list_calls", method: "listCalls", required: true },
  { tool: "end_call", method: "endCall", required: (c) => c.supports_hangup },
  { tool: "get_recording", method: "getRecording", required: (c) => c.supports_recording },
  {
    tool: "send_sms",
    method: "sendSms",
    required: (c) => Boolean(c.supports_sms || c.supports_whatsapp || c.supports_rcs),
  },
  { tool: "search_numbers", method: "searchNumbers", required: (c) => c.supports_number_purchase },
  { tool: "buy_number", method: "buyNumber", required: (c) => c.supports_number_purchase },
  {
    tool: "configure_number",
    method: "configureNumber",
    required: (c) => c.supports_number_configuration,
  },
];

export interface ConformanceFailure {
  tool: ToolName;
  method: keyof Driver;
  reason: string;
}

export interface ConformanceResult {
  passed: boolean;
  failures: ConformanceFailure[];
  /** number of tool gates evaluated, for a quick sanity check in test output */
  checked: number;
}

/**
 * Runs the SPEC §6.2 capability-vs-method assertions against a `Driver`
 * instance and its `CapabilityManifest`.
 *
 * Does not perform any real network I/O — `Driver` methods that are present
 * but gated `false` are invoked with an empty/minimal payload purely to
 * observe whether they throw `UNSUPPORTED_CAPABILITY`; a well-behaved driver
 * should perform its capability check before touching the network.
 */
export async function runConformanceSuite(
  driver: Driver,
  manifest: CapabilityManifest,
): Promise<ConformanceResult> {
  const failures: ConformanceFailure[] = [];
  const capabilities = manifest.capabilities;

  if (driver.id !== manifest.driver_id) {
    failures.push({
      tool: "list_drivers",
      method: "getManifest",
      reason: `driver.id ("${driver.id}") does not match manifest.driver_id ("${manifest.driver_id}")`,
    });
  }

  for (const gate of TOOL_GATES) {
    const claimsSupport = gate.required === true ? true : gate.required(capabilities);
    const method = driver[gate.method];

    if (claimsSupport) {
      if (typeof method !== "function") {
        failures.push({
          tool: gate.tool,
          method: gate.method,
          reason: `manifest claims support (or ${gate.tool} is a baseline tool) but driver.${gate.method} is not a callable function`,
        });
      }
      continue;
    }

    // Manifest claims this capability is false — absence is the preferred signal.
    if (method === undefined) {
      continue;
    }

    if (typeof method !== "function") {
      failures.push({
        tool: gate.tool,
        method: gate.method,
        reason: `driver.${gate.method} is neither undefined nor a function`,
      });
      continue;
    }

    try {
      await (method as (arg: unknown) => unknown).call(driver, {});
      failures.push({
        tool: gate.tool,
        method: gate.method,
        reason: `capability flag is false but driver.${gate.method} did not throw UNSUPPORTED_CAPABILITY`,
      });
    } catch (err) {
      if (!isUnsupportedCapabilityError(err)) {
        failures.push({
          tool: gate.tool,
          method: gate.method,
          reason: `capability flag is false; driver.${gate.method} threw, but not with code UNSUPPORTED_CAPABILITY (got: ${describeError(err)})`,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures, checked: TOOL_GATES.length };
}

/**
 * Accepts either the concrete `UnsupportedCapabilityError` class or any
 * thrown value structurally shaped like a SPEC §5 error object with
 * `code: "UNSUPPORTED_CAPABILITY"` — drivers are not required to import
 * this package's error class to conform, only to match the wire shape.
 */
function isUnsupportedCapabilityError(err: unknown): boolean {
  if (err instanceof UnsupportedCapabilityError) {
    return true;
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    return (err as { code?: unknown }).code === "UNSUPPORTED_CAPABILITY";
  }
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
