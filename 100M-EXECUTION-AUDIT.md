# CallMCP / KaiCalls: $100M Execution Audit

Status: review-ready strategy and risk document
Date: 2026-07-10
Audience: product, platform, telephony, security, growth, and strategy reviewers

## Review instruction

This document is deliberately written for adversarial review. A reviewing
agent must:

1. Separate observed facts, implementation claims, strategic hypotheses, and
   revenue assumptions.
2. Verify every “current” claim against the repository, live endpoints, and
   published package behavior.
3. Treat anything marked “to earn” as unproven.
4. Attack the strategy from the perspective of an AI agent builder, a
   platform buyer, a carrier/provider, a security reviewer, and a competitor.
5. Return corrections with file/line or live-source evidence rather than
   rewriting the strategy by preference.

Primary source documents:

- [`WHO-WE-ARE.md`](./WHO-WE-ARE.md)
- [`MARKETING.md`](./MARKETING.md)
- [`BUILD_STATUS.md`](./BUILD_STATUS.md)
- [`workspace/CALLMCP_DOMINANCE_PLAN.md`](./workspace/CALLMCP_DOMINANCE_PLAN.md)
- [`WHO-WE-ARE-ADVERSARIAL-REVIEW.md`](./WHO-WE-ARE-ADVERSARIAL-REVIEW.md)

## Executive position

The $100M position is not “AgentPhone, but open source.”

> The trusted communications operating system for AI agents: portable across
> providers, managed in production, and able to prove what every call or
> message accomplished.

This requires a strict product boundary:

- **CallMCP OSS:** open, provider-neutral 14-tool contract and distribution
  wedge.
- **KaiCalls driver:** the managed route inside that contract.
- **KaiCalls hosted API/MCP:** broader provider-specific execution and control
  surface; not automatically identical to the portable OSS contract.

CallMCP earns developer adoption and portability. KaiCalls earns revenue from
managed execution, state, policy, deliverability, evidence, integrations,
support, and enterprise controls.

This is a strategic thesis, not a current performance claim.

## Target customer

The primary customer is not a hobbyist seeking a phone number. It is the
builder responsible for shipping a real agent:

- AI automation consultants;
- custom agent builders;
- agency owners;
- vertical-AI and workflow-platform teams;
- technical founders deploying agents into client workflows;
- enterprise agent/platform teams at larger scale.

They build the domain brain: prompts, tools, workflows, knowledge, and
decisioning. They do not want to become a carrier, call-center operator,
compliance team, webhook reliability engineer, or deliverability specialist.

## Acquisition, activation, retention, monetization

| Stage | Current judgment | Evidence standard |
|---|---|---|
| Acquisition | Promising | Builders understand “give your agent phone capability.” |
| Activation | Weak and unproven | A cold builder completes one safe, inspectable task in under 10 minutes. |
| Retention | Hypothesis | Builders repeat production tasks without founder intervention. |
| Monetization | Plausible but fragile | OSS adoption converts to retained KaiCalls managed usage. |

The true activation moment is not installation or `tools/list`.

> An existing agent completes one approved, inspectable phone task and returns
> an honest terminal state plus fetchable evidence.

## Revenue logic

CallMCP remains open and is not a separate SaaS billing line.

KaiCalls monetizes:

- managed communication usage;
- numbers, routing, and provider operations;
- policy, approvals, consent/opt-out operations, and auditability;
- durable state and evidence;
- integrations and workflow control;
- support, intervention, and enterprise SLAs;
- high-volume platform and agency contracts.

Illustrative $100M ARR shapes, not forecasts:

- 2,000 customers at $50,000 ARR;
- 500 customers at $200,000 ARR;
- 50 platform customers at $1M ARR plus 500 agencies at $100,000 ARR;
- or a blended model of agencies, vertical software, and large agent platforms.

The $100M business therefore requires enterprise/platform value. It cannot be
built from OSS downloads, low-margin minutes, or small-business receptionist
plans alone.

## P0: launch blockers

### 1. Canonical truth and surface separation

Tasks:

- Freeze one versioned CallMCP contract.
- Label CallMCP OSS, the KaiCalls driver, and hosted KaiCalls API/MCP as
  different surfaces.
- Align tool counts, versions, capability flags, safety model, and examples.
- Remove unsupported claims from README, website, `llms.txt`, Registry, npm,
  Docker, Smithery, and skills.
- Refresh stale build/status documents before using them as proof.

Failure point: a buyer cannot tell whether they are adopting neutral OSS,
KaiCalls, or two incompatible products.

Exit gate: one compatibility matrix generated from the same contract source,
with live-versus-designed status visible for every capability.

### 2. Clean-install reliability

Tasks:

- Make real-driver loading work from a clean `npx` install.
- Keep MockDriver behind explicit sandbox/demo configuration only.
- Make broken real-driver configuration abort loudly.
- Align all examples with the actual `CALLMCP_DRIVER_TYPE` and JSON credential
  configuration path.
- Fix package runtime dependencies, Docker entrypoint/port, Smithery mapping,
  Registry environment variables, and release metadata.
- Pack and install-test the actual published artifact in an empty directory and
  container.

Failure point: a developer receives a convincing mock result or a confusing
configuration failure and never trusts the system again.

Exit gate: clean machine → install → `doctor` → explicit sandbox or real
provider readiness, with no accidental mock behavior.

### 3. KaiCalls adapter parity

Tasks:

- Snapshot live KaiCalls discovery schemas.
- Fix `make_call`, `send_sms`, `buy_number`, number attachment, transcript, and
  recording mappings against those schemas.
- Add runtime input/output validation.
- Add schema-drift detection in CI or nightly verification.
- Make the adapter return actual fetchable evidence URLs or a functioning
  resource abstraction.

Failure point: the flagship managed route accepts the wrong fields, loses
  transcripts, or reports success without usable evidence.

Exit gate: read-only, sandbox, and controlled real-provider contract tests pass.

### 4. One certified real route

Tasks:

- Secure a disposable test account and number.
- Test outbound call, inbound call, SMS, status, transcript, recording,
  webhook, approval, and number lifecycle.
- Cover human answer, voicemail, no-answer, busy, failure, retry, and opt-out.
- Record cost, latency, provider, number, attempt, terminal state, and evidence.

Failure point: the product is marketed as production-grade but has only mocks
and injected HTTP clients behind it.

Exit gate: at least one route has honest terminal states and fetchable evidence
across controlled scenarios.

### 5. Durable CallTask

Tasks:

- Add durable task ID and idempotency key.
- Support objective and success criteria.
- Support structured output schema.
- Add budget, deadline, max attempts, retry cadence, and cancellation.
- Track approval/policy state and attempt history.
- Distinguish `completed_verified`, `completed_unverified`, `not_connected`,
  `blocked_policy`, `failed_retryable`, and `failed_terminal`.
- Preserve `make_call` as a compatibility shortcut while CallTask becomes the
  system of record.

Failure point: the system proves only that an API request was accepted, not
that the business task completed.

Exit gate: a builder can leave the process, return later, and retrieve a
verified or honestly unresolved result.

### 6. Evidence and event integrity

Tasks:

- Define provider-independent typed webhook events.
- Add signatures, retries, replay protection, and delivery inspection.
- Persist transcript, recording, status, and evidence references.
- Add provider, carrier, number, latency, cost, and attempt metadata.
- Mark evidence ready only after it is actually fetchable.

Failure point: calls happen but the customer cannot prove what happened.

Exit gate: evidence-fetch success is measurable and reaches 100% whenever the
system marks evidence ready.

### 7. Security and tenant isolation

Tasks:

- Add authentication, scopes, tenant context, and authorization for every tool
  and resource.
- Default self-hosted HTTP to localhost until secured.
- Persist approvals, call ownership, events, and evidence securely.
- Add rate/body limits, Origin/Host controls, CSRF protection, secure approval
  tokens, retention policy, and audit logs.
- Add SSRF protection and separate provider/media authentication.
- Sign and verify provider webhooks.

Failure point: one leaked token, cross-tenant record, forged webhook, or
unsafe approval link destroys the trust category.

Exit gate: independent security review passes before remote self-hosting is
promoted as safe.

## P1: moat-building tasks

### 8. Deliverability plane

Measure and eventually route on:

- carrier acceptance, ring, answer, voicemail, busy, reject, and short-call
  rates;
- spam labels, number age, reputation, and quarantine;
- STIR/SHAKEN, CNAM, branded calling, and A2P readiness;
- destination carrier, geography, time, language, and use-case performance;
- provider outage and degradation signals;
- cost per answered call and cost per verified outcome.

Failure point: a technically correct agent has poor answer rates or gets
marked as spam, making the whole platform look broken.

### 9. Outcome routing

Build the data loop:

```text
provider + number + geography + time + use case
→ answer probability + completion probability + evidence quality
```

Route on verified business outcome, not merely lowest per-minute cost.

Failure point: provider neutrality exists in code but not in useful operational
performance.

### 10. Trust/policy control plane

Build durable support for:

- consent provenance and revocation;
- DNC and opt-out enforcement;
- local quiet hours;
- AI disclosure policy;
- recording consent policy;
- identity and caller-purpose presentation;
- campaign/contact/frequency ceilings;
- spend limits and approval thresholds;
- human approval for high-impact actions;
- immutable policy version and decision evidence;
- exportable communication receipts.

Important boundary: an application approval record is not a blanket legal,
TCPA, identity, caller-ID, retention, or jurisdictional guarantee.

Failure point: marketing language creates legal exposure or the system cannot
prove why a contact was made.

### 11. Certification and benchmark program

Tasks:

- Certify providers against live contract, terminal state, evidence, webhook,
  retry, and failure tests.
- Publish compatibility badges with dates and scope.
- Publish route-level answer, completion, evidence, and cost benchmarks.
- Convert production failures into regression cases.
- Build vertical Call Packs for appointment changes, reservations, supplier
  quotes, insurance verification, cancellations, support escalation, and legal
  intake.

Failure point: “certified” or “verified” becomes another unmeasured marketing
word.

## P2: distribution and revenue tests

### 12. Ten-minute cold-start test

Recruit 10–15 real agent builders. Give them only public docs and examples.
Measure:

- install success;
- time to doctor;
- time to sandbox task;
- time to first approved real task or honest blocker;
- number of human interventions;
- exact error categories.

Success bar: at least 70% reach a meaningful activation in ten minutes without
help.

### 13. OSS-to-KaiCalls experiment

Compare:

- OSS-first → managed route;
- managed-first → OSS portability explanation.

Measure first-task completion, setup time, intent to deploy, retention, and
KaiCalls conversion.

Failure point: OSS attracts curiosity but not paid managed usage, or the
managed surface feels like a separate proprietary product.

### 14. Four-week retention test

Place 5–10 builders on one recurring live workflow for four weeks. Measure:

- repeated tasks;
- evidence retrieval;
- failure recovery;
- provider switching;
- support requests;
- founder intervention;
- paid expansion.

Failure point: builders like the demo but return to their existing provider or
DIY stack for production.

### 15. Shareable proof receipt

Create a privacy-safe artifact showing:

- task outcome class;
- evidence availability;
- approval/policy checks;
- route health;
- latency;
- provider-neutral contract result.

Measure receipt shares, referred installs, reproduced tasks, and retained
builders. Until this produces referrals, call virality a hypothesis.

## Principal failure modes

| Failure | Consequence | Preventive control |
|---|---|---|
| Silent MockDriver | False confidence and destroyed trust | Explicit sandbox only; fail closed |
| Config drift | Builder abandonment | One generated config source and packed-artifact tests |
| Live schema drift | Failed calls and lost evidence | Snapshots, runtime validation, drift CI |
| Duplicate retries | Real-world harm and cost | Idempotency, attempt ledger, reconciliation |
| Missing evidence | No outcome moat | Persistent evidence model and fetch checks |
| Unreachable approval | Unsafe or blocked calls | Health-checked approval provider |
| Approval overclaim | Legal/reputational exposure | Describe authorization evidence, not compliance guarantee |
| Carrier spam | Low answer and completion rates | Deliverability data and routing |
| Provider lock-in accusation | Weak OSS adoption | Clear surface separation and certified drivers |
| OSS without conversion | No $100M business | Measure managed activation and retention |
| Tool-count competition | Commodity positioning | Own task, trust, evidence, and outcome data |
| Too many providers too early | Slow execution and shallow proof | Certify one route before broad expansion |
| Founder-dependent setup | Cannot scale distribution | Cold-start test and exact remediation paths |
| Security incident | Category-ending trust loss | Tenant isolation, signed events, external review |

## Correct order of execution

### Days 0–7: truth sprint

Fix clean install, configuration, dependencies, Docker, Smithery, Registry,
versions, schema parity, claims, CI, and packed-artifact tests.

Exit: a new machine reaches a real provider readiness result without MockDriver.

### Days 8–21: real-call release gate

Secure and persist runtime state. Add ownership, idempotency, webhooks,
reconciliation, evidence, and controlled real tests.

Exit: one route produces honest terminal states and fetchable evidence across
100 controlled scenarios.

### Days 22–35: CallTask beta

Ship durable tasks, structured outcomes, budgets, retries, cancellation,
events, webhooks, and evidence.

Exit: a builder can return later and retrieve the result without holding an
MCP request open.

### Days 36–60: deliverability and provider beta

Add a second certified provider, provider/number health, policy controls,
human takeover, voicemail/IVR handling, and three design-partner Call Packs.

Exit: routing shows measurable verified-outcome improvement over a fixed route.

### Days 61–90: category launch

Ship installation paths for major agent hosts, publish benchmarks and case
studies, and launch only after the live proof gates pass.

Exit: 1,000 weekly activated developers with measurable week-four retention.

## Review questions

A stronger agent should answer these before approving the plan:

1. Which claims in this document are not currently proven by source evidence?
2. Is the OSS-first-to-KaiCalls conversion model supported by observed behavior,
   or only assumed?
3. Does a builder prefer a portable contract, or simply the fastest reliable
   hosted path?
4. What exact evidence would make a platform buyer trust CallMCP over DIY,
   AgentPhone, Twilio/Telnyx, or Vapi?
5. What is the minimum CallTask that creates durable retention without
   overbuilding?
6. Which data assets are truly proprietary and defensible after three years?
7. What gross margin and support model can support the proposed ARR shapes?
8. Which compliance claims must be removed or reviewed by counsel?
9. What is the kill criterion if the ten-minute activation test fails?
10. What is the narrowest vertical Call Pack that can produce a paid reference
    customer fastest?

## Final decision rule

Do not declare category leadership, viral growth, production readiness, or
verified outcomes until the corresponding live metric and evidence artifact
exists.

The first non-negotiable proof is:

> A cold builder can complete one approved, inspectable real communication task
> in under ten minutes, and the system can explain every success or failure.
