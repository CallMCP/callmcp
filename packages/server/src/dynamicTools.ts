/**
 * CallMCP server — capability-driven `tools/list` (SPEC §2.2).
 *
 * Computes, from the currently loaded drivers' capability manifests, which
 * of the 14 catalog tools (`tools.ts`) are actually exposed, and keeps
 * connected clients honest about it via `notifications/tools/list_changed`
 * whenever the driver set changes (a driver added/removed/reconfigured, or
 * a capability flag flips).
 *
 * Multi-driver visibility rule: a capability-gated tool is listed if *any*
 * configured driver supports it (a client routes to a specific driver via
 * the tool's `driver` argument, so the tool needs to be discoverable if it
 * works for at least one of them). `tools/call`'s defense-in-depth gate
 * check (SPEC §6.2) still re-validates against the *resolved* driver at
 * call time and returns `UNSUPPORTED_CAPABILITY` if that specific driver
 * doesn't support it — this module governs discovery, not authorization.
 * For the common single-driver deployment this reduces exactly to "that
 * driver's capabilities", matching SPEC §2.2's worked examples verbatim.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, type ListToolsResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import type { ToolName } from "@callmcp/driver-interface";

import { TOOL_CATALOG } from "./tools.js";
import type { DriverRegistry } from "./driverRegistry.js";

/** Server capability block this server always declares (SPEC §2.2: "MUST declare tools.listChanged: true"). */
export const TOOLS_SERVER_CAPABILITY = { listChanged: true } as const;

function toolNames(): ToolName[] {
  return Object.keys(TOOL_CATALOG) as ToolName[];
}

/** Computes the live `tools/list` array for the current driver set (SPEC §2.2). */
export function computeVisibleTools(driverRegistry: DriverRegistry): Tool[] {
  const loaded = driverRegistry.list();
  const tools: Tool[] = [];

  for (const name of toolNames()) {
    const entry = TOOL_CATALOG[name];
    const gate = entry.gate;
    const visible = gate === true || loaded.some((d) => gate(d.manifest.capabilities));
    if (!visible) {
      continue;
    }
    tools.push({
      name,
      description: entry.description,
      inputSchema: entry.inputSchema as Tool["inputSchema"],
      annotations: entry.annotations,
      ...(entry.execution ? { execution: entry.execution } : {}),
    });
  }

  return tools;
}

/**
 * Registers the `tools/list` handler and wires `driverRegistry` changes to
 * `notifications/tools/list_changed` (SPEC §2.2).
 */
export function registerDynamicToolList(server: Server, driverRegistry: DriverRegistry): () => void {
  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
    return { tools: computeVisibleTools(driverRegistry) };
  });

  return driverRegistry.onChange(() => {
    // Best-effort: if no transport is attached yet (or it has gone away),
    // the client simply re-fetches tools/list on its next call — there is
    // nothing to recover from a failed notification here.
    void server.sendToolListChanged().catch(() => undefined);
  });
}
