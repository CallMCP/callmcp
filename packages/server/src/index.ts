#!/usr/bin/env node
/**
 * CallMCP server — CLI entrypoint.
 *
 * Resolves configuration (`config.ts`), loads drivers (`driverRegistry.ts`),
 * and starts either the stdio transport (default — the common case for a
 * locally-launched MCP server) or the Streamable HTTP transport (`--http`),
 * both wired through the shared `ServerCore` (`tools.ts`).
 *
 * Note on the out-of-band approval fallback (SPEC §3.4): the `/approve/:id`
 * page is only actually served while the HTTP transport is running. In
 * stdio-only mode, `out_of_band_url` is still generated (pointing at
 * `--public-url`, or `http://localhost:<port>` by default) so the contract
 * ("never silently block forever") holds, but a human can only open it if
 * *some* CallMCP HTTP surface — this process with `--http`, or a separately
 * hosted one at `--public-url` — is actually reachable there.
 */

import { ApprovalStore } from "./approval.js";
import { resolveConfig } from "./config.js";
import { DriverRegistry } from "./driverRegistry.js";
import type { ServerCore } from "./tools.js";
import { SERVER_NAME, SERVER_VERSION, startHttpTransport, startStdioTransport } from "./transports.js";

const DEFAULT_PORT = 8787;

interface CliOptions {
  configPath?: string | undefined;
  transport: "stdio" | "http";
  port?: number | undefined;
  publicUrl?: string | undefined;
}

function printHelp(): void {
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION}

Usage: callmcp-server [options]

Options:
  --config <path>      path to callmcp.config.json (default: ./callmcp.config.json, or $CALLMCP_CONFIG)
  --transport <mode>   "stdio" (default) or "http"
  --http                shorthand for --transport http
  --port <n>            HTTP port (default: 8787, or callmcp.config.json's http.port)
  --public-url <url>    base URL this server is reachable at, for out-of-band approval links
  -h, --help             show this help
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { transport: "stdio" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
        opts.configPath = argv[++i];
        break;
      case "--transport": {
        const value = argv[++i];
        if (value !== "stdio" && value !== "http") {
          throw new Error(`--transport must be "stdio" or "http", got "${String(value)}"`);
        }
        opts.transport = value;
        break;
      }
      case "--http":
        opts.transport = "http";
        break;
      case "--port":
        opts.port = Number(argv[++i]);
        break;
      case "--public-url":
        opts.publicUrl = argv[++i];
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        process.stderr.write(`unknown argument: ${arg}\n`);
        printHelp();
        process.exit(1);
    }
  }

  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = await resolveConfig({ ...(opts.configPath ? { configPath: opts.configPath } : {}) });

  const driverRegistry = new DriverRegistry();
  await driverRegistry.load(config);
  for (const warning of driverRegistry.warnings) {
    process.stderr.write(`[${SERVER_NAME}] ${warning}\n`);
  }

  const approvals = new ApprovalStore();
  const stopExpirySweep = approvals.startExpirySweep();

  const port = opts.port ?? config.http?.port ?? DEFAULT_PORT;
  const publicUrl = (opts.publicUrl ?? config.http?.publicUrl ?? `http://localhost:${port}`).replace(/\/$/, "");
  const core: ServerCore = { driverRegistry, approvals, outOfBandBaseUrl: `${publicUrl}/approve` };

  const cleanups: Array<() => Promise<void>> = [async () => stopExpirySweep()];
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`[${SERVER_NAME}] received ${signal}, shutting down\n`);
    for (const cleanup of cleanups) {
      await cleanup().catch(() => undefined);
    }
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (opts.transport === "http") {
    const handle = await startHttpTransport(core, { port });
    cleanups.push(handle.close);
    process.stderr.write(
      `[${SERVER_NAME}] listening on http://localhost:${handle.port} (mcp: /mcp, approvals: /approve/:id)\n`,
    );
  } else {
    const handle = await startStdioTransport(core);
    cleanups.push(handle.close);
    process.stderr.write(`[${SERVER_NAME}] listening on stdio\n`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[${SERVER_NAME}] fatal: ${message}\n`);
  process.exit(1);
});
