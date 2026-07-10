# @callmcp/server

The CallMCP server core — an MCP server implementing the 14-tool CallMCP
telephony contract ([`SPEC.md`](../../SPEC.md) at the repo root) against
whichever `Driver` you configure. This package has no telephony logic of its
own; it's the neutral layer that turns a `Driver` implementation
(`@callmcp/driver-kaicalls`, `@callmcp/driver-dograh`, `@callmcp/driver-byok`,
or a third-party one) into a spec-conformant MCP server.

## What's in here

| File | What it's for |
|---|---|
| `src/config.ts` | Resolves a `callmcp.config.json` file or env vars into a set of configured drivers, exactly one marked default. |
| `src/driverRegistry.ts` | Dynamically loads driver packages (or embeds already-constructed `Driver`s), falls back to `@callmcp/driver-interface`'s `MockDriver` if nothing loads, notifies listeners on reconfiguration. |
| `src/approval.ts` | `ApprovalStore` — the SPEC §3 approval state machine (pending/approved/denied/expired), elicitation-first with the out-of-band-URL fallback for clients that don't support MCP elicitation. |
| `src/tools.ts` | `ServerCore` — registers all 14 tools with their SPEC-defined schemas and annotations; `make_call`/`send_sms` route through `ensureDestinationApproved` before ever touching a driver. |
| `src/dynamicTools.ts` | Computes the live `tools/list` from the active driver's capability manifest (SPEC §2.2) and fires `notifications/tools/list_changed` when the driver set changes. |
| `src/transports.ts` | stdio and Streamable HTTP transports, both backed by the same `ServerCore`. Also serves `/approve/:id`, the human-facing approval page for the non-elicitation fallback. |
| `src/index.ts` | CLI entrypoint (`callmcp-server` bin). |
| `test/server.test.ts` | Unit tests against `@callmcp/driver-interface`'s `MockDriver`, plus a real dynamic-`import()` test against the three bundled driver packages. |

## Usage

```bash
npx @callmcp/server                    # stdio transport, reads ./callmcp.config.json if present
npx @callmcp/server --http --port 8787 # Streamable HTTP transport
```

### Config file

```json
{
  "drivers": [
    { "id": "kaicalls", "type": "kaicalls", "default": true,
      "credentials": { "apiKey": "kc_live_..." } },
    { "id": "dograh", "type": "dograh",
      "credentials": { "baseUrl": "http://localhost:8000", "apiKey": "..." } }
  ],
  "http": { "port": 8787, "publicUrl": "https://your-host.example.com" }
}
```

- `type` is one of `kaicalls`, `dograh`, `byok`, or `mock` (an in-memory
  no-credentials driver for local testing, from `@callmcp/driver-interface`).
- Exactly one driver may be `"default": true`. Omit it entirely and the
  first configured driver becomes default. A tool call with no `driver`
  field routes to whichever one is default.
- `credentials`/`options` are shallow-merged and passed straight through to
  the driver package's constructor — see each driver's own README for its
  expected shape (e.g. `KaiCallsDriverConfig`, `DograhDriverOptions`,
  `BYOKDriverConfig`).
- `http.publicUrl` matters even in stdio mode: it's what the out-of-band
  approval link (SPEC §3.4) points at when the connected client doesn't
  support MCP elicitation. If you're running stdio-only with no HTTP
  surface reachable at that URL, a human can't open the link — see the
  note in `src/index.ts`.

### Env vars (no config file — e.g. a single-tenant Docker container)

```bash
CALLMCP_DRIVER_TYPE=kaicalls
CALLMCP_DRIVER_CREDENTIALS='{"apiKey":"kc_live_..."}'
npx @callmcp/server
```

Or `CALLMCP_DRIVERS_JSON` (a JSON array, same shape as the config file's
`drivers` field) for more than one driver without a mounted file.

### No driver configured

The server still starts — `driverRegistry.ts` falls back to the mock driver
so `tools/list` always returns something, and a warning is logged to
stderr. This is deliberate: a misconfigured or not-yet-configured deployment
should be inspectable, not refuse to boot.

## Third-party drivers

A driver package doesn't need to be in this monorepo. Export a
`createDriver(entry: { id, credentials, options }) => Driver` factory (named
or default export) and reference it as `type` in your config — see
`driverRegistry.ts`'s factory-convention lookup. The three bundled drivers
predate this convention and are loaded via a known-class fallback instead;
new drivers should use the factory.
