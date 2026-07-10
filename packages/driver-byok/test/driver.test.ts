/**
 * @callmcp/driver-byok — driver tests
 *
 * Fully mocked: a fake Twilio client (TwilioClientLike) and a fake
 * BrainAdapter stand in for the real `twilio` SDK and OpenAI Realtime
 * WebSocket session. No real network calls, no Twilio/OpenAI spend.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runConformanceSuite } from "@callmcp/driver-interface";
import { BYOKDriver, TwilioDriverError } from "../src/driver.js";
import { buildVoiceStreamTwiml, mapTwilioError, type TwilioClientLike } from "../src/transport/twilio.js";
import type {
  BrainAdapter,
  BrainErrorEvent,
  BrainSessionConfig,
  BrainToolCallEvent,
  BrainTranscriptEvent,
} from "../src/brain/adapter.js";
import { BYOK_DRIVER_MANIFEST } from "../src/manifest.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeTwilioClient(overrides: Partial<TwilioClientLike> = {}): TwilioClientLike {
  const callInstance = {
    fetch: vi.fn(async () => ({
      sid: "CAtest",
      to: "+14155551234",
      from: "+14155550000",
      status: "in-progress",
      startTime: "2026-07-09T18:00:00Z",
      endTime: null,
      duration: null,
    })),
    update: vi.fn(async (params: Record<string, unknown>) => ({
      sid: "CAtest",
      to: "+14155551234",
      from: "+14155550000",
      status: params.status === "completed" ? "completed" : "in-progress",
    })),
  };

  const callsFn = Object.assign(vi.fn(() => callInstance), {
    create: vi.fn(async () => ({ sid: "CAtest", status: "queued" })),
    list: vi.fn(async () => []),
  }) as unknown as TwilioClientLike["calls"];

  const numberInstance = { update: vi.fn(async (params: Record<string, unknown>) => ({ sid: "PNtest", phoneNumber: "+14155559999", capabilities: {}, ...params })) };
  const incomingPhoneNumbersFn = Object.assign(vi.fn(() => numberInstance), {
    create: vi.fn(async () => ({ sid: "PNtest", phoneNumber: "+14155559999", capabilities: { voice: true, sms: true } })),
    list: vi.fn(async () => [{ sid: "PNtest", phoneNumber: "+14155559999", capabilities: { voice: true, sms: true }, dateCreated: "2026-07-01T00:00:00Z" }]),
  }) as unknown as TwilioClientLike["incomingPhoneNumbers"];

  return {
    calls: callsFn,
    messages: { create: vi.fn(async () => ({ sid: "SMtest", status: "queued", to: "+14155551234", from: "+14155550000" })) },
    recordings: { list: vi.fn(async () => []) },
    availablePhoneNumbers: vi.fn(() => ({
      local: { list: vi.fn(async () => [{ phoneNumber: "+14155550001", isoCountry: "US", capabilities: { voice: true, sms: true } }]) },
    })) as unknown as TwilioClientLike["availablePhoneNumbers"],
    incomingPhoneNumbers: incomingPhoneNumbersFn,
    ...overrides,
  };
}

function makeFakeBrainAdapter() {
  const callbacks: {
    audio?: (chunk: string) => void;
    transcript?: (event: BrainTranscriptEvent) => void;
    toolCall?: (event: BrainToolCallEvent) => void;
    error?: (event: BrainErrorEvent) => void;
  } = {};

  const adapter: BrainAdapter & {
    _emitAgentAudio: (chunk: string) => void;
    _emitTranscript: (event: BrainTranscriptEvent) => void;
    _emitToolCall: (event: BrainToolCallEvent) => void;
    connectCalls: BrainSessionConfig[];
    sentCallerAudio: string[];
    sentToolResults: Array<{ toolCallId: string; resultJson: string }>;
    closed: boolean;
  } = {
    id: "fake_brain",
    connectCalls: [],
    sentCallerAudio: [],
    sentToolResults: [],
    closed: false,
    connect: vi.fn(async (config: BrainSessionConfig) => {
      adapter.connectCalls.push(config);
    }),
    sendCallerAudio: vi.fn((chunk: string) => {
      adapter.sentCallerAudio.push(chunk);
    }),
    onAgentAudio: vi.fn((cb) => {
      callbacks.audio = cb;
    }),
    onTranscript: vi.fn((cb) => {
      callbacks.transcript = cb;
    }),
    onToolCall: vi.fn((cb) => {
      callbacks.toolCall = cb;
    }),
    onError: vi.fn((cb) => {
      callbacks.error = cb;
    }),
    sendToolResult: vi.fn((toolCallId: string, resultJson: string) => {
      adapter.sentToolResults.push({ toolCallId, resultJson });
    }),
    interruptAgent: vi.fn(),
    close: vi.fn(() => {
      adapter.closed = true;
    }),
    _emitAgentAudio: (chunk) => callbacks.audio?.(chunk),
    _emitTranscript: (event) => callbacks.transcript?.(event),
    _emitToolCall: (event) => callbacks.toolCall?.(event),
  };

  return adapter;
}

class FakeTwilioSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  emitMessage(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function makeDriver(opts: { twilioClient?: TwilioClientLike; createBrainAdapter?: () => BrainAdapter } = {}) {
  return new BYOKDriver({
    twilioAccountSid: "ACtest",
    twilioAuthToken: "authtoken",
    twilioFromNumber: "+14155550000",
    openaiApiKey: "sk-test",
    voiceWebhookUrl: "https://example.com/voice",
    mediaStreamUrl: "wss://example.com/media-stream",
    twilioClient: opts.twilioClient ?? makeFakeTwilioClient(),
    createBrainAdapter: opts.createBrainAdapter ?? (() => makeFakeBrainAdapter()),
  });
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("BYOK_DRIVER_MANIFEST", () => {
  it("declares driver_id twilio_openai and the documented capability set", () => {
    expect(BYOK_DRIVER_MANIFEST.driver_id).toBe("twilio_openai");
    expect(BYOK_DRIVER_MANIFEST.kind).toBe("byok");
    expect(BYOK_DRIVER_MANIFEST.capabilities.supports_sms).toBe(true);
    expect(BYOK_DRIVER_MANIFEST.capabilities.supports_whatsapp).toBe(false);
    expect(BYOK_DRIVER_MANIFEST.capabilities.supports_hangup).toBe(true);
    expect(BYOK_DRIVER_MANIFEST.capabilities.supports_number_purchase).toBe(true);
  });

  it("names every real degradation in known_degradations", () => {
    const tags = (BYOK_DRIVER_MANIFEST.known_degradations ?? []).map((d) => d.tool_or_capability);
    expect(tags).toContain("supports_whatsapp");
    expect(tags).toContain("send_sms");
    expect(tags).toContain("buy_number");
  });

  it("passes @callmcp/driver-interface's conformance suite (manifest promises match implemented methods)", async () => {
    const driver = makeDriver();
    const result = await runConformanceSuite(driver, BYOK_DRIVER_MANIFEST);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

describe("buildVoiceStreamTwiml", () => {
  it("returns a <Connect><Stream> document pointed at the media-stream URL", () => {
    const xml = buildVoiceStreamTwiml({ mediaStreamUrl: "wss://example.com/media-stream?callSid=CA123", callSid: "CA123" });
    expect(xml).toContain("<Connect><Stream url=\"wss://example.com/media-stream?callSid=CA123\">");
    expect(xml).toContain('<Parameter name="callSid" value="CA123"/>');
  });

  it("escapes XML-significant characters in the URL", () => {
    const xml = buildVoiceStreamTwiml({ mediaStreamUrl: "wss://example.com/media-stream?a=1&b=2" });
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("?a=1&b=2\"");
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("mapTwilioError", () => {
  it("maps regulatory-bundle errors to KYC_REQUIRED", () => {
    const mapped = mapTwilioError(new Error("Regulatory Bundle is required for this number"), { driver: "twilio_openai" });
    expect(mapped.code).toBe("KYC_REQUIRED");
    expect(mapped.details?.outstanding).toContain("regulatory_bundle");
  });

  it("maps A2P/10DLC errors to KYC_REQUIRED with the campaign turnaround", () => {
    const mapped = mapTwilioError(new Error("A2P 10DLC campaign registration required"), { driver: "twilio_openai" });
    expect(mapped.code).toBe("KYC_REQUIRED");
    expect(mapped.details?.typical_turnaround).toBe("10-15 business days");
  });

  it("falls back to the DRIVER_ERROR passthrough envelope for unmapped errors", () => {
    const mapped = mapTwilioError(new Error("something Twilio-specific and unmapped"), { driver: "twilio_openai" });
    expect(mapped.code).toBe("DRIVER_ERROR");
    expect(mapped.details?.driver_native_message).toContain("unmapped");
  });
});

// ---------------------------------------------------------------------------
// BYOKDriver — calls
// ---------------------------------------------------------------------------

describe("BYOKDriver.makeCall / getCallStatus / endCall", () => {
  it("places a call via Twilio and returns a MakeCallResult keyed by the Twilio CallSid", async () => {
    const client = makeFakeTwilioClient();
    const driver = makeDriver({ twilioClient: client });

    const result = await driver.makeCall({ to: "+14155551234", approval_id: "a_123" });

    expect(result.call_id).toBe("CAtest");
    expect(result.approval_id).toBe("a_123");
    expect(result.driver).toBe("twilio_openai");
    expect(client.calls.create).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+14155551234", from: "+14155550000", url: "https://example.com/voice", record: true }),
    );
  });

  it("defaults approval_id to an allowlist marker when omitted (server core already gated it)", async () => {
    const driver = makeDriver();
    const result = await driver.makeCall({ to: "+14155551234" });
    expect(result.approval_id).toBe("allowlist_match");
  });

  it("throws DRIVER_ERROR when no from number is configured or supplied", async () => {
    const driver = new BYOKDriver({
      twilioAccountSid: "ACtest",
      twilioAuthToken: "authtoken",
      openaiApiKey: "sk-test",
      voiceWebhookUrl: "https://example.com/voice",
      mediaStreamUrl: "wss://example.com/media-stream",
      twilioClient: makeFakeTwilioClient(),
    });

    await expect(driver.makeCall({ to: "+14155551234" })).rejects.toMatchObject({ code: "DRIVER_ERROR" });
  });

  it("respects options.twilio_openai.record=false to opt out of default recording", async () => {
    const client = makeFakeTwilioClient();
    const driver = makeDriver({ twilioClient: client });

    await driver.makeCall({ to: "+14155551234", options: { twilio_openai: { record: false } } });

    expect(client.calls.create).toHaveBeenCalledWith(expect.objectContaining({ record: false }));
  });

  it("getCallStatus reflects Twilio's call resource", async () => {
    const driver = makeDriver();
    await driver.makeCall({ to: "+14155551234" });

    const status = await driver.getCallStatus({ call_id: "CAtest" });
    expect(status.status).toBe("in_progress");
    expect(status.to).toBe("+14155551234");
  });

  it("endCall is idempotent for an already-ended call", async () => {
    const client = makeFakeTwilioClient({
      calls: Object.assign(
        vi.fn(() => ({
          fetch: vi.fn(),
          update: vi.fn(async () => {
            throw new Error("Call is not in-progress. Cannot update status");
          }),
        })),
        { create: vi.fn(async () => ({ sid: "CAtest", status: "queued" })), list: vi.fn(async () => []) },
      ) as unknown as TwilioClientLike["calls"],
    });
    const driver = makeDriver({ twilioClient: client });
    await driver.makeCall({ to: "+14155551234" });

    const result = await driver.endCall({ call_id: "CAtest" });
    expect(result.status).toBe("already_ended");
  });

  it("endCall surfaces a genuine Twilio failure rather than masking it as already_ended", async () => {
    const client = makeFakeTwilioClient({
      calls: Object.assign(
        vi.fn(() => ({
          fetch: vi.fn(),
          update: vi.fn(async () => {
            throw new Error("Authentication Error - invalid credentials");
          }),
        })),
        { create: vi.fn(async () => ({ sid: "CAtest", status: "queued" })), list: vi.fn(async () => []) },
      ) as unknown as TwilioClientLike["calls"],
    });
    const driver = makeDriver({ twilioClient: client });
    await driver.makeCall({ to: "+14155551234" });

    await expect(driver.endCall({ call_id: "CAtest" })).rejects.toBeInstanceOf(TwilioDriverError);
  });
});

// ---------------------------------------------------------------------------
// BYOKDriver — SMS
// ---------------------------------------------------------------------------

describe("BYOKDriver.sendSms", () => {
  it("sends a real standalone SMS via Twilio Messaging", async () => {
    const client = makeFakeTwilioClient();
    const driver = makeDriver({ twilioClient: client });

    const result = await driver.sendSms({ to: "+14155551234", body: "hello", approval_id: "a_1" });

    expect(result.message_id).toBe("SMtest");
    expect(result.channel).toBe("sms");
    expect(client.messages.create).toHaveBeenCalledWith(expect.objectContaining({ to: "+14155551234", body: "hello" }));
  });

  it("rejects whatsapp/rcs channels as UNSUPPORTED_CAPABILITY (not silently degraded)", async () => {
    const driver = makeDriver();
    await expect(driver.sendSms({ to: "+14155551234", body: "hi", channel: "whatsapp" })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
  });
});

// ---------------------------------------------------------------------------
// BYOKDriver — numbers
// ---------------------------------------------------------------------------

describe("BYOKDriver numbers", () => {
  it("searchNumbers maps Twilio's available-number shape to SearchNumbersResult", async () => {
    const driver = makeDriver();
    const result = await driver.searchNumbers({ country: "US" });
    expect(result.numbers[0]?.number).toBe("+14155550001");
    expect(result.numbers[0]?.capabilities).toContain("voice");
  });

  it("buyNumber surfaces KYC_REQUIRED honestly on a regulatory-bundle failure", async () => {
    const client = makeFakeTwilioClient({
      incomingPhoneNumbers: Object.assign(
        vi.fn(() => ({ update: vi.fn() })),
        {
          create: vi.fn(async () => {
            throw new Error("Regulatory Bundle required for this number type");
          }),
          list: vi.fn(async () => []),
        },
      ) as unknown as TwilioClientLike["incomingPhoneNumbers"],
    });
    const driver = makeDriver({ twilioClient: client });

    await expect(driver.buyNumber({ number: "+441234567890" })).rejects.toMatchObject({ code: "KYC_REQUIRED" });
  });

  it("listNumbers reports owned Twilio numbers", async () => {
    const driver = makeDriver();
    const result = await driver.listNumbers({});
    expect(result.numbers[0]?.number).toBe("+14155559999");
  });

  it("configureNumber throws DRIVER_ERROR for a number this account doesn't own", async () => {
    const driver = makeDriver();
    await expect(driver.configureNumber({ number: "+19995551234" })).rejects.toMatchObject({ code: "DRIVER_ERROR" });
  });
});

// ---------------------------------------------------------------------------
// BYOKDriver — realtime media-stream bridge
// ---------------------------------------------------------------------------

describe("BYOKDriver.attachMediaStream (RealtimeBridge integration)", () => {
  it("bridges Twilio media events to the brain and back, and captures the transcript", async () => {
    const brain = makeFakeBrainAdapter();
    const driver = makeDriver({ createBrainAdapter: () => brain });
    const { call_id } = await driver.makeCall({ to: "+14155551234" });
    expect(call_id).toBe("CAtest");

    const socket = new FakeTwilioSocket();
    driver.attachMediaStream(socket as unknown as import("ws").default);

    socket.emitMessage({ event: "connected" });
    socket.emitMessage({ event: "start", start: { streamSid: "MZ123", callSid: "CAtest" } });
    // Allow the async onStart handler (which awaits brain.connect) to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(brain.connect).toHaveBeenCalled();

    socket.emitMessage({ event: "media", media: { payload: "AAAA" } });
    expect(brain.sentCallerAudio).toEqual(["AAAA"]);

    brain._emitAgentAudio("BBBB");
    expect(socket.sent.some((s) => s.includes('"media"') && s.includes("BBBB") && s.includes("MZ123"))).toBe(true);

    brain._emitTranscript({ role: "caller", text: "hi there", final: true, at: "2026-07-09T18:00:01Z" });
    brain._emitTranscript({ role: "agent", text: "partial...", final: false, at: "2026-07-09T18:00:02Z" });
    brain._emitTranscript({ role: "agent", text: "hello, how can I help?", final: true, at: "2026-07-09T18:00:03Z" });

    const transcript = await driver.getTranscript({ call_id: "CAtest" });
    expect(transcript.transcript).toEqual([
      { role: "caller", text: "hi there", at: "2026-07-09T18:00:01Z" },
      { role: "agent", text: "hello, how can I help?", at: "2026-07-09T18:00:03Z" },
    ]);
  });

  it("round-trips a mid-call tool call through the configured toolCallHook before settling it to the brain", async () => {
    const brain = makeFakeBrainAdapter();
    const toolCallHook = vi.fn(async (event: BrainToolCallEvent, callId: string) => {
      expect(callId).toBe("CAtest");
      expect(event.name).toBe("lookup_order");
      return { resultJson: JSON.stringify({ order_status: "shipped" }) };
    });

    const driver = new BYOKDriver({
      twilioAccountSid: "ACtest",
      twilioAuthToken: "authtoken",
      twilioFromNumber: "+14155550000",
      openaiApiKey: "sk-test",
      voiceWebhookUrl: "https://example.com/voice",
      mediaStreamUrl: "wss://example.com/media-stream",
      twilioClient: makeFakeTwilioClient(),
      createBrainAdapter: () => brain,
      toolCallHook,
    });

    await driver.makeCall({ to: "+14155551234" });

    const socket = new FakeTwilioSocket();
    driver.attachMediaStream(socket as unknown as import("ws").default);
    socket.emitMessage({ event: "start", start: { streamSid: "MZ123", callSid: "CAtest" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    brain._emitToolCall({ toolCallId: "call_1", name: "lookup_order", argumentsJson: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toolCallHook).toHaveBeenCalled();
    expect(brain.sentToolResults).toEqual([{ toolCallId: "call_1", resultJson: JSON.stringify({ order_status: "shipped" }) }]);
  });

  it("uses the default toolCallHook (returns an explicit error, never silently drops the call) when none is configured", async () => {
    const brain = makeFakeBrainAdapter();
    const driver = makeDriver({ createBrainAdapter: () => brain });
    await driver.makeCall({ to: "+14155551234" });

    const socket = new FakeTwilioSocket();
    driver.attachMediaStream(socket as unknown as import("ws").default);
    socket.emitMessage({ event: "start", start: { streamSid: "MZ123", callSid: "CAtest" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    brain._emitToolCall({ toolCallId: "call_1", name: "place_another_call", argumentsJson: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(brain.sentToolResults).toHaveLength(1);
    const parsed = JSON.parse(brain.sentToolResults[0]!.resultJson) as { error: string };
    expect(parsed.error).toContain("place_another_call");
  });

  it("backfills a call record for an inbound call with no prior make_call", async () => {
    const client = makeFakeTwilioClient();
    const brain = makeFakeBrainAdapter();
    const driver = makeDriver({ twilioClient: client, createBrainAdapter: () => brain });

    const socket = new FakeTwilioSocket();
    driver.attachMediaStream(socket as unknown as import("ws").default);
    socket.emitMessage({ event: "start", start: { streamSid: "MZ999", callSid: "CAinbound" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(brain.connect).toHaveBeenCalled();
    // A record now exists for CAinbound (transcript is `[]`, not `null`,
    // which is the signal a CallRecord was created — see getTranscript's
    // not-found-vs-empty distinction in driver.ts).
    const transcript = await driver.getTranscript({ call_id: "CAinbound" });
    expect(transcript.transcript).toEqual([]);
  });
});
