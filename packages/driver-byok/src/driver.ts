/**
 * @callmcp/driver-byok — Driver
 *
 * Implements the CallMCP `Driver` interface (@callmcp/driver-interface) for
 * driver_id `twilio_openai`: Twilio as the transport (voice, numbers, SMS)
 * and OpenAI's Realtime API as the brain, bridged per the pattern documented
 * in workspace/research/r2-transports.md §1 and r3-realtime-brains.md §1 —
 * Twilio Voice webhook -> TwiML `<Connect><Stream>` -> this driver's own
 * WebSocket media-stream server -> OpenAI Realtime session, audio forwarded
 * both directions, tool-calling preserved mid-call.
 *
 * This package does not run an HTTP/WebSocket server itself (see
 * `realtimeBridge.ts`'s file comment) — `@callmcp/server` (or any host)
 * calls `handleVoiceWebhook` from its TwiML route and `attachMediaStream`
 * from its WebSocket upgrade handler. Everything else is the normal `Driver`
 * method surface.
 */

import type {
  BuyNumberParams,
  BuyNumberResult,
  CallLifecycleStatus,
  CallMcpError,
  CapabilityManifest,
  ConfigureNumberParams,
  ConfigureNumberResult,
  Driver,
  EndCallParams,
  EndCallResult,
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
  OwnedNumber,
  SearchNumbersParams,
  SearchNumbersResult,
  SendSmsParams,
  SendSmsResult,
  TranscriptTurn,
} from "@callmcp/driver-interface";
import type WebSocket from "ws";
import { TwilioTransport, buildVoiceStreamTwiml, mapTwilioError, type TwilioClientLike } from "./transport/twilio.js";
import { RealtimeBridge, type ToolCallHook, type ToolCallOutcome } from "./brain/realtimeBridge.js";
import { openaiRealtimeAdapter, type BrainAdapter, type BrainSessionConfig } from "./brain/adapter.js";
import { BYOK_DRIVER_ID, BYOK_DRIVER_MANIFEST } from "./manifest.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BYOKDriverConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  /** Default caller-ID number used when `make_call` omits `from`. */
  twilioFromNumber?: string;
  openaiApiKey: string;
  /** Defaults to "gpt-realtime" (see adapter.ts). */
  openaiModel?: string;
  /**
   * Public `https://` URL this driver's Voice webhook is reachable at — the
   * host process must route Twilio's POST to that URL into
   * `handleVoiceWebhook`. Required to place calls at all.
   */
  voiceWebhookUrl: string;
  /**
   * Public `wss://` URL this driver's media-stream WebSocket server is
   * reachable at — the host process must route the WebSocket upgrade at
   * that URL into `attachMediaStream`. Required to place calls at all.
   */
  mediaStreamUrl: string;
  /** Optional `https://` URL for Twilio call status callbacks (ringing/
   * answered/completed). Purely informational if set — not required for
   * core call flow, which relies on the media-stream `start`/`stop` events
   * and `get_call_status` polling instead. */
  statusCallbackUrl?: string;
  /**
   * Fallback agent instructions used when `make_call` omits
   * `agent_config_ref` (or when `agentConfigResolver` isn't provided).
   * Agent-configuration tools are explicitly out of v0 scope per SPEC
   * Appendix A, so this driver treats `agent_config_ref` as an opaque
   * string a host application resolves on its own — see
   * `agentConfigResolver`.
   */
  defaultInstructions?: string;
  /**
   * Resolves `make_call`'s `agent_config_ref` (an opaque string per SPEC
   * §1.4) into a concrete brain session config (instructions/voice/tools).
   * If omitted, every call uses `defaultInstructions` with no tools —
   * fine for a single-purpose deployment, insufficient for a host that
   * wants per-call agent configuration (which is exactly why this hook
   * exists rather than this driver inventing its own agent-config storage,
   * which would be scope creep past SPEC Appendix A).
   */
  agentConfigResolver?: (
    agentConfigRef: string | undefined,
  ) => Promise<BrainSessionConfig> | BrainSessionConfig;
  /**
   * Called for every mid-call tool invocation the brain emits. Default
   * behavior (if omitted) is to return an error result to the brain rather
   * than silently no-op — see `defaultToolCallHook` below. A host that
   * wires real tools through here is responsible for routing anything that
   * itself contacts a third party back through CallMCP's approval/allowlist
   * machinery (SPEC §3) before acting — this driver has no visibility into
   * that state (owned by the server core, per driver-interface's README).
   */
  toolCallHook?: ToolCallHook;
  /** Test-only injection points. */
  twilioClient?: TwilioClientLike;
  createBrainAdapter?: (opts: { apiKey: string; model?: string }) => BrainAdapter;
}

function defaultToolCallHook(): ToolCallHook {
  return async (event) => {
    return {
      resultJson: JSON.stringify({
        error: `no toolCallHook configured for this driver instance; '${event.name}' was not executed`,
      }),
    };
  };
}

// ---------------------------------------------------------------------------
// Internal per-call state
// ---------------------------------------------------------------------------

interface CallRecord {
  call_id: string;
  to: string;
  from: string;
  status: CallLifecycleStatus;
  agent_config_ref?: string;
  metadata: Record<string, unknown>;
  approval_id: string;
  started_at: string | null;
  ended_at: string | null;
  transcript: TranscriptTurn[];
  streamSid?: string;
}

function mapTwilioStatusToLifecycle(status: string): CallLifecycleStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "ringing":
      return "ringing";
    case "in-progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
      return "busy";
    case "no-answer":
      return "no_answer";
    case "canceled":
      return "canceled";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function mapTwilioStatusToMakeCallStatus(status: string): MakeCallStatus {
  const lifecycle = mapTwilioStatusToLifecycle(status);
  if (lifecycle === "queued" || lifecycle === "ringing" || lifecycle === "in_progress") {
    return lifecycle;
  }
  // Twilio's call-creation response is essentially always "queued" in
  // practice; any other terminal-looking value this early is surfaced as
  // "queued" too rather than inventing a MakeCallResult status the spec
  // doesn't define (MakeCallStatus has no "failed" member — SPEC §1.4).
  return "queued";
}

/** Thrown by driver methods on an unmapped/mapped Twilio failure, carrying
 * the SPEC §5 error shape as `.callMcpError` for the server core to surface
 * verbatim rather than re-deriving it. */
export class TwilioDriverError extends Error implements CallMcpError {
  readonly code: CallMcpError["code"];
  readonly details?: Record<string, unknown>;

  constructor(mapped: CallMcpError) {
    super(mapped.message);
    this.name = "TwilioDriverError";
    this.code = mapped.code;
    if (mapped.details !== undefined) {
      this.details = mapped.details;
    }
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class BYOKDriver implements Driver {
  readonly id = BYOK_DRIVER_ID;

  private readonly config: BYOKDriverConfig;
  private readonly transport: TwilioTransport;
  private readonly calls = new Map<string, CallRecord>();
  private readonly toolCallHook: ToolCallHook;
  private readonly createBrain: (opts: { apiKey: string; model?: string }) => BrainAdapter;

  constructor(config: BYOKDriverConfig) {
    this.config = config;
    this.transport = new TwilioTransport({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
      ...(config.twilioClient ? { client: config.twilioClient } : {}),
    });
    this.toolCallHook = config.toolCallHook ?? defaultToolCallHook();
    this.createBrain = config.createBrainAdapter ?? openaiRealtimeAdapter;
  }

  getManifest(): CapabilityManifest {
    return BYOK_DRIVER_MANIFEST;
  }

  // -- Voice webhook + media-stream WS entry points (not spec tools; the
  //    host process wires these to its own HTTP/WS server) ------------------

  /**
   * Returns the TwiML document Twilio's Voice webhook must respond with.
   * `callSid` is read by the host from Twilio's webhook POST body
   * (`req.body.CallSid`, form-encoded) — parsing that body is left to the
   * host so this package stays framework-agnostic.
   */
  handleVoiceWebhook(params: { callSid: string }): string {
    const url = new URL(this.config.mediaStreamUrl);
    url.searchParams.set("callSid", params.callSid);
    return buildVoiceStreamTwiml({ mediaStreamUrl: url.toString(), callSid: params.callSid });
  }

  /**
   * Accepts the raw WebSocket for an incoming Twilio Media Streams
   * connection (the host process performs the HTTP upgrade at
   * `mediaStreamUrl` and hands the resulting `ws.WebSocket` here) and wires
   * a `RealtimeBridge` for the call's duration.
   */
  attachMediaStream(socket: WebSocket): RealtimeBridge {
    // Captured once Twilio's `start` event resolves it, so `onTranscriptTurn`
    // (fired for every turn thereafter) can push straight into this bridge's
    // own call record without re-deriving identity per turn.
    let activeCallSid: string | null = null;

    const bridge = new RealtimeBridge({
      twilioSocket: socket,
      createBrainAdapter: () =>
        this.createBrain({
          apiKey: this.config.openaiApiKey,
          ...(this.config.openaiModel !== undefined ? { model: this.config.openaiModel } : {}),
        }),
      resolveSessionConfig: async ({ callSid }) => {
        const record = this.calls.get(callSid);
        if (this.config.agentConfigResolver) {
          return this.config.agentConfigResolver(record?.agent_config_ref);
        }
        return { instructions: this.config.defaultInstructions ?? "" };
      },
      onToolCall: this.toolCallHook,
      onStart: async ({ callSid, streamSid }) => {
        activeCallSid = callSid;
        let record = this.calls.get(callSid);
        if (!record) {
          // Inbound call (or a call this process didn't originate) — Twilio's
          // stream `start` event only carries callSid/streamSid, so backfill
          // to/from from the REST API rather than leaving them empty.
          const twilioCall = await this.transport.getCall(callSid).catch(() => null);
          record = {
            call_id: callSid,
            to: twilioCall?.to ?? "",
            from: twilioCall?.from ?? "",
            status: "in_progress",
            metadata: {},
            approval_id: "inbound_no_approval_required",
            started_at: new Date().toISOString(),
            ended_at: null,
            transcript: [],
          };
          this.calls.set(callSid, record);
        }
        record.status = "in_progress";
        record.started_at = record.started_at ?? new Date().toISOString();
        record.streamSid = streamSid;
      },
      onTranscriptTurn: (turn) => {
        if (!activeCallSid) {
          return;
        }
        this.calls.get(activeCallSid)?.transcript.push(turn);
      },
      onEnd: () => {
        // Bridge closed — call-level status transitions are driven by
        // Twilio call status (endCall/getCallStatus), not by the media
        // stream ending, since the stream can close slightly before or
        // after Twilio finalizes the call resource.
      },
    });

    bridge.attach();
    return bridge;
  }

  // -- Driver interface methods ----------------------------------------------

  async makeCall(params: MakeCallParams): Promise<MakeCallResult> {
    const from = params.from ?? this.config.twilioFromNumber;
    if (!from) {
      throw new TwilioDriverError({
        code: "DRIVER_ERROR",
        message: "no 'from' number supplied and no twilioFromNumber configured on this driver instance",
        details: { driver: this.id },
      });
    }

    // options.twilio_openai.record: false opts a specific call out of the
    // default recording behavior implied by this driver's
    // supports_recording:true manifest claim (see TwilioTransport.createCall).
    const recordOption = params.options?.[this.id]?.record;

    let created: { sid: string; status: string };
    try {
      created = await this.transport.createCall({
        to: params.to,
        from,
        twimlUrl: this.config.voiceWebhookUrl,
        ...(this.config.statusCallbackUrl ? { statusCallbackUrl: this.config.statusCallbackUrl } : {}),
        ...(typeof recordOption === "boolean" ? { record: recordOption } : {}),
      });
    } catch (err) {
      throw new TwilioDriverError(mapTwilioError(err, { driver: this.id }));
    }

    const approval_id = params.approval_id ?? "allowlist_match";
    this.calls.set(created.sid, {
      call_id: created.sid,
      to: params.to,
      from,
      status: mapTwilioStatusToLifecycle(created.status),
      ...(params.agent_config_ref !== undefined ? { agent_config_ref: params.agent_config_ref } : {}),
      metadata: params.metadata ?? {},
      approval_id,
      started_at: null,
      ended_at: null,
      transcript: [],
    });

    return {
      call_id: created.sid,
      status: mapTwilioStatusToMakeCallStatus(created.status),
      to: params.to,
      from,
      approval_id,
      started_at: null,
      driver: this.id,
    };
  }

  async endCall(params: EndCallParams): Promise<EndCallResult> {
    const record = this.calls.get(params.call_id);
    if (record?.ended_at) {
      return { call_id: params.call_id, status: "already_ended", ended_at: record.ended_at, driver: this.id };
    }

    let twilioCall;
    try {
      twilioCall = await this.transport.endCall(params.call_id);
    } catch (err) {
      // Twilio rejects updating a call that isn't in-progress (e.g. already
      // completed) with an error rather than a friendly no-op. Recognize
      // that specific shape and fold it into idempotent success per SPEC
      // §1.5 (`end_call` idempotentHint: true); every other error (auth
      // failure, network error, unknown call_id) is a genuine failure and
      // must not be masked as success.
      const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const looksAlreadyEnded = message.includes("not in-progress") || message.includes("not in progress");
      if (looksAlreadyEnded) {
        return { call_id: params.call_id, status: "already_ended", ended_at: new Date().toISOString(), driver: this.id };
      }
      throw new TwilioDriverError(mapTwilioError(err, { driver: this.id }));
    }

    const ended_at = new Date().toISOString();
    if (record) {
      record.status = mapTwilioStatusToLifecycle(twilioCall.status);
      record.ended_at = ended_at;
    }
    return { call_id: params.call_id, status: "completed", ended_at, driver: this.id };
  }

  async getCallStatus(params: GetCallStatusParams): Promise<GetCallStatusResult> {
    let twilioCall;
    try {
      twilioCall = await this.transport.getCall(params.call_id);
    } catch (err) {
      throw new TwilioDriverError(mapTwilioError(err, { driver: this.id }));
    }

    const record = this.calls.get(params.call_id);
    const status = mapTwilioStatusToLifecycle(twilioCall.status);
    const started_at = toIsoOrNull(twilioCall.startTime) ?? record?.started_at ?? null;
    const ended_at = toIsoOrNull(twilioCall.endTime) ?? record?.ended_at ?? null;

    if (record) {
      record.status = status;
      record.started_at = started_at;
      record.ended_at = ended_at;
    }

    return {
      call_id: params.call_id,
      status,
      to: twilioCall.to,
      from: twilioCall.from,
      started_at,
      ended_at,
      duration_seconds: twilioCall.duration ? Number(twilioCall.duration) : null,
      metadata: record?.metadata ?? {},
      driver: this.id,
    };
  }

  async getTranscript(params: GetTranscriptParams): Promise<GetTranscriptResult> {
    const record = this.calls.get(params.call_id);
    if (!record) {
      return { call_id: params.call_id, status: "not_available_yet", transcript: null, driver: this.id };
    }

    const status = record.ended_at ? "complete" : record.transcript.length > 0 ? "partial" : "not_available_yet";

    if (params.format === "resource_link") {
      return {
        call_id: params.call_id,
        status,
        resource_link: `tel://calls/${params.call_id}/transcript`,
        driver: this.id,
      };
    }

    return { call_id: params.call_id, status, transcript: record.transcript, driver: this.id };
  }

  async getRecording(params: GetRecordingParams): Promise<GetRecordingResult> {
    const recording = await this.transport.getRecordingForCall(params.call_id);
    if (!recording) {
      return { call_id: params.call_id, status: "not_available", driver: this.id };
    }

    const status = recording.status === "completed" ? "ready" : "processing";
    return {
      call_id: params.call_id,
      status,
      resource_link: status === "ready" ? `tel://calls/${params.call_id}/recording` : null,
      mime_type: status === "ready" ? "audio/x-wav" : null,
      duration_seconds: recording.duration ? Number(recording.duration) : null,
      driver: this.id,
    };
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    if (params.channel && params.channel !== "sms") {
      throw new TwilioDriverError({
        code: "UNSUPPORTED_CAPABILITY",
        message: `driver '${this.id}' does not support send_sms channel '${params.channel}'`,
        details: { driver: this.id, tool: "send_sms", missing_flag: `supports_${params.channel}` },
      });
    }

    const from = params.from ?? this.config.twilioFromNumber;
    if (!from) {
      throw new TwilioDriverError({
        code: "DRIVER_ERROR",
        message: "no 'from' number supplied and no twilioFromNumber configured on this driver instance",
        details: { driver: this.id },
      });
    }

    let message;
    try {
      message = await this.transport.sendMessage({
        to: params.to,
        from,
        body: params.body,
        ...(params.media_urls ? { mediaUrls: params.media_urls } : {}),
      });
    } catch (err) {
      throw new TwilioDriverError(mapTwilioError(err, { driver: this.id }));
    }

    return {
      message_id: message.sid,
      status: message.status === "queued" || message.status === "sent" || message.status === "delivered" ? message.status : "queued",
      channel: "sms",
      to: message.to,
      from: message.from,
      approval_id: params.approval_id ?? "allowlist_match",
      driver: this.id,
    };
  }

  async searchNumbers(params: SearchNumbersParams): Promise<SearchNumbersResult> {
    let results;
    try {
      results = await this.transport.searchNumbers({
        country: params.country,
        ...(params.area_code ? { areaCode: params.area_code } : {}),
        ...(params.capabilities_required ? { capabilities: params.capabilities_required } : {}),
      });
    } catch (err) {
      throw new TwilioDriverError(mapTwilioError(err, { driver: this.id }));
    }

    return {
      numbers: results.map((n) => ({
        number: n.phoneNumber,
        country: n.isoCountry,
        capabilities: [
          ...(n.capabilities.voice ? ["voice"] : []),
          ...(n.capabilities.sms ? ["sms"] : []),
          ...(n.capabilities.mms ? ["mms"] : []),
        ],
        // Twilio's Available Phone Numbers search does not return pricing
        // inline; a real implementation should cross-reference the Pricing
        // API. Left null rather than guessing a number.
        monthly_price_usd: null,
        setup_price_usd: null,
      })),
      next_cursor: null,
      driver: this.id,
    };
  }

  async buyNumber(params: BuyNumberParams): Promise<BuyNumberResult> {
    let purchased;
    try {
      purchased = await this.transport.buyNumber({
        phoneNumber: params.number,
        voiceWebhookUrl: this.config.voiceWebhookUrl,
      });
    } catch (err) {
      throw new TwilioDriverError(mapTwilioError(err, { driver: this.id }));
    }

    return { number: purchased.phoneNumber, status: "active", monthly_price_usd: null, driver: this.id };
  }

  async configureNumber(params: ConfigureNumberParams): Promise<ConfigureNumberResult> {
    const owned = await this.transport.listNumbers();
    const match = owned.find((n) => n.phoneNumber === params.number);
    if (!match) {
      throw new TwilioDriverError({
        code: "DRIVER_ERROR",
        message: `number ${params.number} is not owned by this Twilio account`,
        details: { driver: this.id },
      });
    }

    try {
      await this.transport.configureNumber({
        sid: match.sid,
        ...(params.sms_webhook_url ? { smsWebhookUrl: params.sms_webhook_url } : {}),
        ...(params.caller_id_name ? { friendlyName: params.caller_id_name } : {}),
        // agent_config_ref has no Twilio-native home (Appendix A: no
        // agent-config tools in v0) — a host that needs to route
        // number -> agent_config_ref should track that mapping itself and
        // feed it into `agentConfigResolver` above, keyed by the callSid
        // Twilio's inbound webhook reports for calls to this number.
      });
    } catch (err) {
      throw new TwilioDriverError(mapTwilioError(err, { driver: this.id }));
    }

    return { number: params.number, status: "updated", driver: this.id };
  }

  async listNumbers(_params: ListNumbersParams): Promise<ListNumbersResult> {
    const owned = await this.transport.listNumbers();
    const numbers: OwnedNumber[] = owned.map((n) => ({
      number: n.phoneNumber,
      country: n.phoneNumber.startsWith("+1") ? "US" : "",
      capabilities: [
        ...(n.capabilities.voice ? ["voice"] : []),
        ...(n.capabilities.sms ? ["sms"] : []),
        ...(n.capabilities.mms ? ["mms"] : []),
      ],
      agent_config_ref: null,
      acquired_at: toIsoOrNull(n.dateCreated) ?? new Date(0).toISOString(),
    }));
    return { numbers, next_cursor: null, driver: this.id };
  }

  async listCalls(params: ListCallsParams): Promise<ListCallsResult> {
    const twilioCalls = await this.transport.listCalls({
      ...(params.since ? { since: params.since } : {}),
      ...(params.until ? { until: params.until } : {}),
      ...(params.status ? { status: params.status } : {}),
    });

    return {
      calls: twilioCalls.map((c) => ({
        call_id: c.sid,
        to: c.to,
        from: c.from,
        status: mapTwilioStatusToLifecycle(c.status),
        started_at: toIsoOrNull(c.startTime),
        ended_at: toIsoOrNull(c.endTime),
        duration_seconds: c.duration ? Number(c.duration) : null,
      })),
      next_cursor: null,
      driver: this.id,
    };
  }
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export type { ToolCallHook, ToolCallOutcome };
