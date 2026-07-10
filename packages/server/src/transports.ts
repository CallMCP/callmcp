/**
 * CallMCP server — transport wiring.
 *
 * Wires the shared `ServerCore` (config-resolved driver registry + approval
 * store) to both MCP transports:
 *
 * - stdio (`StdioServerTransport`) — one `Server` for the process lifetime,
 *   the common case for a CLI-launched local MCP server.
 * - Streamable HTTP (`StreamableHTTPServerTransport`) — a fresh `Server` per
 *   negotiated session (stateful mode, `mcp-session-id` header), all sharing
 *   the same `ServerCore` so driver state and approvals are consistent
 *   across sessions. The same `node:http` server also serves the SPEC §3.4
 *   non-elicitation fallback: a plain `/approve/:id` web page a human can
 *   open without any MCP client to approve or deny a pending request.
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ApprovalRecord } from "@callmcp/driver-interface";

import { registerDynamicToolList, TOOLS_SERVER_CAPABILITY } from "./dynamicTools.js";
import { registerToolCallHandler, type ServerCore } from "./tools.js";

export const SERVER_NAME = "callmcp-server";
export const SERVER_VERSION = "0.1.0";

/** Builds one `Server` instance wired to `core`, ready to `connect()` to a transport. */
export function createMcpServer(core: ServerCore): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: TOOLS_SERVER_CAPABILITY } },
  );
  registerDynamicToolList(server, core.driverRegistry);
  registerToolCallHandler(server, core);
  return server;
}

export interface StdioTransportHandle {
  server: Server;
  close: () => Promise<void>;
}

/** Connects a fresh `Server` to stdio and starts listening. */
export async function startStdioTransport(core: ServerCore): Promise<StdioTransportHandle> {
  const server = createMcpServer(core);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, close: () => server.close() };
}

export interface HttpTransportOptions {
  port: number;
  /** URL path the MCP endpoint is served at. Default "/mcp". */
  mcpPath?: string;
  /** URL path prefix the human approval page is served at. Default "/approve". */
  approvePath?: string;
}

export interface HttpTransportHandle {
  httpServer: ReturnType<typeof createHttpServer>;
  port: number;
  close: () => Promise<void>;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the SPEC §3.4 out-of-band approval page: plain HTML, no MCP client required. */
function renderApprovalPage(id: string, record: ApprovalRecord | null): string {
  if (!record) {
    return `<!doctype html><html><body><h1>Unknown approval</h1><p>No approval found for id ${escapeHtml(id)}.</p></body></html>`;
  }

  const destinations = record.destinations.map(escapeHtml).join(", ");
  const isPending = record.state === "pending";
  const statusBlock = isPending
    ? `<form method="post"><button name="action" value="approve">Approve</button> <button name="action" value="deny">Deny</button></form>`
    : `<p>This request has already been decided: <strong>${escapeHtml(record.state)}</strong>.</p>`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>CallMCP approval ${escapeHtml(id)}</title></head>
<body style="font-family: sans-serif; max-width: 32rem; margin: 3rem auto;">
  <h1>CallMCP approval request</h1>
  <p><strong>Scope:</strong> ${escapeHtml(record.scope)}</p>
  <p><strong>Channel:</strong> ${escapeHtml(record.channel)}</p>
  <p><strong>Destinations:</strong> ${destinations}</p>
  <p><strong>Driver:</strong> ${escapeHtml(record.driver)}</p>
  <p><strong>Status:</strong> ${escapeHtml(record.state)}</p>
  ${statusBlock}
</body>
</html>`;
}

/**
 * Starts the shared HTTP server: Streamable HTTP MCP transport (stateful,
 * multi-session) at `mcpPath`, plus the built-in approval page at
 * `approvePath/:id`.
 */
export async function startHttpTransport(core: ServerCore, opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const mcpPath = opts.mcpPath ?? "/mcp";
  const approvePath = opts.approvePath ?? "/approve";
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== "POST") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "DRIVER_ERROR", message: "no active MCP session" } }));
        return;
      }

      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, created);
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
        },
      });
      created.onclose = () => {
        if (created.sessionId) {
          sessions.delete(created.sessionId);
        }
      };

      const server = createMcpServer(core);
      // `StreamableHTTPServerTransport` declares `onclose`/`onerror`/`onmessage`
      // as accessor pairs typed `(() => void) | undefined`, which satisfies
      // the `Transport` interface's `onclose?: () => void` at runtime but not
      // under this package's `exactOptionalPropertyTypes` when re-checked at
      // the call site — a known friction point with accessor-based optional
      // properties, not an actual type mismatch.
      await server.connect(created as unknown as Parameters<typeof server.connect>[0]);
      transport = created;
    }

    await transport.handleRequest(req, res);
  }

  async function handleApprovalPage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const id = decodeURIComponent(url.pathname.slice(approvePath.length + 1));
    if (!id) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (req.method === "GET") {
      const record = core.approvals.get(id);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderApprovalPage(id, record));
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const action = new URLSearchParams(body).get("action");
      if (action !== "approve" && action !== "deny") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("invalid action");
        return;
      }
      const record = core.approvals.decide(id, action);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderApprovalPage(id, record));
      return;
    }

    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed");
  }

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://internal");
        if (url.pathname === mcpPath) {
          await handleMcpRequest(req, res);
          return;
        }
        if (url.pathname.startsWith(`${approvePath}/`)) {
          await handleApprovalPage(req, res, url);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: { code: "DRIVER_ERROR", message: describeError(err) } }));
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(opts.port, () => resolveListen());
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    httpServer,
    port,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        for (const transport of sessions.values()) {
          void transport.close();
        }
        httpServer.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}
