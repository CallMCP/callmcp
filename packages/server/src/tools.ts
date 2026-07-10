/**
 * CallMCP server — tool catalog and `tools/call` dispatch (SPEC §1).
 *
 * This module owns two things:
 * 1. `TOOL_CATALOG` — the full 14-tool catalog: JSON Schema input shapes
 *    (transcribed from SPEC.md §1.1–§1.14), MCP annotations (SPEC §4), and a
 *    capability `gate` predicate consumed by `dynamicTools.ts` to compute
 *    the live `tools/list` response (SPEC §2.2).
 * 2. `registerToolCallHandler` — the `tools/call` request handler. Validates
 *    arguments against a zod mirror of each tool's JSON Schema, re-checks
 *    the capability gate defense-in-depth (SPEC §6.2 stale-cache race),
 *    enforces the approval gate on `make_call`/`send_sms` (SPEC §3), invokes
 *    the resolved driver, and maps every failure mode into the SPEC §5
 *    error taxonomy.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type ClientCapabilities,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  ApprovalChannel,
  ApprovalRequest,
  BuyNumberParams,
  BuyNumberResult,
  CallMcpError,
  CallMcpErrorCode,
  CapabilityFlags,
  ConfigureNumberParams,
  ConfigureNumberResult,
  Driver,
  DriverOptions,
  EndCallParams,
  EndCallResult,
  GetCallStatusParams,
  GetCallStatusResult,
  GetRecordingParams,
  GetRecordingResult,
  GetTranscriptParams,
  GetTranscriptResult,
  ListApprovalsParams,
  ListCallsParams,
  ListCallsResult,
  ListNumbersParams,
  ListNumbersResult,
  MakeCallParams,
  MakeCallResult,
  MessageChannel,
  NumberCapability,
  CallLifecycleStatus,
  SearchNumbersParams,
  SearchNumbersResult,
  SendSmsParams,
  SendSmsResult,
  ToolName,
  TranscriptFormat,
} from "@callmcp/driver-interface";
import { UnsupportedCapabilityError } from "@callmcp/driver-interface";

import { ApprovalStore, ApprovalValidationError, type ElicitDecision, type RequestApprovalContext } from "./approval.js";
import type { DriverRegistry, LoadedDriver } from "./driverRegistry.js";

/** Shared, transport-agnostic server state every tool handler needs. */
export interface ServerCore {
  driverRegistry: DriverRegistry;
  approvals: ApprovalStore;
  /** base URL the built-in `/approve/:id` page is reachable at (SPEC §3.4); e.g. "http://localhost:8787/approve" */
  outOfBandBaseUrl: string;
}

// ---------------------------------------------------------------------------
// JSON Schemas (SPEC §1) + zod mirrors for runtime validation
// ---------------------------------------------------------------------------

/** Loose structural alias for a JSON Schema object fragment (draft 2020-12). */
type JsonSchema = Record<string, unknown>;

const driverOptionsSchema: JsonSchema = {
  type: "object",
  additionalProperties: { type: "object" },
  description: "namespaced driver-specific passthrough, keyed by driver_id",
};

const zDriverOptions = z.record(z.record(z.unknown())).optional();

interface ToolCatalogEntry {
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  execution?: { taskSupport: "optional" | "required" | "forbidden" };
  /** `true` = always listed; a predicate = listed only when the resolved driver's capabilities pass it (SPEC §2.2) */
  gate: true | ((caps: CapabilityFlags) => boolean);
  zodSchema: z.ZodTypeAny;
}

export const TOOL_CATALOG: Record<ToolName, ToolCatalogEntry> = {
  list_drivers: {
    description: "Read-only capability introspection. Call before assuming any other tool's behavior (SPEC §1.1).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: true,
    zodSchema: z.object({}).strict(),
  },

  request_call_approval: {
    description:
      "Creates a pending human authorization for a destination, allowlist entry, or campaign batch (SPEC §1.2). Fires MCP elicitation when supported; otherwise returns an out-of-band approval URL.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["single_call", "allowlist_add", "campaign_batch"] },
        destinations: {
          type: "array",
          items: { type: "string", description: "E.164 phone number, or a wildcard pattern for allowlist_add e.g. '+1415555....'" },
          minItems: 1,
        },
        purpose: { type: "string", description: "human-readable reason shown in the elicitation/approval UI" },
        channel: { type: "string", enum: ["voice", "sms", "whatsapp", "rcs"], default: "voice" },
        campaign_max_contacts: { type: "integer", minimum: 1, description: "required when scope=campaign_batch" },
        ttl_seconds: { type: "integer", minimum: 60, default: 86400, description: "see SPEC §3.2 for tier defaults" },
        driver: { type: "string" },
        options: driverOptionsSchema,
      },
      required: ["scope", "destinations"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    gate: true,
    zodSchema: z
      .object({
        scope: z.enum(["single_call", "allowlist_add", "campaign_batch"]),
        destinations: z.array(z.string()).min(1),
        purpose: z.string().optional(),
        channel: z.enum(["voice", "sms", "whatsapp", "rcs"]).optional(),
        campaign_max_contacts: z.number().int().min(1).optional(),
        ttl_seconds: z.number().int().min(60).optional(),
        driver: z.string().optional(),
        options: zDriverOptions,
      })
      .strict(),
  },

  list_approvals: {
    description: "Read-only. Returns pending approvals, allowlist entries, and active campaign grants (SPEC §1.3).",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["pending", "approved", "denied", "expired", "any"], default: "any" },
        scope: { type: "string", enum: ["single_call", "allowlist_add", "campaign_batch", "any"], default: "any" },
        driver: { type: "string" },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: true,
    zodSchema: z
      .object({
        state: z.enum(["pending", "approved", "denied", "expired", "any"]).optional(),
        scope: z.enum(["single_call", "allowlist_add", "campaign_batch", "any"]).optional(),
        driver: z.string().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
  },

  make_call: {
    description:
      "Places an outbound call (SPEC §1.4). Requires a valid, unexpired approval_id or an allowlist match; otherwise the server elicits approval inline rather than dialing.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "E.164 destination number" },
        from: { type: "string", description: "E.164 caller-id number; if omitted, driver default number is used" },
        driver: { type: "string" },
        approval_id: { type: "string", description: "omit only if `to` matches a standing allowlist entry" },
        agent_config_ref: { type: "string", description: "opaque reference to an already-configured agent/assistant" },
        max_duration_seconds: { type: "integer", minimum: 1 },
        metadata: { type: "object", additionalProperties: true },
        options: driverOptionsSchema,
      },
      required: ["to"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    execution: { taskSupport: "optional" },
    gate: true,
    zodSchema: z
      .object({
        to: z.string().min(1),
        from: z.string().optional(),
        driver: z.string().optional(),
        approval_id: z.string().optional(),
        agent_config_ref: z.string().optional(),
        max_duration_seconds: z.number().int().min(1).optional(),
        metadata: z.record(z.unknown()).optional(),
        options: zDriverOptions,
      })
      .strict(),
  },

  end_call: {
    description: "Terminates an in-progress call (SPEC §1.5). Capability-gated by supports_hangup.",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string" }, reason: { type: "string" } },
      required: ["call_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    gate: (c) => c.supports_hangup,
    zodSchema: z.object({ call_id: z.string().min(1), reason: z.string().optional() }).strict(),
  },

  get_call_status: {
    description: "Read-only poll fallback for clients that don't subscribe to resource updates (SPEC §1.6).",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string" } },
      required: ["call_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: true,
    zodSchema: z.object({ call_id: z.string().min(1) }).strict(),
  },

  get_transcript: {
    description: "Returns a call's transcript, inline or as a subscribable resource link (SPEC §1.7).",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        format: { type: "string", enum: ["inline", "resource_link"], default: "inline" },
      },
      required: ["call_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: true,
    zodSchema: z.object({ call_id: z.string().min(1), format: z.enum(["inline", "resource_link"]).optional() }).strict(),
  },

  get_recording: {
    description: "Returns a resource link to the call's audio recording (SPEC §1.8). Capability-gated by supports_recording.",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string" } },
      required: ["call_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: (c) => c.supports_recording,
    zodSchema: z.object({ call_id: z.string().min(1) }).strict(),
  },

  send_sms: {
    description:
      "Sends an outbound message over SMS, WhatsApp, or RCS (SPEC §1.9). Capability-gated; approval-gated like make_call.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        from: { type: "string" },
        channel: { type: "string", enum: ["sms", "whatsapp", "rcs"], default: "sms" },
        body: { type: "string", maxLength: 4096 },
        media_urls: { type: "array", items: { type: "string" } },
        approval_id: { type: "string" },
        driver: { type: "string" },
        options: driverOptionsSchema,
      },
      required: ["to", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    gate: (c) => Boolean(c.supports_sms || c.supports_whatsapp || c.supports_rcs),
    zodSchema: z
      .object({
        to: z.string().min(1),
        from: z.string().optional(),
        channel: z.enum(["sms", "whatsapp", "rcs"]).optional(),
        body: z.string().max(4096),
        media_urls: z.array(z.string()).optional(),
        approval_id: z.string().optional(),
        driver: z.string().optional(),
        options: zDriverOptions,
      })
      .strict(),
  },

  search_numbers: {
    description: "Read-only search for purchasable phone numbers (SPEC §1.10).",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "ISO 3166-1 alpha-2" },
        area_code: { type: "string" },
        capabilities_required: { type: "array", items: { type: "string", enum: ["voice", "sms", "mms", "whatsapp"] } },
        driver: { type: "string" },
        cursor: { type: "string" },
      },
      required: ["country"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: (c) => c.supports_number_purchase,
    zodSchema: z
      .object({
        country: z.string().min(1),
        area_code: z.string().optional(),
        capabilities_required: z.array(z.enum(["voice", "sms", "mms", "whatsapp"])).optional(),
        driver: z.string().optional(),
        cursor: z.string().optional(),
      })
      .strict(),
  },

  buy_number: {
    description:
      "Purchases a phone number (SPEC §1.11). Spends money but does not contact a third party, so no human approval gate.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "a number returned by search_numbers" },
        driver: { type: "string" },
        compliance: { type: "object", additionalProperties: true },
        options: driverOptionsSchema,
      },
      required: ["number"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    gate: (c) => c.supports_number_purchase,
    zodSchema: z
      .object({
        number: z.string().min(1),
        driver: z.string().optional(),
        compliance: z.record(z.unknown()).optional(),
        options: zDriverOptions,
      })
      .strict(),
  },

  configure_number: {
    description: "Updates routing/configuration for an already-owned number (SPEC §1.12).",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string" },
        driver: { type: "string" },
        agent_config_ref: { type: ["string", "null"] },
        sms_webhook_url: { type: ["string", "null"] },
        caller_id_name: { type: ["string", "null"] },
        options: driverOptionsSchema,
      },
      required: ["number"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: (c) => c.supports_number_configuration,
    zodSchema: z
      .object({
        number: z.string().min(1),
        driver: z.string().optional(),
        agent_config_ref: z.string().nullable().optional(),
        sms_webhook_url: z.string().nullable().optional(),
        caller_id_name: z.string().nullable().optional(),
        options: zDriverOptions,
      })
      .strict(),
  },

  list_numbers: {
    description: "Read-only inventory of owned numbers (SPEC §1.13).",
    inputSchema: {
      type: "object",
      properties: { driver: { type: "string" }, cursor: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: true,
    zodSchema: z.object({ driver: z.string().optional(), cursor: z.string().optional() }).strict(),
  },

  list_calls: {
    description: "Read-only call history/inventory (SPEC §1.14).",
    inputSchema: {
      type: "object",
      properties: {
        driver: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        status: {
          type: "string",
          enum: ["queued", "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled", "any"],
          default: "any",
        },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    gate: true,
    zodSchema: z
      .object({
        driver: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        status: z
          .enum(["queued", "ringing", "in_progress", "completed", "failed", "no_answer", "busy", "canceled", "any"])
          .optional(),
        cursor: z.string().optional(),
      })
      .strict(),
  },
};

// ---------------------------------------------------------------------------
// Error / result helpers (SPEC §5)
// ---------------------------------------------------------------------------

function toolErrorResult(code: CallMcpErrorCode, message: string, details?: Record<string, unknown>): CallToolResult {
  const error: CallMcpError = details ? { code, message, details } : { code, message };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    structuredContent: { error: error as unknown as Record<string, unknown> },
  };
}

function toolSuccessResult(result: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function isToolErrorResult(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Maps a thrown driver error (or a CallMcpError-shaped throw) into the SPEC §5 taxonomy. */
function mapDriverError(err: unknown, driverId: string): CallToolResult {
  if (err instanceof UnsupportedCapabilityError) {
    return toolErrorResult(err.code, err.message, err.details);
  }
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    const shaped = err as CallMcpError;
    return toolErrorResult(shaped.code, shaped.message, shaped.details);
  }
  return toolErrorResult("DRIVER_ERROR", "upstream driver returned an unmapped error", {
    driver: driverId,
    driver_native_code: err instanceof Error ? err.name : "unknown_error",
    driver_native_message: describeError(err),
  });
}

function resolveDriverOrError(core: ServerCore, driverId: string | undefined): LoadedDriver | CallToolResult {
  try {
    return core.driverRegistry.get(driverId);
  } catch (err) {
    return toolErrorResult("DRIVER_ERROR", describeError(err), {
      driver: driverId ?? core.driverRegistry.defaultDriverId ?? null,
      driver_native_code: "unknown_driver",
    });
  }
}

/** Invokes an optional `Driver` method, translating absence/throws into SPEC §5 errors. */
async function invokeDriver<TResult>(
  toolName: ToolName,
  record: LoadedDriver,
  methodName: Exclude<keyof Driver, "id" | "getManifest">,
  params: unknown,
): Promise<TResult | CallToolResult> {
  const method = record.driver[methodName] as ((p: unknown) => Promise<TResult>) | undefined;
  if (typeof method !== "function") {
    return toolErrorResult("UNSUPPORTED_CAPABILITY", `driver '${record.driver.id}' does not support ${toolName}`, {
      driver: record.driver.id,
      tool: toolName,
    });
  }
  try {
    return await method.call(record.driver, params);
  } catch (err) {
    return mapDriverError(err, record.driver.id);
  }
}

// ---------------------------------------------------------------------------
// Elicitation plumbing (SPEC §3.3)
// ---------------------------------------------------------------------------

/** True iff both the connected client and the resolved driver declare elicitation support. */
function elicitationAvailable(clientCapabilities: ClientCapabilities | undefined, driverCaps: CapabilityFlags): boolean {
  return Boolean(clientCapabilities?.elicitation) && driverCaps.supports_elicitation_approval;
}

function buildElicitFn(server: Server): (message: string) => Promise<ElicitDecision> {
  return async (message) => {
    const result = await server.elicitInput({ message, requestedSchema: { type: "object", properties: {} } });
    if (result.action === "accept") {
      return "approved";
    }
    if (result.action === "decline") {
      return "denied";
    }
    // action === "cancel" — SPEC §3.3.2: a cancel is treated as expired, not denied.
    return "expired";
  };
}

interface EnsureApprovedArgs {
  to: string;
  channel: ApprovalChannel;
  approval_id?: string | undefined;
  purpose: string;
  driverId: string;
}

/**
 * Gates `make_call`/`send_sms` (SPEC §3). Resolves an existing grant
 * (explicit approval_id or standing allowlist match); if none exists,
 * triggers the approval flow inline — elicitation when available, otherwise
 * an out-of-band URL — rather than proceeding, per SPEC §0.1.3/§3.3/§3.4.
 */
async function ensureDestinationApproved(
  args: EnsureApprovedArgs,
  server: Server,
  core: ServerCore,
  driverCaps: CapabilityFlags,
): Promise<{ approval_id: string } | CallToolResult> {
  const grant = core.approvals.resolveGrant({ approval_id: args.approval_id, to: args.to, channel: args.channel });
  if (grant.ok) {
    return { approval_id: grant.approval_id };
  }

  if (args.approval_id && grant.reason === "denied") {
    return toolErrorResult("APPROVAL_DENIED", `approval ${args.approval_id} was denied`, {
      approval_id: args.approval_id,
      decided_at: grant.approvalRecord?.decided_at ?? null,
    });
  }

  const canElicit = elicitationAvailable(server.getClientCapabilities(), driverCaps);
  const ctx: RequestApprovalContext = {
    driver: args.driverId,
    elicitationAvailable: canElicit,
    elicit: canElicit ? buildElicitFn(server) : undefined,
    outOfBandBaseUrl: core.outOfBandBaseUrl,
  };

  const approvalResult = await core.approvals.requestCallApproval(
    { scope: "single_call", destinations: [args.to], channel: args.channel, purpose: args.purpose },
    ctx,
  );

  if (approvalResult.state === "approved") {
    return { approval_id: approvalResult.approval_id };
  }
  if (approvalResult.state === "denied" || approvalResult.state === "expired") {
    return toolErrorResult("APPROVAL_DENIED", `approval ${approvalResult.approval_id} was ${approvalResult.state}`, {
      approval_id: approvalResult.approval_id,
      decided_at: new Date().toISOString(),
    });
  }

  // Still pending: the non-elicitation fallback. Return immediately — never
  // block indefinitely (SPEC §3.4.1).
  return toolErrorResult("APPROVAL_REQUIRED", `no valid approval covers ${args.to}; elicitation unsupported by this client`, {
    to: args.to,
    out_of_band_url: approvalResult.out_of_band_url,
    expires_at: approvalResult.expires_at,
  });
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>, core: ServerCore, server: Server) => Promise<CallToolResult>;

const handleListDrivers: ToolHandler = async (_args, core) => {
  return toolSuccessResult({ drivers: core.driverRegistry.listDriverInfos() });
};

const handleRequestCallApproval: ToolHandler = async (args, core, server) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }

  const canElicit = elicitationAvailable(server.getClientCapabilities(), driverRecord.manifest.capabilities);
  const ctx: RequestApprovalContext = {
    driver: driverRecord.driver.id,
    elicitationAvailable: canElicit,
    elicit: canElicit ? buildElicitFn(server) : undefined,
    outOfBandBaseUrl: core.outOfBandBaseUrl,
  };

  try {
    const result = await core.approvals.requestCallApproval(args as unknown as ApprovalRequest, ctx);
    return toolSuccessResult(result as unknown as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ApprovalValidationError) {
      throw new McpError(ErrorCode.InvalidParams, err.message);
    }
    throw err;
  }
};

const handleListApprovals: ToolHandler = async (args, core) => {
  const result = core.approvals.listApprovals(args as unknown as ListApprovalsParams);
  return toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleMakeCall: ToolHandler = async (args, core, server) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }

  const to = args.to as string;
  const approvalOutcome = await ensureDestinationApproved(
    {
      to,
      channel: "voice",
      approval_id: typeof args.approval_id === "string" ? args.approval_id : undefined,
      purpose: `make_call to ${to}`,
      driverId: driverRecord.driver.id,
    },
    server,
    core,
    driverRecord.manifest.capabilities,
  );
  if (isToolErrorResult(approvalOutcome)) {
    return approvalOutcome;
  }

  const params: MakeCallParams = {
    to,
    approval_id: approvalOutcome.approval_id,
    driver: driverRecord.driver.id,
    ...(typeof args.from === "string" ? { from: args.from } : {}),
    ...(typeof args.agent_config_ref === "string" ? { agent_config_ref: args.agent_config_ref } : {}),
    ...(typeof args.max_duration_seconds === "number" ? { max_duration_seconds: args.max_duration_seconds } : {}),
    ...(args.metadata ? { metadata: args.metadata as Record<string, unknown> } : {}),
    ...(args.options ? { options: args.options as DriverOptions } : {}),
  };

  const result = await invokeDriver<MakeCallResult>("make_call", driverRecord, "makeCall", params);
  if (isToolErrorResult(result)) {
    return result;
  }
  return toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleEndCall: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: EndCallParams = {
    call_id: args.call_id as string,
    ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
  };
  const result = await invokeDriver<EndCallResult>("end_call", driverRecord, "endCall", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleGetCallStatus: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: GetCallStatusParams = { call_id: args.call_id as string };
  const result = await invokeDriver<GetCallStatusResult>("get_call_status", driverRecord, "getCallStatus", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleGetTranscript: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: GetTranscriptParams = {
    call_id: args.call_id as string,
    ...(typeof args.format === "string" ? { format: args.format as TranscriptFormat } : {}),
  };
  const result = await invokeDriver<GetTranscriptResult>("get_transcript", driverRecord, "getTranscript", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleGetRecording: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: GetRecordingParams = { call_id: args.call_id as string };
  const result = await invokeDriver<GetRecordingResult>("get_recording", driverRecord, "getRecording", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleSendSms: ToolHandler = async (args, core, server) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }

  const to = args.to as string;
  const channel = (typeof args.channel === "string" ? args.channel : "sms") as ApprovalChannel;
  const approvalOutcome = await ensureDestinationApproved(
    {
      to,
      channel,
      approval_id: typeof args.approval_id === "string" ? args.approval_id : undefined,
      purpose: `send_sms to ${to}`,
      driverId: driverRecord.driver.id,
    },
    server,
    core,
    driverRecord.manifest.capabilities,
  );
  if (isToolErrorResult(approvalOutcome)) {
    return approvalOutcome;
  }

  const params: SendSmsParams = {
    to,
    body: args.body as string,
    approval_id: approvalOutcome.approval_id,
    driver: driverRecord.driver.id,
    ...(typeof args.from === "string" ? { from: args.from } : {}),
    ...(typeof args.channel === "string" ? { channel: args.channel as MessageChannel } : {}),
    ...(Array.isArray(args.media_urls) ? { media_urls: args.media_urls as string[] } : {}),
    ...(args.options ? { options: args.options as DriverOptions } : {}),
  };

  const result = await invokeDriver<SendSmsResult>("send_sms", driverRecord, "sendSms", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleSearchNumbers: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: SearchNumbersParams = {
    country: args.country as string,
    ...(typeof args.area_code === "string" ? { area_code: args.area_code } : {}),
    ...(Array.isArray(args.capabilities_required)
      ? { capabilities_required: args.capabilities_required as NumberCapability[] }
      : {}),
    ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
  };
  const result = await invokeDriver<SearchNumbersResult>("search_numbers", driverRecord, "searchNumbers", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleBuyNumber: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: BuyNumberParams = {
    number: args.number as string,
    ...(args.compliance ? { compliance: args.compliance as Record<string, unknown> } : {}),
    ...(args.options ? { options: args.options as DriverOptions } : {}),
  };
  const result = await invokeDriver<BuyNumberResult>("buy_number", driverRecord, "buyNumber", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleConfigureNumber: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: ConfigureNumberParams = {
    number: args.number as string,
    ...(args.agent_config_ref !== undefined ? { agent_config_ref: args.agent_config_ref as string | null } : {}),
    ...(args.sms_webhook_url !== undefined ? { sms_webhook_url: args.sms_webhook_url as string | null } : {}),
    ...(args.caller_id_name !== undefined ? { caller_id_name: args.caller_id_name as string | null } : {}),
    ...(args.options ? { options: args.options as DriverOptions } : {}),
  };
  const result = await invokeDriver<ConfigureNumberResult>("configure_number", driverRecord, "configureNumber", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleListNumbers: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: ListNumbersParams = { ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}) };
  const result = await invokeDriver<ListNumbersResult>("list_numbers", driverRecord, "listNumbers", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const handleListCalls: ToolHandler = async (args, core) => {
  const driverId = typeof args.driver === "string" ? args.driver : undefined;
  const driverRecord = resolveDriverOrError(core, driverId);
  if (isToolErrorResult(driverRecord)) {
    return driverRecord;
  }
  const params: ListCallsParams = {
    ...(typeof args.since === "string" ? { since: args.since } : {}),
    ...(typeof args.until === "string" ? { until: args.until } : {}),
    ...(typeof args.status === "string" ? { status: args.status as CallLifecycleStatus | "any" } : {}),
    ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
  };
  const result = await invokeDriver<ListCallsResult>("list_calls", driverRecord, "listCalls", params);
  return isToolErrorResult(result) ? result : toolSuccessResult(result as unknown as Record<string, unknown>);
};

const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  list_drivers: handleListDrivers,
  request_call_approval: handleRequestCallApproval,
  list_approvals: handleListApprovals,
  make_call: handleMakeCall,
  end_call: handleEndCall,
  get_call_status: handleGetCallStatus,
  get_transcript: handleGetTranscript,
  get_recording: handleGetRecording,
  send_sms: handleSendSms,
  search_numbers: handleSearchNumbers,
  buy_number: handleBuyNumber,
  configure_number: handleConfigureNumber,
  list_numbers: handleListNumbers,
  list_calls: handleListCalls,
};

// ---------------------------------------------------------------------------
// tools/call registration
// ---------------------------------------------------------------------------

function isKnownToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_CATALOG, name);
}

/** Registers the `tools/call` request handler on `server`. */
export function registerToolCallHandler(server: Server, core: ServerCore): void {
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;

    if (!isKnownToolName(name)) {
      return toolErrorResult("UNSUPPORTED_CAPABILITY", `unknown tool "${name}"`, { tool: name });
    }

    const catalogEntry = TOOL_CATALOG[name];
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    // Defense-in-depth against a stale tools/list cache (SPEC §2.2, §6.2):
    // re-check the capability gate even though it already governed
    // discovery.
    if (catalogEntry.gate !== true) {
      const driverId = typeof args.driver === "string" ? args.driver : undefined;
      let record: LoadedDriver | undefined;
      try {
        record = core.driverRegistry.get(driverId);
      } catch {
        record = undefined;
      }
      if (!record || !catalogEntry.gate(record.manifest.capabilities)) {
        return toolErrorResult("UNSUPPORTED_CAPABILITY", `driver '${record?.driver.id ?? driverId ?? "unknown"}' does not support ${name}`, {
          driver: record?.driver.id ?? driverId ?? null,
          tool: name,
          missing_flag: undefined,
        });
      }
    }

    const parsed = catalogEntry.zodSchema.safeParse(args);
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `invalid arguments for ${name}: ${parsed.error.message}`);
    }

    try {
      return await TOOL_HANDLERS[name](parsed.data as Record<string, unknown>, core, server);
    } catch (err) {
      if (err instanceof McpError) {
        throw err;
      }
      return mapDriverError(err, typeof args.driver === "string" ? args.driver : (core.driverRegistry.defaultDriverId ?? "unknown"));
    }
  });
}

export { toolErrorResult, toolSuccessResult, isToolErrorResult };
