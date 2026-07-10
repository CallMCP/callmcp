/**
 * CallMCP driver-interface — types
 *
 * Normative reference: /SPEC.md at the repo root ("CallMCP Core Telephony Tool
 * Contract", v0.1.0). Every type here corresponds to a numbered section of that
 * document; section numbers are cited in comments so drift can be caught by
 * diffing against the spec rather than by memory.
 *
 * Scope note (SPEC §0.1.4, §3.5, Appendix A): `list_drivers`,
 * `request_call_approval`, and `list_approvals` are SERVER-core concerns, not
 * per-driver concerns — a driver never decides on its own whether a human has
 * approved a destination. Their request/response shapes are still typed here
 * (`ApprovalRequest`, `ApprovalRecord`, etc.) because drivers and the server
 * core both need to speak the same shapes, but there is deliberately no
 * `Driver.requestCallApproval` / `Driver.listApprovals` method — see the
 * `Driver` interface doc comment below.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp, e.g. "2026-07-09T18:04:00Z" (SPEC §1, conventions). */
export type Iso8601Timestamp = string;

/** Opaque cursor for `cursor`/`next_cursor` pagination (SPEC §1, conventions). */
export type Cursor = string;

/**
 * Namespaced driver-specific passthrough, keyed by `driver_id`
 * (SPEC §1.0, §0.1.1). Never a substitute for universal fields — additive
 * refinements only (compliance data, voice selection, routing hints, etc).
 */
export type DriverOptions = Record<string, Record<string, unknown>>;

/** `kind` enum shared by `list_drivers` (§1.1) and the manifest (§6.1). */
export type DriverKind = "hosted" | "local" | "byok";

/**
 * Full call lifecycle, as seen by `get_call_status` (§1.6) and `list_calls`
 * (§1.14). Note `make_call`'s own output status (`MakeCallStatus`) and
 * `end_call`'s (`EndCallStatus`) are narrower subsets/variants — they are
 * deliberately kept as distinct types below rather than aliased to this one,
 * to match the spec's per-tool enums exactly.
 */
export type CallLifecycleStatus =
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "failed"
  | "no_answer"
  | "busy"
  | "canceled";

/** Messaging channel discriminator for `send_sms` (SPEC §1.9). */
export type MessageChannel = "sms" | "whatsapp" | "rcs";

// ---------------------------------------------------------------------------
// Capability model (SPEC §2)
// ---------------------------------------------------------------------------

/**
 * Canonical capability flag set (SPEC §2.1 table). This mirrors the stricter
 * union of the `list_drivers` per-driver `capabilities` object (§1.1) and the
 * static manifest's `capabilities` object (§6.1) — the manifest schema
 * additionally requires `supports_number_configuration` and
 * `supports_elicitation_approval`, which this type treats as required since
 * a driver package's shipped manifest (the thing `CapabilityManifest` below
 * models) must always declare them. `supports_whatsapp`/`supports_rcs` stay
 * optional (absent implies false) in both schemas.
 *
 * `additionalProperties: true` in the JSON Schema is modeled with a string
 * index signature so non-normative extension keys (e.g. `supports_ivr_dtmf`)
 * type-check without widening the named fields.
 */
export interface CapabilityFlags {
  supports_sms: boolean;
  supports_whatsapp?: boolean;
  supports_rcs?: boolean;
  supports_recording: boolean;
  supports_hangup: boolean;
  supports_number_purchase: boolean;
  supports_number_configuration: boolean;
  supports_realtime_transcription: boolean;
  supports_elicitation_approval: boolean;
  /** integer ceiling, or null if unbounded/unknown */
  max_concurrent_calls: number | null;
  /** ISO 3166-1 alpha-2 country codes, or "GLOBAL" */
  regions: string[];
  /** non-normative extension keys a driver MAY add (SPEC §2.1) */
  [key: string]: unknown;
}

/** One entry of `list_drivers`' `drivers[]` array (SPEC §1.1). */
export interface DriverInfo {
  id: string;
  display_name: string;
  kind: DriverKind;
  /** used when a tool call omits `driver` */
  default?: boolean;
  capabilities: CapabilityFlags;
  /** tool names this driver deliberately does not expose; informational only */
  degraded_tools?: string[];
}

export interface ListDriversResult {
  drivers: DriverInfo[];
}

/** The full set of tool names defined by the spec (§1), for manifest typing. */
export type ToolName =
  | "list_drivers"
  | "request_call_approval"
  | "list_approvals"
  | "make_call"
  | "end_call"
  | "get_call_status"
  | "get_transcript"
  | "get_recording"
  | "send_sms"
  | "search_numbers"
  | "buy_number"
  | "configure_number"
  | "list_numbers"
  | "list_calls";

export interface DriverToolSupportEntry {
  supported: boolean;
  notes?: string;
}

export interface KnownDegradation {
  tool_or_capability: string;
  reason: string;
  upstream_tracking_url?: string | null;
}

/**
 * Static `callmcp.manifest.json` shape a driver package MUST ship (SPEC §6.1),
 * independent of the live `list_drivers` MCP response. This is the manifest
 * `runConformanceSuite` (src/conformance.ts) checks a `Driver` implementation
 * against.
 */
export interface CapabilityManifest {
  spec_version: "0.1.0";
  /** pattern ^[a-z][a-z0-9_]*$ */
  driver_id: string;
  display_name: string;
  kind: DriverKind;
  repository_url?: string;
  /** one entry per tool this driver claims to support */
  tools: Partial<Record<ToolName, DriverToolSupportEntry>>;
  capabilities: CapabilityFlags;
  known_degradations?: KnownDegradation[];
}

// ---------------------------------------------------------------------------
// Approval semantics (SPEC §3) — types only; owned operationally by server core
// ---------------------------------------------------------------------------

export type ApprovalScope = "single_call" | "allowlist_add" | "campaign_batch";
export type ApprovalState = "pending" | "approved" | "denied" | "expired";
/** channel gated by an approval; distinct from MessageChannel by including "voice" */
export type ApprovalChannel = "voice" | "sms" | "whatsapp" | "rcs";

/** Input to `request_call_approval` (SPEC §1.2). */
export interface ApprovalRequest {
  scope: ApprovalScope;
  /** E.164 phone number, or a wildcard pattern for allowlist_add e.g. '+1415555....' */
  destinations: string[];
  /** human-readable reason shown in the elicitation/approval UI */
  purpose?: string;
  /** default "voice" */
  channel?: ApprovalChannel;
  /** required when scope === "campaign_batch" */
  campaign_max_contacts?: number;
  /** default 86400; see §3.2 for tier defaults */
  ttl_seconds?: number;
  driver?: string;
  options?: DriverOptions;
}

/** Output of `request_call_approval` (SPEC §1.2). */
export interface ApprovalRequestResult {
  approval_id: string;
  state: ApprovalState;
  scope: ApprovalScope;
  elicitation_used: boolean;
  /** populated when elicitation_used is false; see §3.4 */
  out_of_band_url?: string | null;
  expires_at: Iso8601Timestamp;
  driver: string;
}

/** One entry of `list_approvals`' `approvals[]` array (SPEC §1.3). */
export interface ApprovalRecord {
  approval_id: string;
  scope: ApprovalScope;
  state: ApprovalState;
  destinations: string[];
  channel: ApprovalChannel;
  created_at: Iso8601Timestamp;
  decided_at?: Iso8601Timestamp | null;
  expires_at: Iso8601Timestamp;
  /** relevant for campaign_batch */
  remaining_uses?: number | null;
  driver: string;
}

/** Input to `list_approvals` (SPEC §1.3). */
export interface ListApprovalsParams {
  state?: ApprovalState | "any";
  scope?: ApprovalScope | "any";
  driver?: string;
  cursor?: Cursor;
}

export interface ListApprovalsResult {
  approvals: ApprovalRecord[];
  next_cursor: Cursor | null;
}

// ---------------------------------------------------------------------------
// make_call (SPEC §1.4)
// ---------------------------------------------------------------------------

export type MakeCallStatus = "queued" | "ringing" | "in_progress" | "elicitation_pending";

export interface MakeCallParams {
  /** E.164 destination number */
  to: string;
  /** E.164 caller-id number; if omitted, driver default number is used */
  from?: string;
  driver?: string;
  /** omit only if `to` matches a standing allowlist entry */
  approval_id?: string;
  /** opaque reference to an already-configured agent/assistant on the driver side */
  agent_config_ref?: string;
  max_duration_seconds?: number;
  /** opaque client metadata echoed back in get_call_status/get_transcript */
  metadata?: Record<string, unknown>;
  options?: DriverOptions;
}

export interface MakeCallResult {
  call_id: string;
  status: MakeCallStatus;
  to: string;
  from?: string;
  approval_id: string;
  started_at?: Iso8601Timestamp | null;
  driver: string;
}

// ---------------------------------------------------------------------------
// end_call (SPEC §1.5) — capability-gated by supports_hangup
// ---------------------------------------------------------------------------

export type EndCallStatus = "completed" | "already_ended";

export interface EndCallParams {
  call_id: string;
  reason?: string;
}

export interface EndCallResult {
  call_id: string;
  status: EndCallStatus;
  ended_at: Iso8601Timestamp;
  driver: string;
}

// ---------------------------------------------------------------------------
// get_call_status (SPEC §1.6)
// ---------------------------------------------------------------------------

export interface GetCallStatusParams {
  call_id: string;
}

export interface GetCallStatusResult {
  call_id: string;
  status: CallLifecycleStatus;
  to?: string;
  from?: string;
  started_at?: Iso8601Timestamp | null;
  ended_at?: Iso8601Timestamp | null;
  duration_seconds?: number | null;
  metadata?: Record<string, unknown>;
  driver: string;
}

// ---------------------------------------------------------------------------
// get_transcript (SPEC §1.7)
// ---------------------------------------------------------------------------

export type TranscriptStatus = "not_available_yet" | "partial" | "complete";
export type TranscriptFormat = "inline" | "resource_link";

export interface TranscriptTurn {
  role: "agent" | "caller" | "system";
  text: string;
  at: Iso8601Timestamp;
}

export interface GetTranscriptParams {
  call_id: string;
  /** default "inline" */
  format?: TranscriptFormat;
}

export interface GetTranscriptResult {
  call_id: string;
  status: TranscriptStatus;
  /** populated when format=inline */
  transcript?: TranscriptTurn[] | null;
  /**
   * tel://calls/{call_id}/transcript — populated when format=resource_link;
   * subscribable via resources/subscribe. MUST be supported by every driver
   * that sets supports_realtime_transcription: true (SPEC §1.7).
   */
  resource_link?: string | null;
  driver: string;
}

// ---------------------------------------------------------------------------
// get_recording (SPEC §1.8) — capability-gated by supports_recording
// ---------------------------------------------------------------------------

export type RecordingStatus = "not_available" | "processing" | "ready";

export interface GetRecordingParams {
  call_id: string;
}

export interface GetRecordingResult {
  call_id: string;
  status: RecordingStatus;
  /** tel://calls/{call_id}/recording */
  resource_link?: string | null;
  mime_type?: string | null;
  duration_seconds?: number | null;
  driver: string;
}

// ---------------------------------------------------------------------------
// send_sms (SPEC §1.9) — capability-gated by supports_sms/whatsapp/rcs
// ---------------------------------------------------------------------------

export type MessageStatus = "queued" | "sent" | "delivered" | "failed";

export interface SendSmsParams {
  to: string;
  from?: string;
  /** default "sms" */
  channel?: MessageChannel;
  /** maxLength 4096 */
  body: string;
  /** MMS/RCS/WhatsApp media attachments */
  media_urls?: string[];
  approval_id?: string;
  driver?: string;
  options?: DriverOptions;
}

export interface SendSmsResult {
  message_id: string;
  status: MessageStatus;
  channel: MessageChannel;
  to: string;
  from?: string;
  approval_id: string;
  driver: string;
}

// ---------------------------------------------------------------------------
// search_numbers (SPEC §1.10)
// ---------------------------------------------------------------------------

export type NumberCapability = "voice" | "sms" | "mms" | "whatsapp";

export interface SearchNumbersParams {
  /** ISO 3166-1 alpha-2 */
  country: string;
  area_code?: string;
  capabilities_required?: NumberCapability[];
  driver?: string;
  cursor?: Cursor;
}

export interface AvailableNumber {
  number: string;
  country: string;
  capabilities: string[];
  monthly_price_usd?: number | null;
  setup_price_usd?: number | null;
}

export interface SearchNumbersResult {
  numbers: AvailableNumber[];
  next_cursor: Cursor | null;
  driver: string;
}

// ---------------------------------------------------------------------------
// buy_number (SPEC §1.11) — capability-gated by supports_number_purchase
// ---------------------------------------------------------------------------

export type BuyNumberStatus = "active" | "pending_compliance" | "pending_provider";

export interface BuyNumberParams {
  /** a number returned by search_numbers */
  number: string;
  driver?: string;
  /**
   * jurisdiction-variable fields (10DLC brand/campaign IDs, KYC references,
   * etc.); server MAY elicit these interactively if omitted and required
   */
  compliance?: Record<string, unknown>;
  options?: DriverOptions;
}

export interface BuyNumberResult {
  number: string;
  status: BuyNumberStatus;
  monthly_price_usd?: number | null;
  /** outstanding compliance field names, if status=pending_compliance */
  compliance_required?: string[];
  driver: string;
}

// ---------------------------------------------------------------------------
// configure_number (SPEC §1.12) — capability-gated by supports_number_configuration
// ---------------------------------------------------------------------------

export interface ConfigureNumberParams {
  number: string;
  driver?: string;
  agent_config_ref?: string | null;
  sms_webhook_url?: string | null;
  caller_id_name?: string | null;
  options?: DriverOptions;
}

export interface ConfigureNumberResult {
  number: string;
  status: "updated";
  driver: string;
}

// ---------------------------------------------------------------------------
// list_numbers (SPEC §1.13)
// ---------------------------------------------------------------------------

export interface ListNumbersParams {
  driver?: string;
  cursor?: Cursor;
}

export interface OwnedNumber {
  number: string;
  country: string;
  capabilities: string[];
  agent_config_ref?: string | null;
  acquired_at: Iso8601Timestamp;
}

export interface ListNumbersResult {
  numbers: OwnedNumber[];
  next_cursor: Cursor | null;
  driver: string;
}

// ---------------------------------------------------------------------------
// list_calls (SPEC §1.14)
// ---------------------------------------------------------------------------

export interface ListCallsParams {
  driver?: string;
  since?: Iso8601Timestamp;
  until?: Iso8601Timestamp;
  /** default "any" */
  status?: CallLifecycleStatus | "any";
  cursor?: Cursor;
}

export interface CallSummary {
  call_id: string;
  to: string;
  from: string;
  status: string;
  started_at?: Iso8601Timestamp | null;
  ended_at?: Iso8601Timestamp | null;
  duration_seconds?: number | null;
}

export interface ListCallsResult {
  calls: CallSummary[];
  next_cursor: Cursor | null;
  driver: string;
}

// ---------------------------------------------------------------------------
// Error taxonomy (SPEC §5)
// ---------------------------------------------------------------------------

export type CallMcpErrorCode =
  | "UNSUPPORTED_CAPABILITY"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_DENIED"
  | "INSUFFICIENT_FUNDS"
  | "KYC_REQUIRED"
  | "DRIVER_ERROR";

/** The structured `error` object shape every CallMCP tool error carries (SPEC §5). */
export interface CallMcpError {
  code: CallMcpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Thrown by a `Driver` method when it is present on the object but the
 * current configuration does not actually support the call (SPEC §5.1 —
 * defense-in-depth only; the primary discovery path is the tool's absence
 * from `tools/list`, modeled here as the method being `undefined`).
 *
 * `runConformanceSuite` (src/conformance.ts) accepts either an `undefined`
 * method OR a method that throws this (or a plain object shaped like
 * `CallMcpError` with `code: "UNSUPPORTED_CAPABILITY"`) as a passing result
 * for a capability the manifest declares `false`.
 */
export class UnsupportedCapabilityError extends Error implements CallMcpError {
  readonly code: "UNSUPPORTED_CAPABILITY" = "UNSUPPORTED_CAPABILITY";
  readonly details: { driver: string; tool: string; missing_flag: string | undefined };

  constructor(driver: string, tool: string, missing_flag?: string) {
    super(`driver '${driver}' does not support ${tool}`);
    this.name = "UnsupportedCapabilityError";
    this.details = { driver, tool, missing_flag };
  }
}

// ---------------------------------------------------------------------------
// The Driver interface (SPEC §1, minus §1.1–§1.3)
// ---------------------------------------------------------------------------

/**
 * The contract every CallMCP driver package implements: one method per
 * contract tool, EXCLUDING `list_drivers`, `request_call_approval`, and
 * `list_approvals`.
 *
 * Those three are deliberately not methods here:
 * - `list_drivers` is answered by the server core from the set of registered
 *   `Driver` instances plus each one's `getManifest()` — a driver doesn't
 *   describe the whole fleet.
 * - `request_call_approval` / `list_approvals` implement the approval state
 *   machine (SPEC §3), which is server-core, cross-driver state (an
 *   allowlist entry approved once must gate every driver's `make_call`/
 *   `send_sms`, not just the driver active when it was created). A driver
 *   MUST NOT decide on its own whether a human has approved a destination.
 *
 * Every other method is OPTIONAL on this interface. This is the mechanical
 * expression of SPEC §0.1.2 ("Absence, not runtime surprise, is how
 * degradation is expressed"): a driver whose backend has no hangup endpoint
 * simply does not implement `endCall` (it is `undefined`), rather than
 * implementing it to throw. Implementing it to throw
 * `UnsupportedCapabilityError` is also acceptable (see `runConformanceSuite`)
 * for drivers that want one code path that inspects the manifest at call
 * time, but omission is the preferred, primary signal.
 *
 * `getManifest()` is the one non-optional, non-spec-tool method — every
 * driver must be able to report its own static capability manifest (§6.1)
 * so the server core can compute `tools/list` (§2.2) without invoking any
 * other method.
 */
export interface Driver {
  /** short lowercase slug matching `driver_id`, e.g. "kaicalls" */
  readonly id: string;

  /** Returns this driver's static capability manifest (SPEC §6.1). */
  getManifest(): CapabilityManifest | Promise<CapabilityManifest>;

  /** SPEC §1.4. Baseline — every driver implements this. */
  makeCall(params: MakeCallParams): Promise<MakeCallResult>;

  /** SPEC §1.5. Capability-gated by `supports_hangup`. */
  endCall?(params: EndCallParams): Promise<EndCallResult>;

  /** SPEC §1.6. Baseline — every driver implements this. */
  getCallStatus(params: GetCallStatusParams): Promise<GetCallStatusResult>;

  /**
   * SPEC §1.7. Baseline in its non-realtime form — every driver implements
   * this; `supports_realtime_transcription` governs only whether the
   * returned `resource_link` streams live updates via `resources/subscribe`.
   */
  getTranscript(params: GetTranscriptParams): Promise<GetTranscriptResult>;

  /** SPEC §1.8. Capability-gated by `supports_recording`. */
  getRecording?(params: GetRecordingParams): Promise<GetRecordingResult>;

  /** SPEC §1.9. Capability-gated by `supports_sms`/`supports_whatsapp`/`supports_rcs`. */
  sendSms?(params: SendSmsParams): Promise<SendSmsResult>;

  /**
   * SPEC §1.10. Capability-gated by `supports_number_purchase` — a driver
   * that cannot purchase numbers at all (§7: Synthflow, ElevenLabs, Dograh,
   * Phonely) has nothing meaningful to search either.
   */
  searchNumbers?(params: SearchNumbersParams): Promise<SearchNumbersResult>;

  /** SPEC §1.11. Capability-gated by `supports_number_purchase`. */
  buyNumber?(params: BuyNumberParams): Promise<BuyNumberResult>;

  /** SPEC §1.12. Capability-gated by `supports_number_configuration`. */
  configureNumber?(params: ConfigureNumberParams): Promise<ConfigureNumberResult>;

  /**
   * SPEC §1.13. Baseline — even a BYO-carrier/BYO-number driver with no
   * purchase capability (e.g. ElevenLabs, Dograh) can still report the
   * numbers it knows about.
   */
  listNumbers(params: ListNumbersParams): Promise<ListNumbersResult>;

  /** SPEC §1.14. Baseline — every driver implements this. */
  listCalls(params: ListCallsParams): Promise<ListCallsResult>;
}
