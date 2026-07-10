/**
 * KaiCallsDriver — maps the CallMCP `Driver` contract (SPEC.md, every
 * method typed in `@callmcp/driver-interface`) onto KaiCalls' real,
 * production 38-tool MCP backend, as documented in
 * https://callmcp.ai/llms.txt and https://callmcp.ai/skill.md.
 *
 * Tool mapping (every one of these tool NAMES is directly confirmed by
 * llms.txt's tool inventory — nothing here is guessed):
 *
 *   Driver method      KaiCalls MCP tool         Scope
 *   ------------------  -------------------------  --------------
 *   makeCall            make_call                  calls:write
 *   getCallStatus       check_call_status          calls:read
 *   getTranscript       get_transcript             calls:read
 *   getRecording        get_call_recording         calls:read
 *   sendSms             send_sms                   sms:write
 *   searchNumbers       search_available_numbers   numbers:read
 *   buyNumber           buy_number                 numbers:write
 *   configureNumber     attach_number / detach_number  numbers:write
 *   listNumbers         list_numbers                numbers:read
 *   listCalls           list_recent_calls           calls:read
 *   endCall             (none — see manifest.ts)    n/a
 *
 * What is NOT confirmed by the source docs, and how this file handles it:
 * llms.txt/skill.md are index/onboarding documents. They enumerate tool
 * names, scopes, and categories precisely, but explicitly defer full JSON
 * Schemas to a live `tools/list` call or `.well-known/mcp.json` ("call
 * tools/list ... for the full JSON Schema of every tool"). This file does
 * NOT invent a confident schema for request/response field names. Instead:
 *   - Outbound `arguments` objects use the most natural field names implied
 *     by each tool's own name and by CallMCP SPEC's own parameter
 *     vocabulary (this backend IS the reference implementation the SPEC
 *     was modeled on — SPEC §5.6's own worked example cites
 *     `"driver": "kaicalls"` and a Vapi-flavored native error code).
 *   - Inbound results are parsed defensively via `firstDefined(...)` over
 *     several plausible key aliases (e.g. `call_id` vs `id`), so a
 *     reasonable field-naming mismatch degrades gracefully instead of
 *     throwing.
 *   - Anywhere this driver had to pick a specific behavior with no
 *     documentary basis (default statuses, fallback capabilities, etc.),
 *     there's a comment saying so at the point of the guess.
 * Field-level behavior here should be re-verified against a live
 * `tools/list` response before production use — see
 * `manifest.ts`'s `known_degradations` entry for this exact caveat.
 */

import type {
  BuyNumberParams,
  BuyNumberResult,
  BuyNumberStatus,
  CallLifecycleStatus,
  CallMcpError,
  CallMcpErrorCode,
  CallSummary,
  CapabilityManifest,
  ConfigureNumberParams,
  ConfigureNumberResult,
  Driver,
  GetCallStatusParams,
  GetCallStatusResult,
  GetRecordingParams,
  GetRecordingResult,
  GetTranscriptParams,
  GetTranscriptResult,
  ListCallsParams,
  ListCallsResult,
  ListNumbersParams,
  ListNumbersResult,
  MakeCallParams,
  MakeCallResult,
  MakeCallStatus,
  MessageStatus,
  OwnedNumber,
  RecordingStatus,
  SearchNumbersParams,
  SearchNumbersResult,
  SendSmsParams,
  SendSmsResult,
  TranscriptStatus,
  TranscriptTurn,
} from "@callmcp/driver-interface";
import { UnsupportedCapabilityError } from "@callmcp/driver-interface";
import { KaiCallsApiError, KaiCallsClient, type KaiCallsClientConfig } from "./client.js";
import { KAICALLS_MANIFEST } from "./manifest.js";

/**
 * KaiCalls' documented OAuth2-style scopes (llms.txt "Scopes" section),
 * threaded through call sites purely as self-documentation of which scope
 * a caller's `kc_live_...` key needs for each tool — this driver does not
 * enforce scopes itself (KaiCalls does, server-side, per llms.txt: "each
 * tool requires an OAuth2-style scope checked against the key").
 */
type KaiCallsScope =
  | "calls:read"
  | "calls:write"
  | "numbers:read"
  | "numbers:write"
  | "sms:read"
  | "sms:write";

/**
 * SPEC §5.6 driver-native error passthrough envelope. Thrown by every
 * `KaiCallsDriver` method when the underlying `KaiCallsClient` call fails,
 * since llms.txt/skill.md do not publish a confirmed KaiCalls-native error
 * code vocabulary this driver could map into the more specific taxonomy
 * entries (`INSUFFICIENT_FUNDS`, `KYC_REQUIRED`, etc.) — guessing a mapping
 * would be dishonest. `DRIVER_ERROR` is the taxonomy's own documented
 * escape hatch for exactly this situation.
 */
export class KaiCallsDriverError extends Error implements CallMcpError {
  readonly code: CallMcpErrorCode = "DRIVER_ERROR";
  readonly details: Record<string, unknown>;

  constructor(tool: string, cause: KaiCallsApiError) {
    super(`KaiCalls driver: tool "${tool}" failed: ${cause.message}`);
    this.name = "KaiCallsDriverError";
    this.details = {
      driver: "kaicalls",
      driver_native_message: cause.message,
      http_status: cause.httpStatus,
      json_rpc_code: cause.jsonRpcCode,
      tool,
      raw: cause.toolErrorPayload,
    };
  }
}

export type KaiCallsDriverConfig = KaiCallsClientConfig;

export class KaiCallsDriver implements Driver {
  readonly id = "kaicalls";
  private readonly client: KaiCallsClient;

  /** Accepts either connection config, or a pre-built `KaiCallsClient` (e.g. one wired with a mock `fetchImpl` for tests). */
  constructor(configOrClient: KaiCallsDriverConfig | KaiCallsClient = {}) {
    this.client = configOrClient instanceof KaiCallsClient ? configOrClient : new KaiCallsClient(configOrClient);
  }

  getManifest(): CapabilityManifest {
    return KAICALLS_MANIFEST;
  }

  // -------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------

  async makeCall(params: MakeCallParams): Promise<MakeCallResult> {
    const args = compact({
      to: params.to,
      from: params.from,
      agent_id: params.agent_config_ref,
      max_duration_seconds: params.max_duration_seconds,
      metadata: params.metadata,
    });
    const raw = asRecord(await this.invoke("make_call", args, "calls:write"));

    const call_id = str(firstDefined(raw.call_id, raw.id));
    if (!call_id) {
      throw this.malformed("make_call", raw);
    }

    return {
      call_id,
      status: mapMakeCallStatus(str(firstDefined(raw.status, raw.call_status))),
      to: str(raw.to) ?? params.to,
      ...compact({ from: str(firstDefined(raw.from, params.from)) }),
      // KaiCalls has no native concept of a CallMCP approval_id (approval
      // gating is server-core per SPEC §3, enforced upstream of this
      // driver) — echo back whatever the caller supplied, or a sentinel
      // making the absence explicit, mirroring MockDriver's convention.
      approval_id: params.approval_id ?? "kaicalls_no_native_approval_concept",
      started_at: str(firstDefined(raw.started_at, raw.created_at)) ?? null,
      driver: this.id,
    };
  }

  // endCall intentionally omitted — see manifest.ts `tools.end_call` and
  // `known_degradations`. No hangup/terminate-call tool is documented in
  // KaiCalls' 38-tool inventory. Per SPEC §0.1.2 / driver-interface's
  // README, absence is the preferred degradation signal — do NOT implement
  // this to throw by default.

  async getCallStatus(params: GetCallStatusParams): Promise<GetCallStatusResult> {
    const raw = asRecord(await this.invoke("check_call_status", { call_id: params.call_id }, "calls:read"));
    const rawStatus = str(firstDefined(raw.status, raw.call_status, raw.state));
    const rawMetadata = asRecord(raw.metadata);

    return {
      call_id: str(firstDefined(raw.call_id, raw.id)) ?? params.call_id,
      status: mapCallLifecycleStatus(rawStatus),
      ...compact({ to: str(raw.to), from: str(raw.from) }),
      started_at: str(firstDefined(raw.started_at, raw.created_at)) ?? null,
      ended_at: str(firstDefined(raw.ended_at, raw.completed_at)) ?? null,
      duration_seconds: num(firstDefined(raw.duration_seconds, raw.duration)),
      // Preserve the untranslated upstream status string — mapCallLifecycleStatus
      // has to fold KaiCalls' real vocabulary (unconfirmed by source docs)
      // into SPEC's closed enum, which is lossy by construction. Callers
      // who need the raw value can read it back out of metadata.
      metadata: rawStatus ? { ...rawMetadata, kaicalls_raw_status: rawStatus } : rawMetadata,
      driver: this.id,
    };
  }

  async getTranscript(params: GetTranscriptParams): Promise<GetTranscriptResult> {
    const raw = asRecord(await this.invoke("get_transcript", { call_id: params.call_id }, "calls:read"));
    const rawTurns = Array.isArray(raw.transcript)
      ? raw.transcript
      : Array.isArray(raw.turns)
        ? raw.turns
        : undefined;
    const status = mapTranscriptStatus(str(firstDefined(raw.status, raw.transcript_status)), rawTurns);

    if (params.format === "resource_link") {
      // Canonical CallMCP resource-addressing convention (SPEC §1.7),
      // constructed from `call_id` rather than any KaiCalls-native field —
      // mirrors driver-interface's own `MockDriver.getTranscript`.
      return {
        call_id: params.call_id,
        status,
        resource_link: `tel://calls/${params.call_id}/transcript`,
        driver: this.id,
      };
    }

    return {
      call_id: params.call_id,
      status,
      transcript: rawTurns ? rawTurns.map(mapTranscriptTurn) : null,
      driver: this.id,
    };
  }

  async getRecording(params: GetRecordingParams): Promise<GetRecordingResult> {
    const raw = asRecord(await this.invoke("get_call_recording", { call_id: params.call_id }, "calls:read"));
    const rawStatus = str(firstDefined(raw.status, raw.recording_status));
    const hasUrl = Boolean(firstDefined(raw.url, raw.recording_url, raw.audio_url));

    return {
      call_id: params.call_id,
      status: rawStatus ? mapRecordingStatus(rawStatus) : hasUrl ? "ready" : "not_available",
      // Canonical CallMCP resource-addressing convention (SPEC §1.8),
      // constructed from `call_id`, mirroring MockDriver. Note: the
      // *actual* playable KaiCalls recording URL (whatever `url` /
      // `recording_url` field the live tool returns) is not itself part of
      // this spec's `GetRecordingResult` shape — resolving `tel://` links
      // back into real media is a CallMCP server-core concern outside this
      // driver package's `Driver` surface.
      resource_link: `tel://calls/${params.call_id}/recording`,
      mime_type: str(firstDefined(raw.mime_type, raw.content_type)) ?? null,
      duration_seconds: num(firstDefined(raw.duration_seconds, raw.duration)),
      driver: this.id,
    };
  }

  // -------------------------------------------------------------------
  // SMS
  // -------------------------------------------------------------------

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const channel = params.channel ?? "sms";
    if (channel !== "sms") {
      // capabilities.supports_whatsapp / supports_rcs are both false — see
      // manifest.ts. Defense-in-depth per SPEC §5.1: `send_sms` itself
      // stays advertised (supports_sms is true), only the unsupported
      // channel value is rejected.
      throw new UnsupportedCapabilityError(
        this.id,
        "send_sms",
        channel === "whatsapp" ? "supports_whatsapp" : "supports_rcs",
      );
    }

    const args = compact({
      to: params.to,
      body: params.body,
      from: params.from,
      // Passed through opportunistically. KaiCalls' send_sms MMS/media
      // attachment support is not confirmed anywhere in llms.txt/skill.md;
      // this is best-effort and the backend may ignore or reject it.
      media_urls: params.media_urls,
    });
    const raw = asRecord(await this.invoke("send_sms", args, "sms:write"));

    const message_id = str(firstDefined(raw.message_id, raw.id, raw.sms_id));
    if (!message_id) {
      throw this.malformed("send_sms", raw);
    }

    return {
      message_id,
      status: mapMessageStatus(str(firstDefined(raw.status, raw.message_status))),
      channel: "sms",
      to: str(raw.to) ?? params.to,
      ...compact({ from: str(firstDefined(raw.from, params.from)) }),
      approval_id: params.approval_id ?? "kaicalls_no_native_approval_concept",
      driver: this.id,
    };
  }

  // -------------------------------------------------------------------
  // Numbers
  // -------------------------------------------------------------------

  async searchNumbers(params: SearchNumbersParams): Promise<SearchNumbersResult> {
    const args = compact({
      country: params.country,
      area_code: params.area_code,
      capabilities: params.capabilities_required,
    });
    const raw = asRecord(await this.invoke("search_available_numbers", args, "numbers:read"));
    const rawNumbers = Array.isArray(raw.numbers)
      ? raw.numbers
      : Array.isArray(raw.available_numbers)
        ? raw.available_numbers
        : [];

    return {
      numbers: rawNumbers.map((entry) => mapAvailableNumber(entry, params.country)),
      next_cursor: str(raw.next_cursor) ?? null,
      driver: this.id,
    };
  }

  async buyNumber(params: BuyNumberParams): Promise<BuyNumberResult> {
    const args = compact({ number: params.number, compliance: params.compliance });
    const raw = asRecord(await this.invoke("buy_number", args, "numbers:write"));
    const complianceRequired = Array.isArray(raw.compliance_required)
      ? raw.compliance_required.filter(isString)
      : undefined;

    return {
      number: str(firstDefined(raw.number, raw.phone_number)) ?? params.number,
      // No compliance-gating step is described anywhere for KaiCalls' flow
      // (llms.txt's own signup flow provisions "a real phone number... in
      // one round trip", no pending-compliance step mentioned) — default
      // to "active" absent an explicit status field.
      status: mapBuyNumberStatus(str(raw.status)),
      monthly_price_usd: num(raw.monthly_price_usd),
      ...compact({ compliance_required: complianceRequired }),
      driver: this.id,
    };
  }

  async configureNumber(params: ConfigureNumberParams): Promise<ConfigureNumberResult> {
    if (params.sms_webhook_url !== undefined && params.sms_webhook_url !== null) {
      throw new UnsupportedCapabilityError(this.id, "configure_number", "sms_webhook_url");
    }
    if (params.caller_id_name !== undefined && params.caller_id_name !== null) {
      throw new UnsupportedCapabilityError(this.id, "configure_number", "caller_id_name");
    }

    if (params.agent_config_ref === null) {
      await this.invoke("detach_number", { number: params.number }, "numbers:write");
    } else if (params.agent_config_ref !== undefined) {
      await this.invoke(
        "attach_number",
        { number: params.number, agent_id: params.agent_config_ref },
        "numbers:write",
      );
    }
    // If neither field is supplied, there's nothing this driver's mapping
    // can change — KaiCalls exposes no other per-number setting via any
    // documented tool (see manifest.ts).

    return { number: params.number, status: "updated", driver: this.id };
  }

  async listNumbers(params: ListNumbersParams): Promise<ListNumbersResult> {
    const raw = asRecord(await this.invoke("list_numbers", compact({ cursor: params.cursor }), "numbers:read"));
    const rawNumbers = Array.isArray(raw.numbers) ? raw.numbers : [];

    return {
      numbers: rawNumbers.map(mapOwnedNumber),
      next_cursor: str(raw.next_cursor) ?? null,
      driver: this.id,
    };
  }

  // -------------------------------------------------------------------
  // Call history
  // -------------------------------------------------------------------

  async listCalls(params: ListCallsParams): Promise<ListCallsResult> {
    const args = compact({
      since: params.since,
      until: params.until,
      status: params.status && params.status !== "any" ? params.status : undefined,
      cursor: params.cursor,
    });
    const raw = asRecord(await this.invoke("list_recent_calls", args, "calls:read"));
    const rawCalls = Array.isArray(raw.calls) ? raw.calls : [];

    return {
      calls: rawCalls.map(mapCallSummary),
      next_cursor: str(raw.next_cursor) ?? null,
      driver: this.id,
    };
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  /** Calls a KaiCalls MCP tool, translating transport/tool failures into `KaiCallsDriverError` (SPEC §5.6). */
  private async invoke(tool: string, args: Record<string, unknown>, _scope: KaiCallsScope): Promise<unknown> {
    try {
      return await this.client.callTool(tool, args);
    } catch (err) {
      if (err instanceof KaiCallsApiError) {
        throw new KaiCallsDriverError(tool, err);
      }
      throw err;
    }
  }

  private malformed(tool: string, raw: unknown): KaiCallsDriverError {
    return new KaiCallsDriverError(
      tool,
      new KaiCallsApiError(`response was missing an identifying id field`, { toolErrorPayload: raw }),
    );
  }
}

// =====================================================================
// Defensive parsing helpers
// =====================================================================

/** First non-null/non-undefined value among the given candidates. */
function firstDefined<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null) {
      return v;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Builds an object omitting any key whose value is `undefined`. Used both
 * for outbound tool `arguments` (so we never send `{"field": undefined}`
 * to KaiCalls) and for building result objects with optional fields
 * without violating `exactOptionalPropertyTypes` (spreading a `compact()`
 * result never explicitly assigns `undefined` to an optional key).
 */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

// =====================================================================
// Status/shape mapping — see the file-header note on what is and isn't
// confirmed by the source docs.
// =====================================================================

function mapMakeCallStatus(raw: string | undefined): MakeCallStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "ringing":
      return "ringing";
    case "in_progress":
    case "in-progress":
    case "active":
    case "connected":
      return "in_progress";
    case "elicitation_pending":
      return "elicitation_pending";
    case "queued":
    default:
      return "queued";
  }
}

function mapCallLifecycleStatus(raw: string | undefined): CallLifecycleStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "queued":
      return "queued";
    case "ringing":
      return "ringing";
    case "in_progress":
    case "in-progress":
    case "active":
    case "connected":
      return "in_progress";
    case "completed":
    case "complete":
    case "ended":
    case "finished":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "no_answer":
    case "no-answer":
    case "noanswer":
      return "no_answer";
    case "busy":
      return "busy";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      // Unrecognized/unconfirmed status string. Claiming "failed" would be
      // actively misleading (we don't know the call failed); claiming
      // "queued" risks a caller polling past a call that already finished.
      // There's no honest default here — "queued" is chosen because it at
      // least won't be read as a false negative outcome, and the raw
      // string survives in `metadata.kaicalls_raw_status` so callers can
      // branch on it themselves.
      return "queued";
  }
}

function mapMessageStatus(raw: string | undefined): MessageStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "failed":
    case "error":
      return "failed";
    case "queued":
    default:
      return "queued";
  }
}

function mapRecordingStatus(raw: string): RecordingStatus {
  switch (raw.toLowerCase()) {
    case "ready":
    case "available":
    case "complete":
    case "completed":
      return "ready";
    case "processing":
    case "pending":
      return "processing";
    case "not_available":
    default:
      return "not_available";
  }
}

function mapBuyNumberStatus(raw: string | undefined): BuyNumberStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "pending_compliance":
      return "pending_compliance";
    case "pending_provider":
      return "pending_provider";
    case "active":
    default:
      return "active";
  }
}

function mapTranscriptStatus(raw: string | undefined, rawTurns: unknown[] | undefined): TranscriptStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "complete":
    case "completed":
    case "final":
      return "complete";
    case "partial":
    case "in_progress":
    case "pending":
      return "partial";
    case "not_available_yet":
    case "not_available":
      return "not_available_yet";
    default:
      // No explicit status field returned. llms.txt: "Transcripts finalize
      // shortly after the call ends" — treat a non-empty turn list as
      // complete and an empty/absent one as not yet available. This is an
      // inference, not a confirmed rule.
      return rawTurns && rawTurns.length > 0 ? "complete" : "not_available_yet";
  }
}

function mapTranscriptTurn(entry: unknown): TranscriptTurn {
  const r = asRecord(entry);
  return {
    role: mapTranscriptRole(str(firstDefined(r.role, r.speaker, r.from)) ?? "system"),
    text: str(firstDefined(r.text, r.message, r.content)) ?? "",
    at: str(firstDefined(r.at, r.timestamp, r.created_at)) ?? "",
  };
}

function mapTranscriptRole(raw: string): TranscriptTurn["role"] {
  const v = raw.toLowerCase();
  if (v === "agent" || v === "assistant" || v === "ai" || v === "bot") {
    return "agent";
  }
  if (v === "caller" || v === "customer" || v === "user" || v === "human") {
    return "caller";
  }
  return "system";
}

function mapAvailableNumber(entry: unknown, fallbackCountry: string) {
  const r = asRecord(entry);
  return {
    number: str(firstDefined(r.number, r.phone_number)) ?? "",
    country: str(r.country) ?? fallbackCountry,
    // Default assumes every KaiCalls number supports voice+SMS (the whole
    // product is voice+SMS telephony) only when the backend omits explicit
    // per-number capability info — not a confirmed per-number field.
    capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter(isString) : ["voice", "sms"],
    monthly_price_usd: num(firstDefined(r.monthly_price_usd, r.monthly_price)),
    setup_price_usd: num(firstDefined(r.setup_price_usd, r.setup_price)),
  };
}

function mapOwnedNumber(entry: unknown): OwnedNumber {
  const r = asRecord(entry);
  return {
    number: str(firstDefined(r.number, r.phone_number)) ?? "",
    country: str(r.country) ?? "US",
    capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter(isString) : ["voice", "sms"],
    agent_config_ref: str(firstDefined(r.agent_id, r.agent_config_ref)) ?? null,
    // Empty string signals "unknown" honestly rather than fabricating a
    // plausible-looking timestamp when the backend omits one.
    acquired_at: str(firstDefined(r.acquired_at, r.created_at)) ?? "",
  };
}

function mapCallSummary(entry: unknown): CallSummary {
  const r = asRecord(entry);
  return {
    call_id: str(firstDefined(r.call_id, r.id)) ?? "",
    to: str(r.to) ?? "",
    from: str(r.from) ?? "",
    status: str(firstDefined(r.status, r.call_status)) ?? "unknown",
    started_at: str(firstDefined(r.started_at, r.created_at)) ?? null,
    ended_at: str(firstDefined(r.ended_at, r.completed_at)) ?? null,
    duration_seconds: num(firstDefined(r.duration_seconds, r.duration)),
  };
}
