# Developer-moat gap report

Date: 2026-07-10

## Canonical journey

Install → configure KaiCalls managed driver → `callmcp doctor` → local sandbox
contract proof → approval → first real-call activation.

## Sprint result

The journey is now explicit and safer:

- `callmcp doctor` is read-only, redacts credentials, and reports activation
  readiness without provider calls.
- `--sandbox` is an explicit local-only mode. It exercises the existing typed
  call, approval, status, and transcript contract without a phone or provider.
- Missing or broken provider configuration fails closed. There is no accidental
  `MockDriver` fallback.
- The managed KaiCalls route is documented as `POST /api/v1/signup` for new
  accounts and `/api/mcp` for existing accounts.
- The AI automation-builder example states the live-key boundary and gives a
  repeatable first deployment path.

## Evidence from the current surfaces

KaiCalls' live API docs say `kc_live_` keys hit live infrastructure and that a
separate `kc_test_` sandbox is not yet available. The same docs expose API
signup, MCP connector usage, typed API discovery, outbound calls, transcripts,
and completion webhooks. CallMCP already has typed call/transcript result
contracts and a server-side approval state machine.

## Remaining gaps (not expanded in this sprint)

1. CallMCP does not yet expose a provider-independent, typed webhook-event
   evidence tool/resource. KaiCalls supports `webhook_url` on calls and durable
   events in its API, but CallMCP's 14-tool contract stops at polling status and
   transcript. This should be the next high-leverage contract addition, with
   signature verification and replay-safe event ids.
2. `doctor` currently validates local configuration, not authenticated provider
   health. Add an opt-in, read-only `--verify-provider` later; keep it separate
   from default doctor so “doctor” never surprises a developer with external
   traffic.
3. The first real-call activation remains intentionally human-controlled. No
   automated provisioning, billing, number purchase, or real call was performed
   in this sprint.

## Journey measurement

Target timing for a prepared builder:

| Milestone | Target |
|---|---:|
| Install command returns | < 30 sec |
| Configure managed driver | < 2 min |
| First doctor result | < 3 min total |
| First sandbox tool call | < 5 min total |
| Approval/activation readiness | < 10 min total |

These are workflow targets measured from command-level execution and the
existing docs, not a claim that a live provider account was activated.

## Non-goals honored

No new telephony tools, CRM, billing system, alternate voice platform, real
call, production mutation, or OSS ideology work was added.
