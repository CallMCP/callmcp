/**
 * @callmcp/driver-byok — capability manifest
 *
 * SPEC §6.1: "a driver package MUST ship a static `callmcp.manifest.json`."
 * This module is the source of truth; `callmcp.manifest.json` at the package
 * root is a generated/kept-in-sync JSON mirror of the object below (see
 * `scripts` note in README — for v0.1.0 it is hand-kept in sync since this
 * package has no build-time codegen step yet).
 *
 * Every flag set `true` here is a promise (driver-interface README: "Every
 * flag you set true is a promise: the matching Driver method exists and
 * works end-to-end"). Where this driver is honestly not there yet
 * (WhatsApp, RCS), the flag stays `false` and the gap is named in
 * `known_degradations` rather than smoothed over — per SPEC §7's own framing,
 * that transparency is the point, not a footnote.
 */

import type { CapabilityManifest } from "@callmcp/driver-interface";

export const BYOK_DRIVER_ID = "twilio_openai";

export const BYOK_DRIVER_MANIFEST: CapabilityManifest = {
  spec_version: "0.1.0",
  driver_id: BYOK_DRIVER_ID,
  display_name: "BYOK: Twilio + OpenAI Realtime",
  kind: "byok",
  repository_url: "https://github.com/callmcp/callmcp",

  tools: {
    // Server-core tools (driver-interface README: these three are answered
    // by the server, not per-driver) — listed here as supported because
    // this driver has no reason to disable them; the server core decides
    // tools/list inclusion regardless of what a driver claims for these three.
    list_drivers: { supported: true, notes: "server-core; not implemented by this package" },
    request_call_approval: { supported: true, notes: "server-core; not implemented by this package" },
    list_approvals: { supported: true, notes: "server-core; not implemented by this package" },

    make_call: {
      supported: true,
      notes: "Twilio Voice REST call creation + TwiML <Connect><Stream> into the OpenAI Realtime bridge.",
    },
    end_call: {
      supported: true,
      notes:
        "Twilio calls(sid).update({status:'completed'}) — a stable REST endpoint, unlike Vapi's " +
        "call-scoped ephemeral controlUrl (SPEC §7 degradation appendix note on end_call).",
    },
    get_call_status: { supported: true, notes: "Twilio calls(sid).fetch()." },
    get_transcript: {
      supported: true,
      notes:
        "Assembled from the OpenAI Realtime session's transcript events as the bridge streams them " +
        "(response.audio_transcript.done / conversation.item.input_audio_transcription.completed), " +
        "not from a Twilio-side transcript endpoint.",
    },
    get_recording: {
      supported: true,
      notes: "Twilio call recording via the Recordings resource; enabled by default on make_call (record=true).",
    },
    send_sms: {
      supported: true,
      notes:
        "Real standalone send via Twilio's Programmable Messaging API (not agent-mediated-only) — " +
        "meets SPEC §1.9's bar for supports_sms:true. Subject to Twilio's own A2P 10DLC registration " +
        "gate for higher-volume US traffic; see known_degradations.",
    },
    search_numbers: { supported: true, notes: "Twilio Available Phone Numbers API." },
    buy_number: {
      supported: true,
      notes:
        "Twilio IncomingPhoneNumbers API. International/certain US number types require a Regulatory " +
        "Bundle (KYC) before purchase succeeds — surfaced as KYC_REQUIRED, not hidden; see transport/twilio.ts mapTwilioError.",
    },
    configure_number: { supported: true, notes: "Twilio IncomingPhoneNumbers(sid).update() for voice/SMS webhook URLs." },
    list_numbers: { supported: true, notes: "Twilio IncomingPhoneNumbers list." },
    list_calls: { supported: true, notes: "Twilio Calls list." },
  },

  capabilities: {
    supports_sms: true,
    // Twilio does support WhatsApp (Business API) and has RCS in some
    // markets, but neither is wired up in this driver's v1 — leaving these
    // false rather than claiming support this package doesn't implement.
    supports_whatsapp: false,
    supports_rcs: false,
    supports_recording: true,
    supports_hangup: true,
    supports_number_purchase: true,
    supports_number_configuration: true,
    // The bridge streams transcript turns live as the OpenAI Realtime
    // session produces them (see realtimeBridge.ts onTranscriptTurn); the
    // server core is responsible for exposing that as a subscribable
    // tel://calls/{call_id}/transcript resource per SPEC §1.7.
    supports_realtime_transcription: true,
    // Reflects transport capability, not a block imposed by this driver —
    // elicitation support is ultimately a property of the connected MCP
    // client's session, which this driver has no visibility into or say over.
    supports_elicitation_approval: true,
    // Twilio pay-as-you-go accounts have no documented hard concurrency
    // ceiling from this driver's side (soft trust/fraud limits exist
    // account-side but aren't a stable number to publish here).
    max_concurrent_calls: null,
    // Twilio can originate/terminate in most countries, but per-country KYC
    // (Regulatory Bundles) gates buy_number in many of them — GLOBAL here
    // describes reach, not frictionless reach; see known_degradations and
    // SPEC §5.5 KYC_REQUIRED.
    regions: ["GLOBAL"],
  },

  known_degradations: [
    {
      tool_or_capability: "supports_whatsapp",
      reason:
        "Twilio's WhatsApp Business API requires a separate approved sender/template registration flow " +
        "not yet wired into this driver. send_sms with channel=whatsapp is not implemented.",
      upstream_tracking_url: "https://www.twilio.com/docs/whatsapp",
    },
    {
      tool_or_capability: "supports_rcs",
      reason: "Twilio RCS Business Messaging is not wired into this driver's v1.",
      upstream_tracking_url: "https://www.twilio.com/docs/rcs",
    },
    {
      tool_or_capability: "send_sms",
      reason:
        "US A2P 10DLC brand/campaign registration is required for sustained/high-volume SMS traffic " +
        "and, per Twilio's own vetting FAQ, currently runs 10-15 business days end to end (nominally " +
        "'up to 5 business days' but backlog has pushed it out), plus a $15 campaign verification fee. " +
        "Low-volume/unregistered sends may work initially but are subject to carrier filtering. Voice-only " +
        "use of this driver is unaffected — see r2-transports.md §1.",
      upstream_tracking_url: "https://help.twilio.com/articles/11587910480155-A2P-10DLC-Campaign-Vetting-FAQ",
    },
    {
      tool_or_capability: "buy_number",
      reason:
        "International numbers and several US number types require a Twilio Regulatory Bundle (identity " +
        "and address documentation) before purchase succeeds. This driver surfaces that as KYC_REQUIRED " +
        "(SPEC §5.5) rather than a generic failure, but cannot skip the underlying verification.",
      upstream_tracking_url: "https://www.twilio.com/docs/phone-numbers/regulatory",
    },
    {
      tool_or_capability: "brain (second adapter)",
      reason:
        "Only the OpenAI Realtime API brain is implemented (openaiRealtimeAdapter in src/brain/adapter.ts). " +
        "xAI's Grok Voice Agent API is documented as OpenAI-Realtime-wire-compatible, but grokAdapter is a " +
        "deliberate unimplemented TODO pending verification against a live session — this is not a CallMCP " +
        "capability flag (brain choice is internal to this one driver_id), flagged here for driver-author visibility.",
      upstream_tracking_url: "https://docs.x.ai/developers/model-capabilities/audio/voice-agent",
    },
  ],
};
