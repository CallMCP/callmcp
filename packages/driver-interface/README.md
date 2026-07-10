# @callmcp/driver-interface

[![npm version](https://img.shields.io/npm/v/@callmcp/driver-interface)](https://www.npmjs.com/package/@callmcp/driver-interface)

TypeScript contract every CallMCP driver implements. This package is
intentionally small: types, a conformance test harness, and one reference
implementation. It has no server, no MCP transport code, and no
backend-specific HTTP clients — those live in each driver's own package
([`@callmcp/driver-byok`](../driver-byok) — `driver_id: twilio_openai` — [`@callmcp/driver-kaicalls`](../driver-kaicalls), etc) and in the
server core.

The normative reference for everything in this package is
[`SPEC.md`](../../SPEC.md) at the repo root ("CallMCP Core Telephony Tool
Contract", v0.1.0). If this package and `SPEC.md` ever disagree, `SPEC.md`
wins and this package has a bug.

## What's in here

| File | What it's for |
|---|---|
| `src/types.ts` | The `Driver` interface, every tool's params/result types, `CapabilityManifest`, approval types, and the error taxonomy. |
| `src/conformance.ts` | `runConformanceSuite(driver, manifest)` — checks a `Driver` object against its own manifest. |
| `src/mockDriver.ts` | `MockDriver` — a trivial in-memory reference implementation claiming full capability support. |
| `src/index.ts` | Re-exports everything above. |

## Why `Driver` only has 11 methods, not 14

The spec defines 14 tools, but three of them —  `list_drivers`,
`request_call_approval`, and `list_approvals` — are **server-core**
concerns, not per-driver concerns:

- `list_drivers` is answered by the server from the set of registered
  `Driver` instances plus each one's `getManifest()`. No single driver
  describes the whole fleet.
- `request_call_approval` / `list_approvals` implement the human-approval
  state machine (SPEC §3). Approval state is cross-driver — an
  `allowlist_add` approval created while `twilio_openai` was active must
  still gate `kaicalls`'s `make_call` later. A driver must never be in a
  position to decide, on its own, whether a human approved a destination.

So `Driver` has one method per remaining tool: `makeCall`, `endCall`,
`getCallStatus`, `getTranscript`, `getRecording`, `sendSms`,
`searchNumbers`, `buyNumber`, `configureNumber`, `listNumbers`, `listCalls`
— plus `getManifest()` and a readonly `id`.

## Writing a new driver

1. **Read [`SPEC.md` §1](../../SPEC.md#1-tool-schemas)** for the tool you're implementing before you write
   any code. The params/result types in `types.ts` are a direct transcription
   of the JSON Schemas there — if something is unclear, the spec's prose
   (and the degradation appendix, §7) is the tiebreaker, not this package's
   comments.

2. **Implement `Driver`.** Only implement the methods your backend actually,
   genuinely supports:

   ```ts
   import type { Driver, MakeCallParams, MakeCallResult, CapabilityManifest } from "@callmcp/driver-interface";

   export class AcmeDriver implements Driver {
     readonly id = "acme";

     getManifest(): CapabilityManifest {
       return acmeManifest; // see step 3
     }

     async makeCall(params: MakeCallParams): Promise<MakeCallResult> {
       // call Acme's API, map its response into MakeCallResult
     }

     async getCallStatus(/* ... */) { /* ... */ }
     async getTranscript(/* ... */) { /* ... */ }
     async listNumbers(/* ... */) { /* ... */ }
     async listCalls(/* ... */) { /* ... */ }

     // If Acme has no hangup endpoint: simply don't implement `endCall`.
     // Leave it `undefined` — do NOT implement it to throw by default.
     // Per SPEC §0.1.2, absence (the tool missing from `tools/list`) is the
     // preferred degradation signal, not a runtime error.
   }
   ```

3. **Write your `CapabilityManifest`** (`callmcp.manifest.json` per SPEC
   §6.1, or the equivalent TS object if you build it programmatically).
   Every flag you set `true` is a promise: the matching `Driver` method
   exists and works end-to-end. Check [`SPEC.md` §7](../../SPEC.md#7-degradation-appendix) (the degradation
   appendix) for what's realistically achievable on real backends before you
   flip a flag to `true` — several well-known backends genuinely cannot
   support `end_call`, `get_recording`, or `send_sms`, and claiming they can
   is worse than the honest `false`.

4. **Run the conformance suite** against your own driver + manifest before
   opening a PR:

   ```ts
   import { runConformanceSuite } from "@callmcp/driver-interface";

   const result = await runConformanceSuite(new AcmeDriver(), acmeManifest);
   if (!result.passed) {
     console.error(result.failures);
     process.exitCode = 1;
   }
   ```

   This is a fast, local, no-network check. It does **not** replace the full
   SPEC §6.2 conformance suite (live `tools/list`, real sandbox calls,
   `resources/subscribe` streaming, pagination) that the CallMCP repo runs
   before a driver is accepted — it catches the class of bug where your
   manifest and your object's actual methods disagree.

5. **When in doubt, look at `mockDriver.ts`.** It is the worked example: a
   `Driver` that implements every method, however trivially, backed by two
   `Map`s. It is also exactly what the server core's own unit tests import
   as a fixture, so keeping it simple and spec-faithful helps everyone, not
   just new driver authors.

## The golden rule: absence over runtime surprise

SPEC §0.1.2: *"If a driver cannot support a tool at all, the tool MUST NOT
appear in that driver's `tools/list`. A tool that is advertised MUST work."*

Concretely, for this package:

- Capability-gated methods (`endCall`, `getRecording`, `sendSms`,
  `searchNumbers`, `buyNumber`, `configureNumber`) are **optional** on
  `Driver`. If your backend can't do it, don't implement the method —
  leave it `undefined`.
- The one exception `runConformanceSuite` also accepts: implementing the
  method to throw `UnsupportedCapabilityError` (or any thrown value shaped
  like `{ code: "UNSUPPORTED_CAPABILITY", ... }`, SPEC §5.1) when called.
  This exists for drivers whose server-core wiring finds it easier to
  always register a method and gate at call time — but it is
  defense-in-depth, not the primary mechanism, and the server core is still
  responsible for computing `tools/list` from the manifest so clients never
  see the tool in the first place.
- Baseline tools — `makeCall`, `getCallStatus`, `getTranscript` (in its
  non-realtime form), `listNumbers`, `listCalls` — are **required** on
  `Driver`. Every backend that can place a call at all can do these.

## Options passthrough

Every tool's `options` field is `Record<string, Record<string, unknown>>`
(`DriverOptions` in `types.ts`), keyed by `driver_id`. Put driver-specific
extension fields under your own key — `options.acme` — never at the top
level, and never make a client populate `options` to get baseline behavior
(SPEC §1.0). A client that never heard of `acme` should still get correct
default behavior from every universal field.
