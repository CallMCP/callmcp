/**
 * CallMCP server — configuration resolution.
 *
 * Resolves a set of configured drivers (driver id -> { type, credentials }),
 * with exactly one marked `default`, from one of two sources, in priority
 * order:
 *
 * 1. A `callmcp.config.json` file (path from `CALLMCP_CONFIG` env var, or
 *    `./callmcp.config.json` relative to `cwd`).
 * 2. Environment variables — either the multi-driver escape hatch
 *    `CALLMCP_DRIVERS_JSON` (a JSON array, same shape as the config file's
 *    `drivers` field), or the single-driver shorthand `CALLMCP_DRIVER_TYPE`
 *    / `CALLMCP_DRIVER_ID` / `CALLMCP_DRIVER_CREDENTIALS` /
 *    `CALLMCP_DRIVER_OPTIONS`, intended for simple single-tenant deployments
 *    (e.g. a Docker container wired to exactly one KaiCalls account) where
 *    mounting a config file is inconvenient.
 *
 * If neither source yields any drivers, `resolveConfig` returns an empty
 * driver list — `driverRegistry.ts` is responsible for falling back to the
 * `driver-interface` mock driver in that case, not this module.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

/** One configured driver instance: an id, a driver package "type", and its credentials. */
export interface DriverConfigEntry {
  /** short lowercase slug used as `driver_id` throughout the MCP surface, e.g. "kaicalls" */
  id: string;
  /** which driver package to load — see `driverRegistry.ts` for the type -> package mapping */
  type: string;
  /**
   * used when a tool call omits `driver` and more than one driver is
   * configured. Typed `| undefined` (rather than plain `?:`) so zod's
   * inferred output for an omitted optional JSON field — which types as
   * `boolean | undefined`, not just "possibly absent" — assigns cleanly
   * under `exactOptionalPropertyTypes`.
   */
  default?: boolean | undefined;
  /** opaque, driver-specific auth material (API keys, account ids, etc.) */
  credentials?: Record<string, unknown> | undefined;
  /** opaque, driver-specific non-secret configuration (region, base URL overrides, etc.) */
  options?: Record<string, unknown> | undefined;
}

export interface CallMcpConfig {
  drivers: DriverConfigEntry[];
  http?:
    | {
        port?: number | undefined;
        /** base URL this server is reachable at, used to build out-of-band approval URLs (SPEC §3.4) */
        publicUrl?: string | undefined;
      }
    | undefined;
}

const driverConfigEntrySchema = z.object({
  id: z.string().min(1, "driver config entry requires a non-empty `id`"),
  type: z.string().min(1, "driver config entry requires a non-empty `type`"),
  default: z.boolean().optional(),
  credentials: z.record(z.unknown()).optional(),
  options: z.record(z.unknown()).optional(),
});

const callMcpConfigFileSchema = z.object({
  drivers: z.array(driverConfigEntrySchema).default([]),
  http: z
    .object({
      port: z.number().int().positive().optional(),
      publicUrl: z.string().optional(),
    })
    .optional(),
});

export class ConfigError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Ensures exactly one driver is marked `default`, defaulting to the first entry if none is. */
function normalizeDefaults(drivers: DriverConfigEntry[]): DriverConfigEntry[] {
  if (drivers.length === 0) {
    return drivers;
  }

  const defaultCount = drivers.filter((d) => d.default).length;
  if (defaultCount > 1) {
    throw new ConfigError(
      `more than one driver is marked default: ${drivers
        .filter((d) => d.default)
        .map((d) => d.id)
        .join(", ")}`,
    );
  }

  const ids = new Set<string>();
  for (const d of drivers) {
    if (ids.has(d.id)) {
      throw new ConfigError(`duplicate driver id in config: "${d.id}"`);
    }
    ids.add(d.id);
  }

  if (defaultCount === 1) {
    return drivers;
  }

  // No explicit default: the first configured driver becomes default.
  return drivers.map((d, i) => (i === 0 ? { ...d, default: true } : d));
}

async function readConfigFile(path: string): Promise<CallMcpConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw new ConfigError(`failed to read config file at ${path}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config file at ${path} is not valid JSON`, err);
  }

  const result = callMcpConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`config file at ${path} failed validation: ${result.error.message}`, result.error);
  }

  return { drivers: normalizeDefaults(result.data.drivers), http: result.data.http };
}

function parseJsonEnvVar<T>(name: string, schema: z.ZodType<T>): T | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`env var ${name} is not valid JSON`, err);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`env var ${name} failed validation: ${result.error.message}`, result.error);
  }
  return result.data;
}

function readEnvConfig(): CallMcpConfig {
  const multiDriver = parseJsonEnvVar("CALLMCP_DRIVERS_JSON", z.array(driverConfigEntrySchema));
  if (multiDriver) {
    return { drivers: normalizeDefaults(multiDriver) };
  }

  const type = process.env.CALLMCP_DRIVER_TYPE;
  if (type) {
    const id = process.env.CALLMCP_DRIVER_ID ?? type;
    const credentials = parseJsonEnvVar("CALLMCP_DRIVER_CREDENTIALS", z.record(z.unknown()));
    const options = parseJsonEnvVar("CALLMCP_DRIVER_OPTIONS", z.record(z.unknown()));
    return { drivers: [{ id, type, default: true, credentials, options }] };
  }

  return { drivers: [] };
}

export interface ResolveConfigOptions {
  /** explicit path to a config file, overrides `CALLMCP_CONFIG` and the default `./callmcp.config.json` lookup */
  configPath?: string;
  /** working directory to resolve the default config file path against; defaults to `process.cwd()` */
  cwd?: string;
}

/**
 * Resolves the effective CallMCP configuration: config file first, then env
 * vars, then an empty driver list (mock-driver fallback territory).
 */
export async function resolveConfig(opts: ResolveConfigOptions = {}): Promise<CallMcpConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const explicitPath = opts.configPath ?? process.env.CALLMCP_CONFIG;
  const path = resolve(cwd, explicitPath ?? "callmcp.config.json");

  const fromFile = await readConfigFile(path);
  if (fromFile) {
    return fromFile;
  }

  return readEnvConfig();
}
