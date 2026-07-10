# @callmcp/driver-dograh

CallMCP driver for [Dograh](https://github.com/dograh-hq/dograh) — a
self-hostable, BYO-carrier voice-AI platform. This is the driver you want
when the goal is **zero cloud telephony accounts**: run Dograh on your own
machine (or your own server), point this driver at it, and place an
approved call without ever creating a Twilio, Vapi, or Retell account.

This package wraps Dograh's own REST API directly. It does **not** wrap or
re-export Dograh's own MCP server (`docs.dograh.com/integrations/mcp`) —
Dograh ships that itself, and treating it as a dependency here would put
this driver at the mercy of a direct competitor's roadmap. See
`workspace/research/r4-local-stacks.md` §10 in the CallMCP research corpus
for the full reasoning.

The normative reference for the tool contract this driver implements is
[`SPEC.md`](../../SPEC.md) at the repo root. If this README and `SPEC.md`
ever disagree about a universal field's meaning, `SPEC.md` wins.

## What this driver can and can't do

Dograh's real capability, honestly stated (SPEC §7 "degradation appendix"
philosophy — no smoothing over gaps):

| Tool | Supported? | Why |
|---|---|---|
| `make_call` | Yes | `POST /telephony/initiate-call`, scoped to a `workflow_id` |
| `get_call_status` | Yes | Polls `GET /{workflow_id}/runs/{run_id}` |
| `get_transcript` | Yes (baseline, **not realtime**) | Same poll endpoint returns `transcript_url`; this driver fetches it |
| `get_recording` | Yes | Read from the run's `artifacts[]` (matched by `artifact_type`) |
| `configure_number` | Yes | `PUT /api/v1/workflow/{workflow_id}` — **attaches** a number you already own |
| `list_numbers` | Yes | Derived from each known workflow's telephony config |
| `list_calls` | Yes | Aggregated from `GET /{workflow_id}/runs` across known workflows |
| `end_call` | **No** | Dograh has no external hangup endpoint at all |
| `send_sms` | **No** | Dograh has no SMS capability at all |
| `search_numbers` | **No** | Dograh is strictly BYO-carrier — no number marketplace to search |
| `buy_number` | **No** | No purchase endpoint exists anywhere in Dograh's API |

`end_call`/`buy_number`/`search_numbers`/`send_sms` are real, permanent gaps
in Dograh itself — not "not implemented yet" on this driver's side. They're
implemented here as methods that throw `UNSUPPORTED_CAPABILITY` (SPEC §5.1)
rather than left `undefined`, so a stale `tools/list` cache still fails
loudly and correctly; the manifest (`supports_*: false`) is what keeps them
out of `tools/list` in the first place. Full detail, with upstream tracking
links, lives in `callmcp.manifest.json`'s `known_degradations` and in the
doc comments at the top of `src/client.ts` and `src/driver.ts`.

**A note on what's verified vs. inferred.** `POST /telephony/initiate-call`
and `GET /{workflow_id}/runs/{run_id}` (returning `transcript_url`) were
confirmed by reading dograh-hq/dograh's actual route source. The
number-attachment surface (`PUT /api/v1/workflow/{workflow_id}` and its
GET/collection counterparts) is a reasonable, but **not independently
source-verified**, REST convention this driver assumes. If your Dograh
instance's real routes differ, check `{DOGRAH_BASE_URL}/docs` (FastAPI's
auto-generated OpenAPI UI) and adjust `src/client.ts` — see the provenance
comment at the top of that file for exactly which routes fall into which
bucket.

## Configuration

| Env var | Required | Meaning |
|---|---|---|
| `DOGRAH_BASE_URL` | Yes | Base URL of your Dograh instance, e.g. `http://localhost:8081` |
| `DOGRAH_API_KEY` | No | Bearer token, if your instance requires auth. Dograh's default docker-compose quickstart runs with no auth. |
| `DOGRAH_DEFAULT_WORKFLOW_ID` | Recommended | `workflow_id` used when a call doesn't specify one explicitly (see below) |
| `DOGRAH_WORKFLOW_IDS` | Optional | Comma-separated `workflow_id` list this driver aggregates across for `list_numbers`/`list_calls`. Falls back to `[DOGRAH_DEFAULT_WORKFLOW_ID]`, then to Dograh's workflow-listing endpoint, if unset. |

Every CallMCP call is scoped to a Dograh **workflow** — there's no
backend-agnostic "just call this number" primitive in Dograh, calls are
always "run this workflow against this number." This driver resolves the
workflow to use, in priority order:

1. `agent_config_ref` on the tool call (`make_call`'s/`configure_number`'s
   opaque agent-config reference — this *is* the Dograh `workflow_id`)
2. `options.dograh.workflow_id` (driver-specific passthrough, SPEC §1.0)
3. `DOGRAH_DEFAULT_WORKFLOW_ID`

If none of those resolve, `make_call`/`configure_number` fail with a
`DRIVER_ERROR` explaining exactly what's missing — this driver never
silently guesses a workflow.

## Local quickstart: zero cloud telephony accounts

Two paths, depending on how air-gapped you want to go.

### Path A — Twilio-under-Dograh (fastest to a real call)

You still need *a* carrier account to actually dial the PSTN — Dograh
doesn't eliminate the need for SIP trunking, it eliminates the need for a
**voice-AI platform account** (no Vapi, no Retell, no per-minute platform
markup). This path uses Twilio purely as the SIP/PSTN leg underneath a
Dograh instance that runs entirely on your own machine.

```bash
# 1. Bring up Dograh locally
curl -o docker-compose.yaml https://raw.githubusercontent.com/dograh-hq/dograh/main/docker-compose.yaml
./start_docker.sh
# Dograh is now on http://localhost:3010 (UI) / http://localhost:8081 (API) by default —
# confirm the actual API port against your compose file/instance.

# 2. In the Dograh UI: create a workflow, wire in your Twilio account SID/
#    auth token as the telephony provider, and note the workflow's ID.

# 3. Point this driver at your local instance
export DOGRAH_BASE_URL="http://localhost:8081"
export DOGRAH_DEFAULT_WORKFLOW_ID="wf_your_workflow_id"
# export DOGRAH_API_KEY="..."   # only if your instance requires it
```

```json
{
  "mcpServers": {
    "callmcp": {
      "command": "npx",
      "args": ["-y", "@callmcp/server"],
      "env": {
        "CALLMCP_DEFAULT_DRIVER": "dograh",
        "DOGRAH_BASE_URL": "http://localhost:8081",
        "DOGRAH_DEFAULT_WORKFLOW_ID": "wf_your_workflow_id"
      }
    }
  }
}
```

With that config, `make_call({ to: "+1..." })` places a real outbound call:
Dograh's workflow logic + LLM run entirely on your machine, and only the
SIP/PSTN leg touches Twilio's infrastructure. No calls, recordings, or
transcripts ever leave your boundary except the raw audio Twilio has to
carry to reach the PSTN.

### Path B — Asterisk/ARI, fully air-gapped (zero commercial telephony vendor)

Dograh's Asterisk ARI integration (`/telephony/ws/ari`) is a direct path to
self-hosted SIP/PSTN with **no commercial telephony vendor at all** — the
genuinely air-gapped option, useful for testing against a local SIP
trunk/PBX or a VoIP gateway you already control, with "no calls, recordings,
transcripts, or model inference ever leave your boundary" (Dograh's own
framing).

```bash
# 1. Stand up a local Asterisk instance with ARI enabled (outside the scope
#    of this README — see asterisk.org's ARI documentation). At minimum you
#    need ARI credentials and a SIP trunk/extension Asterisk can dial out
#    through, e.g. a local VoIP gateway or a SIP trunk provider that doesn't
#    require a "voice-AI platform" account (this is a pure SIP trunk, not a
#    Vapi/Retell-style integration).

# 2. Bring up Dograh locally (same as Path A, step 1)
curl -o docker-compose.yaml https://raw.githubusercontent.com/dograh-hq/dograh/main/docker-compose.yaml
./start_docker.sh

# 3. In the Dograh UI: create a workflow, select Asterisk/ARI as the
#    telephony provider, and point it at your local Asterisk instance's ARI
#    endpoint + credentials. Note the workflow's ID.

# 4. Point this driver at your local instance, same as Path A
export DOGRAH_BASE_URL="http://localhost:8081"
export DOGRAH_DEFAULT_WORKFLOW_ID="wf_your_ari_workflow_id"
```

Same `claude-desktop` config as Path A — the driver doesn't know or care
whether the workflow underneath is Twilio- or Asterisk-backed, that's
entirely a Dograh-side configuration choice. This is the path to prove out
"local voice-AI driver, approved call, zero cloud telephony accounts" in
the strictest sense: if your Asterisk box's trunk is itself a local
softphone-to-softphone loop or an on-prem PBX, nothing in this call ever
leaves hardware you control.

See [`examples/claude-desktop-local-dograh.json`](../../examples/claude-desktop-local-dograh.json)
at the repo root for a ready-to-copy MCP client config.

## Using it programmatically

```ts
import { DograhDriver } from "@callmcp/driver-dograh";

const driver = new DograhDriver(); // reads DOGRAH_BASE_URL / DOGRAH_API_KEY / DOGRAH_DEFAULT_WORKFLOW_ID from env

const call = await driver.makeCall({
  to: "+14155551234",
  agent_config_ref: "wf_your_workflow_id", // overrides DOGRAH_DEFAULT_WORKFLOW_ID for this call
  approval_id: "a_...", // supplied by the server core's approval gate, SPEC §3
});

const status = await driver.getCallStatus({ call_id: call.call_id });
const transcript = await driver.getTranscript({ call_id: call.call_id });
```

`call_id` here is a driver-internal composite (`"<workflow_id>::<run_id>"`)
— treat it as opaque. Dograh scopes a run's lifecycle to its parent
workflow (`GET /{workflow_id}/runs/{run_id}`), and CallMCP's `call_id` is a
single opaque string, so this driver encodes both into one value rather
than requiring a server-side call registry.

## Development

```bash
pnpm install
pnpm --filter @callmcp/driver-dograh run typecheck
pnpm --filter @callmcp/driver-dograh run build
pnpm --filter @callmcp/driver-dograh run test
```

`test/driver.test.ts` mocks HTTP entirely (no live Dograh instance
required) and also runs `@callmcp/driver-interface`'s `runConformanceSuite`
against this driver + its manifest, so a manifest/implementation drift
(claiming a capability the code doesn't back, or vice versa) fails CI
rather than surfacing as a runtime surprise for a client.
