/**
 * CallMCP driver-dograh — the `Driver` implementation
 *
 * Maps the CallMCP tool contract (SPEC.md §1) onto Dograh's REST API via
 * `./client.ts`. Read `./client.ts`'s top-of-file provenance note first — it
 * documents exactly which routes are source-verified vs. inferred, which
 * matters for judging how much to trust the parsing logic below.
 *
 * Call-id shape: Dograh scopes a run's lifecycle to a workflow
 * (`GET /{workflow_id}/runs/{run_id}`), but CallMCP's `call_id` is a single
 * opaque string. This driver encodes both into one `call_id` as
 * `"<workflow_id>::<run_id>"` and decodes it on every subsequent
 * get_call_status/get_transcript/get_recording call — there is no server-
 * side call registry to consult, Dograh's own API is the source of truth.
 *
 * Degradation, per SPEC §7 / the research pass this driver is built from
 * (workspace/research/r4-local-stacks.md §2):
 *   - `end_call`: Dograh has no external hangup endpoint.
 *   - `send_sms`: Dograh has no SMS capability at all.
 *   - `search_numbers` / `buy_number`: Dograh is strictly BYO-carrier; no
 *     purchase flow exists to wrap.
 *   - `supports_realtime_transcription`: transcript access is poll-based
 *     only (GET /{workflow_id}/runs/{run_id}), never streamed.
 * These four are implemented below as methods that throw
 * `UnsupportedCapabilityError` (SPEC §5.1) rather than left `undefined`,
 * so a stale `tools/list` cache still fails loudly and correctly. The
 * manifest (`./manifest.ts`, `supports_*: false`) remains the primary
 * discovery signal that keeps them out of `tools/list` in the first place —
 * see driver-interface's README, "The golden rule: absence over runtime
 * surprise."
 */

import { UnsupportedCapabilityError } from "@callmcp/driver-interface";
import type {
  BuyNumberParams,
  BuyNumberResult,
  CallMcpError,
  CallMcpErrorCode,
  CallLifecycleStatus,
  CallSummary,
  CapabilityManifest,
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
  TranscriptStatus,
  TranscriptTurn,
} from "@callmcp/driver-interface";
import { DograhClient, type DograhRun, type DograhRunArtifact } from "./client.js";
import { DOGRAH_MANIFEST } from "./manifest.js";

const CALL_ID_SEPARATOR = "::";
const EPOCH_ISO = new Date(0).toISOString();

/**
 * CallMCP-shaped error this driver throws for anything that isn't cleanly
 * `UNSUPPORTED_CAPABILITY` (which uses driver-interface's own error class
 * instead) — configuration problems, malformed call_ids, and unparseable
 * upstream responses.
 */
export class DograhDriverError extends Error implements CallMcpError {
  readonly code: CallMcpErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CallMcpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DograhDriverError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface DograhDriverOptions {
  /** Inject a pre-configured client (tests, custom fetch, etc). Defaults to `new DograhClient()`. */
  client?: DograhClient;
  /**
   * workflow_id to use when a call doesn't supply `agent_config_ref` or
   * `options.dograh.workflow_id`. Defaults to `process.env.DOGRAH_DEFAULT_WORKFLOW_ID`.
   */
  defaultWorkflowId?: string;
  /**
   * workflow_ids this driver aggregates across for `list_numbers`/`list_calls`
   * (Dograh has no confirmed "all calls across all workflows" endpoint — see
   * client.ts's provenance note). Defaults to
   * `process.env.DOGRAH_WORKFLOW_IDS` (comma-separated); if that's unset too,
   * falls back to `[defaultWorkflowId]` when present, then finally to
   * `DograhClient.listWorkflows()` (an assumed, unverified collection route).
   */
  workflowIds?: string[];
}

export class DograhDriver implements Driver {
  readonly id = "dograh";

  private readonly client: DograhClient;
  private readonly defaultWorkflowId: string | undefined;
  private readonly workflowIds: string[];

  constructor(options: DograhDriverOptions = {}) {
    this.client = options.client ?? new DograhClient();
    this.defaultWorkflowId = options.defaultWorkflowId ?? process.env.DOGRAH_DEFAULT_WORKFLOW_ID;
    this.workflowIds = options.workflowIds ?? parseWorkflowIdsEnv();
  }

  getManifest(): CapabilityManifest {
    return DOGRAH_MANIFEST;
  }

  // ---------------------------------------------------------------------
  // make_call → POST /telephony/initiate-call
  // ---------------------------------------------------------------------

  async makeCall(params: MakeCallParams): Promise<MakeCallResult> {
    const workflowId = this.resolveWorkflowId(params.agent_config_ref, params.options);

    const response = await this.client.initiateCall({
      workflow_id: workflowId,
      phone_number: params.to,
      ...(params.from !== undefined ? { from_number: params.from } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    });

    const runId = response.run_id ?? response.id;
    if (!runId) {
      throw new DograhDriverError(
        "DRIVER_ERROR",
        "Dograh's POST /telephony/initiate-call response did not include a run_id or id field",
        { driver: this.id, response },
      );
    }

    return {
      call_id: encodeCallId(workflowId, runId),
      status: mapInitiateStatus(response.status),
      to: params.to,
      ...(params.from !== undefined ? { from: params.from } : {}),
      approval_id: params.approval_id ?? "dograh_no_approval_id",
      started_at: null,
      driver: this.id,
    };
  }

  // ---------------------------------------------------------------------
  // get_call_status / get_transcript / get_recording → poll
  // GET /{workflow_id}/runs/{run_id}
  // ---------------------------------------------------------------------

  async getCallStatus(params: GetCallStatusParams): Promise<GetCallStatusResult> {
    const { workflowId, runId } = decodeCallId(params.call_id, this.id);
    const run = await this.client.getRun(workflowId, runId);

    return {
      call_id: params.call_id,
      status: mapRunStatus(run),
      ...(run.to_phone_number !== undefined ? { to: run.to_phone_number } : {}),
      ...(run.from_phone_number !== undefined ? { from: run.from_phone_number } : {}),
      started_at: run.started_at ?? run.created_at ?? null,
      ended_at: run.ended_at ?? null,
      duration_seconds: computeDuration(run),
      ...(run.metadata !== undefined ? { metadata: run.metadata } : {}),
      driver: this.id,
    };
  }

  async getTranscript(params: GetTranscriptParams): Promise<GetTranscriptResult> {
    const { workflowId, runId } = decodeCallId(params.call_id, this.id);
    const run = await this.client.getRun(workflowId, runId);
    const status = deriveTranscriptStatus(run);

    if (params.format === "resource_link") {
      return {
        call_id: params.call_id,
        status,
        resource_link: `tel://calls/${params.call_id}/transcript`,
        driver: this.id,
      };
    }

    const transcriptUrl = run.transcript_url ?? run.transcript_public_url ?? null;
    if (!transcriptUrl) {
      return { call_id: params.call_id, status: "not_available_yet", transcript: null, driver: this.id };
    }

    try {
      const raw = await this.client.fetchTranscript(transcriptUrl);
      return { call_id: params.call_id, status, transcript: parseTranscriptTurns(raw), driver: this.id };
    } catch {
      // transcript_url exists but wasn't fetchable from here right now (auth
      // boundary, pre-signed URL not valid yet, transient network issue).
      // Degrade to a resource_link rather than throwing — the caller still
      // has a path forward instead of a hard failure on what may resolve on
      // its own shortly.
      return {
        call_id: params.call_id,
        status: "partial",
        transcript: null,
        resource_link: `tel://calls/${params.call_id}/transcript`,
        driver: this.id,
      };
    }
  }

  async getRecording(params: GetRecordingParams): Promise<GetRecordingResult> {
    const { workflowId, runId } = decodeCallId(params.call_id, this.id);
    const run = await this.client.getRun(workflowId, runId);
    const artifact = findRecordingArtifact(run);

    if (!artifact) {
      return {
        call_id: params.call_id,
        status: run.ended_at ? "not_available" : "processing",
        driver: this.id,
      };
    }

    return {
      call_id: params.call_id,
      status: "ready",
      resource_link: `tel://calls/${params.call_id}/recording`,
      mime_type: artifact.mime_type ?? "audio/wav",
      duration_seconds: artifact.duration_seconds ?? computeDuration(run),
      driver: this.id,
    };
  }

  // ---------------------------------------------------------------------
  // Real, documented gaps — Dograh has no endpoint for any of these.
  // See the file-level doc comment for why these throw rather than being
  // left `undefined`.
  // ---------------------------------------------------------------------

  async endCall(_params: EndCallParams): Promise<EndCallResult> {
    throw new UnsupportedCapabilityError(this.id, "end_call", "supports_hangup");
  }

  async buyNumber(_params: BuyNumberParams): Promise<BuyNumberResult> {
    throw new UnsupportedCapabilityError(this.id, "buy_number", "supports_number_purchase");
  }

  async searchNumbers(_params: SearchNumbersParams): Promise<SearchNumbersResult> {
    throw new UnsupportedCapabilityError(this.id, "search_numbers", "supports_number_purchase");
  }

  async sendSms(_params: SendSmsParams): Promise<SendSmsResult> {
    throw new UnsupportedCapabilityError(this.id, "send_sms", "supports_sms");
  }

  // ---------------------------------------------------------------------
  // configure_number / list_numbers → Dograh's number-attachment surface
  // (PUT /api/v1/workflow/{workflow_id}) — attaching an already-owned
  // number, never purchasing one.
  // ---------------------------------------------------------------------

  async configureNumber(params: ConfigureNumberParams): Promise<ConfigureNumberResult> {
    const workflowId = this.resolveWorkflowId(params.agent_config_ref ?? undefined, params.options);

    const telephonyConfig: Record<string, unknown> = { phone_number: params.number };
    if (params.sms_webhook_url !== undefined) {
      telephonyConfig.sms_webhook_url = params.sms_webhook_url;
    }
    if (params.caller_id_name !== undefined) {
      telephonyConfig.caller_id_name = params.caller_id_name;
    }

    await this.client.updateWorkflowConfig(workflowId, { telephony_config: telephonyConfig });

    return { number: params.number, status: "updated", driver: this.id };
  }

  async listNumbers(_params: ListNumbersParams): Promise<ListNumbersResult> {
    const workflows = await this.listRelevantWorkflows();
    const numbers: OwnedNumber[] = [];

    for (const workflow of workflows) {
      const number = workflow.telephony_config?.phone_number;
      if (!number) {
        continue;
      }
      numbers.push({
        number,
        country: inferCountry(number),
        capabilities: ["voice"],
        agent_config_ref: workflow.workflow_id ?? workflow.id ?? null,
        acquired_at: workflow.created_at ?? EPOCH_ISO,
      });
    }

    return { numbers, next_cursor: null, driver: this.id };
  }

  // ---------------------------------------------------------------------
  // list_calls → aggregated GET /{workflow_id}/runs across known workflows
  // ---------------------------------------------------------------------

  async listCalls(params: ListCallsParams): Promise<ListCallsResult> {
    const workflows = await this.listRelevantWorkflows();
    const calls: CallSummary[] = [];
    const since = params.since ? Date.parse(params.since) : null;
    const until = params.until ? Date.parse(params.until) : null;

    for (const workflow of workflows) {
      const workflowId = workflow.workflow_id ?? workflow.id;
      if (!workflowId) {
        continue;
      }

      const runs = await this.client.listRuns(workflowId);
      for (const run of runs) {
        const runId = run.run_id ?? run.id;
        if (!runId) {
          continue;
        }

        const status = mapRunStatus(run);
        if (params.status && params.status !== "any" && status !== params.status) {
          continue;
        }

        const startedAt = run.started_at ?? run.created_at ?? null;
        if (since !== null && startedAt !== null && Date.parse(startedAt) < since) {
          continue;
        }
        if (until !== null && startedAt !== null && Date.parse(startedAt) > until) {
          continue;
        }

        calls.push({
          call_id: encodeCallId(workflowId, runId),
          to: run.to_phone_number ?? "",
          from: run.from_phone_number ?? "",
          status,
          started_at: startedAt,
          ended_at: run.ended_at ?? null,
          duration_seconds: computeDuration(run),
        });
      }
    }

    return { calls, next_cursor: null, driver: this.id };
  }

  // ---------------------------------------------------------------------
  // internal helpers
  // ---------------------------------------------------------------------

  private resolveWorkflowId(
    agentConfigRef: string | undefined,
    options: DriverOptions | undefined,
  ): string {
    const fromOptions = options?.dograh?.["workflow_id"];
    const workflowId =
      agentConfigRef ?? (typeof fromOptions === "string" ? fromOptions : undefined) ?? this.defaultWorkflowId;

    if (!workflowId) {
      throw new DograhDriverError(
        "DRIVER_ERROR",
        "no Dograh workflow_id available — pass agent_config_ref, options.dograh.workflow_id, or set DOGRAH_DEFAULT_WORKFLOW_ID",
        { driver: this.id },
      );
    }
    return workflowId;
  }

  private async listRelevantWorkflows() {
    if (this.workflowIds.length > 0) {
      return Promise.all(this.workflowIds.map((workflowId) => this.client.getWorkflow(workflowId)));
    }
    if (this.defaultWorkflowId) {
      return [await this.client.getWorkflow(this.defaultWorkflowId)];
    }
    // No configured workflow scope at all — fall back to Dograh's (assumed,
    // unverified) collection endpoint. See client.ts's provenance note.
    return this.client.listWorkflows();
  }
}

// ---------------------------------------------------------------------------
// module-level helpers (pure, no I/O — easy to reason about independent of
// the client/network layer)
// ---------------------------------------------------------------------------

function parseWorkflowIdsEnv(): string[] {
  const raw = process.env.DOGRAH_WORKFLOW_IDS;
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function encodeCallId(workflowId: string, runId: string): string {
  return `${workflowId}${CALL_ID_SEPARATOR}${runId}`;
}

function decodeCallId(callId: string, driverId: string): { workflowId: string; runId: string } {
  const idx = callId.indexOf(CALL_ID_SEPARATOR);
  if (idx === -1) {
    throw new DograhDriverError(
      "DRIVER_ERROR",
      `call_id "${callId}" is not a Dograh-shaped call_id (expected "<workflow_id>${CALL_ID_SEPARATOR}<run_id>")`,
      { driver: driverId, call_id: callId },
    );
  }
  return { workflowId: callId.slice(0, idx), runId: callId.slice(idx + CALL_ID_SEPARATOR.length) };
}

/**
 * Dograh's run `status` field/enum is not source-confirmed (see client.ts's
 * provenance note) — this table covers the plausible common spellings, and
 * falls back to inferring from `started_at`/`ended_at` timestamps (which
 * *are* part of the source-verified run shape) rather than guessing wrong.
 */
function mapRunStatus(run: DograhRun): CallLifecycleStatus {
  const raw = run.status?.toLowerCase();
  const table: Record<string, CallLifecycleStatus> = {
    queued: "queued",
    pending: "queued",
    ringing: "ringing",
    dialing: "ringing",
    in_progress: "in_progress",
    running: "in_progress",
    active: "in_progress",
    completed: "completed",
    complete: "completed",
    succeeded: "completed",
    success: "completed",
    failed: "failed",
    error: "failed",
    errored: "failed",
    no_answer: "no_answer",
    noanswer: "no_answer",
    busy: "busy",
    canceled: "canceled",
    cancelled: "canceled",
  };
  if (raw !== undefined) {
    const mapped = table[raw];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  if (run.ended_at) {
    return "completed";
  }
  if (run.started_at) {
    return "in_progress";
  }
  return "queued";
}

function mapInitiateStatus(status: string | undefined): MakeCallStatus {
  const raw = status?.toLowerCase();
  if (raw === "ringing" || raw === "dialing") {
    return "ringing";
  }
  if (raw === "in_progress" || raw === "running" || raw === "active") {
    return "in_progress";
  }
  return "queued";
}

function computeDuration(run: DograhRun): number | null {
  const start = run.started_at ?? run.created_at ?? null;
  const end = run.ended_at ?? null;
  if (!start || !end) {
    return null;
  }
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return Math.round(ms / 1000);
}

function deriveTranscriptStatus(run: DograhRun): TranscriptStatus {
  if (!run.transcript_url && !run.transcript_public_url) {
    return "not_available_yet";
  }
  return run.ended_at ? "complete" : "partial";
}

const RECORDING_ARTIFACT_PATTERN = /record/i;

function findRecordingArtifact(run: DograhRun): DograhRunArtifact | undefined {
  return run.artifacts?.find((artifact) => RECORDING_ARTIFACT_PATTERN.test(artifact.artifact_type));
}

/**
 * Best-effort parse of whatever `transcript_url` returns. Dograh's exact
 * transcript wire shape wasn't confirmed at research time (client.ts's
 * provenance note), so this accepts a handful of plausible envelopes and
 * field-name synonyms rather than assuming one exact schema. Returns `null`
 * if nothing recognizable is found — callers should treat that as "couldn't
 * parse," not "definitely empty."
 */
function parseTranscriptTurns(raw: unknown): TranscriptTurn[] | null {
  const list = extractTurnList(raw);
  if (!list) {
    return null;
  }

  const turns: TranscriptTurn[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const text = firstString(record, ["text", "message", "content", "utterance"]);
    if (text === undefined) {
      continue;
    }
    const roleRaw = firstString(record, ["role", "speaker", "turn", "sender"]) ?? "system";
    // Dograh's transcript entries may not carry a per-turn timestamp; when
    // absent we synthesize one at parse time rather than omitting a
    // required field.
    const at = firstString(record, ["at", "timestamp", "created_at", "time"]) ?? new Date().toISOString();
    turns.push({ role: normalizeRole(roleRaw), text, at });
  }
  return turns;
}

function extractTurnList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    for (const key of ["turns", "messages", "transcript", "segments"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function normalizeRole(raw: string): TranscriptTurn["role"] {
  const lower = raw.toLowerCase();
  if (lower === "agent" || lower === "assistant" || lower === "bot" || lower === "ai") {
    return "agent";
  }
  if (lower === "user" || lower === "caller" || lower === "customer" || lower === "human") {
    return "caller";
  }
  return "system";
}

/**
 * Best-effort only — Dograh's API has no confirmed field for a number's
 * country. `+1` covers the NANP (US/Canada/etc); this driver guesses "US"
 * since that's overwhelmingly the common case for a BYO-carrier local/dev
 * setup, and otherwise reports ISO 3166-1's reserved "unknown or
 * unspecified country" code rather than guessing wrong.
 */
function inferCountry(e164: string): string {
  return e164.startsWith("+1") ? "US" : "ZZ";
}
