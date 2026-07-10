# AI automation builder: install to activation

This is the canonical CallMCP journey for a builder who already has a custom
agent and needs a phone/SMS layer. It uses KaiCalls as the managed driver and
keeps the first run local until a human approves activation.

## 1. Install (about 30 seconds)

```bash
npx -y @callmcp/server doctor
```

Add this MCP server to the agent host:

```json
{
  "mcpServers": {
    "callmcp": {
      "command": "npx",
      "args": ["-y", "@callmcp/server"],
      "env": {
        "CALLMCP_DRIVER_TYPE": "kaicalls",
        "CALLMCP_DRIVER_CREDENTIALS": "{\"apiKey\":\"kc_live_REPLACE_ME\"}"
      }
    }
  }
}
```

Never put a real key in source control. KaiCalls' current developer surface
does not issue a `kc_test_` key; `kc_live_` reaches live infrastructure.

## 2. Configure and doctor (about 60 seconds)

```bash
npx -y @callmcp/server doctor --json
```

Expected result: the default driver is `kaicalls`, the credential check passes,
and `ready_for_activation` is true. `doctor` is read-only: it does not call a
provider, provision a number, send SMS, or place a call.

## 3. Prove the agent contract in the local sandbox (about 2 minutes)

```bash
npx -y @callmcp/server --sandbox
```

Connect the MCP client and run `list_drivers`, `request_call_approval`,
`make_call` with the approved id, `get_call_status`, and `get_transcript`.
This proves the tool names, approval gate, and typed call/transcript evidence
without network I/O or a phone call. The sandbox is explicit and in-memory;
it is not presented as a provider test environment.

## 4. Choose the managed KaiCalls path (about 2 minutes)

For a new account, use KaiCalls API-first signup at
`POST https://www.kaicalls.com/api/v1/signup`, or connect an existing account
through `https://www.kaicalls.com/api/mcp`. Keep `api_key`, `business_id`,
`agent_id`, and `phone_number` as deployment secrets/configuration, not prompt
text. Configure the agent through KaiCalls' managed API rather than patching
the underlying Vapi assistant directly.

## 5. Approval and activation readiness (about 3 minutes)

Before the first real call:

1. Run `callmcp doctor` again against the intended config.
2. Confirm `list_drivers` reports `kaicalls` and its honest capabilities.
3. Request approval for the exact destination or allowlist scope.
4. Have the deployment owner approve the request.
5. Only then invoke `make_call`; CallMCP's server-side approval gate is the
   consent boundary.

The target is under 10 minutes to “ready for the first approved real call.”
This example does not make that call.
