/**
 * CallMCP server — approval state machine (SPEC §3).
 *
 * Implements `request_call_approval` / `list_approvals` (SPEC §1.2/§1.3) and
 * the grant-resolution logic `make_call`/`send_sms` (SPEC §1.4/§1.9) use to
 * decide whether a destination may be contacted. This module is
 * transport-agnostic: it does not import the MCP SDK. `tools.ts` supplies an
 * `elicit` callback (backed by `Server.elicitInput`) when the connected
 * client + active driver both support elicitation; when they don't, this
 * module falls back to an out-of-band URL (SPEC §3.4) and never blocks
 * indefinitely and never silently opens the gate (the two failure modes
 * SPEC §3.4 forbids equally).
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalChannel,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalRequestResult,
  ApprovalScope,
  ApprovalState,
  Cursor,
  ListApprovalsParams,
  ListApprovalsResult,
} from "@callmcp/driver-interface";

/** SPEC §3.2 scope tier defaults. `null` means "no expiry unless ttl_seconds is set". */
const TIER_DEFAULT_TTL_SECONDS: Record<ApprovalScope, number | null> = {
  single_call: 15 * 60,
  allowlist_add: null,
  campaign_batch: 7 * 24 * 60 * 60,
};

/** Sentinel "does not expire" timestamp for approvals with `ttl_seconds: null` (SPEC §3.2, `allowlist_add`). */
const FAR_FUTURE_ISO = "2999-01-01T00:00:00.000Z";

const PAGE_SIZE = 50;

export class ApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalValidationError";
  }
}

interface StoredApproval {
  approval_id: string;
  scope: ApprovalScope;
  state: ApprovalState;
  destinations: string[];
  channel: ApprovalChannel;
  /** `| undefined` (not just `?:`) so it can be assigned directly from `ApprovalRequest.purpose` under exactOptionalPropertyTypes. */
  purpose?: string | undefined;
  created_at: string;
  decided_at: string | null;
  expires_at: string;
  /** null means "does not expire" (only reachable for `allowlist_add` without an explicit ttl_seconds). */
  ttl_seconds: number | null;
  driver: string;
  elicitation_used: boolean;
  out_of_band_url: string | null;
  /** campaign_batch only */
  remaining_uses: number | null;
  /** single_call only — one-shot consumption flag (SPEC §3.2) */
  consumed: boolean;
}

export type ElicitDecision = "approved" | "denied" | "expired";

export interface RequestApprovalContext {
  /** the driver_id this approval is scoped to (the resolved default when the request omitted `driver`) */
  driver: string;
  /** true iff both the connected client and the active driver declare elicitation support */
  elicitationAvailable: boolean;
  /** performs the actual `elicitation/create` round trip; required when `elicitationAvailable` is true */
  elicit?: ((message: string) => Promise<ElicitDecision>) | undefined;
  /** base URL this server's built-in approval page is reachable at, e.g. "http://localhost:8787/approve" */
  outOfBandBaseUrl: string;
}

export type GrantResolution =
  | { ok: true; approval_id: string }
  | { ok: false; reason: "not_found" | "denied" | "expired" | "no_match"; approvalRecord?: ApprovalRecord };

export interface ResolveGrantInput {
  /** explicit approval_id from the tool call, if the caller supplied one */
  approval_id?: string | undefined;
  to: string;
  channel: ApprovalChannel;
}

/**
 * Converts a SPEC §1.2 destination pattern (E.164 number, or a wildcard
 * pattern using `.` as a single-character wildcard, e.g. `+1415555....`)
 * into a matcher against a concrete destination.
 */
function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }
  // Escape every regex metacharacter except '.', which SPEC §1.2 defines as
  // the single-character wildcard — conveniently already regex's "any char".
  const escaped = pattern.replace(/[-/\\^$*+?()[\]{}|]/g, "\\$&");
  return new RegExp(`^${escaped}$`).test(value);
}

function buildElicitationMessage(params: ApprovalRequest): string {
  const dest = params.destinations.length === 1 ? params.destinations[0] : `${params.destinations.length} destinations`;
  const scopeLabel =
    params.scope === "single_call"
      ? "a single call/message"
      : params.scope === "allowlist_add"
        ? "a standing allowlist entry"
        : `a campaign of up to ${params.campaign_max_contacts ?? "?"} contacts`;
  const purpose = params.purpose ? ` Purpose: ${params.purpose}.` : "";
  return `An agent is requesting approval for ${scopeLabel} over ${params.channel ?? "voice"} to ${dest}.${purpose}`;
}

/** In-memory approval store keyed by `approval_id`. One instance is shared server-wide (SPEC §3 is cross-driver state). */
export class ApprovalStore {
  private readonly approvals = new Map<string, StoredApproval>();

  /** Lazily transitions a `pending` approval to `expired` once its TTL has elapsed. */
  private effectiveState(rec: StoredApproval): ApprovalState {
    if (rec.state === "pending" && rec.ttl_seconds !== null) {
      if (Date.now() > Date.parse(rec.expires_at)) {
        rec.state = "expired";
        rec.decided_at = rec.decided_at ?? new Date().toISOString();
      }
    }
    return rec.state;
  }

  private toResult(rec: StoredApproval): ApprovalRequestResult {
    return {
      approval_id: rec.approval_id,
      state: this.effectiveState(rec),
      scope: rec.scope,
      elicitation_used: rec.elicitation_used,
      out_of_band_url: rec.out_of_band_url,
      expires_at: rec.expires_at,
      driver: rec.driver,
    };
  }

  private toRecord(rec: StoredApproval): ApprovalRecord {
    return {
      approval_id: rec.approval_id,
      scope: rec.scope,
      state: this.effectiveState(rec),
      destinations: rec.destinations,
      channel: rec.channel,
      created_at: rec.created_at,
      decided_at: rec.decided_at,
      expires_at: rec.expires_at,
      remaining_uses: rec.remaining_uses,
      driver: rec.driver,
    };
  }

  /** SPEC §1.2 — `request_call_approval`. */
  async requestCallApproval(params: ApprovalRequest, ctx: RequestApprovalContext): Promise<ApprovalRequestResult> {
    if (params.scope === "campaign_batch" && (!params.campaign_max_contacts || params.campaign_max_contacts < 1)) {
      throw new ApprovalValidationError("campaign_max_contacts (>= 1) is required when scope=campaign_batch");
    }

    const approval_id = `appr_${randomUUID()}`;
    const channel = params.channel ?? "voice";
    const tierDefault = TIER_DEFAULT_TTL_SECONDS[params.scope];
    const ttl_seconds = params.ttl_seconds ?? tierDefault;
    const created_at = new Date().toISOString();
    const expires_at = ttl_seconds === null ? FAR_FUTURE_ISO : new Date(Date.now() + ttl_seconds * 1000).toISOString();

    const record: StoredApproval = {
      approval_id,
      scope: params.scope,
      state: "pending",
      destinations: params.destinations,
      channel,
      purpose: params.purpose,
      created_at,
      decided_at: null,
      expires_at,
      ttl_seconds,
      driver: ctx.driver,
      elicitation_used: false,
      out_of_band_url: null,
      remaining_uses: params.scope === "campaign_batch" ? params.campaign_max_contacts! : null,
      consumed: false,
    };
    this.approvals.set(approval_id, record);

    if (ctx.elicitationAvailable && ctx.elicit) {
      record.elicitation_used = true;
      try {
        const decision = await ctx.elicit(buildElicitationMessage(params));
        record.state = decision;
        record.decided_at = new Date().toISOString();
      } catch {
        // Elicitation transport failed mid-flight. Per SPEC §3.4 the gate
        // must never silently open OR silently block forever — fall back to
        // the out-of-band path rather than either extreme.
        record.elicitation_used = false;
        record.out_of_band_url = `${ctx.outOfBandBaseUrl}/${approval_id}`;
      }
    } else {
      record.out_of_band_url = `${ctx.outOfBandBaseUrl}/${approval_id}`;
    }

    return this.toResult(record);
  }

  /** SPEC §1.3 — `list_approvals`, with naive offset-encoded cursor pagination. */
  listApprovals(params: ListApprovalsParams): ListApprovalsResult {
    let items = Array.from(this.approvals.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));

    if (params.driver) {
      items = items.filter((r) => r.driver === params.driver);
    }
    if (params.scope && params.scope !== "any") {
      items = items.filter((r) => r.scope === params.scope);
    }

    // Compute (and possibly transition) effective state before filtering by it.
    const withState = items.map((r) => ({ r, state: this.effectiveState(r) }));
    const filtered = params.state && params.state !== "any" ? withState.filter((x) => x.state === params.state) : withState;

    const offset = decodeCursor(params.cursor);
    const page = filtered.slice(offset, offset + PAGE_SIZE);
    const next_cursor: Cursor | null = offset + PAGE_SIZE < filtered.length ? encodeCursor(offset + PAGE_SIZE) : null;

    return { approvals: page.map((x) => this.toRecord(x.r)), next_cursor };
  }

  /** Fetches a single approval record (effective state), or null if unknown. */
  get(approval_id: string): ApprovalRecord | null {
    const rec = this.approvals.get(approval_id);
    return rec ? this.toRecord(rec) : null;
  }

  /**
   * Records a human decision made via the out-of-band URL (SPEC §3.4).
   * Terminal states are immutable — deciding an already-decided approval is
   * a no-op that returns the (unchanged) record.
   */
  decide(approval_id: string, action: "approve" | "deny"): ApprovalRecord | null {
    const rec = this.approvals.get(approval_id);
    if (!rec) {
      return null;
    }
    if (this.effectiveState(rec) !== "pending") {
      return this.toRecord(rec);
    }
    rec.state = action === "approve" ? "approved" : "denied";
    rec.decided_at = new Date().toISOString();
    return this.toRecord(rec);
  }

  /**
   * Resolves whether `to` may be contacted right now: an explicit
   * `approval_id` (consuming single_call/campaign_batch grants on match), or
   * a standing `allowlist_add` match (SPEC §1.4 — "omit only if `to` matches
   * a standing allowlist entry"). Never invents a silent allow.
   */
  resolveGrant(input: ResolveGrantInput): GrantResolution {
    if (input.approval_id) {
      const rec = this.approvals.get(input.approval_id);
      if (!rec) {
        return { ok: false, reason: "not_found" };
      }
      const state = this.effectiveState(rec);
      if (state === "denied") {
        return { ok: false, reason: "denied", approvalRecord: this.toRecord(rec) };
      }
      if (state === "expired") {
        return { ok: false, reason: "expired", approvalRecord: this.toRecord(rec) };
      }
      if (state !== "approved") {
        // still pending (e.g. out-of-band URL not yet resolved)
        return { ok: false, reason: "no_match", approvalRecord: this.toRecord(rec) };
      }
      const matches = rec.destinations.some((p) => matchesPattern(p, input.to));
      if (!matches || rec.channel !== input.channel) {
        return { ok: false, reason: "no_match", approvalRecord: this.toRecord(rec) };
      }
      if (rec.scope === "single_call") {
        if (rec.consumed) {
          return { ok: false, reason: "no_match", approvalRecord: this.toRecord(rec) };
        }
        rec.consumed = true;
      } else if (rec.scope === "campaign_batch") {
        if (rec.remaining_uses === null || rec.remaining_uses <= 0) {
          return { ok: false, reason: "no_match", approvalRecord: this.toRecord(rec) };
        }
        rec.remaining_uses -= 1;
      }
      return { ok: true, approval_id: rec.approval_id };
    }

    // No approval_id supplied — the only zero-interaction path is a
    // pre-approved standing allowlist entry (SPEC §3.4.2).
    for (const rec of this.approvals.values()) {
      if (rec.scope !== "allowlist_add") {
        continue;
      }
      if (this.effectiveState(rec) !== "approved") {
        continue;
      }
      if (rec.channel !== input.channel) {
        continue;
      }
      if (rec.destinations.some((p) => matchesPattern(p, input.to))) {
        return { ok: true, approval_id: rec.approval_id };
      }
    }

    return { ok: false, reason: "no_match" };
  }

  /**
   * Starts a light periodic sweep that lazily-expires pending approvals past
   * their TTL, purely so `list_approvals` reflects reality even without a
   * concurrent read. Returns a stop function. The timer is `unref()`d so it
   * never keeps the process alive on its own.
   */
  startExpirySweep(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      for (const rec of this.approvals.values()) {
        this.effectiveState(rec);
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

function encodeCursor(offset: number): Cursor {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: Cursor | undefined): number {
  if (!cursor) {
    return 0;
  }
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
