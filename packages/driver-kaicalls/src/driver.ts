/**
 * KaiCallsDriver — maps the CallMCP `Driver` contract (SPEC.md, every
 * method typed in `@callmcp/driver-interface`) onto KaiCalls' real,
 * production 44-tool MCP backend at https://callmcp.ai/mcp.
 *
 * Tool mapping:
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
 * Field-level request/response shapes below are confirmed live (2026-07-10)
 * against an unauthenticated `tools/list` call to https://callmcp.ai/mcp —
 * not guessed from llms.txt/skill.md, which only confirm tool names/scopes,
 * not exact field names. That earlier guesswork was wrong in several places
 * this pass corrected: make_call/check_call_status/get_call_recording all
 * nest their real payload under a `call` object, not top-level; send_sms's
 * real fields are `from_agent_id`/`to`/`message` (not `from`/`body`);
 * buy_number/attach_number/detach_number all key on `phone_number`, not
 * `number`; get_transcript returns a flat string gated by
 * `transcript_available`, not a turn-by-turn array; and
 * search_available_numbers returns bare E.164 strings, not objects. Each
 * fix is called out inline at its call site. The only remaining
 * defensively-guessed shapes are buy_number's nested `number` object and
 * list_numbers' entry objects, whose sub-fields aren't in the published
 * schema at all (typed only as `object`) — see `manifest.ts`'s
 * `known_degradations` entry for that specific residual gap.
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
  SearchNumbersParams,
  SearchNumbersResult,
  SendSmsParams,
  SendSmsResult,
  TranscriptStatus,
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
    // Confirmed live (2026-07-10, unauthenticated tools/list against
    // https://callmcp.ai/mcp): make_call's real inputSchema requires
    // `agent_id` + `to`, and has NO `from` / `max_duration_seconds` /
    // `metadata` fields — CallMCP's generic contract has no field that maps
    // to a KaiCalls agent id other than `agent_config_ref`, so that's the
    // only source; `options.kaicalls.*` reaches the real KaiCalls-only
    // fields (`name`/`context`/`first_message`/`lead_id`) the generic
    // contract has no equivalent for.
    const agentId = params.agent_config_ref ?? str(params.options?.kaicalls?.["agent_id"]);
    if (!agentId) {
      throw this.missingAgentId("make_call");
    }

    const args = compact({
      agent_id: agentId,
      to: params.to,
      name: str(params.options?.kaicalls?.["name"]),
      context: str(params.options?.kaicalls?.["context"]),
      first_message: str(params.options?.kaicalls?.["first_message"]),
      lead_id: str(params.options?.kaicalls?.["lead_id"]),
    });
    const raw = asRecord(await this.invoke("make_call", args, "calls:write"));
    // Confirmed live: the whole result is nested under `call`, not top-level.
    const call = asRecord(raw.call);

    const call_id = str(firstDefined(call.id, call.conversation_id));
    if (!call_id) {
      throw this.malformed("make_call", raw);
    }

    return {
      call_id,
      status: mapMakeCallStatus(str(call.status)),
      to: str(call.to) ?? params.to,
      // KaiCalls has no native concept of a CallMCP approval_id (approval
      // gating is server-core per SPEC §3, enforced upstream of this
      // driver) — echo back whatever the caller supplied, or a sentinel
      // making the absence explicit, mirroring MockDriver's convention.
      approval_id: params.approval_id ?? "kaicalls_no_native_approval_concept",
      // Confirmed live: make_call's output has no timestamp field at all.
      started_at: null,
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
    // Confirmed live: result is nested under `call`; no `to`/`from`/`ended_at`
    // fields exist at all (only `duration_seconds`), and `id` can be null
    // (fall back to `conversation_id`).
    const call = asRecord(raw.call);
    const rawStatus = str(call.status);

    return {
      call_id: str(firstDefined(call.id, call.conversation_id)) ?? params.call_id,
      status: mapCallLifecycleStatus(rawStatus),
      started_at: str(call.created_at) ?? null,
      ended_at: null,
      duration_seconds: num(call.duration_seconds),
      // Preserve the untranslated upstream status string — mapCallLifecycleStatus
      // has to fold KaiCalls' real vocabulary into SPEC's closed enum, which
      // is lossy by construction. Callers who need the raw value, plus the
      // real summary/quality fields with no SPEC-typed home, can read them
      // back out of metadata.
      metadata: compact({
        kaicalls_raw_status: rawStatus,
        summary: str(call.summary),
        quality_dimensions: call.quality_dimensions,
      }),
      driver: this.id,
    };
  }

  async getTranscript(params: GetTranscriptParams): Promise<GetTranscriptResult> {
    const raw = asRecord(await this.invoke("get_transcript", { call_id: params.call_id }, "calls:read"));
    // Confirmed live: `transcript` is a flat STRING (not a turn-by-turn
    // array), gated by a `transcript_available` boolean — there is no
    // per-speaker structure in this tool's response at all.
    const available = raw.transcript_available === true;
    const transcriptText = str(raw.transcript);
    const status: TranscriptStatus = available && transcriptText ? "complete" : "not_available_yet";

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
      // SPEC's `transcript` field is typed as turn objects (role/text/at),
      // but KaiCalls' live tool only ever returns one flat string with no
      // speaker attribution — fabricating a role/turn split would be
      // dishonest, so the whole transcript is carried as a single "system"
      // turn rather than lost or silently reshaped into fake dialogue.
      transcript: transcriptText ? [{ role: "system", text: transcriptText, at: "" }] : null,
      driver: this.id,
    };
  }

  async getRecording(params: GetRecordingParams): Promise<GetRecordingResult> {
    const raw = asRecord(await this.invoke("get_call_recording", { call_id: params.call_id }, "calls:read"));
    // Confirmed live: gated by a top-level `recording_available` boolean;
    // the actual URL and duration are nested under `call`, not top-level —
    // no `mime_type` field exists anywhere in this tool's response.
    const call = asRecord(raw.call);
    const available = raw.recording_available === true && Boolean(call.recording_url);

    return {
      call_id: params.call_id,
      status: available ? "ready" : "not_available",
      // Canonical CallMCP resource-addressing convention (SPEC §1.8),
      // constructed from `call_id`, mirroring MockDriver. Note: the
      // *actual* playable KaiCalls recording URL (`call.recording_url`) is
      // not itself part of this spec's `GetRecordingResult` shape —
      // resolving `tel://` links back into real media is a CallMCP
      // server-core concern outside this driver package's `Driver` surface.
      resource_link: `tel://calls/${params.call_id}/recording`,
      mime_type: null,
      duration_seconds: num(call.duration_seconds),
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

    // Confirmed live: send_sms requires `from_agent_id` (a KaiCalls agent
    // id — NOT a phone number), `to`, and `message` (not `from`/`body`).
    // CallMCP's generic SendSmsParams.from models a caller-id *phone
    // number*, which has no honest mapping onto a KaiCalls agent id, so
    // that agent id can only come from the driver-specific
    // `options.kaicalls.agent_id` extension point.
    const fromAgentId = str(params.options?.kaicalls?.["agent_id"]);
    if (!fromAgentId) {
      throw this.missingAgentId("send_sms");
    }

    const args = compact({
      from_agent_id: fromAgentId,
      to: params.to,
      message: params.body,
      lead_id: str(params.options?.kaicalls?.["lead_id"]),
    });
    const raw = asRecord(await this.invoke("send_sms", args, "sms:write"));

    const message_id = str(raw.message_sid);
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
    // Confirmed live: no `capabilities` input field exists (search is
    // area_code/country/limit only); the result is `available_numbers`, a
    // flat array of plain E.164 STRINGS — no country/price/capability
    // metadata per number at all, unlike this used to assume.
    const args = compact({ country: params.country, area_code: params.area_code });
    const raw = asRecord(await this.invoke("search_available_numbers", args, "numbers:read"));
    const rawNumbers = Array.isArray(raw.available_numbers) ? raw.available_numbers : [];

    return {
      numbers: rawNumbers.map((entry) => mapAvailableNumber(entry, params.country)),
      next_cursor: null,
      driver: this.id,
    };
  }

  async buyNumber(params: BuyNumberParams): Promise<BuyNumberResult> {
    // Confirmed live: the request field is `phone_number`, not `number` —
    // and the response's `number` field is a nested OBJECT (undocumented
    // sub-shape), not the string this used to assume; `compliance` is
    // `{ high_risk_category, disclosure_note }`, not a `compliance_required`
    // string array. Defensive candidate-key parsing on the nested object
    // since its exact fields aren't in the published schema.
    const args = compact({ phone_number: params.number, business_id: str(params.options?.kaicalls?.["business_id"]) });
    const raw = asRecord(await this.invoke("buy_number", args, "numbers:write"));
    const numberObj = asRecord(raw.number);
    const compliance = asRecord(raw.compliance);
    const complianceRequired = compliance.high_risk_category === true
      ? [str(compliance.disclosure_note) ?? "high_risk_category"]
      : undefined;

    return {
      number: str(firstDefined(numberObj.phone_number, numberObj.number, numberObj.e164)) ?? params.number,
      // No compliance-gating step is described anywhere for KaiCalls' flow
      // (llms.txt's own signup flow provisions "a real phone number... in
      // one round trip", no pending-compliance step mentioned) — default
      // to "active" absent an explicit status field.
      status: mapBuyNumberStatus(str(raw.status)),
      monthly_price_usd: num(firstDefined(numberObj.monthly_price_usd, raw.monthly_price_usd)),
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

    // Confirmed live: both attach_number and detach_number take
    // `phone_number`, not `number`.
    if (params.agent_config_ref === null) {
      await this.invoke("detach_number", { phone_number: params.number }, "numbers:write");
    } else if (params.agent_config_ref !== undefined) {
      await this.invoke(
        "attach_number",
        { phone_number: params.number, agent_id: params.agent_config_ref },
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

  /**
   * KaiCalls' live make_call/send_sms both require a KaiCalls-native
   * `agent_id`, which CallMCP's generic contract has no field for beyond
   * `agent_config_ref` (make_call only). Rather than silently omitting a
   * required field and letting the live API return an opaque validation
   * error, this driver fails with a clear, specific message pointing at the
   * one honest way to supply it: `agent_config_ref` or `options.kaicalls.agent_id`.
   */
  private missingAgentId(tool: string): never {
    throw new KaiCallsDriverError(
      tool,
      new KaiCallsApiError(
        `KaiCalls requires an agent_id for "${tool}"; supply it via agent_config_ref (make_call) or options.kaicalls.agent_id`,
      ),
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

// mapTranscriptStatus/mapTranscriptTurn/mapTranscriptRole removed: KaiCalls'
// live get_transcript returns a flat string plus a `transcript_available`
// boolean, not a turn-by-turn array — see getTranscript() above, which now
// derives status directly from that boolean instead of inferring it from
// turn-array contents.

/**
 * Confirmed live: search_available_numbers' `available_numbers` entries are
 * plain E.164 strings, not objects — KaiCalls' real response carries no
 * per-number country/price/capability metadata at all. `country` is echoed
 * back from the request (or the tool's own "US" default) rather than
 * fabricated per-number, and price fields are honestly left null rather
 * than invented. Kept tolerant of an object shape too, in case this
 * degrades gracefully if the live response ever gains structure.
 */
function mapAvailableNumber(entry: unknown, fallbackCountry: string) {
  if (typeof entry === "string") {
    return {
      number: entry,
      country: fallbackCountry,
      capabilities: ["voice", "sms"],
      monthly_price_usd: null,
      setup_price_usd: null,
    };
  }
  const r = asRecord(entry);
  return {
    number: str(firstDefined(r.number, r.phone_number)) ?? "",
    country: str(r.country) ?? fallbackCountry,
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
