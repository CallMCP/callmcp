/**
 * KaiCalls hosted backend client — thin fetch-based wrapper.
 *
 * Two distinct wire surfaces, per https://callmcp.ai/llms.txt and
 * https://callmcp.ai/skill.md (read in full while building this driver):
 *
 * 1. MCP JSON-RPC 2.0 `tools/call` against the hosted endpoint
 *    (`https://callmcp.ai/mcp`, itself documented as a same-server proxy to
 *    `https://www.kaicalls.com/api/mcp` — "same server, same tool
 *    handlers"). This is how every telephony tool this driver wraps is
 *    actually invoked. `initialize`/`tools/list` are unauthenticated;
 *    `tools/call` requires `Authorization: Bearer kc_live_...` plus a
 *    per-tool OAuth2-style scope enforced server-side.
 * 2. A small number of plain REST endpoints on `https://www.kaicalls.com`
 *    that live outside the MCP surface — currently just
 *    `POST /api/v1/signup`, used by `provisioning.ts` for the documented
 *    x402 self-provisioning flow.
 *
 * This module deliberately knows nothing about CallMCP's `Driver` contract
 * or its error taxonomy (SPEC §5) — that mapping lives in `driver.ts`. This
 * file only knows how to authenticate and shape requests/responses against
 * KaiCalls' real, documented wire format, and to surface transport/tool
 * failures honestly via `KaiCallsApiError`.
 *
 * Honesty note (see also driver.ts and manifest.ts): llms.txt/skill.md are
 * index/onboarding documents. They confirm tool *names*, *scopes*, and
 * *categories* precisely, but not full JSON Schemas for every tool's
 * input/output shape — those are only available live, via `tools/list` or
 * `.well-known/mcp.json`. This client is deliberately schema-agnostic on
 * the wire (it passes through whatever `arguments` object it's given and
 * returns whatever result payload it gets back); field-level interpretation
 * of that payload is `driver.ts`'s job, done defensively.
 */

export interface KaiCallsClientConfig {
  /** `kc_live_...` bearer token. Required for any `callTool()`. */
  apiKey?: string;
  /**
   * MCP endpoint to POST `tools/call` requests to. Defaults to the hosted
   * CallMCP proxy (`https://callmcp.ai/mcp`), which llms.txt documents as
   * forwarding to the same backend as `https://www.kaicalls.com/api/mcp`.
   * Override for testing, or to hit the KaiCalls origin directly.
   */
  mcpEndpoint?: string;
  /**
   * Origin for KaiCalls REST endpoints that live outside the MCP surface
   * (currently just `/api/v1/signup`). Defaults to
   * `https://www.kaicalls.com`.
   */
  restBaseUrl?: string;
  /** Injectable `fetch` implementation, for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_MCP_ENDPOINT = "https://callmcp.ai/mcp";
export const DEFAULT_REST_BASE_URL = "https://www.kaicalls.com";

/**
 * A JSON-RPC-level or MCP-tool-level error surfaced by the KaiCalls
 * backend. Deliberately distinct from `CallMcpError`
 * (`@callmcp/driver-interface`) — that taxonomy is what `driver.ts` maps
 * *into*; this class carries the raw upstream signal so the mapping layer
 * has something honest to translate from, rather than losing information
 * at the transport boundary.
 */
export class KaiCallsApiError extends Error {
  readonly httpStatus: number | undefined;
  readonly jsonRpcCode: number | undefined;
  readonly toolErrorPayload: unknown;

  constructor(
    message: string,
    opts: { httpStatus?: number; jsonRpcCode?: number; toolErrorPayload?: unknown } = {},
  ) {
    super(message);
    this.name = "KaiCallsApiError";
    this.httpStatus = opts.httpStatus;
    this.jsonRpcCode = opts.jsonRpcCode;
    this.toolErrorPayload = opts.toolErrorPayload;
  }
}

/**
 * An x402 payment-required challenge, as returned by
 * `POST /api/v1/signup` with HTTP 402. llms.txt/skill.md confirm: USDC on
 * Base (`network: eip155:8453`), facilitated by Stripe Machine Payments,
 * amount 5 USDC — but do not publish the exact JSON body shape (that lives
 * at https://callmcp.ai/connect, which this driver does not fetch). The
 * shape below follows the generic x402 protocol convention (also used
 * illustratively in this repo's own SPEC.md §5.4 `INSUFFICIENT_FUNDS`
 * example) — `x402Version` + an `accepts[]` array of payment requirements.
 * Treat unknown/extra fields as normal; this type is intentionally loose.
 */
export interface X402Challenge {
  x402Version?: number;
  accepts?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Result of a raw REST POST via {@link KaiCallsClient.restPost}. */
export interface RestResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

export class KaiCallsClient {
  private readonly apiKey: string | undefined;
  private readonly mcpEndpoint: string;
  private readonly restBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private requestId = 0;

  constructor(config: KaiCallsClientConfig = {}) {
    this.apiKey = config.apiKey;
    this.mcpEndpoint = config.mcpEndpoint ?? DEFAULT_MCP_ENDPOINT;
    this.restBaseUrl = config.restBaseUrl ?? DEFAULT_REST_BASE_URL;

    const injected = config.fetchImpl;
    if (injected) {
      this.fetchImpl = injected;
    } else if (typeof fetch === "function") {
      this.fetchImpl = fetch;
    } else {
      throw new Error("KaiCallsClient: no fetch implementation available; pass `fetchImpl` explicitly.");
    }
  }

  /** Whether this client has a bearer token configured. */
  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Calls one MCP tool via JSON-RPC 2.0 `tools/call`, per the handshake
   * documented in llms.txt: `Authorization: Bearer kc_live_...` on every
   * `tools/call`, per-tool scope enforced server-side. Returns the tool's
   * parsed result payload (either `structuredContent`, or the first text
   * content block parsed as JSON as a fallback).
   *
   * Throws {@link KaiCallsApiError} on transport failure, a JSON-RPC-level
   * error, or an MCP tool result with `isError: true`.
   */
  async callTool<TResult = unknown>(name: string, args: Record<string, unknown> = {}): Promise<TResult> {
    if (!this.apiKey) {
      throw new KaiCallsApiError(
        `KaiCallsClient has no API key configured; cannot call tool "${name}". Provision one via provisioning.ts, or pass \`apiKey\` explicitly.`,
      );
    }

    const id = ++this.requestId;
    const requestBody = {
      jsonrpc: "2.0" as const,
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };

    const response = await this.fetchImpl(this.mcpEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await safeText(response);
      throw new KaiCallsApiError(`KaiCalls MCP endpoint returned HTTP ${response.status} for tool "${name}"`, {
        httpStatus: response.status,
        toolErrorPayload: text,
      });
    }

    const payload = (await safeJson(response)) as JsonRpcResponse | undefined;
    if (!payload) {
      throw new KaiCallsApiError(`KaiCalls MCP tool "${name}" returned a non-JSON response`);
    }

    if (payload.error) {
      throw new KaiCallsApiError(`KaiCalls MCP tool "${name}" returned JSON-RPC error: ${payload.error.message}`, {
        jsonRpcCode: payload.error.code,
        toolErrorPayload: payload.error.data,
      });
    }

    const result = payload.result;
    if (!result) {
      throw new KaiCallsApiError(`KaiCalls MCP tool "${name}" returned no result`);
    }

    if (result.isError) {
      throw new KaiCallsApiError(`KaiCalls MCP tool "${name}" reported a tool-level error`, {
        toolErrorPayload: result.structuredContent ?? result.content,
      });
    }

    if (result.structuredContent !== undefined) {
      return result.structuredContent as TResult;
    }

    // Fall back to parsing the first text content block as JSON. llms.txt
    // documents tool *names* and *scopes*, not the exact `CallToolResult`
    // envelope shape every tool returns; this keeps the client working
    // whether a given tool answers via `structuredContent` or plain
    // `content: [{ type: "text", text: "<json>" }]`.
    const firstText = result.content?.find((c) => c.type === "text")?.text;
    if (firstText !== undefined) {
      try {
        return JSON.parse(firstText) as TResult;
      } catch {
        return firstText as unknown as TResult;
      }
    }

    throw new KaiCallsApiError(`KaiCalls MCP tool "${name}" returned an unparseable result`, {
      toolErrorPayload: result,
    });
  }

  /**
   * Raw REST POST against `restBaseUrl`, used by `provisioning.ts` for
   * `POST /api/v1/signup`. Never throws on non-2xx — the x402 flow needs
   * the caller to inspect HTTP 402 responses directly, so this returns the
   * status/headers/body as-is and lets the caller decide.
   */
  async restPost<TBody extends Record<string, unknown>>(
    path: string,
    body: TBody,
    extraHeaders: Record<string, string> = {},
  ): Promise<RestResponse> {
    const response = await this.fetchImpl(new URL(path, this.restBaseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
    const json = await safeJson(response);
    return { status: response.status, headers: response.headers, json };
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: McpToolCallResult;
  error?: { code: number; message: string; data?: unknown };
}

interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface McpToolCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
