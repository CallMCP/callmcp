/**
 * CallMCP driver-dograh — static capability manifest (SPEC §6.1)
 *
 * This is a promise, not marketing copy (SPEC §7 intro): every flag set
 * `true` here means the matching src/driver.ts method exists and genuinely
 * works end-to-end against a real Dograh instance. Every flag set `false`
 * reflects a real, documented gap in Dograh's API — not a "not implemented
 * yet" placeholder. See workspace/research/r4-local-stacks.md §2 for the
 * source citations behind each gap.
 */

import type { CapabilityManifest } from "@callmcp/driver-interface";

export const DOGRAH_MANIFEST: CapabilityManifest = {
  spec_version: "0.1.0",
  driver_id: "dograh",
  display_name: "Dograh (self-hosted / local)",
  kind: "local",
  repository_url: "https://github.com/dograh-hq/dograh",
  tools: {
    make_call: {
      supported: true,
      notes: "POST /telephony/initiate-call, scoped to a workflow_id (agent_config_ref).",
    },
    get_call_status: {
      supported: true,
      notes: "Polls GET /{workflow_id}/runs/{run_id}; Dograh has no push/webhook status feed.",
    },
    get_transcript: {
      supported: true,
      notes:
        "Baseline (non-realtime) only. Polls GET /{workflow_id}/runs/{run_id} for transcript_url, " +
        "then fetches that URL. No resources/subscribe-compatible streaming feed exists.",
    },
    get_recording: {
      supported: true,
      notes: "Read from the run's artifacts[] (artifact_type match) on GET /{workflow_id}/runs/{run_id}.",
    },
    end_call: {
      supported: false,
      notes: "Dograh has no external hangup endpoint (SPEC §7). Method intentionally omitted, not stubbed.",
    },
    send_sms: {
      supported: false,
      notes: "Dograh has no SMS capability at all (SPEC §7). Method intentionally omitted.",
    },
    search_numbers: {
      supported: false,
      notes: "Dograh is strictly BYO-carrier; there is no number marketplace to search.",
    },
    buy_number: {
      supported: false,
      notes: "No purchase endpoint exists anywhere in Dograh's API (SPEC §7) — BYO-carrier only.",
    },
    configure_number: {
      supported: true,
      notes:
        "PUT /api/v1/workflow/{workflow_id} attaches an already-owned number to a workflow's " +
        "telephony_config. This is attachment, not purchase.",
    },
    list_numbers: {
      supported: true,
      notes: "Derived from each known workflow's telephony_config.phone_number — not a dedicated numbers API.",
    },
    list_calls: {
      supported: true,
      notes: "Aggregated from GET /{workflow_id}/runs across known workflows.",
    },
  },
  capabilities: {
    supports_sms: false,
    supports_whatsapp: false,
    supports_rcs: false,
    supports_recording: true,
    supports_hangup: false,
    supports_number_purchase: false,
    supports_number_configuration: true,
    // Poll-based only (GET /{workflow_id}/runs/{run_id}) — no streaming
    // transcript feed a resources/subscribe caller could attach to.
    supports_realtime_transcription: false,
    // Elicitation is an MCP-session/server-core concern (SPEC §3.3), not a
    // Dograh backend feature — nothing about Dograh's API prevents it.
    supports_elicitation_approval: true,
    // Self-hosted: the real ceiling is whatever the operator's own
    // Dograh instance + underlying carrier account can sustain, which this
    // driver has no way to introspect. `null` per SPEC's "unbounded/unknown"
    // convention — operators who know their real ceiling should enforce it
    // upstream of this driver, not rely on this manifest for it.
    max_concurrent_calls: null,
    // Dograh's telephony is BYO-carrier (Twilio/Vonage/Vobiz/Cloudonix/
    // Asterisk ARI) — regionality is a function of the operator's own
    // carrier account, not a Dograh-imposed limit.
    regions: ["GLOBAL"],
  },
  known_degradations: [
    {
      tool_or_capability: "end_call",
      reason:
        "Dograh has no external hangup endpoint as of the 2026-07-09 research pass. A live call can only " +
        "be ended by the underlying carrier/PSTN leg hanging up or by Dograh's own workflow logic — not via " +
        "any REST surface this driver can call.",
      upstream_tracking_url: "https://github.com/dograh-hq/dograh/blob/main/api/routes/telephony.py",
    },
    {
      tool_or_capability: "send_sms",
      reason: "Dograh ships no SMS capability at all as of the 2026-07-09 research pass.",
      upstream_tracking_url: "https://github.com/dograh-hq/dograh",
    },
    {
      tool_or_capability: "buy_number / search_numbers",
      reason:
        "Dograh is strictly BYO-carrier (you bring your own Twilio/Vonage/Vobiz/Cloudonix credentials, or " +
        "run it against Asterisk ARI for a zero-vendor path). There is no number marketplace or purchase " +
        "flow in Dograh's API to search against or buy from.",
      upstream_tracking_url: "https://github.com/dograh-hq/dograh",
    },
    {
      tool_or_capability: "supports_realtime_transcription",
      reason:
        "get_transcript is poll-based against GET /{workflow_id}/runs/{run_id}. There is no documented " +
        "push/streaming transcript feed, so this driver claims baseline (inline/resource_link) transcript " +
        "support only, never realtime — a resources/subscribe caller will not receive incremental updates.",
      upstream_tracking_url:
        "https://raw.githubusercontent.com/dograh-hq/dograh/main/api/routes/workflow.py",
    },
    {
      tool_or_capability: "configure_number / list_numbers (route shape)",
      reason:
        "The exact number-attachment REST surface (PUT /api/v1/workflow/{workflow_id} and its GET/collection " +
        "counterparts) was not independently source-verified against dograh-hq/dograh's route files at " +
        "research time — see the provenance note atop src/client.ts. Verify against your own instance's " +
        "OpenAPI docs (typically served at {DOGRAH_BASE_URL}/docs) before relying on this in production.",
      upstream_tracking_url: "https://github.com/dograh-hq/dograh",
    },
  ],
};
