# @callmcp/driver-byok

[![npm version](https://img.shields.io/npm/v/@callmcp/driver-byok)](https://www.npmjs.com/package/@callmcp/driver-byok)

`driver_id: twilio_openai`. A CallMCP driver composed from two independent
pieces you bring your own keys for:

- **Transport** — [Twilio](https://www.twilio.com/docs) (Voice, Programmable
  Messaging, Phone Numbers).
- **Brain** — [OpenAI's Realtime API](https://platform.openai.com/docs/guides/realtime)
  (speech-to-speech, GA today). A second
  brain (xAI's Grok Voice Agent API, documented as OpenAI-Realtime-wire-
  compatible) is stubbed as a deliberate TODO — see `src/brain/adapter.ts`.

Normative reference: [`SPEC.md`](../../SPEC.md) at the repo root. If this
README and `SPEC.md` disagree, `SPEC.md` wins.

## Architecture

```
 caller ──PSTN──▶ Twilio number
                     │
                     ▼
           Twilio Voice webhook (POST)
           handleVoiceWebhook(callSid) → TwiML <Connect><Stream url="wss://…">
                     │
                     ▼
     Twilio Media Streams WebSocket (8kHz mu-law, bidirectional)
                     │
                     ▼
        attachMediaStream(ws) → RealtimeBridge
                     │  (audio in both directions, g711_ulaw, no resampling)
                     ▼
         OpenAI Realtime API WebSocket session
         (wss://api.openai.com/v1/realtime) — tool calls, transcript
         events, and barge-in all flow back through the same bridge.
```

This package does **not** run its own HTTP/WebSocket server. The host
process (`@callmcp/server`, or anything else embedding this driver) owns the
server; this driver exposes two integration points:

- `BYOKDriver.handleVoiceWebhook({ callSid })` → returns a TwiML XML string.
  Mount this at the URL you pass as `voiceWebhookUrl`, parse Twilio's
  form-encoded POST body for `CallSid` yourself, and return the string with
  `Content-Type: text/xml`.
- `BYOKDriver.attachMediaStream(ws)` → wires a `RealtimeBridge` onto a raw
  `ws.WebSocket`. Mount this at the URL you pass as `mediaStreamUrl` and hand
  it the WebSocket from your server's upgrade handler.

Everything else is the normal 11-method `Driver` interface from
`@callmcp/driver-interface`.

## Required configuration

| Field (constructor) | Typical env var | Required | Notes |
|---|---|---|---|
| `twilioAccountSid` | `TWILIO_ACCOUNT_SID` | yes | |
| `twilioAuthToken` | `TWILIO_AUTH_TOKEN` | yes | |
| `twilioFromNumber` | `TWILIO_FROM_NUMBER` | recommended | default caller ID; `make_call`/`send_sms` can override per-call via `from` |
| `openaiApiKey` | `OPENAI_API_KEY` | yes | |
| `openaiModel` | `OPENAI_REALTIME_MODEL` | no | defaults to `gpt-realtime`; set to `gpt-realtime-2.1-mini` for the cheaper tier |
| `voiceWebhookUrl` | `CALLMCP_BYOK_VOICE_WEBHOOK_URL` | yes | public `https://` URL routed to `handleVoiceWebhook` |
| `mediaStreamUrl` | `CALLMCP_BYOK_MEDIA_STREAM_URL` | yes | public `wss://` URL routed to `attachMediaStream` |
| `statusCallbackUrl` | `CALLMCP_BYOK_STATUS_CALLBACK_URL` | no | Twilio call-status webhook, informational only |
| `defaultInstructions` | — | no | fallback agent instructions when no `agentConfigResolver` is wired |
| `agentConfigResolver` | — | no | resolves `make_call`'s `agent_config_ref` into brain session config — see note below |
| `toolCallHook` | — | no | routes mid-call tool invocations through your own approval-aware logic |

These match the naming already used in `examples/claude-desktop-byok.json`
at the repo root (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM_NUMBER`, `OPENAI_API_KEY`). The `CALLMCP_BYOK_*` webhook/stream
URLs aren't in that example yet because they depend on wherever
`@callmcp/server` is actually deployed — set them to your public
domain/tunnel URL.

### Why `agentConfigResolver` exists

SPEC Appendix A puts agent-configuration tools (`create_agent`, prompt/voice
tuning) explicitly out of v0 scope — backend config models diverge too much
to unify honestly. `make_call`'s `agent_config_ref` is defined as "opaque"
(SPEC §1.4). This driver doesn't invent its own agent-config storage on top
of that; it just gives you a resolver hook so your host application's own
config store can turn `agent_config_ref` into concrete instructions/tools
for the OpenAI Realtime session. If you don't need per-call configuration,
skip it and set `defaultInstructions` once.

### Why `toolCallHook` exists

If the agent's toolset includes something that would itself contact a third
party (place another call, send a message), that tool's implementation is
responsible for checking CallMCP's approval/allowlist state (SPEC §3) before
acting — and that state is server-core, not something this driver package
has visibility into (see `@callmcp/driver-interface`'s README). `toolCallHook`
is the seam: wire it to whatever your host process uses to check/request
approval, and `RealtimeBridge` guarantees every brain-originated tool call is
round-tripped through it before being settled back to the brain.

## Usage sketch

```ts
import { BYOKDriver } from "@callmcp/driver-byok";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const driver = new BYOKDriver({
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID!,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN!,
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
  openaiApiKey: process.env.OPENAI_API_KEY!,
  voiceWebhookUrl: "https://your-domain.example.com/callmcp/byok/voice",
  mediaStreamUrl: "wss://your-domain.example.com/callmcp/byok/media-stream",
});

const httpServer = createServer(async (req, res) => {
  if (req.url === "/callmcp/byok/voice" && req.method === "POST") {
    const body = await readFormBody(req); // your own form-decoder
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(driver.handleVoiceWebhook({ callSid: body.CallSid }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/callmcp/byok/media-stream" });
wss.on("connection", (ws) => driver.attachMediaStream(ws));

httpServer.listen(3000);

// Elsewhere, wired into the CallMCP server core's `make_call` tool handler
// (after approval gating has already happened — this driver never checks
// approval itself):
await driver.makeCall({ to: "+14155551234", approval_id: "a_9f2c..." });
```

## Per-minute cost math

Sourced from `workspace/research/r2-transports.md` (Twilio) and
`workspace/research/r3-realtime-brains.md` (OpenAI Realtime), both dated
2026-07-09 against each provider's own pricing pages.

**Transport (Twilio):**

| Component | Rate |
|---|---|
| Voice, outbound (`make_call`) | $0.014/min |
| Voice, inbound (receive) | $0.0085/min |
| Media Streams add-on (bidirectional) | $0.004/min |
| SMS (Programmable Messaging) | $0.0083/message |
| Number rental | ~$1.00/mo local, ~$2.00/mo toll-free |

A typical outbound call: **$0.014 + $0.004 = $0.018/min transport.**

**Brain (OpenAI Realtime, `gpt-realtime-2.1`):**

Token pricing: audio input $32/1M tokens, audio output $64/1M tokens.
User audio ≈ 600 tokens/min, assistant audio ≈ 1,200 tokens/min. For a
mixed-duplex minute (~50% each speaking):

```
input:  600  × $32/1M  ≈ $0.0192
output: 1200 × $64/1M  ≈ $0.0768
                          -------
mixed-duplex minute      ≈ $0.048  (uncached)
```

Real-world measured sessions (HackerNoon's 4,000-session dataset, cited in
the research doc) land at **$0.18–$0.46/min uncached, $0.05–$0.10/min with
prompt caching** — caching matters a lot here because tool schemas and
system instructions are re-sent on every turn otherwise. The cheaper
`gpt-realtime-2.1-mini` tier runs ~40% of flagship audio-token cost
(≈$0.015–0.03/min).

**All-in per minute (this driver's default configuration, `gpt-realtime-2.1`, cached):**

```
  Twilio transport   $0.018/min
+ OpenAI brain        $0.05–0.08/min  (cached, mixed-duplex)
-------------------------------------
= ~$0.07–0.10/min outbound voice
```

Swap to `gpt-realtime-2.1-mini` for roughly **$0.03–0.05/min all-in**
instead. Recording ($0.0025–0.004/min per various Twilio community pricing
references — not independently re-verified against Twilio's own recording
pricing page while writing this driver, treat as approximate) and SMS
($0.0083/message) are additive, not included in the per-minute voice figure
above.

## Compliance: KYC and A2P 10DLC, surfaced honestly

This driver does not hide Twilio's own compliance gates behind a generic
error:

- **`buy_number`** — international numbers and several US number types
  require a Twilio **Regulatory Bundle** (identity/address verification)
  before purchase succeeds. `mapTwilioError` (`src/transport/twilio.ts`)
  recognizes Twilio's regulatory/bundle-shaped errors and surfaces them as
  SPEC §5.5 `KYC_REQUIRED`, with `typical_turnaround` and a link to Twilio's
  own regulatory-compliance console — not a bare 400.
- **`send_sms`** at volume — **A2P 10DLC** brand/campaign registration is
  required for sustained US long-code SMS traffic. Per Twilio's own vetting
  FAQ this currently runs **10–15 business days** (nominally "up to 5
  business days" but backlog has pushed it out), plus a $15 campaign
  verification fee. Low-volume/unregistered sends may work initially but are
  subject to carrier filtering over time. **This gate does not affect
  voice-only use of this driver** — `make_call` has no A2P dependency.

Both gaps are also declared in `known_degradations` in
`src/manifest.ts` / `callmcp.manifest.json` per SPEC §6.1 — the manifest is
the durable record, this README is the human-readable summary of it.

## What's not implemented (v1)

- `send_sms` with `channel: whatsapp` or `channel: rcs` — Twilio supports
  both, neither is wired into this driver yet (`supports_whatsapp: false`,
  `supports_rcs: false` in the manifest, not silently dropped).
- `grokAdapter` (`src/brain/adapter.ts`) — xAI's Grok Voice Agent API is
  documented as OpenAI-Realtime-wire-compatible (same event vocabulary,
  swap the base URL and key), but this repo hasn't verified that against a
  live session, so it's a real thrown-error stub with the exact
  implementation sketch left in a comment, not a silent no-op.
- Explicit caller-side barge-in detection in `RealtimeBridge` — OpenAI's
  server-side `turn_detection` already interrupts generation brain-side on
  `input_audio_buffer.speech_started`, but this bridge doesn't yet listen
  for that event to also clear Twilio's outbound buffer client-side (see
  `RealtimeBridge.interruptForBargeIn`, currently exposed but not
  auto-wired).

## Development

```bash
pnpm install
pnpm --filter @callmcp/driver-byok run build
pnpm --filter @callmcp/driver-byok run test
```

`test/driver.test.ts` mocks the Twilio SDK client and the brain adapter
factory — no real Twilio or OpenAI calls, no spend, safe to run in CI.
