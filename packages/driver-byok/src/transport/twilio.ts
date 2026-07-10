/**
 * @callmcp/driver-byok — Twilio transport
 *
 * Wraps the Twilio REST client (calls, numbers, SMS via the Messaging API)
 * and builds the TwiML `<Connect><Stream>` document that hands a live call
 * off to this driver's own media-stream WebSocket endpoint. This is the
 * "PSTN number -> provider's realtime media transport" half of the pattern
 * documented in workspace/research/r2-transports.md §1 — the Twilio↔OpenAI-
 * Realtime bridge is "the most thoroughly documented ... pattern of any
 * provider researched" per that doc, which is why Twilio is transport #1.
 *
 * Auth: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (per
 * examples/claude-desktop-byok.json at the repo root).
 */

import twilioSdk from "twilio";
import type { CallMcpError } from "@callmcp/driver-interface";

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

/** The subset of the Twilio SDK's client surface this transport uses.
 * Typed narrowly (rather than importing Twilio's full generated client type)
 * so tests can inject a minimal fake without satisfying Twilio's entire
 * REST API surface. */
export interface TwilioClientLike {
  calls: {
    create(params: Record<string, unknown>): Promise<{ sid: string; status: string }>;
    (sid: string): {
      fetch(): Promise<TwilioCallResource>;
      update(params: Record<string, unknown>): Promise<TwilioCallResource>;
    };
    list(params?: Record<string, unknown>): Promise<TwilioCallResource[]>;
  };
  messages: {
    create(params: Record<string, unknown>): Promise<TwilioMessageResource>;
  };
  recordings: {
    list(params?: Record<string, unknown>): Promise<TwilioRecordingResource[]>;
  };
  availablePhoneNumbers(country: string): {
    local: { list(params?: Record<string, unknown>): Promise<TwilioAvailableNumberResource[]> };
  };
  incomingPhoneNumbers: {
    create(params: Record<string, unknown>): Promise<TwilioIncomingNumberResource>;
    list(params?: Record<string, unknown>): Promise<TwilioIncomingNumberResource[]>;
    (sid: string): { update(params: Record<string, unknown>): Promise<TwilioIncomingNumberResource> };
  };
}

export interface TwilioCallResource {
  sid: string;
  to: string;
  from: string;
  status: string;
  startTime?: string | Date | null;
  endTime?: string | Date | null;
  duration?: string | null;
}

export interface TwilioMessageResource {
  sid: string;
  status: string;
  to: string;
  from: string;
}

export interface TwilioRecordingResource {
  sid: string;
  callSid: string;
  status: string;
  duration?: string | null;
  mediaUrl?: string;
}

export interface TwilioAvailableNumberResource {
  phoneNumber: string;
  isoCountry: string;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
}

export interface TwilioIncomingNumberResource {
  sid: string;
  phoneNumber: string;
  friendlyName?: string;
  dateCreated?: string | Date;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
}

export interface TwilioTransportConfig {
  accountSid: string;
  authToken: string;
  /** Injectable for tests / alternate SDK construction. Defaults to
   * `twilio(accountSid, authToken)`. */
  client?: TwilioClientLike;
}

/**
 * Thin wrapper over the Twilio REST client. Every method here maps 1:1 to a
 * `driver.ts` method; none of them know about CallMCP's tool schemas — that
 * translation lives in `driver.ts` so this file stays a plain Twilio client.
 */
export class TwilioTransport {
  readonly client: TwilioClientLike;

  constructor(config: TwilioTransportConfig) {
    this.client =
      config.client ??
      (twilioSdk(config.accountSid, config.authToken) as unknown as TwilioClientLike);
  }

  // -- Calls ----------------------------------------------------------------

  async createCall(params: {
    to: string;
    from: string;
    twimlUrl: string;
    statusCallbackUrl?: string;
    machineDetection?: boolean;
    /** Defaults to true — this driver's manifest claims supports_recording:
     * true unconditionally, so every call is recorded unless explicitly
     * opted out (SPEC §7's rule that a capability flag is a promise the
     * matching behavior actually happens, not merely that it theoretically
     * could). Pass `false` via options.twilio_openai.record to opt out. */
    record?: boolean;
  }): Promise<{ sid: string; status: string }> {
    return this.client.calls.create({
      to: params.to,
      from: params.from,
      url: params.twimlUrl,
      record: params.record ?? true,
      ...(params.statusCallbackUrl
        ? { statusCallback: params.statusCallbackUrl, statusCallbackEvent: ["initiated", "ringing", "answered", "completed"] }
        : {}),
      ...(params.machineDetection ? { machineDetection: "Enable" } : {}),
    });
  }

  async endCall(callSid: string): Promise<TwilioCallResource> {
    return this.client.calls(callSid).update({ status: "completed" });
  }

  async getCall(callSid: string): Promise<TwilioCallResource> {
    return this.client.calls(callSid).fetch();
  }

  async listCalls(params: { since?: string; until?: string; status?: string; limit?: number }): Promise<TwilioCallResource[]> {
    const twilioParams: Record<string, unknown> = {};
    if (params.since) twilioParams.startTimeAfter = params.since;
    if (params.until) twilioParams.startTimeBefore = params.until;
    if (params.status && params.status !== "any") twilioParams.status = params.status;
    if (params.limit) twilioParams.limit = params.limit;
    return this.client.calls.list(twilioParams);
  }

  // -- Recordings -------------------------------------------------------------

  async getRecordingForCall(callSid: string): Promise<TwilioRecordingResource | null> {
    const recordings = await this.client.recordings.list({ callSid });
    return recordings[0] ?? null;
  }

  // -- SMS / Messaging API (real standalone send — supports_sms: true) -------

  async sendMessage(params: {
    to: string;
    from: string;
    body: string;
    mediaUrls?: string[];
  }): Promise<TwilioMessageResource> {
    return this.client.messages.create({
      to: params.to,
      from: params.from,
      body: params.body,
      ...(params.mediaUrls && params.mediaUrls.length > 0 ? { mediaUrl: params.mediaUrls } : {}),
    });
  }

  // -- Numbers ----------------------------------------------------------------

  async searchNumbers(params: {
    country: string;
    areaCode?: string;
    capabilities?: string[];
  }): Promise<TwilioAvailableNumberResource[]> {
    const searchParams: Record<string, unknown> = {};
    if (params.areaCode) searchParams.areaCode = params.areaCode;
    if (params.capabilities?.includes("voice")) searchParams.voiceEnabled = true;
    if (params.capabilities?.includes("sms")) searchParams.smsEnabled = true;
    if (params.capabilities?.includes("mms")) searchParams.mmsEnabled = true;
    return this.client.availablePhoneNumbers(params.country).local.list(searchParams);
  }

  /**
   * Purchases a number. Twilio's own compliance gates apply here honestly
   * (see `mapTwilioError` below and SPEC §5.5 `KYC_REQUIRED`) — international
   * numbers and certain US number types require a Regulatory Bundle
   * (identity/address documentation) before `IncomingPhoneNumbers.create`
   * succeeds; Twilio returns a 400 with a regulatory-compliance-shaped error
   * in that case rather than a generic failure.
   */
  async buyNumber(params: {
    phoneNumber: string;
    voiceWebhookUrl?: string;
    smsWebhookUrl?: string;
  }): Promise<TwilioIncomingNumberResource> {
    return this.client.incomingPhoneNumbers.create({
      phoneNumber: params.phoneNumber,
      ...(params.voiceWebhookUrl ? { voiceUrl: params.voiceWebhookUrl, voiceMethod: "POST" } : {}),
      ...(params.smsWebhookUrl ? { smsUrl: params.smsWebhookUrl, smsMethod: "POST" } : {}),
    });
  }

  async listNumbers(): Promise<TwilioIncomingNumberResource[]> {
    return this.client.incomingPhoneNumbers.list();
  }

  async configureNumber(params: {
    sid: string;
    voiceWebhookUrl?: string;
    smsWebhookUrl?: string;
    friendlyName?: string;
  }): Promise<TwilioIncomingNumberResource> {
    const update: Record<string, unknown> = {};
    if (params.voiceWebhookUrl) update.voiceUrl = params.voiceWebhookUrl;
    if (params.smsWebhookUrl) update.smsUrl = params.smsWebhookUrl;
    if (params.friendlyName) update.friendlyName = params.friendlyName;
    return this.client.incomingPhoneNumbers(params.sid).update(update);
  }
}

// ---------------------------------------------------------------------------
// TwiML: <Connect><Stream> to this driver's own media-stream WS endpoint
// ---------------------------------------------------------------------------

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Builds the TwiML document Twilio's Voice webhook must return so the call
 * is bridged into this driver's media-stream WebSocket server via
 * bidirectional `<Connect><Stream>` (SPEC target pattern: Twilio Voice
 * webhook -> TwiML `<Connect><Stream>` -> WebSocket media-stream server ->
 * OpenAI Realtime bridge). Reference:
 * https://www.twilio.com/docs/voice/twiml/stream.
 *
 * `mediaStreamUrl` MUST be a `wss://` URL this driver's own WebSocket server
 * is listening on (see `realtimeBridge.ts`); `callSid` is passed through as
 * a Twilio `<Parameter>` so the media-stream handler can correlate the
 * incoming WS connection with the `call_id` `make_call` already returned,
 * even before Twilio's `start` event (which also carries CallSid) arrives.
 */
export function buildVoiceStreamTwiml(params: { mediaStreamUrl: string; callSid?: string }): string {
  const paramTag = params.callSid
    ? `<Parameter name="callSid" value="${escapeXmlAttr(params.callSid)}"/>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${escapeXmlAttr(params.mediaStreamUrl)}">${paramTag}</Stream></Connect></Response>`
  );
}

// ---------------------------------------------------------------------------
// Error mapping — best-effort, honest about its own limits
// ---------------------------------------------------------------------------

/** Shape of the error the `twilio` SDK actually throws (superset of what we
 * read here — the SDK's real type is broader but this is all we inspect). */
interface TwilioSdkError {
  code?: number;
  status?: number;
  message?: string;
  moreInfo?: string;
}

/**
 * Best-effort translation of a thrown Twilio SDK error into CallMCP's error
 * taxonomy (SPEC §5). This is deliberately conservative: only patterns this
 * repo can point at Twilio's own documented compliance gates for (A2P 10DLC
 * registration, Regulatory Bundles for KYC-gated number purchase) are mapped
 * to a named code; everything else falls through to the `DRIVER_ERROR`
 * passthrough envelope (SPEC §5.6) rather than guessing. Exact Twilio error
 * *codes* for every regulatory-bundle failure mode were not independently
 * enumerated against a live sandbox account while writing this driver — the
 * message-substring heuristics below should be verified/tightened against
 * real Twilio error responses before being trusted as exhaustive.
 */
export function mapTwilioError(err: unknown, context: { driver: string }): CallMcpError {
  const e = err as TwilioSdkError;
  const message = e?.message ?? String(err);
  const lower = message.toLowerCase();

  if (lower.includes("regulatory") || lower.includes("bundle") || lower.includes("compliance")) {
    return {
      code: "KYC_REQUIRED",
      message: "Twilio requires identity/regulatory-bundle verification before this number can be provisioned",
      details: {
        driver: context.driver,
        provider_verification_url: "https://www.twilio.com/console/phone-numbers/regulatory-compliance",
        outstanding: ["regulatory_bundle"],
        typical_turnaround: "1-15 business days",
        twilio_native_message: message,
      },
    };
  }

  if (lower.includes("a2p") || lower.includes("10dlc") || lower.includes("campaign")) {
    return {
      code: "KYC_REQUIRED",
      message: "Twilio requires A2P 10DLC brand/campaign registration for this SMS traffic",
      details: {
        driver: context.driver,
        provider_verification_url: "https://www.twilio.com/console/sms/regulatory-compliance/a2p",
        outstanding: ["a2p_10dlc_brand", "a2p_10dlc_campaign"],
        // Per r2-transports.md §1: nominally "up to 5 business days" but
        // backlog has pushed real-world vetting to 10-15 business days, plus
        // a $15 campaign verification fee. Not required for voice-only use.
        typical_turnaround: "10-15 business days",
        twilio_native_message: message,
      },
    };
  }

  return {
    code: "DRIVER_ERROR",
    message: "upstream Twilio API returned an unmapped error",
    details: {
      driver: context.driver,
      driver_native_code: e?.code ?? null,
      driver_native_message: message,
      http_status: e?.status ?? null,
    },
  };
}
