/**
 * CallMCP driver-interface — mock reference driver
 *
 * A trivial, fully in-memory `Driver` implementation. Two jobs:
 *
 * 1. Reference example for new driver authors — read this file alongside
 *    `SPEC.md` and `types.ts` to see the minimal shape a real driver (backed
 *    by Twilio, Vapi, Telnyx, etc) needs to fill in.
 * 2. Fixture for the server core's unit tests — a `Driver` that never makes
 *    real network calls, so server-core logic (routing, approval gating,
 *    `tools/list` computation) can be tested without sandbox credentials.
 *
 * `MOCK_DRIVER_MANIFEST` claims full support for every capability, so every
 * optional method on `Driver` is implemented here (nothing is `undefined`) —
 * this file is also what `runConformanceSuite` is exercised against in this
 * package's own test suite to prove the harness works end to end.
 */

import type {
  BuyNumberParams,
  BuyNumberResult,
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
  OwnedNumber,
  SearchNumbersParams,
  SearchNumbersResult,
  SendSmsParams,
  SendSmsResult,
  TranscriptTurn,
  CallLifecycleStatus,
} from "./types.js";

/** Static capability manifest (SPEC §6.1) for {@link MockDriver}. */
export const MOCK_DRIVER_MANIFEST: CapabilityManifest = {
  spec_version: "0.1.0",
  driver_id: "mock",
  display_name: "Mock Driver (reference implementation)",
  kind: "local",
  repository_url: "https://github.com/callmcp/callmcp",
  tools: {
    list_drivers: { supported: true },
    request_call_approval: { supported: true },
    list_approvals: { supported: true },
    make_call: { supported: true },
    end_call: { supported: true },
    get_call_status: { supported: true },
    get_transcript: { supported: true },
    get_recording: { supported: true },
    send_sms: { supported: true },
    search_numbers: { supported: true },
    buy_number: { supported: true },
    configure_number: { supported: true },
    list_numbers: { supported: true },
    list_calls: { supported: true },
  },
  capabilities: {
    supports_sms: true,
    supports_whatsapp: true,
    supports_rcs: true,
    supports_recording: true,
    supports_hangup: true,
    supports_number_purchase: true,
    supports_number_configuration: true,
    supports_realtime_transcription: true,
    supports_elicitation_approval: true,
    max_concurrent_calls: null,
    regions: ["GLOBAL"],
  },
  known_degradations: [],
};

const DEFAULT_FROM_NUMBER = "+15550000000";

interface InternalCallRecord {
  call_id: string;
  to: string;
  from: string;
  status: CallLifecycleStatus;
  started_at: string | null;
  ended_at: string | null;
  metadata: Record<string, unknown>;
  transcript: TranscriptTurn[];
}

function secondsBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) {
    return null;
  }
  return Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1000));
}

/**
 * Reference `Driver` implementation backed by in-memory `Map`s. No network
 * I/O, no persistence across process restarts — intentionally trivial.
 */
export class MockDriver implements Driver {
  readonly id = "mock";

  private readonly calls = new Map<string, InternalCallRecord>();
  private readonly numbers = new Map<string, OwnedNumber>();
  private callSeq = 0;
  private messageSeq = 0;
  private numberSeq = 0;

  getManifest(): CapabilityManifest {
    return MOCK_DRIVER_MANIFEST;
  }

  async makeCall(params: MakeCallParams): Promise<MakeCallResult> {
    const call_id = `mock_call_${++this.callSeq}`;
    const now = new Date().toISOString();
    const from = params.from ?? DEFAULT_FROM_NUMBER;

    this.calls.set(call_id, {
      call_id,
      to: params.to,
      from,
      status: "in_progress",
      started_at: now,
      ended_at: null,
      metadata: params.metadata ?? {},
      transcript: [{ role: "system", text: "call connected (mock)", at: now }],
    });

    return {
      call_id,
      status: "in_progress",
      to: params.to,
      from,
      approval_id: params.approval_id ?? "mock_allowlist_match",
      started_at: now,
      driver: this.id,
    };
  }

  async endCall(params: EndCallParams): Promise<EndCallResult> {
    const now = new Date().toISOString();
    const record = this.calls.get(params.call_id);

    if (!record || record.ended_at) {
      return {
        call_id: params.call_id,
        status: "already_ended",
        ended_at: record?.ended_at ?? now,
        driver: this.id,
      };
    }

    record.status = "completed";
    record.ended_at = now;
    return { call_id: record.call_id, status: "completed", ended_at: now, driver: this.id };
  }

  async getCallStatus(params: GetCallStatusParams): Promise<GetCallStatusResult> {
    const record = this.calls.get(params.call_id);
    if (!record) {
      // Reference behavior only: a real driver should distinguish "unknown
      // call_id" from a genuinely failed call, likely via a thrown error.
      return { call_id: params.call_id, status: "failed", driver: this.id };
    }

    return {
      call_id: record.call_id,
      status: record.status,
      to: record.to,
      from: record.from,
      started_at: record.started_at,
      ended_at: record.ended_at,
      duration_seconds: secondsBetween(record.started_at, record.ended_at),
      metadata: record.metadata,
      driver: this.id,
    };
  }

  async getTranscript(params: GetTranscriptParams): Promise<GetTranscriptResult> {
    const record = this.calls.get(params.call_id);
    if (!record) {
      return { call_id: params.call_id, status: "not_available_yet", transcript: null, driver: this.id };
    }

    const status = record.ended_at ? "complete" : "partial";

    if (params.format === "resource_link") {
      return {
        call_id: record.call_id,
        status,
        resource_link: `tel://calls/${record.call_id}/transcript`,
        driver: this.id,
      };
    }

    return { call_id: record.call_id, status, transcript: record.transcript, driver: this.id };
  }

  async getRecording(params: GetRecordingParams): Promise<GetRecordingResult> {
    const record = this.calls.get(params.call_id);
    if (!record || !record.ended_at) {
      return { call_id: params.call_id, status: "not_available", driver: this.id };
    }

    return {
      call_id: record.call_id,
      status: "ready",
      resource_link: `tel://calls/${record.call_id}/recording`,
      mime_type: "audio/wav",
      duration_seconds: secondsBetween(record.started_at, record.ended_at),
      driver: this.id,
    };
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const message_id = `mock_msg_${++this.messageSeq}`;
    return {
      message_id,
      status: "sent",
      channel: params.channel ?? "sms",
      to: params.to,
      from: params.from ?? DEFAULT_FROM_NUMBER,
      approval_id: params.approval_id ?? "mock_allowlist_match",
      driver: this.id,
    };
  }

  async searchNumbers(params: SearchNumbersParams): Promise<SearchNumbersResult> {
    const candidate = `+1555010${String(this.numberSeq).padStart(4, "0")}`;
    return {
      numbers: [
        {
          number: candidate,
          country: params.country,
          capabilities: params.capabilities_required ?? ["voice", "sms"],
          monthly_price_usd: 1.15,
          setup_price_usd: 0,
        },
      ],
      next_cursor: null,
      driver: this.id,
    };
  }

  async buyNumber(params: BuyNumberParams): Promise<BuyNumberResult> {
    this.numberSeq += 1;
    const record: OwnedNumber = {
      number: params.number,
      country: "US",
      capabilities: ["voice", "sms"],
      agent_config_ref: null,
      acquired_at: new Date().toISOString(),
    };
    this.numbers.set(params.number, record);
    return { number: params.number, status: "active", monthly_price_usd: 1.15, driver: this.id };
  }

  async configureNumber(params: ConfigureNumberParams): Promise<ConfigureNumberResult> {
    const record = this.numbers.get(params.number);
    if (record) {
      record.agent_config_ref = params.agent_config_ref ?? record.agent_config_ref ?? null;
    }
    return { number: params.number, status: "updated", driver: this.id };
  }

  async listNumbers(_params: ListNumbersParams): Promise<ListNumbersResult> {
    return { numbers: Array.from(this.numbers.values()), next_cursor: null, driver: this.id };
  }

  async listCalls(params: ListCallsParams): Promise<ListCallsResult> {
    const wantedStatus = params.status;
    const calls = Array.from(this.calls.values())
      .filter((record) => !wantedStatus || wantedStatus === "any" || record.status === wantedStatus)
      .map((record) => ({
        call_id: record.call_id,
        to: record.to,
        from: record.from,
        status: record.status,
        started_at: record.started_at,
        ended_at: record.ended_at,
        duration_seconds: secondsBetween(record.started_at, record.ended_at),
      }));

    return { calls, next_cursor: null, driver: this.id };
  }
}
