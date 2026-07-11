# Who We Are

Status: positioning source of truth
Date: 2026-07-10

## The short version

CallMCP is an open developer interface for agent communications.

KaiCalls is the managed production communications layer behind it.

KaiCalls is the managed route for builders who want someone else to operate
the communications stack. Together, the products give custom AI agents a path
to call, text, receive messages, and return inspectable communication results.

The strongest credible position today is:

> CallMCP is an open, provider-neutral interface for phone actions. KaiCalls
> is the managed route for builders who want someone else to operate the
> communications stack.

“Trusted verified-outcome layer” is the standard we are building toward, not a
claim we make without route-level production evidence.

## The problem we exist to solve

An agent can browse, reason, call APIs, and update a database. The hard part
starts when it must communicate with a real person.

The builder then inherits phone numbers, carrier behavior, SMS, voice,
transcripts, webhooks, approvals, opt-outs, retries, state, escalation,
deliverability, evidence, and support. A simple “give my agent a phone” demo
can become an entire communications company hidden inside the customer’s
product.

We remove that accidental infrastructure burden.

## Who we serve

Our primary customer is the agent builder:

- AI automation consultants
- custom agent builders
- agency owners
- vertical-AI and workflow-platform teams
- technical founders shipping agents into client workflows

They already build the business brain: prompts, tools, workflows, domain
knowledge, and decisions. They need a production-grade communications layer
without becoming a carrier, call-center operator, compliance team, or webhook
reliability engineer.

## What CallMCP is

CallMCP is an open contract and server for agent communications. Its promise
is portability across certified CallMCP drivers; “any provider” is an ecosystem
goal, not a claim that every provider is live-certified today.

It gives builders:

- one stable 14-tool contract across eligible drivers;
- hosted, local, and BYOK driver paths;
- capability honesty instead of present-but-broken tools;
- structural approval semantics for outbound contact;
- normalized call, message, transcript, and status results;
- a conformance path for new drivers;
- a safe way to experiment before choosing a managed provider.

CallMCP is not a second commercial control plane. It is the distribution,
adoption, and portability layer.

The CallMCP OSS contract and the KaiCalls hosted API/MCP are separate
surfaces. KaiCalls may expose a broader, provider-specific control surface;
CallMCP does not claim those additional operations are part of the portable
14-tool contract.

## What KaiCalls is

KaiCalls is the managed provider and intended production operating layer for
builders who do not want to operate communications infrastructure themselves.
Its superiority claims must be earned through published route-level evidence,
not assumed from the architecture.

KaiCalls earns the right to own:

- durable communication state;
- phone and SMS operations;
- policy, consent, and opt-out enforcement;
- deliverability and provider/number health;
- communication receipts and evidence;
- human escalation and intervention;
- integrations, support, and operational learning.

CallMCP remains genuinely useful with other drivers. KaiCalls wins when the
builder values the lowest operational burden and the highest verified-outcome
reliability.

## The promise to builders

> You keep building the custom business brain. KaiCalls gives it
> production-grade communication infrastructure.

The first activation should feel like:

> Give my agent a phone, prove the contract locally, then make the managed
> path safe to deploy by completing one approved, inspectable phone task.

The deeper promise is not “a call was initiated.” It is:

> Your agent can attempt a communication task and return an honest,
> inspectable result. Verified completion is the standard we are building
> toward on certified routes.

## Why we are different

The acquisition hook is simple: give an agent a phone.

The durable differentiation is that we treat communication as a production
system rather than a single API call:

- approval before consequential outbound contact;
- explicit sandbox and fail-closed configuration;
- typed lifecycle and transcript evidence;
- verifiable webhook events and replay-safe delivery;
- honest provider capability discovery;
- portability when a provider is unavailable or no longer fits;
- managed deliverability, escalation, and support through KaiCalls.

CallMCP approval proves that an authorized application actor approved an
action. It is an auditable approval primitive, not a blanket legal-consent,
TCPA, identity, caller-ID, retention, or jurisdictional guarantee.

Portability is not the first thing we ask a builder to care about. It is the
reason they can adopt us without fearing a future rewrite.

## Two messages, kept separate

### Builder message

You build the custom business brain. We provide the communications layer that
makes it deployable: phone, SMS, approvals, state, evidence, escalation, and
support.

### Business-owner message

Kai answers missed calls, qualifies callers, books work, follows up, and keeps
the owner informed.

The builder message sells infrastructure and relief. The business-owner
message sells outcomes and coverage. They should not be collapsed into one
generic receptionist pitch.

## What we are not

- We are not another CRM.
- We are not a billing product.
- We are not trying to replace every voice platform.
- We are not only a raw carrier API.
- We are not an OSS ideology project where portability matters more than a
  working deployment.
- We are not promising production readiness from mocks or marketing claims.

## Product principles

1. Start with the shortest credible path to a working agent phone experience.
2. Make the managed KaiCalls path obvious without hiding the open contract.
3. Make unsafe or unconfigured states fail closed.
4. Treat evidence, consent, delivery, and terminal outcomes as first-class.
5. Never claim a provider capability that cannot be demonstrated.
6. Keep the business application’s domain meaning and decisioning outside the
   communications layer.
7. Optimize for a serious builder trusting us with a client deployment.

## How we grow

CallMCP grows through developer distribution:

- GitHub and the open specification;
- npm/PyPI and copy-paste examples;
- MCP Registry and major MCP clients;
- Claude, Codex, Cursor, OpenClaw, n8n, Make, and Zapier workflows;
- adjacent automation consultants and vertical-software partners;
- public examples that show a working agent, not an abstract tool catalog.

The intended growth loop is:

```text
builder discovers CallMCP
  -> runs a safe local example
  -> gives an existing agent a phone
  -> chooses a managed or BYOK path
  -> ships a real communication task
  -> produces a privacy-safe, shareable proof receipt
  -> another builder reproduces the integration
```

Virality is a hypothesis until those receipts produce referred installs and
retained builders. Open source is the distribution surface; certified driver
behavior, cross-provider delivery data, evidence-fetch success, and
failure-to-regression learning are the potential durable moats.

## What success means

Our north-star outcome is weekly verified communication tasks originated by
retained builders through CallMCP.

We measure:

- install-to-first-tool-call time;
- install-to-ready-in-10-minutes rate;
- first managed task completion;
- fetchable evidence rate;
- terminal-state convergence;
- approval and opt-out enforcement;
- provider/number health and deliverability;
- retained unique builders;
- KaiCalls conversion and paid retention sourced by CallMCP.

Before making production or superiority claims, publish route-level proof for
terminal-state convergence, evidence-fetch success, duplicate-call rate,
delivery/answer outcomes, opt-out enforcement, and human-intervention results.

## Current adoption truth

The acquisition hook is strong, but the developer growth loop is not proven.
The current choke point is activation: configuration examples, provider
reachability, number readiness, webhook/media readiness, and the meaning of
“ready” must become boringly reliable before we call this a viral loop.

The first validation gates are:

1. 10–15 cold-start builders; at least 70% reach a meaningful activation in ten
   minutes without human help.
2. Compare OSS-first and managed-first onboarding on first-task completion and
   KaiCalls conversion.
3. Run 5–10 builders through one recurring live use case for four weeks and
   measure repeat tasks, evidence retrieval, recovery, and founder intervention.

Until those tests pass, we describe growth as a hypothesis, not an outcome.

We do not use tool count, GitHub stars, or raw call volume as the primary
definition of product success.

## The sentence we should be able to prove

> CallMCP gives any serious agent builder an open path to phone capability;
> KaiCalls gives them the managed communications infrastructure to deploy it
> for a real client.
