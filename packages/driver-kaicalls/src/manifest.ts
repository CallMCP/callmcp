/**
 * Static capability manifest for the KaiCalls driver (SPEC §6.1).
 *
 * Every flag and note below is derived exclusively from what
 * https://callmcp.ai/llms.txt and https://callmcp.ai/skill.md (v1.0,
 * 2026-07-09) actually confirm about the live KaiCalls MCP/REST backend —
 * both files were read in full while building this driver. Where the
 * source docs are silent or only imply a behavior, the comment next to the
 * flag says so explicitly rather than defaulting to an optimistic guess.
 * This driver is meant to be CallMCP's fullest-parity, flagship driver;
 * honesty about the gaps is the entire point of the capability model
 * (SPEC §0.1.2, §7) — a driver that overclaims is worse than one that
 * underclaims, because overclaiming surfaces as a runtime surprise instead
 * of a `tools/list` absence.
 *
 * This TypeScript object is the source of truth; `callmcp.manifest.json`
 * at the package root mirrors it for tooling that expects a static JSON
 * file per SPEC §6.1's exact schema (e.g. registries that validate driver
 * packages without executing code). Keep the two in sync.
 */

import type { CapabilityManifest } from "@callmcp/driver-interface";

export const KAICALLS_MANIFEST: CapabilityManifest = {
  spec_version: "0.1.0",
  driver_id: "kaicalls",
  display_name: "KaiCalls (hosted)",
  kind: "hosted",
  repository_url: "https://github.com/callmcp/callmcp",
  tools: {
    // Server-core tools (SPEC §1.1-1.3): driver-agnostic, always available
    // regardless of which driver is active. No `Driver` method exists for
    // these — see driver-interface's README, "Why Driver only has 11
    // methods, not 14". Listed here (mirroring driver-interface's own
    // MockDriver manifest) so the manifest documents the full 14-tool spec
    // surface, not just this package's 11 `Driver` methods.
    list_drivers: { supported: true, notes: "Server-core; not a per-driver capability." },
    request_call_approval: { supported: true, notes: "Server-core; not a per-driver capability." },
    list_approvals: { supported: true, notes: "Server-core; not a per-driver capability." },

    make_call: { supported: true, notes: "Maps to KaiCalls' `make_call` MCP tool (scope calls:write)." },
    end_call: {
      supported: false,
      notes:
        'No hangup/terminate-call tool appears in KaiCalls\' documented 44-tool inventory (confirmed live via an unauthenticated tools/list call against callmcp.ai/mcp on 2026-07-10 — the llms.txt/skill.md "38"/"42" tool-count figures are stale) (llms.txt "Calls (5)": make_call, check_call_status, list_recent_calls, get_transcript, get_call_recording — no sixth call-control tool). `endCall` is intentionally left unimplemented on KaiCallsDriver (undefined, not a throwing stub) per SPEC §0.1.2\'s preferred absence signal.',
    },
    get_call_status: { supported: true, notes: "Maps to `check_call_status` (scope calls:read)." },
    get_transcript: {
      supported: true,
      notes:
        "Maps to `get_transcript` (scope calls:read). Baseline/non-realtime form only — see capabilities.supports_realtime_transcription.",
    },
    get_recording: { supported: true, notes: "Maps to `get_call_recording` (scope calls:read)." },
    send_sms: {
      supported: true,
      notes: "Maps to `send_sms` (scope sms:write). SMS channel only — see capabilities.supports_whatsapp / supports_rcs.",
    },
    search_numbers: { supported: true, notes: "Maps to `search_available_numbers` (scope numbers:read)." },
    buy_number: { supported: true, notes: "Maps to `buy_number` (scope numbers:write)." },
    configure_number: {
      supported: true,
      notes:
        "Partial support. Only the `agent_config_ref` field is honestly implementable, via KaiCalls' `attach_number`/`detach_number` tools (scope numbers:write). `sms_webhook_url` and `caller_id_name` are not exposed per-number by any tool in the documented inventory; KaiCallsDriver.configureNumber throws UnsupportedCapabilityError if either is supplied rather than silently dropping them.",
    },
    list_numbers: { supported: true, notes: "Maps to `list_numbers` (scope numbers:read)." },
    list_calls: { supported: true, notes: "Maps to `list_recent_calls` (scope calls:read)." },
  },
  capabilities: {
    // send_sms is documented as a real, standalone tool ("SMS &
    // conversations (4)": send_sms, list_sms_messages, list_conversations,
    // get_conversation) — not agent-mediated-only, so this legitimately
    // earns `true` per SPEC §7's bar for supports_sms.
    supports_sms: true,
    // Neither llms.txt nor skill.md mentions a WhatsApp channel anywhere in
    // the 44-tool inventory (confirmed live via an unauthenticated tools/list call against callmcp.ai/mcp on 2026-07-10 — the llms.txt/skill.md "38"/"42" tool-count figures are stale) or the send_sms description.
    supports_whatsapp: false,
    // Same — no RCS channel documented anywhere.
    supports_rcs: false,
    // get_call_recording is a documented, standalone tool.
    supports_recording: true,
    // No hangup/terminate tool documented — see tools.end_call above.
    supports_hangup: false,
    // search_available_numbers + buy_number are both documented, standalone
    // tools; no UI-only or BYO-carrier caveat is mentioned anywhere.
    supports_number_purchase: true,
    // attach_number/detach_number are documented, standalone tools. See the
    // "Partial support" note on tools.configure_number for the honest
    // scope limit (agent routing only, not webhook/caller-ID config).
    supports_number_configuration: true,
    // llms.txt describes get_transcript as poll/finalize-after-call
    // ("Transcripts finalize shortly after the call ends -- if a
    // transcript looks truncated, wait and re-fetch before concluding the
    // call failed") and never states that KaiCalls' backend itself streams
    // transcript updates via `resources/subscribe`. The `tel://` URI
    // scheme is CallMCP SPEC's own resource-addressing convention
    // (constructed by this driver in driver.ts), not evidence of a live
    // KaiCalls streaming source. Honest `false`.
    supports_realtime_transcription: false,
    // llms.txt's own restrictions section is explicit: 'Today the server
    // enforces this via `destructiveHint: true` annotations that your
    // client must honor... A server-side approval gate... is specified and
    // on the public roadmap.' The "What's real vs not yet built" section
    // lists "no server-side approval gate in front of make_call/buy_number
    // (annotation-only today)" under Not yet built. No `elicitation/create`
    // support is documented anywhere. Honest `false`.
    supports_elicitation_approval: false,
    // Not documented anywhere in llms.txt/skill.md.
    max_concurrent_calls: null,
    // Not explicitly enumerated by the source docs. Every compliance
    // concept KaiCalls' materials reference (TCPA, do-not-call, quiet
    // hours) is exclusively US-framed, and no international numbering,
    // country dialing code, or non-US carrier is mentioned anywhere. This
    // is a documented *inference*, not a confirmed fact — update it the
    // moment KaiCalls publishes explicit regional coverage (SPEC §7's
    // closing instruction: update the manifest, not the spec, when a
    // backend's real capability differs from a prior snapshot).
    regions: ["US"],
  },
  known_degradations: [
    {
      tool_or_capability: "end_call",
      reason:
        "No hangup/terminate-call MCP tool is documented in KaiCalls' 44-tool inventory (confirmed live via an unauthenticated tools/list call against callmcp.ai/mcp on 2026-07-10 — the llms.txt/skill.md '38'/'42' tool-count figures are stale) (callmcp.ai/llms.txt). Cannot be implemented honestly without a confirmed endpoint.",
      upstream_tracking_url: "https://callmcp.ai/safety",
    },
    {
      tool_or_capability: "supports_whatsapp",
      reason: "send_sms is documented as a single SMS channel; no WhatsApp send path is mentioned anywhere in the source docs.",
    },
    {
      tool_or_capability: "supports_rcs",
      reason: "send_sms is documented as a single SMS channel; no RCS send path is mentioned anywhere in the source docs.",
    },
    {
      tool_or_capability: "supports_realtime_transcription",
      reason:
        "get_transcript is documented as poll/finalize-after-call, not a live `resources/subscribe` stream. No MCP resource-subscription behavior is described for KaiCalls' transcript tool.",
    },
    {
      tool_or_capability: "supports_elicitation_approval",
      reason:
        "llms.txt explicitly lists 'no server-side approval gate in front of make_call/buy_number (annotation-only today)' under 'What's real vs not yet built,' and no `elicitation/create` support is documented anywhere.",
      upstream_tracking_url: "https://callmcp.ai/safety",
    },
    {
      tool_or_capability: "configure_number (sms_webhook_url, caller_id_name fields)",
      reason:
        "Only attach_number/detach_number are documented; neither exposes a per-number SMS webhook or caller-ID-name field. KaiCallsDriver.configureNumber throws UnsupportedCapabilityError for these fields instead of silently ignoring them.",
    },
    {
      tool_or_capability: "buy_number / list_numbers nested object sub-shape",
      reason:
        "Confirmed live (2026-07-10, unauthenticated tools/list against callmcp.ai/mcp) for every other tool's field names and nesting — driver.ts was corrected to match. The one remaining gap: buy_number's response `number` field and list_numbers' `numbers[]` entries are typed only as `{\"type\":\"object\"}` in the published outputSchema, with no listed sub-properties, so this driver still defensively guesses at candidate key names (`phone_number`/`number`/`e164`) for those two nested shapes rather than a confirmed field name.",
      upstream_tracking_url: "https://callmcp.ai/mcp-server-for-phone-calls",
    },
  ],
};
