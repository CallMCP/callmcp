/**
 * CallMCP driver-dograh — mocked HTTP tests
 *
 * No real network calls. `mockFetch` is a tiny router keyed on
 * method+pathname that stands in for `fetch` (injected into `DograhClient`
 * via `fetchImpl`), so these tests exercise the exact request/response
 * mapping driver.ts does without needing a live Dograh instance.
 */

import { describe, expect, it, vi } from "vitest";
import { runConformanceSuite, UnsupportedCapabilityError } from "@callmcp/driver-interface";
import { DograhClient } from "../src/client.js";
import { DograhDriver } from "../src/driver.js";
import { DOGRAH_MANIFEST } from "../src/manifest.js";

const BASE_URL = "http://localhost:8081";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type RouteHandler = (method: string, url: URL, body: unknown) => Response | Promise<Response>;

function mockFetch(handler: RouteHandler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(method, url, body);
  }) as typeof fetch;
}

interface BuildDriverExtras {
  defaultWorkflowId?: string;
  workflowIds?: string[];
}

function buildDriver(handler: RouteHandler, extra: BuildDriverExtras = {}): DograhDriver {
  const client = new DograhClient({ baseUrl: BASE_URL, apiKey: "test-key", fetchImpl: mockFetch(handler) });
  return new DograhDriver({ client, ...extra });
}

describe("DograhDriver", () => {
  it("conforms to its own manifest (methods present/absent match capability flags)", async () => {
    const driver = buildDriver(() => jsonResponse({}));
    const result = await runConformanceSuite(driver, DOGRAH_MANIFEST);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
  });

  describe("makeCall", () => {
    it("POSTs /telephony/initiate-call and encodes call_id from workflow_id + run_id", async () => {
      const driver = buildDriver((method, url, body) => {
        expect(method).toBe("POST");
        expect(url.pathname).toBe("/telephony/initiate-call");
        expect(body).toMatchObject({ workflow_id: "wf_1", phone_number: "+14155551234" });
        return jsonResponse({ run_id: "run_1", status: "queued" });
      });

      const result = await driver.makeCall({ to: "+14155551234", agent_config_ref: "wf_1" });

      expect(result.call_id).toBe("wf_1::run_1");
      expect(result.status).toBe("queued");
      expect(result.driver).toBe("dograh");
      expect(result.to).toBe("+14155551234");
    });

    it("throws DRIVER_ERROR when no workflow_id can be resolved", async () => {
      const driver = buildDriver(() => jsonResponse({}));
      await expect(driver.makeCall({ to: "+14155551234" })).rejects.toMatchObject({
        code: "DRIVER_ERROR",
      });
    });

    it("throws DRIVER_ERROR when Dograh's response has no run_id/id", async () => {
      const driver = buildDriver(() => jsonResponse({ status: "queued" }));
      await expect(
        driver.makeCall({ to: "+14155551234", agent_config_ref: "wf_1" }),
      ).rejects.toMatchObject({ code: "DRIVER_ERROR" });
    });

    it("falls back to defaultWorkflowId when agent_config_ref is omitted", async () => {
      const driver = buildDriver(
        (_method, _url, body) => {
          expect(body).toMatchObject({ workflow_id: "wf_default" });
          return jsonResponse({ run_id: "run_2" });
        },
        { defaultWorkflowId: "wf_default" },
      );

      const result = await driver.makeCall({ to: "+14155551234" });
      expect(result.call_id).toBe("wf_default::run_2");
    });
  });

  describe("getCallStatus", () => {
    it("maps a completed run", async () => {
      const driver = buildDriver((method, url) => {
        expect(method).toBe("GET");
        expect(url.pathname).toBe("/wf_1/runs/run_1");
        return jsonResponse({
          run_id: "run_1",
          status: "completed",
          started_at: "2026-07-09T18:00:00Z",
          ended_at: "2026-07-09T18:03:00Z",
          to_phone_number: "+14155551234",
          from_phone_number: "+14155550000",
        });
      });

      const result = await driver.getCallStatus({ call_id: "wf_1::run_1" });
      expect(result.status).toBe("completed");
      expect(result.duration_seconds).toBe(180);
      expect(result.to).toBe("+14155551234");
    });

    it("infers in_progress/queued/completed from timestamps when status is missing or unrecognized", async () => {
      const driver = buildDriver(() => jsonResponse({ run_id: "run_1", status: "some_unknown_string" }));
      const result = await driver.getCallStatus({ call_id: "wf_1::run_1" });
      expect(result.status).toBe("queued");
    });

    it("rejects a malformed call_id", async () => {
      const driver = buildDriver(() => jsonResponse({}));
      await expect(driver.getCallStatus({ call_id: "not-a-composite-id" })).rejects.toMatchObject({
        code: "DRIVER_ERROR",
      });
    });
  });

  describe("getTranscript", () => {
    it("fetches and parses transcript_url content inline", async () => {
      const driver = buildDriver((_method, url) => {
        if (url.pathname === "/wf_1/runs/run_1") {
          return jsonResponse({
            run_id: "run_1",
            transcript_url: "/transcripts/run_1.json",
            ended_at: "2026-07-09T18:03:00Z",
          });
        }
        if (url.pathname === "/transcripts/run_1.json") {
          return jsonResponse([
            { role: "agent", text: "Hello!", at: "2026-07-09T18:00:01Z" },
            { role: "caller", text: "Hi there", at: "2026-07-09T18:00:05Z" },
          ]);
        }
        throw new Error(`unexpected path ${url.pathname}`);
      });

      const result = await driver.getTranscript({ call_id: "wf_1::run_1" });
      expect(result.status).toBe("complete");
      expect(result.transcript).toHaveLength(2);
      expect(result.transcript?.[0]).toMatchObject({ role: "agent", text: "Hello!" });
      expect(result.transcript?.[1]).toMatchObject({ role: "caller", text: "Hi there" });
    });

    it("returns not_available_yet when no transcript_url exists", async () => {
      const driver = buildDriver(() => jsonResponse({ run_id: "run_1" }));
      const result = await driver.getTranscript({ call_id: "wf_1::run_1" });
      expect(result.status).toBe("not_available_yet");
      expect(result.transcript).toBeNull();
    });

    it("returns a tel:// resource_link when format=resource_link, without fetching the transcript body", async () => {
      const transcriptFetchSpy = vi.fn();
      const driver = buildDriver((_method, url) => {
        if (url.pathname === "/transcripts/run_1.json") {
          transcriptFetchSpy();
        }
        return jsonResponse({ run_id: "run_1", transcript_url: "/transcripts/run_1.json" });
      });

      const result = await driver.getTranscript({ call_id: "wf_1::run_1", format: "resource_link" });
      expect(result.resource_link).toBe("tel://calls/wf_1::run_1/transcript");
      expect(transcriptFetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("getRecording", () => {
    it("finds a recording artifact by artifact_type", async () => {
      const driver = buildDriver(() =>
        jsonResponse({
          run_id: "run_1",
          started_at: "2026-07-09T18:00:00Z",
          ended_at: "2026-07-09T18:03:00Z",
          artifacts: [
            { artifact_type: "transcript", url: "/t.json" },
            { artifact_type: "call_recording", url: "/r.wav", mime_type: "audio/wav" },
          ],
        }),
      );

      const result = await driver.getRecording({ call_id: "wf_1::run_1" });
      expect(result.status).toBe("ready");
      expect(result.resource_link).toBe("tel://calls/wf_1::run_1/recording");
      expect(result.mime_type).toBe("audio/wav");
      expect(result.duration_seconds).toBe(180);
    });

    it("reports not_available when the run has ended with no recording artifact", async () => {
      const driver = buildDriver(() => jsonResponse({ run_id: "run_1", ended_at: "2026-07-09T18:03:00Z" }));
      const result = await driver.getRecording({ call_id: "wf_1::run_1" });
      expect(result.status).toBe("not_available");
    });

    it("reports processing when the run hasn't ended and there's no recording artifact yet", async () => {
      const driver = buildDriver(() => jsonResponse({ run_id: "run_1" }));
      const result = await driver.getRecording({ call_id: "wf_1::run_1" });
      expect(result.status).toBe("processing");
    });
  });

  describe("documented gaps throw UNSUPPORTED_CAPABILITY", () => {
    it("end_call", async () => {
      const driver = buildDriver(() => jsonResponse({}));
      await expect(driver.endCall({ call_id: "wf_1::run_1" })).rejects.toBeInstanceOf(
        UnsupportedCapabilityError,
      );
    });

    it("buy_number", async () => {
      const driver = buildDriver(() => jsonResponse({}));
      await expect(driver.buyNumber({ number: "+14155551234" })).rejects.toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
      });
    });

    it("search_numbers", async () => {
      const driver = buildDriver(() => jsonResponse({}));
      await expect(driver.searchNumbers({ country: "US" })).rejects.toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
      });
    });

    it("send_sms", async () => {
      const driver = buildDriver(() => jsonResponse({}));
      await expect(driver.sendSms({ to: "+14155551234", body: "hi" })).rejects.toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
      });
    });
  });

  describe("configureNumber", () => {
    it("PUTs telephony_config to /api/v1/workflow/{workflow_id}", async () => {
      const driver = buildDriver((method, url, body) => {
        expect(method).toBe("PUT");
        expect(url.pathname).toBe("/api/v1/workflow/wf_1");
        expect(body).toMatchObject({
          telephony_config: { phone_number: "+14155551234", caller_id_name: "Acme Support" },
        });
        return jsonResponse({ workflow_id: "wf_1" });
      });

      const result = await driver.configureNumber({
        number: "+14155551234",
        agent_config_ref: "wf_1",
        caller_id_name: "Acme Support",
      });
      expect(result.status).toBe("updated");
      expect(result.number).toBe("+14155551234");
    });
  });

  describe("listNumbers / listCalls", () => {
    it("listNumbers derives numbers from known workflows' telephony_config", async () => {
      const driver = buildDriver(
        (_method, url) => {
          expect(url.pathname).toBe("/api/v1/workflow/wf_1");
          return jsonResponse({
            workflow_id: "wf_1",
            telephony_config: { phone_number: "+14155551234" },
            created_at: "2026-01-01T00:00:00Z",
          });
        },
        { defaultWorkflowId: "wf_1" },
      );

      const result = await driver.listNumbers({});
      expect(result.numbers).toHaveLength(1);
      expect(result.numbers[0]).toMatchObject({
        number: "+14155551234",
        country: "US",
        agent_config_ref: "wf_1",
      });
    });

    it("listCalls aggregates runs across a workflow and applies a status filter", async () => {
      const driver = buildDriver(
        (_method, url) => {
          if (url.pathname === "/api/v1/workflow/wf_1") {
            return jsonResponse({ workflow_id: "wf_1" });
          }
          if (url.pathname === "/wf_1/runs") {
            return jsonResponse([
              { run_id: "run_1", status: "completed", to_phone_number: "+1", from_phone_number: "+2" },
              { run_id: "run_2", status: "failed", to_phone_number: "+1", from_phone_number: "+2" },
            ]);
          }
          throw new Error(`unexpected path ${url.pathname}`);
        },
        { defaultWorkflowId: "wf_1" },
      );

      const all = await driver.listCalls({});
      expect(all.calls).toHaveLength(2);

      const completedOnly = await driver.listCalls({ status: "completed" });
      expect(completedOnly.calls).toHaveLength(1);
      expect(completedOnly.calls[0]?.call_id).toBe("wf_1::run_1");
    });
  });
});
