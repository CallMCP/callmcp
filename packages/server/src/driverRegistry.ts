/**
 * CallMCP server — driver registry.
 *
 * Loads/instantiates `Driver` implementations from `resolveConfig()`'s
 * output. Driver packages are loaded via dynamic `import()` so this package
 * never hard-depends on `@callmcp/driver-kaicalls` / `@callmcp/driver-dograh`
 * / `@callmcp/driver-byok` — a deployment only needs whichever of those it
 * actually configures.
 *
 * Two ways a driver package can be instantiated, tried in order:
 * 1. **Factory convention** (preferred for third-party/community drivers):
 *    a `createDriver` named export, or a default export, that is a function
 *    `(entry: { id, credentials, options }) => Driver | Promise<Driver>`.
 * 2. **Known class fallback** (what the three bundled launch drivers
 *    actually export today — plain `Driver`-implementing classes with their
 *    own constructor shapes, no `createDriver` wrapper): `KaiCallsDriver`,
 *    `DograhDriver`, `BYOKDriver`. `entry.credentials` and `entry.options`
 *    are shallow-merged and passed straight through as that class's
 *    constructor argument, so a `callmcp.config.json` driver entry's fields
 *    map 1:1 onto e.g. `KaiCallsDriverConfig` / `DograhDriverOptions` /
 *    `BYOKDriverConfig`.
 *
 * If no driver is configured, or every configured driver fails to load
 * (missing package, bad credentials shape, whatever), the registry falls
 * back to `@callmcp/driver-interface`'s `MockDriver` so the server always
 * has *something* to serve `tools/list` against rather than refusing to
 * start. Load failures are collected in `warnings` rather than thrown, so
 * one bad driver entry doesn't take down a multi-driver deployment.
 */

import type { CapabilityManifest, Driver, DriverInfo, ToolName } from "@callmcp/driver-interface";
import { MockDriver } from "@callmcp/driver-interface";
import type { CallMcpConfig, DriverConfigEntry } from "./config.js";

export type DriverFactoryInput = Pick<DriverConfigEntry, "id" | "credentials" | "options">;
export type DriverFactory = (entry: DriverFactoryInput) => Driver | Promise<Driver>;

interface KnownDriverType {
  /** npm package specifier (dynamic import target) */
  pkg: string;
  /** constructs the package's `Driver` class directly when it exports no `createDriver` factory */
  instantiate: (mod: Record<string, unknown>, entry: DriverConfigEntry) => Driver;
}

function classFromModule(mod: Record<string, unknown>, exportName: string, pkg: string): new (config?: unknown) => Driver {
  const ctor = mod[exportName];
  if (typeof ctor !== "function") {
    throw new Error(`driver package "${pkg}" does not export "${exportName}"`);
  }
  return ctor as new (config?: unknown) => Driver;
}

/** `type` (config) -> how to load that driver package. */
const KNOWN_DRIVER_TYPES: Record<string, KnownDriverType> = {
  kaicalls: {
    pkg: "@callmcp/driver-kaicalls",
    instantiate: (mod, entry) => {
      const KaiCallsDriver = classFromModule(mod, "KaiCallsDriver", "@callmcp/driver-kaicalls");
      return new KaiCallsDriver({ ...entry.credentials, ...entry.options });
    },
  },
  dograh: {
    pkg: "@callmcp/driver-dograh",
    instantiate: (mod, entry) => {
      const DograhDriver = classFromModule(mod, "DograhDriver", "@callmcp/driver-dograh");
      return new DograhDriver({ ...entry.credentials, ...entry.options });
    },
  },
  byok: {
    pkg: "@callmcp/driver-byok",
    instantiate: (mod, entry) => {
      const BYOKDriver = classFromModule(mod, "BYOKDriver", "@callmcp/driver-byok");
      return new BYOKDriver({ ...entry.credentials, ...entry.options });
    },
  },
};

export interface LoadedDriver {
  driver: Driver;
  manifest: CapabilityManifest;
  isDefault: boolean;
}

export type DriverChangeListener = () => void;

export class DriverNotFoundError extends Error {
  constructor(readonly driverId: string) {
    super(`no such driver configured: "${driverId}"`);
    this.name = "DriverNotFoundError";
  }
}

export class NoDriversConfiguredError extends Error {
  constructor() {
    super("no drivers configured and registry has not been loaded");
    this.name = "NoDriversConfiguredError";
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function resolveFactory(mod: unknown): DriverFactory | undefined {
  const asRecord = mod as Record<string, unknown> | undefined;
  if (typeof asRecord?.createDriver === "function") {
    return asRecord.createDriver as DriverFactory;
  }
  if (typeof asRecord?.default === "function") {
    return asRecord.default as DriverFactory;
  }
  const defaultExport = asRecord?.default as Record<string, unknown> | undefined;
  if (typeof defaultExport?.createDriver === "function") {
    return defaultExport.createDriver as DriverFactory;
  }
  return undefined;
}

function isDriverShaped(value: unknown): value is Driver {
  const d = value as Partial<Driver> | undefined;
  return Boolean(d) && typeof d?.id === "string" && typeof d?.getManifest === "function" && typeof d?.makeCall === "function";
}

async function instantiateDriver(entry: DriverConfigEntry): Promise<Driver> {
  if (entry.type === "mock") {
    return new MockDriver();
  }

  const known = KNOWN_DRIVER_TYPES[entry.type];
  if (!known) {
    throw new Error(
      `unknown driver type "${entry.type}" for driver id "${entry.id}" (expected one of: mock, ${Object.keys(KNOWN_DRIVER_TYPES).join(", ")})`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(known.pkg)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`failed to import driver package "${known.pkg}": ${describeError(err)}`, { cause: err });
  }

  const factory = resolveFactory(mod);
  const driver = factory
    ? await factory({ id: entry.id, credentials: entry.credentials ?? {}, options: entry.options ?? {} })
    : known.instantiate(mod, entry);

  if (!isDriverShaped(driver)) {
    throw new Error(`driver package "${known.pkg}" did not produce an object implementing the Driver interface`);
  }
  if (driver.id !== entry.id) {
    throw new Error(`driver package "${known.pkg}" returned driver.id "${driver.id}" but was configured under id "${entry.id}"`);
  }

  return driver;
}

/** Derives `degraded_tools` (SPEC §1.1) from a manifest's per-tool `supported: false` entries. */
function degradedToolsFromManifest(manifest: CapabilityManifest): ToolName[] {
  return (Object.entries(manifest.tools) as [ToolName, { supported: boolean }][])
    .filter(([, entry]) => entry.supported === false)
    .map(([tool]) => tool);
}

export class DriverRegistry {
  private drivers = new Map<string, LoadedDriver>();
  private defaultId: string | null = null;
  private listeners = new Set<DriverChangeListener>();

  /** Non-fatal load problems from the most recent `load()` call. */
  readonly warnings: string[] = [];

  /** Registers a listener fired after every `load()` (config swap, capability flip). */
  onChange(listener: DriverChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * (Re)loads the registry from a resolved config. Safe to call more than
   * once (e.g. on SIGHUP-triggered reconfiguration) — replaces the driver
   * set atomically and notifies listeners so `dynamicTools.ts` can emit
   * `notifications/tools/list_changed` (SPEC §2.2).
   */
  async load(config: CallMcpConfig): Promise<void> {
    const nextDrivers = new Map<string, LoadedDriver>();
    const warnings: string[] = [];
    let defaultId: string | null = null;

    for (const entry of config.drivers) {
      try {
        const driver = await instantiateDriver(entry);
        const manifest = await driver.getManifest();
        nextDrivers.set(entry.id, { driver, manifest, isDefault: Boolean(entry.default) });
        if (entry.default) {
          defaultId = entry.id;
        }
      } catch (err) {
        warnings.push(`driver "${entry.id}" (type=${entry.type}) failed to load: ${describeError(err)}`);
      }
    }

    if (nextDrivers.size === 0) {
      const mock = new MockDriver();
      const manifest = await mock.getManifest();
      nextDrivers.set(mock.id, { driver: mock, manifest, isDefault: true });
      defaultId = mock.id;
      warnings.push("no drivers configured (or all configured drivers failed to load) — falling back to the in-memory mock driver");
    } else if (!defaultId) {
      const [firstId, firstRecord] = nextDrivers.entries().next().value as [string, LoadedDriver];
      nextDrivers.set(firstId, { ...firstRecord, isDefault: true });
      defaultId = firstId;
    }

    this.drivers = nextDrivers;
    this.defaultId = defaultId;
    this.warnings.length = 0;
    this.warnings.push(...warnings);

    this.emitChange();
  }

  /**
   * Directly registers already-constructed `Driver` instances, bypassing
   * config resolution and dynamic package loading. Intended for embedding
   * CallMCP programmatically (a host application that constructs its own
   * `Driver` in-process) and for tests that need a driver with a specific
   * capability manifest without publishing a driver package.
   */
  async loadDrivers(drivers: Driver[], opts: { defaultId?: string } = {}): Promise<void> {
    const nextDrivers = new Map<string, LoadedDriver>();
    const defaultId = opts.defaultId ?? drivers[0]?.id ?? null;

    for (const driver of drivers) {
      const manifest = await driver.getManifest();
      nextDrivers.set(driver.id, { driver, manifest, isDefault: driver.id === defaultId });
    }

    this.drivers = nextDrivers;
    this.defaultId = defaultId;
    this.warnings.length = 0;

    this.emitChange();
  }

  /** Looks up a driver by id, or the configured default when `id` is omitted. */
  get(id?: string): LoadedDriver {
    if (this.drivers.size === 0) {
      throw new NoDriversConfiguredError();
    }
    const key = id ?? this.defaultId;
    if (!key) {
      throw new NoDriversConfiguredError();
    }
    const record = this.drivers.get(key);
    if (!record) {
      throw new DriverNotFoundError(key);
    }
    return record;
  }

  has(id: string): boolean {
    return this.drivers.has(id);
  }

  list(): LoadedDriver[] {
    return Array.from(this.drivers.values());
  }

  get defaultDriverId(): string | null {
    return this.defaultId;
  }

  /** Builds the `list_drivers` (SPEC §1.1) `drivers[]` array from loaded manifests. */
  listDriverInfos(): DriverInfo[] {
    return this.list().map(({ driver, manifest, isDefault }): DriverInfo => ({
      id: driver.id,
      display_name: manifest.display_name,
      kind: manifest.kind,
      default: isDefault,
      capabilities: manifest.capabilities,
      degraded_tools: degradedToolsFromManifest(manifest),
    }));
  }
}
