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
  sandbox: boolean;
  json: boolean;
}

function printHelp(): void {
  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION}

Usage: callmcp-server [options]

Options:
  doctor                validate the journey without starting a server or calling a provider
  --config <path>      path to callmcp.config.json (default: ./callmcp.config.json, or $CALLMCP_CONFIG)
  --transport <mode>   "stdio" (default) or "http"
  --http                shorthand for --transport http
  --port <n>            HTTP port (default: 8787, or callmcp.config.json's http.port)
  --public-url <url>    base URL this server is reachable at, for out-of-band approval links
  --sandbox              run the explicit in-memory sandbox (never contacts a provider)
  --json                 emit doctor output as JSON
  -h, --help             show this help
`);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { transport: "stdio", sandbox: false, json: false };

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
      case "--sandbox":
        opts.sandbox = true;
        break;
      case "--json":
        opts.json = true;
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

function hasCredential(entry: { credentials?: Record<string, unknown> | undefined }): boolean {
  return Object.values(entry.credentials ?? {}).some((value) => typeof value === "string" && value.length > 0);
}

async function doctor(opts: CliOptions): Promise<void> {
  const config = opts.sandbox
    ? { drivers: [{ id: "mock", type: "mock", default: true }] }
    : await resolveConfig({ ...(opts.configPath ? { configPath: opts.configPath } : {}) });
  const drivers = config.drivers.map((entry) => ({
    id: entry.id,
    type: entry.type,
    default: Boolean(entry.default),
    credential_configured: hasCredential(entry),
    mode: entry.type === "mock" ? "sandbox" : "provider",
  }));
  const defaultDriver = drivers.find((entry) => entry.default) ?? drivers[0];
  const checks = [
    { name: "driver_configured", ok: Boolean(defaultDriver) },
    { name: "explicit_sandbox_or_provider", ok: Boolean(defaultDriver?.type) },
    { name: "provider_credential_configured", ok: Boolean(defaultDriver?.type === "mock" || defaultDriver?.credential_configured) },
  ];
  const result = {
    command: "callmcp doctor",
    read_only: true,
    no_provider_calls: true,
    live_activation_performed: false,
    default_driver: defaultDriver?.id ?? null,
    mode: defaultDriver?.mode ?? "unconfigured",
    drivers,
    checks,
    ready_for_activation: checks.every((check) => check.ok) && defaultDriver?.type !== "mock",
    next_step: defaultDriver?.type === "mock"
      ? "Sandbox is ready. Configure a managed KaiCalls kc_live_ key before activation."
      : defaultDriver?.credential_configured
        ? "Run a provider-side dry verification, then obtain human approval before the first real call."
        : "Configure provider credentials, then rerun callmcp doctor.",
  };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.command} (read-only)\n`);
  process.stdout.write(`mode: ${result.mode}; default: ${result.default_driver ?? "none"}\n`);
  for (const check of checks) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}\n`);
  process.stdout.write(`activation readiness: ${result.ready_for_activation ? "ready to review" : "not ready"}\n`);
  process.stdout.write(`${result.next_step}\n`);
  if (drivers.some((entry) => entry.type === "kaicalls")) {
    process.stdout.write("KaiCalls note: kc_live_ keys hit live infrastructure; CallMCP sandbox is local-only.\n");
  }
  if (!checks.every((check) => check.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isDoctor = argv[0] === "doctor";
  const opts = parseArgs(isDoctor ? argv.slice(1) : argv);
  if (isDoctor) {
    await doctor(opts);
    return;
  }
  const config = await resolveConfig({ ...(opts.configPath ? { configPath: opts.configPath } : {}) });
  const effectiveConfig = opts.sandbox ? { drivers: [{ id: "mock", type: "mock", default: true }] } : config;

  const driverRegistry = new DriverRegistry();
  await driverRegistry.load(effectiveConfig);
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
