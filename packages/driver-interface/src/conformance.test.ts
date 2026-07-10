import { describe, expect, it } from "vitest";
import { runConformanceSuite } from "./conformance.js";
import { MockDriver, MOCK_DRIVER_MANIFEST } from "./mockDriver.js";
import { UnsupportedCapabilityError } from "./types.js";
import type { Driver, CapabilityManifest } from "./types.js";

describe("runConformanceSuite", () => {
  it("passes MockDriver against its own manifest (full support)", async () => {
    const driver = new MockDriver();
    const result = await runConformanceSuite(driver, MOCK_DRIVER_MANIFEST);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checked).toBeGreaterThan(0);
  });

  it("fails when a manifest claims true but the method is missing", async () => {
    const driver = new MockDriver();
    // supports_hangup: true, but no endCall implementation on this object.
    const partialDriver: Driver = {
      id: driver.id,
      getManifest: () => driver.getManifest(),
      makeCall: (p) => driver.makeCall(p),
      getCallStatus: (p) => driver.getCallStatus(p),
      getTranscript: (p) => driver.getTranscript(p),
      listNumbers: (p) => driver.listNumbers(p),
      listCalls: (p) => driver.listCalls(p),
      // endCall intentionally omitted
    };

    const result = await runConformanceSuite(partialDriver, MOCK_DRIVER_MANIFEST);

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.tool === "end_call")).toBe(true);
  });

  it("passes a degraded driver whose unsupported methods are undefined", async () => {
    const degradedManifest: CapabilityManifest = {
      ...MOCK_DRIVER_MANIFEST,
      driver_id: "degraded",
      capabilities: {
        ...MOCK_DRIVER_MANIFEST.capabilities,
        supports_hangup: false,
        supports_recording: false,
        supports_number_purchase: false,
        supports_number_configuration: false,
        supports_sms: false,
        supports_whatsapp: false,
        supports_rcs: false,
      },
    };

    const driver = new MockDriver();
    const degradedDriver: Driver = {
      id: "degraded",
      getManifest: () => degradedManifest,
      makeCall: (p) => driver.makeCall(p),
      getCallStatus: (p) => driver.getCallStatus(p),
      getTranscript: (p) => driver.getTranscript(p),
      listNumbers: (p) => driver.listNumbers(p),
      listCalls: (p) => driver.listCalls(p),
      // endCall, getRecording, sendSms, searchNumbers, buyNumber,
      // configureNumber all correctly omitted (undefined).
    };

    const result = await runConformanceSuite(degradedDriver, degradedManifest);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("passes a driver that implements a gated method but throws UnsupportedCapabilityError", async () => {
    const degradedManifest: CapabilityManifest = {
      ...MOCK_DRIVER_MANIFEST,
      driver_id: "throws",
      capabilities: { ...MOCK_DRIVER_MANIFEST.capabilities, supports_hangup: false },
    };

    const driver = new MockDriver();
    const throwingDriver: Driver = {
      id: "throws",
      getManifest: () => degradedManifest,
      makeCall: (p) => driver.makeCall(p),
      getCallStatus: (p) => driver.getCallStatus(p),
      getTranscript: (p) => driver.getTranscript(p),
      listNumbers: (p) => driver.listNumbers(p),
      listCalls: (p) => driver.listCalls(p),
      getRecording: (p) => driver.getRecording(p),
      sendSms: (p) => driver.sendSms(p),
      searchNumbers: (p) => driver.searchNumbers(p),
      buyNumber: (p) => driver.buyNumber(p),
      configureNumber: (p) => driver.configureNumber(p),
      endCall: () => {
        throw new UnsupportedCapabilityError("throws", "end_call", "supports_hangup");
      },
    };

    const result = await runConformanceSuite(throwingDriver, degradedManifest);

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails when a gated method is present but does not throw UNSUPPORTED_CAPABILITY", async () => {
    const degradedManifest: CapabilityManifest = {
      ...MOCK_DRIVER_MANIFEST,
      driver_id: "misbehaving",
      capabilities: { ...MOCK_DRIVER_MANIFEST.capabilities, supports_hangup: false },
    };

    const driver = new MockDriver();
    const misbehavingDriver: Driver = {
      id: "misbehaving",
      getManifest: () => degradedManifest,
      makeCall: (p) => driver.makeCall(p),
      getCallStatus: (p) => driver.getCallStatus(p),
      getTranscript: (p) => driver.getTranscript(p),
      listNumbers: (p) => driver.listNumbers(p),
      listCalls: (p) => driver.listCalls(p),
      getRecording: (p) => driver.getRecording(p),
      sendSms: (p) => driver.sendSms(p),
      searchNumbers: (p) => driver.searchNumbers(p),
      buyNumber: (p) => driver.buyNumber(p),
      configureNumber: (p) => driver.configureNumber(p),
      endCall: async (p) => driver.endCall(p),
    };

    const result = await runConformanceSuite(misbehavingDriver, degradedManifest);

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.tool === "end_call")).toBe(true);
  });
});
