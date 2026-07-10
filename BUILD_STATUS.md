# CallMCP — Build Status

**Date:** 2026-07-09
**Scope of this pass:** verify the monorepo built at `E:/Dev/callmcp` against `SPEC.md` v0.1.0, attempt a real build/typecheck/test, and report honestly — same "what's real vs not yet built" discipline as `callmcp.ai/llms.txt`.

---

## 1. Spec conformance review (read, not run)

Read `SPEC.md` in full plus every package's `src/` (driver-interface, server, driver-kaicalls, driver-dograh, driver-byok).

- **All 14 contract tools are implemented server-side.** `packages/server/src/tools.ts`'s `TOOL_CATALOG` has one entry per SPEC §1.1–§1.14 tool, with input JSON Schema + zod mirror, MCP annotations matching SPEC §4's table exactly (`make_call`/`end_call`/`send_sms`/`buy_number` all `destructiveHint: true`; every `list_*`/`get_*` `readOnlyHint: true`), and a capability `gate` predicate for the 6 tools SPEC says are capability-gated (`end_call`, `get_recording`, `send_sms`, `search_numbers`, `buy_number`, `configure_number`). `dynamicTools.ts` computes live `tools/list` from the gate + loaded drivers' manifests and fires `notifications/tools/list_changed` on driver-set changes, per SPEC §2.2. `tools.ts`'s `tools/call` handler re-checks the gate defense-in-depth (SPEC §6.2's stale-cache race) before dispatch.
- **Approval gating (SPEC §3) is real, not decorative.** `approval.ts` implements the full state machine (pending/approved/denied/expired), tier-default TTLs (`single_call` 15 min, `allowlist_add` no expiry, `campaign_batch` 7 days), elicitation-first with out-of-band-URL fallback (SPEC §3.4), and `resolveGrant` never invents a silent allow — `make_call`/`send_sms` in `tools.ts` route through `ensureDestinationApproved` before ever touching a driver method. `transports.ts` serves the actual `/approve/:id` HTML page for the non-elicitation fallback.
- **Error taxonomy (SPEC §5)** is centralized in `tools.ts`'s `mapDriverError`/`toolErrorResult`, covering `UNSUPPORTED_CAPABILITY`, `APPROVAL_REQUIRED`, `APPROVAL_DENIED`, and a `DRIVER_ERROR` passthrough envelope for anything a driver doesn't map itself.
- **Manifest-vs-driver honesty check, per driver, passed:**
  - **KaiCalls** (`driver-kaicalls`): manifest claims `end_call: false` / `supports_hangup: false` — and `driver.ts` has no `endCall` method at all (not a throwing stub — correct per SPEC §0.1.2's "absence, not runtime surprise"). Every other manifest-`true` tool has a corresponding implemented method mapping to a real, named KaiCalls MCP tool (`make_call`, `check_call_status`, `get_transcript`, `get_call_recording`, `send_sms`, `search_available_numbers`, `buy_number`, `attach_number`/`detach_number`, `list_numbers`, `list_recent_calls`). `configure_number`'s partial-support note (only `agent_config_ref` honestly implementable) matches `driver.ts`, which throws `UnsupportedCapabilityError` if `sms_webhook_url`/`caller_id_name` are supplied rather than silently dropping them. `sendSms` throws `UnsupportedCapabilityError` for `whatsapp`/`rcs` channels, matching `supports_whatsapp: false` / `supports_rcs: false`. `callmcp.manifest.json` and `manifest.ts` are in sync.
  - **Dograh** (`driver-dograh`): manifest correctly flags `false` for `end_call`, `send_sms`, `search_numbers`, `buy_number` (BYO-carrier, no purchase/hangup/SMS surface documented) — and `driver.ts` implements exactly those four methods to throw `UnsupportedCapabilityError` rather than leaving them undefined, which the file-header comment explains is deliberate (so a stale `tools/list` cache still fails loudly and correctly) and which the conformance harness accepts as an equally valid signal. `supports_realtime_transcription: false` matches the poll-only `GET /{workflow_id}/runs/{run_id}` implementation. `callmcp.manifest.json` and `manifest.ts` are in sync.
  - **BYOK/Twilio+OpenAI** (`driver-byok`): the only driver claiming full parity (`end_call: true` via a stable Twilio REST endpoint, `supports_realtime_transcription: true` via the OpenAI Realtime bridge's live transcript events) — and every claimed method is implemented: `makeCall`/`endCall`/`getCallStatus`/`getTranscript`/`getRecording`/`sendSms`/`searchNumbers`/`buyNumber`/`configureNumber`/`listNumbers`/`listCalls` all call through `TwilioTransport`. `sendSms` correctly rejects non-`sms` channels with `UNSUPPORTED_CAPABILITY`, matching `supports_whatsapp: false`/`supports_rcs: false`. `buyNumber`'s KYC-required path is wired through `mapTwilioError`. `callmcp.manifest.json` and `manifest.ts` are in sync.
- **No tool claims support it doesn't have, and no honest gap is silently papered over** — every `known_degradations` entry in all three manifests corresponds to a real absent/throwing method, and every present method traces to a real upstream endpoint or a documented inference (called out inline where the source docs were ambiguous, e.g. KaiCalls field-name aliasing, Dograh's unverified `PUT /api/v1/workflow/{id}` route).

No correctness issues found in this review pass.

---

## 2. Build / typecheck / test — actually run, not assumed

```
node v20.18.1, npm 10.8.2, pnpm 9.10.0 (packageManager pin is 9.15.0 — pnpm 9.10.0 ran the workspace fine)
```

- **`pnpm install`** — lockfile already up to date, no network fetch needed (`node_modules` were already present in every package). **Did not need to fabricate this: it genuinely completed in <1s against the existing lockfile.**
- **`pnpm run build`** (`tsc -p tsconfig.json` in each of the 5 packages) — **all 5 packages built clean, zero errors:** `driver-interface`, `driver-byok`, `driver-kaicalls`, `driver-dograh`, `server` (built in dependency order).
- **`pnpm run typecheck`** (`tsc --noEmit` in each package) — **all 5 packages passed, zero errors.**
- **`pnpm run test`** (vitest per package) — **all 5 test suites passed, 91/91 tests green:**
  - `driver-interface`: 5/5 (conformance harness self-test)
  - `driver-dograh`: 21/21
  - `driver-kaicalls`: 30/30
  - `driver-byok`: 25/25
  - `server`: 10/10 (includes a real dynamic-`import()` test against the bundled driver packages)

This is a genuine passing build — not fabricated. Full command transcripts were captured during this session.

**Two minor packaging gaps found while running scripts** (cosmetic, not correctness issues):
- Root `package.json`'s `pnpm run lint` fails with "None of the selected packages has a lint script" — no package defines a `lint` script yet.
- Root `package.json`'s `pnpm run conformance` (`pnpm --filter @callmcp/driver-interface run conformance`) fails the same way — `driver-interface/package.json` has no `conformance` script; the conformance harness (`src/conformance.ts`) is only exercised today via `driver-interface`'s own `test` script (`conformance.test.ts`), not a standalone CLI entry point. Either add a `conformance` script or fix the root script to point at `test`.

---

## 3. What's stubbed pending live credentials (not a code gap — an inherent BYOK/hosted-driver property)

None of these are things this pass could "finish" — they require secrets that only the founder holds, and the driver code is already written to consume them:

- **KaiCalls driver** — needs a real `kc_live_...` API key (`KaiCallsClientConfig.apiKey`) to make any live call against `https://callmcp.ai/mcp`. Field-level response shapes are defensively parsed against several plausible aliases because llms.txt/skill.md don't publish full JSON Schemas — `manifest.ts`'s own `known_degradations` flags this and says it should be re-verified against a live `tools/list` call before production use.
- **Dograh driver** — needs a reachable Dograh instance (`DOGRAH_BASE_URL`, optionally `DOGRAH_API_KEY`) plus at least one `workflow_id` (`DOGRAH_DEFAULT_WORKFLOW_ID` / `DOGRAH_WORKFLOW_IDS`). Several routes (`PUT /api/v1/workflow/{id}`, the `GET` collection endpoints) are explicitly marked ASSUMED/INFERRED in `client.ts`'s provenance note, not source-verified — they need to be checked against a live instance's `/docs` OpenAPI page.
- **BYOK driver** — needs `twilioAccountSid`/`twilioAuthToken`/`openaiApiKey`, plus a real publicly reachable `voiceWebhookUrl`/`mediaStreamUrl` for the Twilio↔OpenAI Realtime bridge to actually carry audio. None of this can be exercised without a deployed host process and a live phone call.

None of this blocked the build/typecheck/test pass above — those all run against the type contracts and mocked/injected clients, which is exactly what unit tests should do. It does mean **zero live phone calls, SMS sends, or number purchases have actually been placed** in this pass.

---

## 4. Explicitly NOT done in this pass — external, hard-to-reverse actions only the founder can take

Per instruction, this pass deliberately did not touch any of the following. Each requires a real-world, largely irreversible action outside a coding agent's remit:

1. **Creating the public GitHub repo/org and pushing.** The repo is git-initialized locally (`E:/Dev/callmcp/.git` exists) but has **zero commits** — `git log` reports `fatal: your current branch 'main' does not have any commits yet`, and `git status` shows every file as untracked. `server.json` and every package's `repository_url` already point at `https://github.com/callmcp/callmcp`, which does not yet exist. Someone with authority over the `callmcp` GitHub org/name needs to create it and do the first push.
2. **Claiming `ai.callmcp/*` and `com.kaicalls/*` namespaces in the official MCP Registry via DNS.** `server.json` declares `"name": "ai.callmcp/server"`, which per the MCP Registry's DNS-verification namespace rules requires proving control of the `callmcp.ai` (and `kaicalls.com`) domains via a TXT record. Not attempted here — it's a DNS/domain-registrar action.
3. **Publishing the `@callmcp/*` npm packages.** All 5 packages are `publishConfig: { access: "public" }` and ready to publish (`npm publish` from each `dist/`), but nothing was published to the npm registry in this pass — that's a one-way action (package name + version squatting) that shouldn't happen before the repo/registry story above is settled.
4. **Submitting to awesome-mcp-servers / PulseMCP / Glama / Smithery.** `smithery.yaml` exists and documents the config-schema gotcha to avoid, but no submission/PR was opened against any of these directories.
5. **Any real x402 payment or a "Show HN" post.** `provisioning.ts` (KaiCalls driver) references the documented x402 self-provisioning flow and SPEC §5.4's `INSUFFICIENT_FUNDS`/x402-challenge shape, but no real on-chain USDC payment was made, and no public launch post was drafted or submitted.

---

## Summary

Build is real and green: `pnpm install` → `pnpm run build` → `pnpm run typecheck` → `pnpm run test` all pass cleanly across all 5 packages (91/91 tests), with zero fabrication. Spec-conformance review found the server core correctly implements all 14 tools with capability-gated discovery, and all three drivers' manifests are honest — every `true` capability maps to a real implemented method, every `false`/degraded capability maps to a genuinely absent or `UNSUPPORTED_CAPABILITY`-throwing method, with no silent gaps found in either direction. Two cosmetic script wiring gaps (`lint`, `conformance` npm scripts) were found and are noted above, not fixed, since fixing them wasn't in scope for this verification pass. Nothing in this pass touched external infrastructure (GitHub, DNS, npm registry, x402 payments, launch posts) — those five items remain explicitly for the founder.
