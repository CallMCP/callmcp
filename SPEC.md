# CallMCP Core Telephony Tool Contract

**Version:** v0.1.0
**Status:** Draft — public specification, open for driver-implementer review
**Spec target:** Model Context Protocol revision **2025-11-25**
**License:** This document is prior art for the telephony-MCP category and is released under the same license as the CallMCP repository (Apache-2.0), so anyone may implement a conformant driver without asking permission.

---

## 0. Purpose and scope

CallMCP defines one MCP tool contract for outbound/inbound telephony — calls, SMS, recordings, transcripts, and phone number lifecycle — that is implemented identically regardless of which backend actually places the call. A client that speaks this contract against a hosted backend (KaiCalls), a self-hosted local backend (Dograh), or a bring-your-own-key composed backend (Twilio transport + an LLM realtime brain) sees **the same 14 tools, the same schemas, the same error shapes**. What differs between backends is *which* tools are present (via capability-gated dynamic discovery) and what values populate capability flags — never the shape of a tool that is present.

This document is the normative reference driver implementations are reviewed against. It is not a tutorial and not a marketing page. Where a requirement uses **MUST**, **MUST NOT**, **SHOULD**, or **MAY**, those terms carry their RFC 2119 meaning.

### 0.1 Design invariants (do not violate these in a driver PR)

1. **One tool, one schema, all drivers.** Driver-specific parameters live exclusively inside the namespaced `options.<driver_id>` passthrough object (see §1.0). CallMCP will never ship `make_call_twilio`, `make_call_kaicalls`, or any other per-driver tool variant.
2. **Absence, not runtime surprise, is how degradation is expressed.** If a driver cannot support a tool at all, the tool **MUST NOT** appear in that driver's `tools/list` response. A tool that is advertised **MUST** work. Capability flags and dynamic discovery exist so unsupported behavior is discoverable before invocation, not discovered as a runtime error.
3. **Outbound contact with a third party is always human-approval-gated.** `make_call` and `send_sms` (and any future tool that dials or messages a phone number that isn't the caller) require a valid, unexpired `approval_id` or an allowlist match before they act. This is structural, not a bolt-on flag — see §3.
4. **Agent self-provisioning is never gated.** `search_numbers`, `buy_number`, `configure_number`, and `list_numbers` do not contact a third-party human and are fully autonomous, including compensating an operator via x402 machine payments. The gate exists only where a human other than the calling agent's operator would be contacted.
5. **The server is the source of truth for capability.** Clients **MUST** call `list_drivers` (or read the capability manifest, §6.1) before assuming a tool exists, and **MUST** re-read capability state after any `notifications/tools/list_changed` (§2.2).

---

## 1. Tool schemas

All 14 tools are defined below as JSON Schema (draft 2020-12) input schemas, an output shape, and MCP tool annotations. Every tool's input schema includes an `options` object keyed by `driver_id` for driver-specific extension fields; a driver **MUST NOT** require a client to populate `options` to get baseline behavior — driver-specific fields are additive refinements (compliance data, voice selection, routing hints), never a substitute for the universal fields.

Conventions used throughout:
- `driver_id` is a short lowercase slug (`kaicalls`, `dograh`, `twilio_openai`, etc.) matching the `id` field returned by `list_drivers`.
- All timestamps are ISO-8601 UTC (`2026-07-09T18:04:00Z`).
- All durations are seconds unless the field name says otherwise.
- Every tool output includes a top-level `driver` field (the `driver_id` that actually served the call) so multi-driver clients can attribute results.
- Every list-shaped output supports `cursor`-based pagination: an optional input `cursor` (opaque string) and an output `next_cursor` (`string | null`).

### 1.1 `list_drivers`

Read-only capability introspection. The entry point every client **MUST** call before assuming any other tool's behavior.

**Input schema:**
```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "drivers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "driver_id, e.g. 'kaicalls'" },
          "display_name": { "type": "string" },
          "kind": { "type": "string", "enum": ["hosted", "local", "byok"] },
          "default": { "type": "boolean", "description": "used when a tool call omits `driver`" },
          "capabilities": {
            "type": "object",
            "properties": {
              "supports_sms": { "type": "boolean" },
              "supports_whatsapp": { "type": "boolean" },
              "supports_rcs": { "type": "boolean" },
              "supports_recording": { "type": "boolean" },
              "supports_hangup": { "type": "boolean" },
              "supports_number_purchase": { "type": "boolean" },
              "supports_number_configuration": { "type": "boolean" },
              "supports_realtime_transcription": { "type": "boolean" },
              "supports_elicitation_approval": { "type": "boolean", "description": "false means only the out-of-band URL / allowlist fallback path is available (see §3.4)" },
              "max_concurrent_calls": { "type": ["integer", "null"] },
              "regions": {
                "type": "array",
                "items": { "type": "string", "description": "ISO 3166-1 alpha-2 country code, or 'GLOBAL'" }
              }
            },
            "required": [
              "supports_sms", "supports_recording", "supports_hangup",
              "supports_number_purchase", "supports_realtime_transcription",
              "max_concurrent_calls", "regions"
            ],
            "additionalProperties": true
          },
          "degraded_tools": {
            "type": "array",
            "items": { "type": "string" },
            "description": "tool names this driver deliberately does not expose; informational, mirrors tools/list absence"
          }
        },
        "required": ["id", "display_name", "kind", "capabilities"]
      }
    }
  },
  "required": ["drivers"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

---

### 1.2 `request_call_approval`

Creates a pending human authorization for a destination, a standing allowlist entry, or a campaign batch. Fires MCP elicitation when the connected client supports it; otherwise returns an out-of-band approval URL (§3.4). This is the tool that puts the human-in-the-loop constraint structurally into the contract rather than as an afterthought.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "scope": { "type": "string", "enum": ["single_call", "allowlist_add", "campaign_batch"] },
    "destinations": {
      "type": "array",
      "items": { "type": "string", "description": "E.164 phone number, or a wildcard pattern for allowlist_add e.g. '+1415555....'" },
      "minItems": 1
    },
    "purpose": { "type": "string", "description": "human-readable reason shown in the elicitation/approval UI" },
    "channel": { "type": "string", "enum": ["voice", "sms", "whatsapp", "rcs"], "default": "voice" },
    "campaign_max_contacts": { "type": "integer", "minimum": 1, "description": "required when scope=campaign_batch" },
    "ttl_seconds": { "type": "integer", "minimum": 60, "default": 86400, "description": "how long the resulting approval remains valid; see §3.2 for tier defaults" },
    "driver": { "type": "string" },
    "options": {
      "type": "object",
      "additionalProperties": { "type": "object" },
      "description": "namespaced driver-specific passthrough, keyed by driver_id"
    }
  },
  "required": ["scope", "destinations"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "approval_id": { "type": "string" },
    "state": { "type": "string", "enum": ["pending", "approved", "denied", "expired"] },
    "scope": { "type": "string", "enum": ["single_call", "allowlist_add", "campaign_batch"] },
    "elicitation_used": { "type": "boolean" },
    "out_of_band_url": { "type": ["string", "null"], "description": "populated when elicitation_used is false; see §3.4" },
    "expires_at": { "type": "string" },
    "driver": { "type": "string" }
  },
  "required": ["approval_id", "state", "scope", "elicitation_used", "expires_at", "driver"]
}
```

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`.

Note: `request_call_approval` itself is not destructive — it does not contact the destination — but it is not read-only either, since it creates state. It is the mechanism, not the act.

---

### 1.3 `list_approvals`

Read-only. Returns pending approvals, standing allowlist entries, verified consented destinations, and active campaign grants.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "state": { "type": "string", "enum": ["pending", "approved", "denied", "expired", "any"], "default": "any" },
    "scope": { "type": "string", "enum": ["single_call", "allowlist_add", "campaign_batch", "any"], "default": "any" },
    "driver": { "type": "string" },
    "cursor": { "type": "string" }
  },
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "approvals": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "approval_id": { "type": "string" },
          "scope": { "type": "string", "enum": ["single_call", "allowlist_add", "campaign_batch"] },
          "state": { "type": "string", "enum": ["pending", "approved", "denied", "expired"] },
          "destinations": { "type": "array", "items": { "type": "string" } },
          "channel": { "type": "string", "enum": ["voice", "sms", "whatsapp", "rcs"] },
          "created_at": { "type": "string" },
          "decided_at": { "type": ["string", "null"] },
          "expires_at": { "type": "string" },
          "remaining_uses": { "type": ["integer", "null"], "description": "relevant for campaign_batch" },
          "driver": { "type": "string" }
        },
        "required": ["approval_id", "scope", "state", "destinations", "channel", "created_at", "expires_at", "driver"]
      }
    },
    "next_cursor": { "type": ["string", "null"] }
  },
  "required": ["approvals", "next_cursor"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

---

### 1.4 `make_call`

Places an outbound call. **The consequential act in this system.** Requires a valid, unexpired `approval_id` whose scope covers `to`, or an allowlist match; otherwise the server elicits approval inline rather than dialing, or returns `APPROVAL_REQUIRED` (§5) on non-elicitation clients.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "to": { "type": "string", "description": "E.164 destination number" },
    "from": { "type": "string", "description": "E.164 caller-id number; if omitted, driver default number is used" },
    "driver": { "type": "string" },
    "approval_id": { "type": "string", "description": "omit only if `to` matches a standing allowlist entry" },
    "agent_config_ref": { "type": "string", "description": "opaque reference to an already-configured agent/assistant on the driver side; agent-config tools are out of v0 scope (see §0)" },
    "max_duration_seconds": { "type": "integer", "minimum": 1 },
    "metadata": { "type": "object", "additionalProperties": true, "description": "opaque client metadata echoed back in get_call_status/get_transcript" },
    "options": {
      "type": "object",
      "additionalProperties": { "type": "object" }
    }
  },
  "required": ["to"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" },
    "status": { "type": "string", "enum": ["queued", "ringing", "in_progress", "elicitation_pending"] },
    "to": { "type": "string" },
    "from": { "type": "string" },
    "approval_id": { "type": "string" },
    "started_at": { "type": ["string", "null"] },
    "driver": { "type": "string" }
  },
  "required": ["call_id", "status", "to", "approval_id", "driver"]
}
```

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`. `execution.taskSupport: "optional"` — a client MAY treat this as a long-running MCP task and poll rather than block on the call's live duration.

`destructiveHint: true` here is a deliberate departure from earlier telephony-MCP strawmen that annotated `make_call` as non-destructive. Contacting a third party by phone is the consequential, hard-to-undo act in this system — the annotation is the sanctioned client-side gating surface (confirmation dialogs, "requires approval" UI) and **MUST** be honored by conformant clients as such.

---

### 1.5 `end_call`

Terminates an in-progress call. **Capability-gated** — several backends have no hangup endpoint at all (see §7).

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" },
    "reason": { "type": "string" }
  },
  "required": ["call_id"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" },
    "status": { "type": "string", "enum": ["completed", "already_ended"] },
    "ended_at": { "type": "string" },
    "driver": { "type": "string" }
  },
  "required": ["call_id", "status", "ended_at", "driver"]
}
```

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` (calling `end_call` twice on an already-ended call is a no-op success, not an error), `openWorldHint: true`.

If a driver lacks `supports_hangup`, this tool **MUST NOT** appear in that driver's `tools/list`. It is not acceptable to advertise the tool and return an error at call time.

---

### 1.6 `get_call_status`

Read-only poll fallback for clients that don't subscribe to resource updates.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" }
  },
  "required": ["call_id"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["queued", "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled"]
    },
    "to": { "type": "string" },
    "from": { "type": "string" },
    "started_at": { "type": ["string", "null"] },
    "ended_at": { "type": ["string", "null"] },
    "duration_seconds": { "type": ["integer", "null"] },
    "metadata": { "type": "object", "additionalProperties": true },
    "driver": { "type": "string" }
  },
  "required": ["call_id", "status", "driver"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

---

### 1.7 `get_transcript`

Returns a completed or in-progress call's transcript, either inline or as a subscribable resource link.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" },
    "format": { "type": "string", "enum": ["inline", "resource_link"], "default": "inline" }
  },
  "required": ["call_id"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" },
    "status": { "type": "string", "enum": ["not_available_yet", "partial", "complete"] },
    "transcript": {
      "type": ["array", "null"],
      "items": {
        "type": "object",
        "properties": {
          "role": { "type": "string", "enum": ["agent", "caller", "system"] },
          "text": { "type": "string" },
          "at": { "type": "string" }
        },
        "required": ["role", "text", "at"]
      },
      "description": "populated when format=inline"
    },
    "resource_link": {
      "type": ["string", "null"],
      "description": "tel://calls/{call_id}/transcript — populated when format=resource_link; subscribable via resources/subscribe"
    },
    "driver": { "type": "string" }
  },
  "required": ["call_id", "status", "driver"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

The `tel://calls/{call_id}/transcript` URI scheme **MUST** be supported by every driver that sets `supports_realtime_transcription: true`, so a client can `resources/subscribe` and stream updates rather than poll.

---

### 1.8 `get_recording`

Returns a resource link to the call's audio recording. **Capability-gated** (see §7 — AgentLine-class backends have no recording at all).

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" }
  },
  "required": ["call_id"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "call_id": { "type": "string" },
    "status": { "type": "string", "enum": ["not_available", "processing", "ready"] },
    "resource_link": { "type": ["string", "null"], "description": "tel://calls/{call_id}/recording" },
    "mime_type": { "type": ["string", "null"] },
    "duration_seconds": { "type": ["integer", "null"] },
    "driver": { "type": "string" }
  },
  "required": ["call_id", "status", "driver"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

If a driver lacks `supports_recording`, this tool **MUST NOT** appear in its `tools/list`.

---

### 1.9 `send_sms`

Sends an outbound message over SMS, WhatsApp, or RCS (single tool, `channel` discriminator — resolves the alternative of separate `send_sms`/`send_whatsapp` tools per the AI SDK / LiteLLM precedent of one message tool with a channel field). **The most degraded tool in the contract** — see §0 decision below and §7.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "to": { "type": "string" },
    "from": { "type": "string" },
    "channel": { "type": "string", "enum": ["sms", "whatsapp", "rcs"], "default": "sms" },
    "body": { "type": "string", "maxLength": 4096 },
    "media_urls": { "type": "array", "items": { "type": "string" }, "description": "MMS/RCS/WhatsApp media attachments" },
    "approval_id": { "type": "string" },
    "driver": { "type": "string" },
    "options": {
      "type": "object",
      "additionalProperties": { "type": "object" }
    }
  },
  "required": ["to", "body"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "message_id": { "type": "string" },
    "status": { "type": "string", "enum": ["queued", "sent", "delivered", "failed"] },
    "channel": { "type": "string", "enum": ["sms", "whatsapp", "rcs"] },
    "to": { "type": "string" },
    "from": { "type": "string" },
    "approval_id": { "type": "string" },
    "driver": { "type": "string" }
  },
  "required": ["message_id", "status", "channel", "to", "approval_id", "driver"]
}
```

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`.

**Decision (see §0 and this document's charter): `send_sms` ships in v0 core, gated by capability, not as a separate extension contract.** It is defined here with a full normative schema so that any driver *can* implement it identically, but it **MUST** be omitted from `tools/list` for any driver where `supports_sms` (or the relevant `supports_whatsapp`/`supports_rcs` flag) is false. Rationale: keeping the schema in core (rather than splitting it into a bolt-on extension spec) means registries and clients that scan schemas see one canonical `send_sms` shape everywhere it exists, instead of drivers inventing incompatible shapes in their own extensions. The cost of degradation is paid by *absence*, which this spec already requires as the universal degradation mechanism (§0.1.2) — there is no need for a second, weaker mechanism just for this one tool. A driver that cannot support any messaging channel simply never advertises `send_sms`, full stop; it is not shipped as a "mostly-no-op" tool that appears everywhere and errors most places.

---

### 1.10 `search_numbers`

Read-only search for purchasable phone numbers.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string", "description": "ISO 3166-1 alpha-2" },
    "area_code": { "type": "string" },
    "capabilities_required": {
      "type": "array",
      "items": { "type": "string", "enum": ["voice", "sms", "mms", "whatsapp"] }
    },
    "driver": { "type": "string" },
    "cursor": { "type": "string" }
  },
  "required": ["country"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "numbers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "number": { "type": "string" },
          "country": { "type": "string" },
          "capabilities": { "type": "array", "items": { "type": "string" } },
          "monthly_price_usd": { "type": ["number", "null"] },
          "setup_price_usd": { "type": ["number", "null"] }
        },
        "required": ["number", "country", "capabilities"]
      }
    },
    "next_cursor": { "type": ["string", "null"] },
    "driver": { "type": "string" }
  },
  "required": ["numbers", "next_cursor", "driver"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

---

### 1.11 `buy_number`

Purchases a phone number. Spends money — **not** contacting a third party, so **no human approval gate** per the standing constraint. Uses MCP elicitation only for jurisdiction-variable compliance fields (e.g. US 10DLC brand/campaign registration), never for authorization.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "number": { "type": "string", "description": "a number returned by search_numbers" },
    "driver": { "type": "string" },
    "compliance": {
      "type": "object",
      "additionalProperties": true,
      "description": "jurisdiction-variable fields (10DLC brand/campaign IDs, KYC references, etc.); server MAY elicit these interactively if omitted and required"
    },
    "options": {
      "type": "object",
      "additionalProperties": { "type": "object" }
    }
  },
  "required": ["number"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "number": { "type": "string" },
    "status": { "type": "string", "enum": ["active", "pending_compliance", "pending_provider"] },
    "monthly_price_usd": { "type": ["number", "null"] },
    "compliance_required": {
      "type": "array",
      "items": { "type": "string" },
      "description": "outstanding compliance field names, if status=pending_compliance"
    },
    "driver": { "type": "string" }
  },
  "required": ["number", "status", "driver"]
}
```

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`.

`destructiveHint: true` here reflects irreversible spend, not third-party contact — see §4 for why this is a distinct rationale from `make_call`/`end_call`.

---

### 1.12 `configure_number`

Updates routing/configuration for an already-owned number (e.g. which agent/assistant it routes to, SMS webhook target, caller-ID name).

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "number": { "type": "string" },
    "driver": { "type": "string" },
    "agent_config_ref": { "type": ["string", "null"] },
    "sms_webhook_url": { "type": ["string", "null"] },
    "caller_id_name": { "type": ["string", "null"] },
    "options": {
      "type": "object",
      "additionalProperties": { "type": "object" }
    }
  },
  "required": ["number"],
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "number": { "type": "string" },
    "status": { "type": "string", "enum": ["updated"] },
    "driver": { "type": "string" }
  },
  "required": ["number", "status", "driver"]
}
```

**Annotations:** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

If a driver lacks `supports_number_configuration`, this tool **MUST NOT** appear in its `tools/list`.

---

### 1.13 `list_numbers`

Read-only inventory of owned numbers.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "driver": { "type": "string" },
    "cursor": { "type": "string" }
  },
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "numbers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "number": { "type": "string" },
          "country": { "type": "string" },
          "capabilities": { "type": "array", "items": { "type": "string" } },
          "agent_config_ref": { "type": ["string", "null"] },
          "acquired_at": { "type": "string" }
        },
        "required": ["number", "country", "capabilities", "acquired_at"]
      }
    },
    "next_cursor": { "type": ["string", "null"] },
    "driver": { "type": "string" }
  },
  "required": ["numbers", "next_cursor", "driver"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

---

### 1.14 `list_calls`

Read-only call history/inventory.

**Input schema:**
```json
{
  "type": "object",
  "properties": {
    "driver": { "type": "string" },
    "since": { "type": "string" },
    "until": { "type": "string" },
    "status": { "type": "string", "enum": ["queued", "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled", "any"], "default": "any" },
    "cursor": { "type": "string" }
  },
  "additionalProperties": false
}
```

**Output shape:**
```json
{
  "type": "object",
  "properties": {
    "calls": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "call_id": { "type": "string" },
          "to": { "type": "string" },
          "from": { "type": "string" },
          "status": { "type": "string" },
          "started_at": { "type": ["string", "null"] },
          "ended_at": { "type": ["string", "null"] },
          "duration_seconds": { "type": ["integer", "null"] }
        },
        "required": ["call_id", "to", "from", "status"]
      }
    },
    "next_cursor": { "type": ["string", "null"] },
    "driver": { "type": "string" }
  },
  "required": ["calls", "next_cursor", "driver"]
}
```

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

---

## 2. Capability model

### 2.1 Capability flags

`list_drivers` (§1.1) is the single source of truth for what a configured driver can do. The canonical flag set:

| Flag | Meaning |
|---|---|
| `supports_sms` | `send_sms` with `channel: sms` is available and functionally real (not agent-mediated-only) |
| `supports_whatsapp` | `send_sms` with `channel: whatsapp` is available |
| `supports_rcs` | `send_sms` with `channel: rcs` is available |
| `supports_recording` | `get_recording` returns real audio |
| `supports_hangup` | `end_call` can actually terminate a live call server-side |
| `supports_number_purchase` | `buy_number` is available (not UI-only, not BYO-carrier-only) |
| `supports_number_configuration` | `configure_number` is available |
| `supports_realtime_transcription` | `get_transcript` resource links stream live, not just post-call |
| `supports_elicitation_approval` | the driver's transport can carry `elicitation/create`; if false, only the out-of-band URL / allowlist path (§3.4) is reachable |
| `max_concurrent_calls` | integer ceiling, or `null` if unbounded/unknown |
| `regions` | ISO country codes (or `GLOBAL`) the driver can originate/terminate calls in |

A driver **MAY** add additional non-normative capability keys (e.g. `supports_ivr_dtmf`) — clients **MUST** tolerate unknown keys in the `capabilities` object per the schema's `additionalProperties: true`.

### 2.2 Dynamic `tools/list` behavior

The CallMCP server **MUST** declare `tools.listChanged: true` in its `initialize` response. Concretely:

- At `initialize` time, and whenever the active driver configuration changes, the server computes the intersection of "tools defined in this spec" and "tools this configuration's capability flags permit," and returns exactly that set from `tools/list`.
- `buy_number` simply does not appear in `tools/list` for a Dograh-backed configuration (no `supports_number_purchase`). `end_call` does not appear for a Retell- or Synthflow-backed configuration. `send_sms` does not appear unless a driver flags real support. This is the mechanism, not an exception to it.
- Whenever the tool set changes (a driver is added/removed/reconfigured, or a capability flag flips — e.g. AgentLine's dormant x402 endpoint activating), the server **MUST** emit `notifications/tools/list_changed` so connected clients re-fetch `tools/list` rather than caching a stale set.
- This mirrors the GitHub MCP server's "toolsets" precedent: dynamic discovery scoped to configuration, not a static maximal tool list with runtime `UNSUPPORTED_CAPABILITY` errors as the primary signal. `UNSUPPORTED_CAPABILITY` (§5) still exists as a defense-in-depth error for stale-cache races, not as the intended discovery path.

### 2.3 Multi-driver addressing

When more than one driver is configured, every tool accepts an optional `driver` field (the `driver_id` from `list_drivers`). If omitted, the server routes to whichever driver has `default: true`. Resource links use `driver:resource` addressing internally (e.g. a `tel://calls/{call_id}/transcript` resource is associated with exactly one driver at creation time, recorded in server state — the URI itself stays driver-agnostic so clients don't need to parse driver identity out of it).

---

## 3. Approval semantics

This section is the normative answer to the standing constraint: **outbound `make_call` and `send_sms` are always human-approval-gated**, tiered, and the gate must never silently block progress or silently open a hole.

### 3.1 State machine

```
                 ┌─────────────┐
   created  ───► │   pending   │
                 └──────┬──────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
  ┌───────────┐   ┌───────────┐   ┌───────────┐
  │ approved  │   │  denied   │   │  expired  │
  └───────────┘   └───────────┘   └───────────┘
```

- `requested` is the transient client-side moment `request_call_approval` is called; the server's first persisted state is always `pending`.
- `pending → approved`: the human accepts, either via MCP elicitation response or via the out-of-band URL (§3.4).
- `pending → denied`: the human declines via either path. A denied approval **MUST NOT** be resurrected; a new `request_call_approval` call is required.
- `pending → expired`: `ttl_seconds` elapses with no decision. Default TTL is tier-dependent (§3.2). An expired approval behaves identically to denied for gating purposes but is reported distinctly so clients can distinguish "no one said yes" from "someone said no."
- Terminal states (`approved`, `denied`, `expired`) are immutable. `campaign_batch` approvals are the one exception where a single `approval_id` in `approved` state is consumed incrementally (see §3.2) rather than being single-use.

### 3.2 Scope tiers

| Scope | Grants | Default TTL | Consumption |
|---|---|---|---|
| `single_call` | exactly one call or message to one destination | 15 minutes | one-shot; `make_call`/`send_sms` consumes it on first use |
| `allowlist_add` | a standing entry (exact number or wildcard pattern) that future `make_call`/`send_sms` calls match against without needing a fresh `approval_id` | no expiry by default (`ttl_seconds` MAY be set to make it temporary); revocable at any time via a driver-side allowlist-removal path outside this spec's v0 tool set | reusable until revoked or expired |
| `campaign_batch` | up to `campaign_max_contacts` distinct destinations under one human sign-off (e.g. "yes, call these 200 leads about X") | 7 days | decrements `remaining_uses`; exhausted or expired batches stop matching |

These are defaults, not hardcoded constants — a driver **MAY** expose tighter organizational policy (e.g. a compliance-conscious deployment forcing `single_call` TTL down to 5 minutes) via its own configuration surface, but **MUST NOT** loosen the ceiling (no driver may make `single_call` reusable, no driver may make a `campaign_batch` uncapped).

### 3.3 Elicitation flow (primary path)

When the connected client declares elicitation support (`supports_elicitation_approval` true for this session) and the driver flags `supports_elicitation_approval`:

1. `request_call_approval` (or an inline gate inside `make_call`/`send_sms` when no approval was pre-created) triggers `elicitation/create` per MCP 2025-11-25, presenting the human with `purpose`, `destinations`, `channel`, and `scope`.
2. The human's client-side response — accept / decline / cancel — is translated to `approved` / `denied` / `expired` (a `cancel` is treated as `expired`, not `denied`, since the human didn't affirmatively refuse).
3. If `make_call`/`send_sms` triggered the elicitation inline (no pre-existing `approval_id`), the tool call itself blocks (or, if `execution.taskSupport` is in play, resolves as a long-running task) until the elicitation resolves, then proceeds or returns `APPROVAL_DENIED`/`APPROVAL_REQUIRED` accordingly.

### 3.4 Non-elicitation fallback (the gate never silently blocks or silently opens)

Many MCP clients do not implement elicitation — it is client-optional in the spec. CallMCP defines exactly one fallback, deliberately narrow:

1. **Out-of-band approval URL.** When `request_call_approval` is called (or a gate is hit inline) and the server detects the connected client cannot elicit, the tool result **MUST** include a fully-formed `out_of_band_url` (§1.2 output) that a human can open in any browser to approve or deny, independent of the MCP session. The tool call itself returns immediately with `state: "pending"` and `elicitation_used: false` rather than blocking indefinitely — an agent **MUST** poll `list_approvals` or `get_call_status`/retry `make_call` rather than hang the connection.
2. **Pre-registered allowlists.** The only way a destination is contacted with *zero* per-call human interaction is a standing `allowlist_add` approval that a human explicitly created (via elicitation or the out-of-band URL) ahead of time. There is no third path. A driver **MUST NOT** invent a silent default-allow behavior for non-elicitation clients — that would silently open the gate, which is the one failure mode this spec forbids as strongly as the reverse (silently blocking forever with no visible path to unblock).
3. Conformant servers **MUST** ensure the out-of-band URL is short-lived-safe (single-use token, tied to the specific `approval_id`) and **MUST NOT** require the approving human to have any MCP client at all — it is a plain web page.

### 3.5 Scope of the constraint

The gate applies to `make_call` and `send_sms` only (contacting a third party). It explicitly does **not** apply to `search_numbers`, `buy_number`, `configure_number`, `list_numbers`, `list_drivers`, `list_approvals`, `list_calls`, `get_call_status`, `get_transcript`, or `get_recording` — none of those contact anyone other than the operating agent's own infrastructure/provider account.

---

## 4. Annotations reference table

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|
| `list_drivers` | true | false | true | false |
| `request_call_approval` | false | false | false | false |
| `list_approvals` | true | false | true | false |
| `make_call` | false | **true** | false | true |
| `end_call` | false | **true** | true | true |
| `get_call_status` | true | false | true | false |
| `get_transcript` | true | false | true | false |
| `get_recording` | true | false | true | false |
| `send_sms` | false | **true** | false | true |
| `search_numbers` | true | false | true | false |
| `buy_number` | false | **true** | false | true |
| `configure_number` | false | false | true | false |
| `list_numbers` | true | false | true | false |
| `list_calls` | true | false | true | false |

Rule of thumb encoded in this table: every `list_*`/`get_*` tool is `readOnlyHint: true`. Every tool that reaches a third-party phone number, terminates a live call, or spends money is `destructiveHint: true` — but for two distinct reasons that clients rendering approval UI should not conflate: `make_call`/`end_call`/`send_sms` are destructive because they act on **another party**; `buy_number` is destructive because it is **irreversible spend**, not third-party contact (which is exactly why `buy_number` carries no approval gate while the other three do — see §0.1.4 and §3.5). A client MAY choose to render these two `destructiveHint` rationales with different confirmation copy, but both MUST be gated by *some* explicit user-facing signal before firing, per MCP's own guidance that destructive tools warrant confirmation.

---

## 5. Error taxonomy

All CallMCP errors are returned as MCP tool errors (`isError: true` in the tool result) with a structured `error` object in the content, of this shape:

```json
{
  "type": "object",
  "properties": {
    "code": { "type": "string" },
    "message": { "type": "string" },
    "details": { "type": "object", "additionalProperties": true }
  },
  "required": ["code", "message"]
}
```

### 5.1 `UNSUPPORTED_CAPABILITY`

Defense-in-depth only — the primary discovery path is a tool's *absence* from `tools/list` (§2.2). This error exists for the race where a client has a stale tool-list cache and calls a tool the current driver configuration no longer supports.

```json
{ "code": "UNSUPPORTED_CAPABILITY", "message": "driver 'dograh' does not support buy_number", "details": { "driver": "dograh", "tool": "buy_number", "missing_flag": "supports_number_purchase" } }
```

### 5.2 `APPROVAL_REQUIRED`

Returned by `make_call`/`send_sms` when no `approval_id` was supplied, no allowlist match exists, and the connected client does not support elicitation (so the server cannot elicit inline and must not silently open the gate).

```json
{ "code": "APPROVAL_REQUIRED", "message": "no valid approval covers +14155551234; elicitation unsupported by this client", "details": { "to": "+14155551234", "out_of_band_url": "https://approve.callmcp.dev/a/9f2c...", "expires_at": "2026-07-10T18:04:00Z" } }
```

### 5.3 `APPROVAL_DENIED`

The human explicitly declined via elicitation or the out-of-band URL.

```json
{ "code": "APPROVAL_DENIED", "message": "approval a_9f2c... was denied", "details": { "approval_id": "a_9f2c...", "decided_at": "2026-07-09T18:06:11Z" } }
```

### 5.4 `INSUFFICIENT_FUNDS`

Returned by any tool that spends money (`buy_number`, usage-metered `make_call`/`send_sms` on prepaid drivers) when the agent's funding source (including x402 machine-payment flows) cannot cover the cost. Embeds an x402 challenge so an agent capable of machine payments can settle it and retry, per the x402 spec's 402 challenge shape.

```json
{
  "code": "INSUFFICIENT_FUNDS",
  "message": "insufficient balance to complete buy_number",
  "details": {
    "required_usd": 1.15,
    "available_usd": 0.20,
    "x402": {
      "x402Version": 1,
      "accepts": [
        {
          "scheme": "exact",
          "network": "base",
          "resource": "https://api.callmcp.dev/v0/numbers/buy",
          "description": "USDC payment to complete number purchase",
          "mimeType": "application/json",
          "payTo": "0xA1b2C3d4E5f6...",
          "maxAmountRequired": "1150000",
          "asset": "USDC",
          "maxTimeoutSeconds": 300
        }
      ]
    }
  }
}
```

### 5.5 `KYC_REQUIRED`

Honest compliance surfacing — several backends gate `buy_number`/`configure_number` behind identity verification (Retell Persona, Telnyx Level-2 KYC, 10DLC brand/campaign registration). Rather than hiding this, the error names exactly what's outstanding.

```json
{
  "code": "KYC_REQUIRED",
  "message": "carrier requires identity verification before this number can be provisioned",
  "details": {
    "driver": "twilio_openai",
    "provider_verification_url": "https://www.twilio.com/console/.../verify",
    "outstanding": ["business_registration", "10dlc_brand_registration"],
    "typical_turnaround": "1-15 business days"
  }
}
```

### 5.6 Driver-native error passthrough envelope

When a driver's own backend returns an error this taxonomy has no mapping for, the server **MUST NOT** swallow it or force it into an ill-fitting code. It is wrapped in a passthrough envelope so clients still get a stable top-level shape while preserving the original signal for debugging:

```json
{
  "code": "DRIVER_ERROR",
  "message": "upstream driver returned an unmapped error",
  "details": {
    "driver": "kaicalls",
    "driver_native_code": "vapi_call_failed_no_available_agent",
    "driver_native_message": "No agent instance available to accept call",
    "http_status": 503
  }
}
```

---

## 6. Conformance

### 6.1 Machine-readable capability manifest

Independent of the live `list_drivers` MCP response, a driver package **MUST** ship a static `callmcp.manifest.json` (validated at publish time, e.g. by the registries in the distribution hit-list) with this JSON Schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CallMCP Driver Capability Manifest",
  "type": "object",
  "properties": {
    "spec_version": { "type": "string", "const": "0.1.0" },
    "driver_id": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
    "display_name": { "type": "string" },
    "kind": { "type": "string", "enum": ["hosted", "local", "byok"] },
    "repository_url": { "type": "string", "format": "uri" },
    "tools": {
      "type": "object",
      "description": "one entry per tool this driver claims to support",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "supported": { "type": "boolean" },
          "notes": { "type": "string" }
        },
        "required": ["supported"]
      }
    },
    "capabilities": {
      "type": "object",
      "properties": {
        "supports_sms": { "type": "boolean" },
        "supports_whatsapp": { "type": "boolean" },
        "supports_rcs": { "type": "boolean" },
        "supports_recording": { "type": "boolean" },
        "supports_hangup": { "type": "boolean" },
        "supports_number_purchase": { "type": "boolean" },
        "supports_number_configuration": { "type": "boolean" },
        "supports_realtime_transcription": { "type": "boolean" },
        "supports_elicitation_approval": { "type": "boolean" },
        "max_concurrent_calls": { "type": ["integer", "null"] },
        "regions": { "type": "array", "items": { "type": "string" } }
      },
      "required": [
        "supports_sms", "supports_recording", "supports_hangup",
        "supports_number_purchase", "supports_number_configuration",
        "supports_realtime_transcription", "supports_elicitation_approval",
        "max_concurrent_calls", "regions"
      ]
    },
    "known_degradations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "tool_or_capability": { "type": "string" },
          "reason": { "type": "string" },
          "upstream_tracking_url": { "type": ["string", "null"] }
        },
        "required": ["tool_or_capability", "reason"]
      }
    }
  },
  "required": ["spec_version", "driver_id", "display_name", "kind", "tools", "capabilities"]
}
```

### 6.2 Conformance test outline

Lives operationally in the CallMCP repo's conformance suite (a separate build), but this spec fixes what it must assert:

**For every capability the manifest claims `true`:**
1. The corresponding tool(s) **MUST** be present in a live `tools/list` call against that driver.
2. A live invocation **MUST** succeed end-to-end against a test destination/sandbox credential and return an output matching this spec's schema (§1) — not merely 200-OK, but shape-valid.
3. For `supports_hangup`: a live `make_call` followed by `end_call` **MUST** result in `get_call_status` reporting a terminal state within a bounded time window.
4. For `supports_recording`: `get_recording` on a completed test call **MUST** eventually return `status: "ready"` with a fetchable `resource_link`.
5. For `supports_realtime_transcription`: a `resources/subscribe` on the call's `tel://` transcript URI **MUST** receive at least one update notification before the call ends.
6. For `supports_sms`/`supports_whatsapp`/`supports_rcs`: `send_sms` with that `channel` **MUST** return `status` progressing from `queued` to `sent` (or `delivered`, transport-permitting) without manual intervention.
7. For `supports_number_purchase`: `search_numbers` → `buy_number` on a sandbox/test carrier account **MUST** result in the number appearing in a subsequent `list_numbers` call.

**For every capability the manifest claims `false` (or omits):**
1. The corresponding tool(s) **MUST NOT** appear in a live `tools/list` call.
2. If a client forces the call anyway (bypassing discovery), the server **MUST** return `UNSUPPORTED_CAPABILITY`, never a bare transport-level error or a silent success.

**Cross-cutting, applies to every driver regardless of manifest contents:**
1. `make_call` and `send_sms` **MUST** fail with `APPROVAL_REQUIRED` or `APPROVAL_DENIED` when invoked with no valid approval and no allowlist match — a conformance run **MUST** include a negative test proving the gate cannot be bypassed.
2. `buy_number` **MUST** succeed with zero approval-related fields required, proving the constraint's asymmetry (§0.1.4) is actually implemented, not just documented.
3. Every list-shaped tool **MUST** honor `cursor`/`next_cursor` pagination without duplicate or dropped entries across pages.

---

## 7. Degradation appendix

This is the honest matrix, not a footnote. Publishing it in full — rather than smoothing it over — **is** the marketing: no competitor in this category combines a provider-neutral contract with a documented, capability-flagged degradation surface. Hiding gaps would cost more credibility with registries that scan schemas (Glama) and with driver implementers than naming them plainly does.

| Tool / capability | Known gaps at spec-writing time | How the contract expresses it |
|---|---|---|
| `buy_number` (`supports_number_purchase`) | Absent on **Synthflow** (UI-only provisioning, no API), **ElevenLabs** (BYO-number only, no purchase API), **Dograh** (BYO carrier account, no purchase flow), **Phonely** (not independently drivable) | Tool omitted from `tools/list`; manifest declares `supports_number_purchase: false` with `known_degradations` reason |
| `end_call` (`supports_hangup`) | Absent on **Retell** and **Synthflow** (no hangup endpoint at all); **Dograh** has no external hangup endpoint; **Vapi** supports it only via an ephemeral `controlUrl` issued per-call, not a stable REST endpoint — a Vapi-backed driver implementation must treat that `controlUrl` as call-scoped internal state, not something reusable across calls | Tool omitted for Retell/Synthflow/Dograh backends; a Vapi driver that wires `controlUrl` correctly is the one path to `supports_hangup: true` among this group |
| `send_sms` (`supports_sms`/`whatsapp`/`rcs`) | The most degraded tool in the whole contract. Only **Telnyx**, **Bland**, **Autocalls**, and **Thoughtly** expose real standalone SMS. **Vapi**, **Retell**, and **Synthflow** are agent-mediated only (the voice agent can be prompted to "text the caller," but there is no standalone send tool a driver can wrap honestly). **Millis**, **Vogent**, and **Dograh** have no SMS capability at all. **AgentLine** is an open contradiction in its own public materials — its `SKILL.md` explicitly forbids SMS while its live API spec defines `POST /v1/messages`; this spec does not resolve that contradiction on AgentLine's behalf, it is simply cited as unresolved upstream | Tool omitted entirely for drivers with no real standalone send path (agent-mediated-only is not "supports_sms: true" — mediation through a voice agent prompt is not a stable, testable API surface and must not be represented as one) |
| `get_recording` (`supports_recording`) | **AgentLine** has no recording capability at all. **LiveKit**-based backends require standing up the separate LiveKit Egress service — recording is not intrinsic to the core call path | Tool omitted for AgentLine-class backends; a LiveKit-based driver only claims `supports_recording: true` once Egress is actually wired, not merely because LiveKit-the-platform theoretically supports it |
| `get_transcript` (`supports_realtime_transcription` / baseline transcript) | **LiveKit**/**Pipecat**-local stacks require DIY event capture — there is no standing transcript endpoint, the driver must assemble it from realtime session events. **Bolna**'s transcript endpoint is unconfirmed (docs did not resolve during research). **Telnyx**'s exact transcript GET route is unverified. **Dograh** is the one fully source-verified case: `GET /{workflow_id}/runs/{run_id}` returns a `transcript_url` | Drivers with DIY-only capture may still claim baseline `get_transcript` support once they've actually implemented the assembly layer, but MUST NOT claim `supports_realtime_transcription: true` unless a live `resources/subscribe` stream genuinely delivers incremental updates (per conformance test 6.2) |

Any driver author who finds their backend's real capability differs from this table (platforms change) **MUST** update their own manifest (§6.1), not this spec — this table is a snapshot at spec-writing time (2026-07-09), not a normative ceiling.

---

## 8. Spec revision note

This document targets **MCP spec revision 2025-11-25** — the revision in which `elicitation/create`, session-based `initialize`, and the annotation fields used throughout this document (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `execution.taskSupport`) are defined as referenced here.

A known future migration surface: the **2026-07-28 stateless RC** changes the protocol materially — it goes stateless, drops `initialize` as a session-establishing handshake, and changes discovery mechanics. Approval, elicitation, and session semantics (§3) differ enough under that RC that this spec's §2.2 (dynamic `tools/list` + `notifications/tools/list_changed`) and §3.3 (elicitation flow) will need a dedicated migration note once the RC stabilizes past preview. **v0.1.0 deliberately does not build against the RC** — it targets the shipped 2025-11-25 revision so drivers have a stable, implementable target today, with the RC migration tracked as a follow-up spec revision (targeted `v0.2.0`) rather than blocking this release.

---

## Appendix A — Out of v0 scope (carried forward from the decision memo, not reopened here)

Agent-configuration tools (`create_agent`, `update_agent`, prompt/voice/model tuning) are explicitly **not** part of this contract. Backend config models diverge too structurally to unify honestly: flat system-prompt strings (Vapi/Retell-style), node-graph "Pathways" (Bland-style), and workflow JSON (Dograh-style) are not the same shape wearing different field names — forcing them into one schema would produce the same kind of dishonest abstraction this spec's degradation appendix exists to avoid. That surface belongs in a future, optional, higher-layer extension contract, versioned independently of this core spec.

## Appendix B — Version history

| Version | Date | Change |
|---|---|---|
| v0.1.0 | 2026-07-09 | Initial public draft. 14-tool core contract, capability model, approval semantics, error taxonomy, conformance manifest schema, degradation appendix. |
