/**
 * Tests for @callmcp/driver-kaicalls, entirely against a mocked HTTP layer
 * (a fake `fetch` injected via `fetchImpl`). No real network calls, no real
 * spend, no real KaiCalls credentials required.
 */

import { describe, expect, it, vi } from "vitest";
import { runConformanceSuite, UnsupportedCapabilityError } from "@callmcp/driver-interface";
import { KaiCallsClient } from "../src/client.js";
import { KaiCallsDriver, KaiCallsDriverError } from "../src/driver.js";
import { KAICALLS_MANIFEST } from "../src/manifest.js";
import {
  provisionKaiCallsAccount,
  retryWithPayment,
  type ProvisionDeferred,
  type ProvisionPaymentRequired,
  type ProvisionSuccess,
} from "../src/provisioning.js";

// ---------------------------------------------------------------------
// Mock fetch harness
// ---------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => unknown | { __isError: true; payload?: unknown };

/**
 * Builds a `fetch` mock that understands two request shapes:
 *  - MCP JSON-RPC `tools/call` POSTs to the configured `mcpEndpoint`
 *  - Plain REST POSTs (used by provisioning) to any other path
 *
 * `tools` maps tool name -> either a plain return value (wrapped as
 * `structuredContent`) or a sentinel `{ __isError: true }` to simulate an
 * MCP tool-level error.
 */
function mockMcpFetch(tools: Record<string, ToolHandler>, opts: { mcpEndpoint?: string } = {}) {
  const endpoint = opts.mcpEndpoint ?? "https://callmcp.ai/mcp";
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === endpoint) {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      expect(body.method).toBe("tools/call");
      const authHeader = (init?.headers as Record<string, string>)?.authorization;
      expect(authHeader).toMatch(/^Bearer /);

      const { name, arguments: args } = body.params;
      calls.push({ tool: name, args });

      const handler = tools[name];
      if (!handler) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: `no mock handler registered for tool "${name}"` },
        });
      }

      const result = handler(args);
      if (isErrorSentinel(result)) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { isError: true, structuredContent: result.payload ?? { message: "tool failed" } },
        });
      }

      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: result },
      });
    }

    throw new Error(`mockMcpFetch: unexpected request to ${url}`);
  });

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function isErrorSentinel(value: unknown): value is { __isError: true; payload?: unknown } {
  return Boolean(value && typeof value === "object" && (value as { __isError?: unknown }).__isError === true);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeDriver(tools: Record<string, ToolHandler>) {
  const { fetchImpl, calls } = mockMcpFetch(tools);
  const client = new KaiCallsClient({ apiKey: "kc_live_test", fetchImpl });
  const driver = new KaiCallsDriver(client);
  return { driver, calls };
}

// ---------------------------------------------------------------------
// Manifest / conformance
// ---------------------------------------------------------------------

describe("KAICALLS_MANIFEST", () => {
  it("is internally consistent with the KaiCallsDriver implementation", async () => {
    const { driver } = makeDriver({});
    const result = await runConformanceSuite(driver, KAICALLS_MANIFEST);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("honestly declines end_call (no hangup tool documented)", () => {
    expect(KAICALLS_MANIFEST.capabilities.supports_hangup).toBe(false);
    expect(KAICALLS_MANIFEST.tools.end_call?.supported).toBe(false);
  });

  it("honestly declines realtime transcription and elicitation approval", () => {
    expect(KAICALLS_MANIFEST.capabilities.supports_realtime_transcription).toBe(false);
    expect(KAICALLS_MANIFEST.capabilities.supports_elicitation_approval).toBe(false);
  });

  it("does not claim WhatsApp/RCS support", () => {
    expect(KAICALLS_MANIFEST.capabilities.supports_whatsapp).toBe(false);
    expect(KAICALLS_MANIFEST.capabilities.supports_rcs).toBe(false);
  });
});

describe("KaiCallsDriver.endCall", () => {
  it("is not implemented (undefined, not a throwing stub)", () => {
    const { driver } = makeDriver({});
    expect(driver.endCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// makeCall
// ---------------------------------------------------------------------

describe("KaiCallsDriver.makeCall", () => {
  it("maps to the make_call tool and normalizes the result", async () => {
    const { driver, calls } = makeDriver({
      make_call: (args) => {
        expect(args).toMatchObject({ to: "+14155551234", agent_id: "agent_123" });
        return {
          call_id: "call_abc",
          status: "ringing",
          to: "+14155551234",
          from: "+14155559999",
          started_at: "2026-07-09T18:04:00Z",
        };
      },
    });

    const result = await driver.makeCall({
      to: "+14155551234",
      agent_config_ref: "agent_123",
      approval_id: "a_test",
    });

    expect(result).toEqual({
      call_id: "call_abc",
      status: "ringing",
      to: "+14155551234",
      from: "+14155559999",
      approval_id: "a_test",
      started_at: "2026-07-09T18:04:00Z",
      driver: "kaicalls",
    });
    expect(calls).toHaveLength(1);
  });

  it("echoes a sentinel approval_id when the caller supplies none", async () => {
    const { driver } = makeDriver({
      make_call: () => ({ call_id: "call_1", status: "queued", to: "+14155551234" }),
    });

    const result = await driver.makeCall({ to: "+14155551234" });
    expect(result.approval_id).toBe("kaicalls_no_native_approval_concept");
  });

  it("wraps upstream failures in KaiCallsDriverError (DRIVER_ERROR)", async () => {
    const { driver } = makeDriver({
      make_call: () => ({ __isError: true, payload: { message: "no agent instance available" } }),
    });

    await expect(driver.makeCall({ to: "+14155551234" })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(KaiCallsDriverError);
      const e = err as KaiCallsDriverError;
      expect(e.code).toBe("DRIVER_ERROR");
      expect(e.details.driver).toBe("kaicalls");
      expect(e.details.tool).toBe("make_call");
      return true;
    });
  });
});

// ---------------------------------------------------------------------
// getCallStatus / getTranscript / getRecording
// ---------------------------------------------------------------------

describe("KaiCallsDriver.getCallStatus", () => {
  it("maps known statuses and preserves the raw string in metadata", async () => {
    const { driver } = makeDriver({
      check_call_status: () => ({
        call_id: "call_abc",
        status: "completed",
        to: "+14155551234",
        from: "+14155559999",
        duration_seconds: 42,
      }),
    });

    const result = await driver.getCallStatus({ call_id: "call_abc" });
    expect(result.status).toBe("completed");
    expect(result.duration_seconds).toBe(42);
    expect(result.metadata?.kaicalls_raw_status).toBe("completed");
  });

  it("falls back gracefully on an unrecognized status string", async () => {
    const { driver } = makeDriver({
      check_call_status: () => ({ call_id: "call_abc", status: "some_future_kaicalls_status" }),
    });

    const result = await driver.getCallStatus({ call_id: "call_abc" });
    expect(result.status).toBe("queued");
    expect(result.metadata?.kaicalls_raw_status).toBe("some_future_kaicalls_status");
  });
});

describe("KaiCallsDriver.getTranscript", () => {
  it("parses inline transcript turns defensively", async () => {
    const { driver } = makeDriver({
      get_transcript: () => ({
        status: "complete",
        transcript: [
          { role: "agent", text: "Hello!", at: "2026-07-09T18:00:00Z" },
          { speaker: "customer", message: "Hi there", timestamp: "2026-07-09T18:00:05Z" },
        ],
      }),
    });

    const result = await driver.getTranscript({ call_id: "call_abc" });
    expect(result.status).toBe("complete");
    expect(result.transcript).toEqual([
      { role: "agent", text: "Hello!", at: "2026-07-09T18:00:00Z" },
      { role: "caller", text: "Hi there", at: "2026-07-09T18:00:05Z" },
    ]);
  });

  it("returns a canonical tel:// resource_link when format=resource_link", async () => {
    const { driver } = makeDriver({
      get_transcript: () => ({ status: "complete", transcript: [] }),
    });

    const result = await driver.getTranscript({ call_id: "call_abc", format: "resource_link" });
    expect(result.resource_link).toBe("tel://calls/call_abc/transcript");
  });
});

describe("KaiCallsDriver.getRecording", () => {
  it("reports ready with a canonical resource_link when a URL is present", async () => {
    const { driver } = makeDriver({
      get_call_recording: () => ({ url: "https://cdn.kaicalls.com/rec.mp3", duration_seconds: 90 }),
    });

    const result = await driver.getRecording({ call_id: "call_abc" });
    expect(result.status).toBe("ready");
    expect(result.resource_link).toBe("tel://calls/call_abc/recording");
    expect(result.duration_seconds).toBe(90);
  });

  it("reports not_available when nothing is present", async () => {
    const { driver } = makeDriver({ get_call_recording: () => ({}) });
    const result = await driver.getRecording({ call_id: "call_abc" });
    expect(result.status).toBe("not_available");
  });
});

// ---------------------------------------------------------------------
// sendSms
// ---------------------------------------------------------------------

describe("KaiCallsDriver.sendSms", () => {
  it("sends over the sms channel", async () => {
    const { driver } = makeDriver({
      send_sms: (args) => {
        expect(args).toMatchObject({ to: "+14155551234", body: "hi" });
        return { message_id: "msg_1", status: "sent", to: "+14155551234", from: "+14155559999" };
      },
    });

    const result = await driver.sendSms({ to: "+14155551234", body: "hi" });
    expect(result).toMatchObject({ message_id: "msg_1", status: "sent", channel: "sms" });
  });

  it("rejects whatsapp/rcs channels honestly as UnsupportedCapabilityError", async () => {
    const { driver } = makeDriver({});

    await expect(driver.sendSms!({ to: "+14155551234", body: "hi", channel: "whatsapp" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    await expect(driver.sendSms!({ to: "+14155551234", body: "hi", channel: "rcs" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });
});

// ---------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------

describe("KaiCallsDriver number tools", () => {
  it("searchNumbers maps results with a sane capability default", async () => {
    const { driver } = makeDriver({
      search_available_numbers: () => ({
        numbers: [{ number: "+15550100000", monthly_price_usd: 1.15 }],
      }),
    });

    const result = await driver.searchNumbers!({ country: "US" });
    expect(result.numbers).toEqual([
      {
        number: "+15550100000",
        country: "US",
        capabilities: ["voice", "sms"],
        monthly_price_usd: 1.15,
        setup_price_usd: null,
      },
    ]);
  });

  it("buyNumber defaults to active status absent an explicit field", async () => {
    const { driver } = makeDriver({
      buy_number: (args) => {
        expect(args.number).toBe("+15550100000");
        return { number: "+15550100000" };
      },
    });

    const result = await driver.buyNumber!({ number: "+15550100000" });
    expect(result.status).toBe("active");
  });

  it("configureNumber attaches via agent_config_ref", async () => {
    const { driver, calls } = makeDriver({
      attach_number: (args) => {
        expect(args).toEqual({ number: "+15550100000", agent_id: "agent_123" });
        return {};
      },
    });

    const result = await driver.configureNumber!({ number: "+15550100000", agent_config_ref: "agent_123" });
    expect(result).toEqual({ number: "+15550100000", status: "updated", driver: "kaicalls" });
    expect(calls[0]?.tool).toBe("attach_number");
  });

  it("configureNumber detaches when agent_config_ref is explicitly null", async () => {
    const { driver, calls } = makeDriver({
      detach_number: (args) => {
        expect(args).toEqual({ number: "+15550100000" });
        return {};
      },
    });

    await driver.configureNumber!({ number: "+15550100000", agent_config_ref: null });
    expect(calls[0]?.tool).toBe("detach_number");
  });

  it("configureNumber throws UnsupportedCapabilityError for sms_webhook_url/caller_id_name", async () => {
    const { driver } = makeDriver({});

    await expect(
      driver.configureNumber!({ number: "+15550100000", sms_webhook_url: "https://example.com/hook" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);

    await expect(
      driver.configureNumber!({ number: "+15550100000", caller_id_name: "Acme Co" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("listNumbers maps owned numbers", async () => {
    const { driver } = makeDriver({
      list_numbers: () => ({
        numbers: [
          {
            number: "+15550100000",
            country: "US",
            agent_id: "agent_123",
            acquired_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    });

    const result = await driver.listNumbers({});
    expect(result.numbers).toEqual([
      {
        number: "+15550100000",
        country: "US",
        capabilities: ["voice", "sms"],
        agent_config_ref: "agent_123",
        acquired_at: "2026-01-01T00:00:00Z",
      },
    ]);
  });
});

// ---------------------------------------------------------------------
// listCalls
// ---------------------------------------------------------------------

describe("KaiCallsDriver.listCalls", () => {
  it("maps call summaries and omits status when 'any'", async () => {
    const { driver, calls } = makeDriver({
      list_recent_calls: () => ({
        calls: [{ call_id: "call_1", to: "+14155551234", from: "+14155559999", status: "completed" }],
      }),
    });

    const result = await driver.listCalls({ status: "any" });
    expect(result.calls).toHaveLength(1);
    expect(calls[0]?.args.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Client-level behavior
// ---------------------------------------------------------------------

describe("KaiCallsClient", () => {
  it("refuses to call a tool with no API key configured", async () => {
    const client = new KaiCallsClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(client.callTool("make_call", {})).rejects.toThrow(/no API key configured/);
  });
});

// ---------------------------------------------------------------------
// Provisioning (x402 self-provisioning)
// ---------------------------------------------------------------------

describe("provisionKaiCallsAccount", () => {
  it("returns a provisioned result on a successful signup", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        api_key: "kc_live_new",
        business_id: "biz_1",
        agent_id: "agent_1",
        phone_number: "+15550100000",
      }),
    );
    const client = new KaiCallsClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provisionKaiCallsAccount(client, { business_name: "Acme", email: "a@b.com" });
    expect(result.status).toBe("provisioned");
    expect((result as ProvisionSuccess).api_key).toBe("kc_live_new");
  });

  it("returns a deferred_to_human result on the non-x402 fallback", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { provisioning_deferred: true, checkout_url: "https://checkout.stripe.com/xyz" }),
    );
    const client = new KaiCallsClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provisionKaiCallsAccount(client, { business_name: "Acme", email: "a@b.com" });
    expect(result.status).toBe("deferred_to_human");
    expect((result as ProvisionDeferred).checkout_url).toBe("https://checkout.stripe.com/xyz");
  });

  it("returns payment_required with the parsed challenge when no signer is supplied", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(402, {
        x402Version: 1,
        accepts: [{ scheme: "exact", network: "eip155:8453", asset: "USDC", maxAmountRequired: "5000000" }],
      }),
    );
    const client = new KaiCallsClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provisionKaiCallsAccount(client, { business_name: "Acme", email: "a@b.com" });
    expect(result.status).toBe("payment_required");
    const payment = result as ProvisionPaymentRequired;
    expect(payment.challenge.x402Version).toBe(1);
    expect(payment.challenge.accepts?.[0]?.asset).toBe("USDC");
  });

  it("does NOT attempt to pay the challenge itself — requires a paymentSigner", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(402, { x402Version: 1, accepts: [] }));
    const client = new KaiCallsClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await provisionKaiCallsAccount(client, { business_name: "Acme", email: "a@b.com" });
    // Exactly one request was made (the initial signup call) — no retry,
    // no payment attempt, because no paymentSigner was provided.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("completes the paid retry when a paymentSigner is supplied", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse(402, { x402Version: 1, accepts: [{ scheme: "exact", asset: "USDC" }] });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers["PAYMENT-SIGNATURE"]).toBe("sig_test");
      return jsonResponse(200, {
        api_key: "kc_live_new",
        business_id: "biz_1",
        agent_id: "agent_1",
        phone_number: "+15550100000",
      });
    });
    const client = new KaiCallsClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await provisionKaiCallsAccount(
      client,
      { business_name: "Acme", email: "a@b.com" },
      { paymentSigner: async () => ({ paymentSignature: "sig_test" }) },
    );

    expect(result.status).toBe("provisioned");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retryWithPayment completes a previously-returned payment_required result", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["PAYMENT-SIGNATURE"]).toBe("sig_manual");
      expect(headers["X-Payment-Challenge"]).toBe("chal_123");
      return jsonResponse(200, {
        api_key: "kc_live_manual",
        business_id: "biz_2",
        agent_id: "agent_2",
        phone_number: "+15550100001",
      });
    });
    const client = new KaiCallsClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await retryWithPayment(
      client,
      { business_name: "Acme", email: "a@b.com" },
      { paymentSignature: "sig_manual" },
      "chal_123",
    );

    expect(result.status).toBe("provisioned");
  });
});
