/**
 * CallMCP server — end-to-end tests against the mock driver.
 *
 * Drives the real `Server` built by `createMcpServer` through a real MCP
 * `Client`, connected via `InMemoryTransport.createLinkedPair()` — no stdio,
 * no HTTP, but the full request/response + elicitation round trip the SPEC
 * describes, exercised in-process.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityManifest, Driver } from "@callmcp/driver-interface";

import { ApprovalStore } from "../src/approval.js";
import { DriverRegistry } from "../src/driverRegistry.js";
import { TOOL_CATALOG, type ServerCore } from "../src/tools.js";
import { createMcpServer } from "../src/transports.js";

async function buildCore(): Promise<ServerCore> {
  const driverRegistry = new DriverRegistry();
  await driverRegistry.load({ drivers: [{ id: "mock", type: "mock", default: true }] });
  return { driverRegistry, approvals: new ApprovalStore(), outOfBandBaseUrl: "http://localhost:8787/approve" };
}

interface ConnectOptions {
  elicitationSupported?: boolean;
  onElicit?: (message: string) => "accept" | "decline" | "cancel";
}

async function connect(core: ServerCore, opts: ConnectOptions = {}) {
  const server = createMcpServer(core);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: opts.elicitationSupported ? { elicitation: {} } : {} },
  );

  if (opts.onElicit) {
    const decide = opts.onElicit;
    client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
      const action = decide(request.params.message);
      return { action, content: {} };
    });
  }

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function errorCode(result: CallToolResult): string | undefined {
  const sc = result.structuredContent as { error?: { code?: string } } | undefined;
  return sc?.error?.code;
}

function successData<T>(result: CallToolResult): T {
  if (result.isError) {
    throw new Error(`expected a successful tool result, got error: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent as T;
}

describe("CallMCP server (mock driver)", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
  });

  it("tools/list reflects the mock driver's full-capability manifest", async () => {
    const core = await buildCore();
    const { client, close } = await connect(core);
    cleanup = close;

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    // Mock driver claims every capability true, so every SPEC §1 tool is present.
    expect(names).toEqual(Object.keys(TOOL_CATALOG).sort());

    const makeCall = tools.find((t) => t.name === "make_call");
    expect(makeCall?.annotations?.destructiveHint).toBe(true);
    expect(makeCall?.annotations?.readOnlyHint).toBe(false);

    const listDrivers = tools.find((t) => t.name === "list_drivers");
    expect(listDrivers?.annotations?.readOnlyHint).toBe(true);
  });

  it("excludes capability-gated tools for a driver that doesn't support them", async () => {
    const manifest: CapabilityManifest = {
      spec_version: "0.1.0",
      driver_id: "degraded",
      display_name: "Degraded Test Driver",
      kind: "byok",
      tools: {},
      capabilities: {
        supports_sms: false,
        supports_recording: false,
        supports_hangup: false,
        supports_number_purchase: false,
        supports_number_configuration: false,
        supports_realtime_transcription: false,
        supports_elicitation_approval: false,
        max_concurrent_calls: null,
        regions: ["US"],
      },
    };
    const degradedDriver: Driver = {
      id: "degraded",
      getManifest: () => manifest,
      makeCall: async (p) => ({
        call_id: "c1",
        status: "in_progress",
        to: p.to,
        approval_id: p.approval_id ?? "x",
        driver: "degraded",
      }),
      getCallStatus: async (p) => ({ call_id: p.call_id, status: "completed", driver: "degraded" }),
      getTranscript: async (p) => ({ call_id: p.call_id, status: "complete", transcript: [], driver: "degraded" }),
      listNumbers: async () => ({ numbers: [], next_cursor: null, driver: "degraded" }),
      listCalls: async () => ({ calls: [], next_cursor: null, driver: "degraded" }),
      // end_call, get_recording, send_sms, search_numbers, buy_number,
      // configure_number all intentionally omitted — this is the "absence,
      // not runtime surprise" signal SPEC §0.1.2 requires.
    };

    const driverRegistry = new DriverRegistry();
    await driverRegistry.loadDrivers([degradedDriver]);
    const core: ServerCore = { driverRegistry, approvals: new ApprovalStore(), outOfBandBaseUrl: "http://localhost:8787/approve" };

    const { client, close } = await connect(core);
    cleanup = close;
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    for (const excluded of ["buy_number", "configure_number", "end_call", "get_recording", "search_numbers", "send_sms"]) {
      expect(names).not.toContain(excluded);
    }
    for (const baseline of ["list_drivers", "make_call", "get_call_status", "get_transcript", "list_numbers", "list_calls"]) {
      expect(names).toContain(baseline);
    }
  });

  it("make_call without a valid approval triggers the approval flow instead of dialing (non-eliciting client)", async () => {
    const core = await buildCore();
    const { client, close } = await connect(core, { elicitationSupported: false });
    cleanup = close;

    const result = await client.callTool({ name: "make_call", arguments: { to: "+14155550100" } });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("APPROVAL_REQUIRED");

    const details = (result.structuredContent as { error: { details?: { out_of_band_url?: string } } }).error.details;
    expect(details?.out_of_band_url).toMatch(/^http:\/\/localhost:8787\/approve\//);

    // The call must never have reached the driver.
    const listCalls = successData<{ calls: unknown[] }>(await client.callTool({ name: "list_calls", arguments: {} }));
    expect(listCalls.calls).toEqual([]);
  });

  it("make_call proceeds once an eliciting client accepts the inline approval", async () => {
    const core = await buildCore();
    const { client, close } = await connect(core, { elicitationSupported: true, onElicit: () => "accept" });
    cleanup = close;

    const result = await client.callTool({ name: "make_call", arguments: { to: "+14155550101" } });
    expect(result.isError).toBeFalsy();

    const data = successData<{ call_id: string; status: string; approval_id: string }>(result);
    expect(data.call_id).toBeTruthy();
    expect(data.status).toBe("in_progress");

    const listCalls = successData<{ calls: { call_id: string }[] }>(
      await client.callTool({ name: "list_calls", arguments: {} }),
    );
    expect(listCalls.calls.map((c) => c.call_id)).toContain(data.call_id);
  });

  it("a denied approval blocks the call", async () => {
    const core = await buildCore();
    const { client, close } = await connect(core, { elicitationSupported: true, onElicit: () => "decline" });
    cleanup = close;

    const approval = successData<{ approval_id: string; state: string }>(
      await client.callTool({
        name: "request_call_approval",
        arguments: { scope: "single_call", destinations: ["+14155550102"], purpose: "test" },
      }),
    );
    expect(approval.state).toBe("denied");

    const result = await client.callTool({
      name: "make_call",
      arguments: { to: "+14155550102", approval_id: approval.approval_id },
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("APPROVAL_DENIED");

    const listCalls = successData<{ calls: unknown[] }>(await client.callTool({ name: "list_calls", arguments: {} }));
    expect(listCalls.calls).toEqual([]);
  });

  it("an expired approval blocks the call", async () => {
    vi.useFakeTimers();
    const core = await buildCore();
    // Non-eliciting client: once the pre-created approval expires, make_call
    // must fall back to the out-of-band gate rather than ever dialing.
    const { client, close } = await connect(core, { elicitationSupported: false });
    cleanup = close;

    const approval = successData<{ approval_id: string; state: string; expires_at: string }>(
      await client.callTool({
        name: "request_call_approval",
        arguments: { scope: "single_call", destinations: ["+14155550103"], ttl_seconds: 60 },
      }),
    );
    expect(approval.state).toBe("pending");

    vi.setSystemTime(new Date(Date.parse(approval.expires_at) + 1000));

    const result = await client.callTool({
      name: "make_call",
      arguments: { to: "+14155550103", approval_id: approval.approval_id },
    });
    expect(result.isError).toBe(true);
    expect(["APPROVAL_REQUIRED", "APPROVAL_DENIED"]).toContain(errorCode(result));

    const listCalls = successData<{ calls: unknown[] }>(await client.callTool({ name: "list_calls", arguments: {} }));
    expect(listCalls.calls).toEqual([]);
  });

  it("emits notifications/tools/list_changed when the driver set is reloaded", async () => {
    const core = await buildCore();
    const { client, close } = await connect(core);
    cleanup = close;

    let notified = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified = true;
    });

    await core.driverRegistry.load({ drivers: [{ id: "mock", type: "mock", default: true }] });
    // Give the in-memory transport a tick to deliver the notification.
    await new Promise((r) => setTimeout(r, 10));

    expect(notified).toBe(true);
  });
});

describe("DriverRegistry against the real bundled driver packages", () => {
  // These prove `driverRegistry.ts`'s "known class fallback" path (none of
  // the three launch drivers export a `createDriver` factory today — they
  // export plain `Driver`-implementing classes) actually loads the real,
  // compiled `@callmcp/driver-kaicalls` / `-dograh` / `-byok` packages, not
  // just the mock driver.

  it("loads @callmcp/driver-kaicalls and computes its tools/list exclusions", async () => {
    const registry = new DriverRegistry();
    await registry.load({
      drivers: [{ id: "kaicalls", type: "kaicalls", default: true, credentials: { apiKey: "test-key" } }],
    });

    expect(registry.warnings).toEqual([]);
    const { driver, manifest } = registry.get("kaicalls");
    expect(driver.id).toBe("kaicalls");
    expect(manifest.kind).toBe("hosted");
    // KaiCalls has no hangup endpoint per its manifest — end_call must be
    // gated out, matching SPEC §7's degradation appendix.
    expect(manifest.capabilities.supports_hangup).toBe(false);
    expect(driver.endCall).toBeUndefined();
  });

  it("loads @callmcp/driver-byok with credentials passed straight through as its config", async () => {
    const registry = new DriverRegistry();
    await registry.load({
      drivers: [
        {
          id: "twilio_openai",
          type: "byok",
          default: true,
          credentials: {
            twilioAccountSid: "AC_test",
            twilioAuthToken: "tok",
            openaiApiKey: "sk_test",
            voiceWebhookUrl: "https://example.com/voice",
            mediaStreamUrl: "wss://example.com/media",
          },
        },
      ],
    });

    expect(registry.warnings).toEqual([]);
    const { driver } = registry.get("twilio_openai");
    expect(driver.id).toBe("twilio_openai");
  });

  it("collects a warning (not a throw) and falls back to mock when a driver package's constructor rejects its config", async () => {
    const registry = new DriverRegistry();
    // DograhClient throws when it has no base URL and DOGRAH_BASE_URL isn't set.
    delete process.env.DOGRAH_BASE_URL;
    await registry.load({ drivers: [{ id: "dograh", type: "dograh" }] });

    expect(registry.warnings.some((w) => w.includes("dograh"))).toBe(true);
    // Falls back to the mock driver rather than leaving the registry empty.
    expect(registry.get().driver.id).toBe("mock");
  });
});
