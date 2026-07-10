# @callmcp/driver-kaicalls

CallMCP's hosted driver for [KaiCalls](https://www.kaicalls.com) — the
production 38-tool MCP/REST telephony backend that
[callmcp.ai](https://callmcp.ai) documents publicly. This is the flagship,
fullest-parity `Driver` implementation in the CallMCP monorepo: it wraps
KaiCalls' real, live tool inventory, not a mock or a partial integration.

Normative references, read in full while building this package:

- [`SPEC.md`](../../SPEC.md) at the repo root — the `Driver` contract every
  method here implements.
- [`https://callmcp.ai/llms.txt`](https://callmcp.ai/llms.txt) — the live
  endpoint, auth model, scopes, and 38-tool inventory this driver targets.
- [`https://callmcp.ai/skill.md`](https://callmcp.ai/skill.md) — the
  agent-facing onboarding doc, including the x402 self-provisioning flow.

## What's in here

| File | What it's for |
|---|---|
| `src/client.ts` | Thin fetch-based wrapper around KaiCalls' MCP JSON-RPC `tools/call` endpoint and its `/api/v1/signup` REST endpoint. |
| `src/provisioning.ts` | The x402 self-provisioning helper — prepares/parses the 402 challenge and completes the paid retry. **Does not execute payments itself** — see the module doc comment. |
| `src/driver.ts` | `KaiCallsDriver` — the `Driver` implementation. Maps every method to a real, documented KaiCalls MCP tool. |
| `src/manifest.ts` | `KAICALLS_MANIFEST` — the static SPEC §6.1 capability manifest, with a comment on every flag explaining what source-doc evidence backs it. |
| `callmcp.manifest.json` | Static JSON mirror of `KAICALLS_MANIFEST`, per SPEC §6.1. |
| `test/driver.test.ts` | Tests against a mocked HTTP layer — no real network calls, no real spend. |

## Honesty notes

This driver is built to be precise about what KaiCalls actually documents
as live, not what would be convenient to claim:

- **No `end_call`.** KaiCalls' documented tool inventory has no
  hangup/terminate-call tool. `KaiCallsDriver.endCall` is not implemented
  (left `undefined`), per SPEC §0.1.2's "absence, not runtime surprise" rule.
- **`send_sms` is SMS-only.** No WhatsApp or RCS channel is documented.
- **No realtime transcript streaming.** `get_transcript` is documented as a
  poll/finalize-after-call model, not a live `resources/subscribe` stream.
- **No elicitation-based approval.** llms.txt's own "What's real vs not yet
  built" section states there is no server-side approval gate today.
- **`configure_number` is partial.** Only the `agent_config_ref` field maps
  to a real tool (`attach_number`/`detach_number`); `sms_webhook_url` and
  `caller_id_name` throw `UnsupportedCapabilityError`.
- **Field-level response shapes are best-effort.** llms.txt/skill.md
  confirm tool names, scopes, and categories, not full JSON Schemas —
  `driver.ts` parses responses defensively over several plausible key
  aliases and documents every non-obvious inference inline.

See `src/manifest.ts`'s `known_degradations` array for the complete,
structured list.

## Usage

```ts
import { KaiCallsDriver } from "@callmcp/driver-kaicalls";

const driver = new KaiCallsDriver({ apiKey: process.env.KAICALLS_API_KEY });

const call = await driver.makeCall({ to: "+14155551234", approval_id: "a_...allowlisted" });
const status = await driver.getCallStatus({ call_id: call.call_id });
```

No API key yet? Provision one via the documented x402 flow:

```ts
import { KaiCallsClient, provisionKaiCallsAccount } from "@callmcp/driver-kaicalls";

const client = new KaiCallsClient(); // no apiKey needed for signup itself
const result = await provisionKaiCallsAccount(client, {
  business_name: "Acme Agent Co",
  email: "ops@acme.example",
});

if (result.status === "provisioned") {
  const driver = new KaiCallsDriver({ apiKey: result.api_key });
} else if (result.status === "payment_required") {
  // Hand `result.challenge` to your own wallet/payment integration, or
  // call `retryWithPayment(client, request, proof, result.challengeToken)`
  // once you have a payment proof. This package does not execute payments.
} else {
  // result.status === "deferred_to_human"
  console.log("Have a human complete checkout:", result.checkout_url);
}
```
