/**
 * CallMCP driver-dograh — REST client
 *
 * A thin HTTP client for a self-hosted or hosted Dograh instance
 * (github.com/dograh-hq/dograh). This wraps Dograh's own FastAPI REST
 * surface directly — it does NOT call, wrap, or re-export Dograh's own MCP
 * server (docs.dograh.com/integrations/mcp). Dograh ships its own MCP
 * server; treating it as an upstream dependency here would make this driver
 * fragile against a direct competitor's roadmap. See
 * workspace/research/r4-local-stacks.md §10 for the risk writeup that
 * motivates this boundary.
 *
 * Route provenance (so future edits know what's verified vs. inferred):
 *
 *   VERIFIED against source (r4-local-stacks.md §2, citing a direct fetch of
 *   dograh-hq/dograh's `api/routes/*.py` on 2026-07-09):
 *     - POST /telephony/initiate-call
 *     - POST /{workflow_id}/runs
 *     - GET  /{workflow_id}/runs/{run_id}  → transcript_url, transcript_public_url,
 *       logs, cost_info, usage_info
 *     - No number-purchase endpoint exists anywhere in the API (BYO-carrier only).
 *     - No external hangup/end-call endpoint exists.
 *     - No SMS endpoint exists.
 *
 *   ASSUMED / INFERRED (not independently source-verified in the research
 *   pass — flagged here so a driver maintainer knows exactly what to
 *   re-check against a live Dograh instance before trusting it blindly):
 *     - PUT  /api/v1/workflow/{workflow_id}      (per-workflow config, incl.
 *       telephony number attachment)
 *     - GET  /api/v1/workflow/{workflow_id}
 *     - GET  /api/v1/workflow                    (collection listing; assumed
 *       REST convention paired with the PUT above — NOT confirmed against
 *       source)
 *     - GET  /{workflow_id}/runs                 (collection listing; assumed
 *       REST convention paired with GET /{workflow_id}/runs/{run_id} — NOT
 *       confirmed against source)
 *     - The exact field names on a run object beyond transcript_url/
 *       transcript_public_url/logs/cost_info/usage_info (status, artifacts,
 *       to/from numbers, timestamps) — the client and driver.ts parse these
 *       defensively (multiple candidate field names, tolerant of absence)
 *       rather than assuming one exact shape, and driver.ts documents how it
 *       degrades when a field isn't where expected.
 *     - Auth convention (`Authorization: Bearer <DOGRAH_API_KEY>`) — Dograh's
 *       docker-compose quickstart runs with no auth at all by default; this
 *       is a reasonable-but-unverified guess for hosted/authenticated
 *       deployments.
 *
 * If your Dograh instance's real API disagrees with an ASSUMED route above,
 * fix it here (and in driver.ts's response parsing) rather than filing that
 * disagreement against SPEC.md — SPEC.md doesn't mandate Dograh's wire
 * format, only the CallMCP tool contract this driver maps it onto.
 */

export interface DograhClientOptions {
  /** Defaults to process.env.DOGRAH_BASE_URL. */
  baseUrl?: string;
  /** Defaults to process.env.DOGRAH_API_KEY. Omit entirely for an unauthenticated local instance. */
  apiKey?: string;
  /** Override for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Raised for any non-2xx response from a Dograh instance. Carries the parsed
 * (or raw-text, if not JSON) response body so driver.ts can inspect it
 * before deciding whether to map it to a CallMCP taxonomy code or fall back
 * to the DRIVER_ERROR passthrough envelope (SPEC §5.6).
 */
export class DograhApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    super(`Dograh API ${method} ${path} responded ${status}`);
    this.name = "DograhApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Wire types — see the provenance note above for what's verified vs assumed.
// All are deliberately permissive (`[key: string]: unknown` + optional
// fields) since we do not control Dograh's schema and it may drift between
// versions; driver.ts is responsible for defensive parsing on top of these.
// ---------------------------------------------------------------------------

export interface InitiateCallRequest {
  workflow_id: string;
  phone_number: string;
  from_number?: string;
  metadata?: Record<string, unknown>;
}

export interface InitiateCallResponse {
  /** Most likely key for the created run's identifier. */
  run_id?: string;
  /** Some Dograh versions may key the created resource under `id` instead. */
  id?: string;
  workflow_id?: string;
  status?: string;
  [key: string]: unknown;
}

export interface DograhRunArtifact {
  /** e.g. "recording" / "call_recording" / "audio" / "transcript" — matched loosely, see driver.ts. */
  artifact_type: string;
  url?: string | null;
  public_url?: string | null;
  mime_type?: string | null;
  duration_seconds?: number | null;
  [key: string]: unknown;
}

export interface DograhRun {
  run_id?: string;
  id?: string;
  workflow_id?: string;
  /** Free-text status from Dograh; not a confirmed enum. Mapped defensively in driver.ts. */
  status?: string;
  transcript_url?: string | null;
  transcript_public_url?: string | null;
  logs?: unknown;
  cost_info?: unknown;
  usage_info?: unknown;
  artifacts?: DograhRunArtifact[];
  to_phone_number?: string;
  from_phone_number?: string;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DograhTelephonyConfig {
  phone_number?: string | null;
  provider?: string | null;
  sms_webhook_url?: string | null;
  caller_id_name?: string | null;
  [key: string]: unknown;
}

export interface DograhWorkflow {
  workflow_id?: string;
  id?: string;
  name?: string;
  telephony_config?: DograhTelephonyConfig | null;
  created_at?: string | null;
  [key: string]: unknown;
}

/** REST client for a self-hosted or hosted Dograh instance. */
export class DograhClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DograhClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.DOGRAH_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "DograhClient: no base URL configured — set DOGRAH_BASE_URL (e.g. http://localhost:8081) or pass { baseUrl } explicitly",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.DOGRAH_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** POST /telephony/initiate-call — SPEC-verified route (r4-local-stacks.md §2). */
  async initiateCall(body: InitiateCallRequest): Promise<InitiateCallResponse> {
    return this.request<InitiateCallResponse>("POST", "/telephony/initiate-call", body);
  }

  /** POST /{workflow_id}/runs — SPEC-verified alternate entry point for triggering a call under a workflow. */
  async createWorkflowRun(workflowId: string, body: Record<string, unknown> = {}): Promise<DograhRun> {
    return this.request<DograhRun>("POST", `/${encodePathSegment(workflowId)}/runs`, body);
  }

  /** GET /{workflow_id}/runs/{run_id} — SPEC-verified route; returns transcript_url etc. */
  async getRun(workflowId: string, runId: string): Promise<DograhRun> {
    return this.request<DograhRun>(
      "GET",
      `/${encodePathSegment(workflowId)}/runs/${encodePathSegment(runId)}`,
    );
  }

  /** GET /{workflow_id}/runs — ASSUMED collection route; see provenance note above. */
  async listRuns(workflowId: string): Promise<DograhRun[]> {
    const result = await this.request<DograhRun[] | { runs?: DograhRun[] }>(
      "GET",
      `/${encodePathSegment(workflowId)}/runs`,
    );
    return Array.isArray(result) ? result : (result.runs ?? []);
  }

  /** GET /api/v1/workflow/{workflow_id} — ASSUMED route; see provenance note above. */
  async getWorkflow(workflowId: string): Promise<DograhWorkflow> {
    return this.request<DograhWorkflow>("GET", `/api/v1/workflow/${encodePathSegment(workflowId)}`);
  }

  /** PUT /api/v1/workflow/{workflow_id} — ASSUMED config route; see provenance note above. */
  async updateWorkflowConfig(
    workflowId: string,
    patch: Record<string, unknown>,
  ): Promise<DograhWorkflow> {
    return this.request<DograhWorkflow>("PUT", `/api/v1/workflow/${encodePathSegment(workflowId)}`, patch);
  }

  /** GET /api/v1/workflow — ASSUMED collection route; see provenance note above. */
  async listWorkflows(): Promise<DograhWorkflow[]> {
    const result = await this.request<DograhWorkflow[] | { workflows?: DograhWorkflow[] }>(
      "GET",
      "/api/v1/workflow",
    );
    return Array.isArray(result) ? result : (result.workflows ?? []);
  }

  /**
   * Fetches whatever `transcript_url`/`transcript_public_url` on a run
   * points at. That URL may be absolute (e.g. a pre-signed storage URL) or
   * relative to this Dograh instance's base URL — both are handled.
   */
  async fetchTranscript(url: string): Promise<unknown> {
    const target = /^https?:\/\//i.test(url) ? url : this.resolvePath(url);
    const res = await this.fetchImpl(target, { headers: this.authHeaders() });
    const parsed = await parseBody(res);
    if (!res.ok) {
      throw new DograhApiError("GET", url, res.status, parsed);
    }
    return parsed;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.resolvePath(path), {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...this.authHeaders(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const parsed = await parseBody(res);
    if (!res.ok) {
      throw new DograhApiError(method, path, res.status, parsed);
    }
    return parsed as T;
  }

  private resolvePath(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}
