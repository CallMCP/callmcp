/**
 * KaiCalls x402 self-provisioning helper.
 *
 * Implements the "No API key? Provision yourself" flow documented in
 * https://callmcp.ai/skill.md and https://callmcp.ai/llms.txt:
 *
 *   1. `POST https://www.kaicalls.com/api/v1/signup` with
 *      `{ business_name, email }` (both required; rate-limited 5 req/hour/IP).
 *   2. The live path returns **HTTP 402** with an x402 payment challenge —
 *      USDC on Base (`network: eip155:8453`), facilitated by Stripe Machine
 *      Payments, 5 USDC.
 *   3. Pay the challenge, retry the *same* request with `PAYMENT-SIGNATURE`
 *      and `X-Payment-Challenge` headers.
 *   4. The success response carries `api_key`, `business_id`, `agent_id`,
 *      and `phone_number` — account, key, live voice agent, and a real
 *      phone number, provisioned in one round trip.
 *
 *   A documented non-x402 fallback also exists in KaiCalls' code (not the
 *   live path today, per llms.txt: "x402 is enabled in production"): the
 *   same endpoint can instead return `provisioning_deferred: true` plus a
 *   Stripe Checkout `checkout_url` a human completes out of band.
 *
 * ---------------------------------------------------------------------
 * IMPORTANT — what this module does NOT do
 * ---------------------------------------------------------------------
 * This module PREPARES the signup request, PARSES the 402 challenge, and
 * COMPLETES the authenticated retry once it has been handed a payment
 * proof. It does **not** execute an x402 payment itself. Actually paying
 * an x402 challenge requires a funded wallet and a payment/signing
 * integration (e.g. a Base-compatible wallet with USDC balance, wired to
 * an x402 client library) — infrastructure this package intentionally does
 * not invent or bundle. Callers supply that capability via the
 * `paymentSigner` callback in {@link ProvisionOptions}; if it is omitted,
 * `provisionKaiCallsAccount` returns the parsed challenge (and/or the
 * Stripe Checkout fallback URL, if the backend offered one instead) so the
 * caller can hand it to their own wallet integration, or to a human.
 *
 * Neither llms.txt nor skill.md publishes the exact 402 response body
 * shape (that lives at https://callmcp.ai/connect, not fetched by this
 * module) — see the field-extraction comments below for exactly which
 * parts of this flow are confirmed vs. best-effort inference.
 */

import { KaiCallsApiError, type KaiCallsClient, type RestResponse, type X402Challenge } from "./client.js";

const SIGNUP_PATH = "/api/v1/signup";

export interface ProvisionRequest {
  business_name: string;
  email: string;
  [key: string]: unknown;
}

/** A successful provisioning result — the full round trip from skill.md step 4. */
export interface ProvisionSuccess {
  status: "provisioned";
  api_key: string;
  business_id: string;
  agent_id: string;
  phone_number: string;
  raw: unknown;
}

/** The documented non-x402 fallback: a human must complete Stripe Checkout. */
export interface ProvisionDeferred {
  status: "deferred_to_human";
  checkout_url: string;
  raw: unknown;
}

/**
 * An x402 payment challenge that this module cannot settle on its own —
 * either no `paymentSigner` was supplied, or the signer's proof was
 * rejected and no further retry was attempted (see
 * `ProvisionOptions.maxPaymentAttempts`).
 */
export interface ProvisionPaymentRequired {
  status: "payment_required";
  challenge: X402Challenge;
  /** best-effort token to echo back via `X-Payment-Challenge`; see {@link extractChallengeToken}. */
  challengeToken: string;
  raw: unknown;
}

export type ProvisionResult = ProvisionSuccess | ProvisionDeferred | ProvisionPaymentRequired;

/** What a `paymentSigner` callback receives to do its job. */
export interface X402ChallengeContext {
  challenge: X402Challenge;
  /** best-effort extracted echo-back token for the `X-Payment-Challenge` retry header. */
  challengeToken: string;
  /** the full, unparsed 402 response body. */
  raw: unknown;
}

/** What a `paymentSigner` callback must return once it has actually paid the challenge. */
export interface X402PaymentProof {
  /**
   * The value to send as the `PAYMENT-SIGNATURE` retry header — the actual
   * signed payment proof from the caller's wallet/payment integration.
   * This module has no opinion on its internal format; it passes it
   * through verbatim.
   */
  paymentSignature: string;
  /**
   * The value to send as the `X-Payment-Challenge` retry header. Defaults
   * to `X402ChallengeContext.challengeToken` if omitted — most callers
   * should not need to override this.
   */
  paymentChallenge?: string;
}

/**
 * Caller-supplied capability that actually settles an x402 payment. This
 * package deliberately does not provide a default implementation — see the
 * module-level doc comment above.
 */
export type X402PaymentSigner = (
  context: X402ChallengeContext,
) => Promise<X402PaymentProof> | X402PaymentProof;

export interface ProvisionOptions {
  /** Settles the x402 challenge, if provided. See {@link X402PaymentSigner}. */
  paymentSigner?: X402PaymentSigner;
  /**
   * How many times to retry after paying before giving up and returning
   * `payment_required` again (e.g. the signer's proof was rejected).
   * Default 1 — one payment attempt, one retry.
   */
  maxPaymentAttempts?: number;
}

/**
 * Runs the KaiCalls self-provisioning flow against `POST /api/v1/signup`.
 *
 * - No `paymentSigner` and the backend returns a 402 → resolves to
 *   `{ status: "payment_required", challenge, challengeToken, raw }` so the
 *   caller can settle it with their own wallet/payment integration and call
 *   {@link retryWithPayment} directly, or hand `challenge` to a human.
 * - `paymentSigner` provided → this module calls it with the parsed
 *   challenge, then retries the signup request with `PAYMENT-SIGNATURE` +
 *   `X-Payment-Challenge` headers per skill.md step 3.
 * - Backend instead returns the non-x402 `provisioning_deferred` fallback →
 *   resolves to `{ status: "deferred_to_human", checkout_url, raw }`
 *   regardless of whether a `paymentSigner` was supplied (there is nothing
 *   to pay via x402 in this path).
 * - Backend returns a success body → resolves to
 *   `{ status: "provisioned", api_key, business_id, agent_id, phone_number, raw }`.
 *
 * Throws {@link KaiCallsApiError} for any response shape this module cannot
 * make sense of (transport failure, or a 2xx/4xx body missing the fields
 * this flow depends on).
 */
export async function provisionKaiCallsAccount(
  client: KaiCallsClient,
  request: ProvisionRequest,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const first = await client.restPost(SIGNUP_PATH, request);
  return handleSignupResponse(client, request, first, options, 0);
}

/**
 * Completes a pending {@link ProvisionPaymentRequired} result once the
 * caller has settled the challenge out of band (e.g. via their own wallet
 * integration, independent of a `paymentSigner` callback). Exposed
 * separately from `provisionKaiCallsAccount` so a caller who obtained a
 * `ProvisionPaymentRequired` result — possibly in a completely different
 * process/session than where the payment was made — can complete the
 * retry without re-running the signup request from scratch.
 */
export async function retryWithPayment(
  client: KaiCallsClient,
  request: ProvisionRequest,
  proof: X402PaymentProof,
  challengeToken: string,
): Promise<ProvisionResult> {
  const response = await client.restPost(SIGNUP_PATH, request, {
    "PAYMENT-SIGNATURE": proof.paymentSignature,
    "X-Payment-Challenge": proof.paymentChallenge ?? challengeToken,
  });
  return handleSignupResponse(client, request, response, {}, 1);
}

async function handleSignupResponse(
  client: KaiCallsClient,
  request: ProvisionRequest,
  response: RestResponse,
  options: ProvisionOptions,
  attempt: number,
): Promise<ProvisionResult> {
  const body = isRecord(response.json) ? response.json : {};

  // Success shape (skill.md step 4): api_key + business_id + agent_id +
  // phone_number all present, confirmed field names.
  if (
    typeof body.api_key === "string" &&
    typeof body.business_id === "string" &&
    typeof body.agent_id === "string" &&
    typeof body.phone_number === "string"
  ) {
    return {
      status: "provisioned",
      api_key: body.api_key,
      business_id: body.business_id,
      agent_id: body.agent_id,
      phone_number: body.phone_number,
      raw: response.json,
    };
  }

  // Non-x402 fallback shape (llms.txt: "provisioning_deferred: true + a
  // Stripe Checkout checkout_url for a human"). Confirmed field names.
  if (body.provisioning_deferred === true && typeof body.checkout_url === "string") {
    return { status: "deferred_to_human", checkout_url: body.checkout_url, raw: response.json };
  }

  // x402 challenge shape (HTTP 402). Confirmed: status code, USDC-on-Base
  // payment, Stripe Machine Payments. NOT confirmed by llms.txt/skill.md:
  // the exact JSON field name(s) inside the body — see extractChallenge().
  if (response.status === 402) {
    const challenge = extractChallenge(body);
    const challengeToken = extractChallengeToken(body, response.headers);

    const signer = options.paymentSigner;
    const maxAttempts = options.maxPaymentAttempts ?? 1;
    if (signer && attempt < maxAttempts) {
      const proof = await signer({ challenge, challengeToken, raw: response.json });
      const retryResponse = await client.restPost(SIGNUP_PATH, request, {
        "PAYMENT-SIGNATURE": proof.paymentSignature,
        "X-Payment-Challenge": proof.paymentChallenge ?? challengeToken,
      });
      return handleSignupResponse(client, request, retryResponse, options, attempt + 1);
    }

    return { status: "payment_required", challenge, challengeToken, raw: response.json };
  }

  throw new KaiCallsApiError(
    `KaiCalls /api/v1/signup returned an unrecognized response (HTTP ${response.status}); expected a success body, a provisioning_deferred fallback, or an HTTP 402 x402 challenge.`,
    { httpStatus: response.status, toolErrorPayload: response.json },
  );
}

/**
 * Best-effort extraction of the x402 challenge payload from the 402 body.
 * If the body itself already looks like a challenge (`x402Version` and/or
 * `accepts` present, per the generic x402 protocol shape — see
 * `X402Challenge`'s doc comment in client.ts), it's used directly. If the
 * challenge is nested under a `challenge`/`payment`/`x402` key, unwrap it.
 * Otherwise the raw body is returned as-is: this module would rather hand
 * the caller (or their payment signer) the full unrecognized body than
 * silently drop data it doesn't understand the shape of.
 */
function extractChallenge(body: Record<string, unknown>): X402Challenge {
  if ("x402Version" in body || "accepts" in body) {
    return body as X402Challenge;
  }
  for (const key of ["challenge", "payment", "x402"]) {
    const nested = body[key];
    if (isRecord(nested)) {
      return nested as X402Challenge;
    }
  }
  return body as X402Challenge;
}

/**
 * Best-effort extraction of a token to echo back via the documented
 * `X-Payment-Challenge` retry header. llms.txt/skill.md confirm the header
 * name but not what value KaiCalls expects in it. In rough order of
 * confidence:
 *   1. A response header of the same name on the 402 itself (the server
 *      may issue its own challenge id and expect it echoed back).
 *   2. A `challenge`/`challenge_id`/`challenge_token` string field in the body.
 *   3. Falls back to the whole 402 body, JSON-stringified — mechanically
 *      correct (echoes back *something* that unambiguously identifies the
 *      challenge that was issued) without guessing a field name that may
 *      not exist. Callers integrating against the real endpoint should
 *      confirm the exact expectation at https://callmcp.ai/connect and,
 *      if it differs, pass an explicit `paymentChallenge` in the
 *      `X402PaymentProof` they return from their `paymentSigner` — that
 *      value always wins over this fallback.
 */
function extractChallengeToken(body: Record<string, unknown>, headers: Headers): string {
  const headerToken = headers.get("x-payment-challenge") ?? headers.get("X-Payment-Challenge");
  if (headerToken) {
    return headerToken;
  }
  for (const key of ["challenge_token", "challenge_id", "challenge"]) {
    const value = body[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return JSON.stringify(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
