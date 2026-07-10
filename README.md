# One MCP server. Any call provider. Fully local, fully hosted, or bring your own frontier model.

[![License: MIT](https://img.shields.io/github/license/CallMCP/callmcp)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/CallMCP/callmcp?style=flat&logo=github)](https://github.com/CallMCP/callmcp/stargazers)

CallMCP is a single [Model Context Protocol](https://modelcontextprotocol.io) server that defines **one** tool contract — 14 tools, identical schemas, identical error shapes — for outbound/inbound telephony: calls, SMS, recordings, transcripts, and phone-number lifecycle. Point it at a hosted backend, a fully local backend, or a bring-your-own-key composed backend, and your agent code doesn't change. What changes is *which* tools are present (via capability-gated dynamic discovery), never the shape of a tool that's there.

The normative reference is [`SPEC.md`](./SPEC.md). This README is the pitch; the spec is the contract.

```
npx -y @callmcp/server
```

Before connecting a real provider, run `npx -y @callmcp/server doctor`.
For a safe local walkthrough, run `npx -y @callmcp/server --sandbox`.
The server fails closed when no driver is configured; the mock driver is only
available through explicit sandbox configuration.

See [`examples/`](./examples) for ready-to-paste Claude Desktop / Claude Code configs for each of the three legs below.

---

## Three structural claims

This isn't "a Twilio wrapper with a marketing page." Three things are actually built into the contract, not bolted on:

### 1. Provider-neutral, multi-backend contract
Every driver — hosted, local, or BYOK — implements the same 14 tools defined in [`SPEC.md`](./SPEC.md). Driver-specific behavior lives exclusively inside a namespaced `options.<driver_id>` passthrough object. There is no `make_call_twilio` or `make_call_kaicalls`. A tool either exists for your configured driver (and works, fully, per spec) or it's absent from `tools/list` — never present-but-broken. Swapping your call backend is a config change, not a rewrite.

### 2. x402-funded autonomous provisioning to production
`search_numbers`, `buy_number`, `configure_number`, and `list_numbers` are **never** human-approval-gated — they don't contact a third party, they contact your own provider account. That includes settling cost via [x402](https://www.x402.org/) machine payments when a driver requires prepayment (`INSUFFICIENT_FUNDS` embeds a full x402 challenge an agent can settle and retry). An agent can search for a number, pay for it, configure it, and go live — autonomously, in production, with real money — without a human clicking anything. This is a deliberate contrast with vendor MCPs whose autonomous/self-serve paths are trial- or sandbox-scoped only.

### 3. Human-in-the-loop outbound approval as designed consent architecture
`make_call` and `send_sms` — anything that contacts a phone number that isn't the calling agent's own infrastructure — structurally require a valid `approval_id` or a standing allowlist match before they act. This isn't a policy suggestion layered on top; it's enforced in the server core, so no driver implementation can bypass it. Primary path is MCP elicitation; the fallback for non-elicitation clients is a single-use out-of-band approval URL — the gate is designed to never silently block forever *and* never silently open. Read as a TCPA-consent posture: the contract makes "who approved contacting this number, and when" a first-class, auditable object (`request_call_approval` / `list_approvals`), not an assumption baked into application code you have to get right yourself.

---

## CallMCP vs. single-vendor MCPs vs. DIY

| Capability | **CallMCP** | Vapi MCP | Telnyx MCP | AgentPhone MCP | DIY (Twilio + your own glue) |
|---|---|---|---|---|---|
| Tool contract | One schema, 14 tools, portable across backends | Single-vendor, Vapi only | Single-vendor, Telnyx only | Single-vendor, AgentPhone only | No contract — you write and maintain it |
| Swap call backend without rewriting agent code | Yes — driver swap only | No | No | No | No |
| Self-hostable / fully local option | Yes (Dograh driver) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | Yes, but you own the entire stack |
| Bring your own frontier model as the call's "brain" | Yes (BYOK driver: any transport + any LLM) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | Yes, fully manual integration |
| Autonomous, **funded**, production-scoped number provisioning (x402) | Yes — `search_numbers`/`buy_number`/`configure_number` ungated, x402-payable | (unverified, recheck before publishing) | Public self-serve docs read as trial-scoped autonomy, not funded production autonomy (unverified, recheck before publishing) | (unverified, recheck before publishing) | No — manual console purchase, manual compliance |
| Outbound approval / consent gate structural in the schema | Yes — `make_call`/`send_sms` require `approval_id` or allowlist match, enforced server-side | (unverified, recheck before publishing) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | No — you build and maintain your own gate |
| Standalone SMS (not agent-mediated only) | Capability-gated per driver, honestly reported — never claimed where it's actually agent-mediated | (unverified, recheck before publishing) | Yes, native | (unverified, recheck before publishing) | Yes, native Twilio API |
| Call recording | Capability-gated per driver, honestly reported | (unverified, recheck before publishing) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | Yes, native Twilio API |
| Real-time transcript streaming | Capability-gated per driver, subscribable resource when supported | (unverified, recheck before publishing) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | DIY — you build the capture/assembly layer |
| Source availability | MIT-licensed server + Apache-2.0 spec, public monorepo | (unverified, recheck before publishing) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | N/A — it's your own code |
| Markup over underlying carrier cost | Zero in the OSS server — it routes at cost; KaiCalls hosted tier is an optional convenience layer, not a requirement | (unverified, recheck before publishing) | (unverified, recheck before publishing) | (unverified, recheck before publishing) | Zero markup, 100% of integration cost is yours |

Every "(unverified, recheck before publishing)" cell is a placeholder, not a claim — we do not put a number or a fact about a competitor's product in this table without a citation behind it. If you're reading this before that recheck has happened, treat those cells as unknown, not as "no."

---

## Who builds this, and what's actually free

CallMCP is built and maintained by [CallMCP](https://github.com/CallMCP) / [KaiCalls](https://kaicalls.com). Full transparency, because hiding this costs more credibility than stating it:

- **This OSS server is not a loss-leader funnel with the real functionality locked behind a paywall.** It routes to any configured driver — hosted, local, or BYOK — with no markup and no artificial capability gating. A self-hosted Dograh driver or a BYOK Twilio+LLM driver gets the exact same 14-tool contract as the KaiCalls driver.
- **KaiCalls is the hosted default** — the path of least resistance if you want a call backend running in minutes with nothing to self-host. It is not the *only* supported path, and the spec and conformance suite exist precisely so that claim stays true as the driver ecosystem grows.
- **The driver interface is public and the conformance suite runs in CI.** Any driver — including ones we didn't write — can claim conformance, and community PRs are held to the same bar KaiCalls' own driver is held to (see [`SPEC.md` §6](./SPEC.md#6-conformance)).

If any of the above stops being true, that's a bug in this README, not a hidden asterisk — open an issue.

---

## Driver capability matrix

Capability is expressed by *presence*, not by runtime errors (see [`SPEC.md` §2.2](./SPEC.md#22-dynamic-toolslist-behavior)). This table mirrors the spec's degradation appendix ([`SPEC.md` §7](./SPEC.md#7-degradation-appendix)) — the honest state of the wider backend landscape at spec-writing time (2026-07-09), not a ceiling on what CallMCP itself can do.

### Launch drivers (this repo)

| Capability | `kaicalls` (hosted) | `dograh` (local) | `twilio_openai` (BYOK) |
|---|---|---|---|
| `make_call` / `end_call` (hangup) | Yes — hangup via Vapi `controlUrl`, treated as call-scoped state | `make_call` yes; **no** external hangup endpoint (`supports_hangup: false`) | Yes, native Twilio call control |
| `search_numbers` / `buy_number` / `configure_number` | Yes | **No** purchase flow — BYO carrier account (`supports_number_purchase: false`) | Yes, native Twilio number API |
| `send_sms` | Capability-gated on the underlying Vapi-class backend; not claimed unless a real standalone send path exists | **No** SMS capability | Yes, native Twilio SMS |
| `get_recording` | Yes, once wired | Capability-dependent on the local stack | Yes, native Twilio recording |
| `get_transcript` / realtime streaming | Yes | Yes, baseline (Dograh's `GET /{workflow_id}/runs/{run_id}` returns `transcript_url` — the one fully source-verified transcript path in the wider landscape) | DIY assembly from realtime session events; `supports_realtime_transcription` only claimed once that assembly is genuinely live |

### Known gaps across the wider backend landscape (context for driver authors)

| Tool / capability | Known gaps at spec-writing time |
|---|---|
| `buy_number` | Absent on Synthflow (UI-only, no API), ElevenLabs (BYO-number only), Dograh (BYO carrier), Phonely (not independently drivable) |
| `end_call` | Absent on Retell and Synthflow (no hangup endpoint); Dograh has no external hangup endpoint; Vapi supports it only via a per-call ephemeral `controlUrl`, not a stable REST endpoint |
| `send_sms` | The most degraded tool in the whole contract. Only Telnyx, Bland, Autocalls, and Thoughtly expose real standalone SMS. Vapi/Retell/Synthflow are agent-mediated only (not a stable API surface, never claimed as `supports_sms: true`). Millis, Vogent, and Dograh have no SMS capability at all. AgentLine's own public materials contradict themselves on this (`SKILL.md` forbids SMS while its API spec defines `POST /v1/messages`) — cited as unresolved upstream, not resolved on AgentLine's behalf |
| `get_recording` | Absent on AgentLine entirely; LiveKit-based backends require standing up a separate Egress service before it's real |
| `get_transcript` (realtime) | LiveKit/Pipecat-local stacks require DIY event capture; Bolna's transcript endpoint is unconfirmed; Telnyx's exact transcript route is unverified |

A driver claiming a capability it can't demonstrate against the conformance suite fails CI (see `SPEC.md` §6.2) — this table is a snapshot, not a promise about backends CallMCP doesn't control, and any driver author whose backend's real capability differs from this snapshot updates their own manifest, not this README.

---

## Repo shape

```
callmcp/callmcp
├── SPEC.md                   canonical tool contract (start here)
├── packages/
│   ├── server/                @callmcp/server — MCP core: transports, driver
│   │                          registry, config resolution, approval state
│   │                          machine, elicitation + fallback-URL flow,
│   │                          dynamic tools/list
│   ├── driver-interface/      @callmcp/driver-interface — TS interface,
│   │                          capability manifest types, conformance test harness
│   ├── driver-kaicalls/       hosted default driver
│   ├── driver-dograh/         local/self-hosted driver
│   └── driver-byok/           bring-your-own transport + bring-your-own LLM
├── examples/                  Claude Desktop / Claude Code config blocks per leg
├── server.json                official MCP Registry manifest — published as
│                              ai.callmcp/server (registry.modelcontextprotocol.io)
├── smithery.yaml               Smithery container deployment config
└── Dockerfile                  self-host / Smithery container build
```

## Packages

| Package | npm | What it is |
|---|---|---|
| [`@callmcp/server`](./packages/server) | [npm](https://www.npmjs.com/package/@callmcp/server) | The MCP server core — start here if you're running CallMCP. |
| [`@callmcp/driver-interface`](./packages/driver-interface) | [npm](https://www.npmjs.com/package/@callmcp/driver-interface) | The `Driver` contract, capability manifest types, conformance harness. Start here if you're writing a new driver. |
| [`@callmcp/driver-kaicalls`](./packages/driver-kaicalls) | [npm](https://www.npmjs.com/package/@callmcp/driver-kaicalls) | Hosted default — [KaiCalls](https://kaicalls.com)' production telephony backend. |
| [`@callmcp/driver-dograh`](./packages/driver-dograh) | [npm](https://www.npmjs.com/package/@callmcp/driver-dograh) | Fully local — wraps a self-hosted [Dograh](https://github.com/dograh-hq/dograh) instance. |
| [`@callmcp/driver-byok`](./packages/driver-byok) | [npm](https://www.npmjs.com/package/@callmcp/driver-byok) | Bring-your-own-key — Twilio transport + OpenAI Realtime (or wire-compatible) brain. |

## Contributing a driver

Implement the interface in `@callmcp/driver-interface`, ship a `callmcp.manifest.json` per [`SPEC.md` §6.1](./SPEC.md#61-machine-readable-capability-manifest), and run the conformance suite. A capability your manifest doesn't claim `true` simply results in that tool being absent from `tools/list` — that's the whole mechanism, not a workaround.

## License

[MIT](./LICENSE) for this repository's code. `SPEC.md` is released under Apache-2.0 as documented in its own header, specifically so anyone can implement a conformant driver without asking permission.

<!--
GitHub topics:
mcp, mcp-server, telephony, ai-agents, voice-ai, phone-api, sms-api, claude,
claude-code, cursor, openai-realtime, twilio, dograh, x402, skill-file,
model-context-protocol
-->
