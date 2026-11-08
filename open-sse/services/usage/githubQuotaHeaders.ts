/**
 * usage/githubQuotaHeaders.ts — passive GitHub Copilot AI-credit quota capture.
 *
 * Every `ghe-copilot` response (and the standard `github` proxy path) carries the
 * account's Copilot quota as headers:
 *
 *   x-quota-snapshot-premium_interactions: crUsed=988&ent=5000&ov=0.0&ovPerm=true
 *                                          &rem=80.2&rst=2026-12-01T00%3A00%3A00Z&totRem=4012.5
 *   x-quota-snapshot-chat:                 crUsed=0&ent=-1&ov=0.0&ovPerm=false
 *                                          &rem=100.0&rst=2026-12-01T00%3A00%3A00Z&totRem=-1
 *   x-quota-snapshot-completions:          (same shape; ent=-1 means unlimited)
 *
 * Field semantics (verified against a live account: ent 5000 / crUsed 988 →
 * totRem 4012.5, rem 80.2):
 *   crUsed — AI credits consumed in the current period
 *   ent    — entitlement (credits included in the plan); -1 → unlimited
 *   totRem — credits still remaining; -1 → unlimited
 *   rem    — remaining percentage (0..100)
 *   rst    — period reset timestamp, URL-encoded
 *   ov     — overage credits already consumed
 *   ovPerm — whether overage is permitted on this account
 *
 * This module is the pure half of the capture: it only turns headers into the
 * shared `UsageQuota` shape. Persistence lives in `src/lib/usage/githubQuotaCapture.ts`
 * (open-sse must not reach into `src/` from a leaf used by the fetchers).
 *
 * No network, no DB, no module state, and no imports at runtime — so it is safe
 * to call from the chat hot path and cheap to unit test with `--experimental-strip-types`.
 */

import type { UsageQuota } from "./quota.ts";

/** Header prefix carrying one quota window per plan bucket. */
export const GITHUB_QUOTA_HEADER_PREFIX = "x-quota-snapshot-";

/** Guard against a hostile/oversized header value being parsed field by field. */
const MAX_HEADER_VALUE_LENGTH = 4096;

/** Window key accepted from the header suffix (defensive: headers are upstream data). */
const WINDOW_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type GitHubQuotaWindow = {
  /** AI credits consumed this period (`crUsed`). */
  used: number;
  /** Plan entitlement in credits (`ent`); 0 when unlimited or unreported. */
  entitlement: number;
  /** Credits still available (`totRem`); 0 when unlimited. */
  remaining: number;
  /** Remaining share, 0..100. */
  remainingPercentage: number;
  /** Period reset timestamp (ISO-8601) or null when absent/unparseable. */
  resetAt: string | null;
  /** Overage credits already consumed (`ov`). */
  overageUsed: number;
  /** Whether the account may exceed its entitlement (`ovPerm`). */
  overagePermitted: boolean;
  /** True when the window reports no credit cap (`ent=-1`). */
  unlimited: boolean;
};

export type ParsedGitHubQuotaHeaders = {
  /** Parsed windows keyed by header suffix, e.g. `premium_interactions`. */
  windows: Record<string, GitHubQuotaWindow>;
  /** Earliest reset across the parsed windows, ISO-8601. */
  resetAt: string | null;
};

type HeaderLike = {
  forEach?: (callback: (value: string, key: string) => void) => void;
  get?: (name: string) => string | null;
};

function headerEntries(headers: unknown): Array<[string, string]> {
  if (!headers || typeof headers !== "object") return [];

  const entries: Array<[string, string]> = [];
  const headerLike = headers as HeaderLike;
  if (typeof headerLike.forEach === "function") {
    try {
      headerLike.forEach((value, key) => {
        if (typeof key === "string" && typeof value === "string") entries.push([key, value]);
      });
      if (entries.length > 0) return entries;
    } catch {
      // Fall through to the plain-object path below.
    }
  }

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") entries.push([key, value]);
  }
  return entries;
}

function decodeHeaderValue(raw: string): string {
  let value = raw.trim();
  if (value.length === 0) return "";
  // Values arrive URL-encoded (`rst=2026-12-01T00%3A00%3A00Z`). Decode once, but
  // tolerate a literal value that is not valid percent-encoding.
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; the individual field parsers reject what they cannot read.
    }
  }
  return value;
}

function toFiniteNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const normalized = raw
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return null;
}

/**
 * Parse a `rst` value into an ISO-8601 timestamp.
 *
 * Accepts an already-decoded ISO string, an epoch number (seconds or millis),
 * and returns null for anything that is not a usable date — a wrong reset date
 * would otherwise park the account past a window that already replenished.
 */
export function parseGitHubQuotaResetAt(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = decodeHeaderValue(raw);
  if (value.length === 0) return null;

  const numeric = toFiniteNumber(value);
  if (numeric !== null) {
    if (numeric <= 0) return null;
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const fromEpoch = new Date(ms);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch.toISOString();
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(parsed).toISOString();
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function readFields(value: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of value.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    fields.set(key, part.slice(separator + 1));
  }
  return fields;
}

/**
 * Parse one `x-quota-snapshot-*` header value.
 *
 * Returns null when the value carries no readable quota field (garbage, empty,
 * or a shape we do not recognize) so callers can skip that window instead of
 * publishing a bogus 0%-remaining quota.
 */
export function parseGitHubQuotaSnapshotHeader(value: unknown): GitHubQuotaWindow | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_HEADER_VALUE_LENGTH) return null;

  const decoded = decodeHeaderValue(value);
  if (decoded.length === 0) return null;

  const fields = readFields(decoded);
  if (fields.size === 0) return null;

  const entitlementRaw = toFiniteNumber(fields.get("ent") ?? fields.get("entitlement"));
  const usedRaw = toFiniteNumber(fields.get("crUsed") ?? fields.get("creditsUsed"));
  const remainingRaw = toFiniteNumber(fields.get("totRem") ?? fields.get("totalRemaining"));
  const percentRaw = toFiniteNumber(fields.get("rem") ?? fields.get("remainingPercent"));
  const overageRaw = toFiniteNumber(fields.get("ov") ?? fields.get("overage"));
  const overagePermitted = toBoolean(fields.get("ovPerm") ?? fields.get("overagePermitted"));
  const resetAt = parseGitHubQuotaResetAt(fields.get("rst") ?? fields.get("reset"));

  // Nothing quota-shaped in this value.
  if (
    entitlementRaw === null &&
    usedRaw === null &&
    remainingRaw === null &&
    percentRaw === null &&
    resetAt === null
  ) {
    return null;
  }

  const unlimited =
    (entitlementRaw !== null && entitlementRaw < 0) ||
    (entitlementRaw === null && remainingRaw !== null && remainingRaw < 0);

  const overageUsed = overageRaw !== null && overageRaw > 0 ? overageRaw : 0;

  if (unlimited) {
    return {
      used: usedRaw !== null && usedRaw > 0 ? usedRaw : 0,
      entitlement: 0,
      remaining: 0,
      remainingPercentage: percentRaw !== null ? clampPercentage(percentRaw) : 100,
      resetAt,
      overageUsed,
      overagePermitted: overagePermitted === true,
      unlimited: true,
    };
  }

  const entitlement = entitlementRaw !== null && entitlementRaw > 0 ? entitlementRaw : 0;
  let remaining =
    remainingRaw !== null && remainingRaw >= 0
      ? remainingRaw
      : entitlement > 0
        ? Math.max(0, entitlement - (usedRaw ?? 0))
        : 0;
  if (entitlement > 0) remaining = Math.min(remaining, entitlement);

  const used =
    usedRaw !== null && usedRaw >= 0
      ? usedRaw
      : entitlement > 0
        ? Math.max(0, entitlement - remaining)
        : 0;

  // Prefer the arithmetic (totRem / ent) over the rounded `rem` field; fall back
  // to the reported percentage when entitlement is unknown.
  const remainingPercentage =
    entitlement > 0
      ? clampPercentage((remaining / entitlement) * 100)
      : percentRaw !== null
        ? clampPercentage(percentRaw)
        : 0;

  return {
    used,
    entitlement,
    remaining,
    remainingPercentage,
    resetAt,
    overageUsed,
    overagePermitted: overagePermitted === true,
    unlimited: false,
  };
}

/**
 * Collect every `x-quota-snapshot-*` header of a provider response.
 *
 * Returns null when the response carries no such header (i.e. not a Copilot
 * quota-bearing response) so the caller can bail out before touching the DB.
 */
export function parseGitHubQuotaHeaders(headers: unknown): ParsedGitHubQuotaHeaders | null {
  const windows: Record<string, GitHubQuotaWindow> = {};
  let earliestResetMs = Number.POSITIVE_INFINITY;

  for (const [rawName, rawValue] of headerEntries(headers)) {
    const name = rawName.toLowerCase().trim();
    if (!name.startsWith(GITHUB_QUOTA_HEADER_PREFIX)) continue;

    const windowKey = name.slice(GITHUB_QUOTA_HEADER_PREFIX.length);
    if (!WINDOW_KEY_PATTERN.test(windowKey)) continue;

    const window = parseGitHubQuotaSnapshotHeader(rawValue);
    if (!window) continue;

    windows[windowKey] = window;
    if (window.resetAt) {
      const ms = Date.parse(window.resetAt);
      if (Number.isFinite(ms) && ms < earliestResetMs) earliestResetMs = ms;
    }
  }

  if (Object.keys(windows).length === 0) return null;

  return {
    windows,
    resetAt: Number.isFinite(earliestResetMs) ? new Date(earliestResetMs).toISOString() : null,
  };
}

/**
 * Map one parsed window onto the shared `UsageQuota` contract.
 *
 * Unlimited windows keep `total: 0` + `unlimited: true` so the existing GitHub
 * display gate (`shouldDisplayGitHubQuota`) hides them — GitHub only meters
 * `premium_interactions` (AI credits); chat/completions are unlimited on every
 * paid plan and must not render as an empty 0% bar.
 */
export function githubQuotaWindowToUsageQuota(window: GitHubQuotaWindow): UsageQuota {
  if (window.unlimited) {
    return {
      used: 0,
      total: 0,
      remaining: 0,
      remainingPercentage: 100,
      resetAt: window.resetAt,
      unlimited: true,
      quotaSource: "responseHeaders",
      overage: { used: window.overageUsed, permitted: window.overagePermitted },
    };
  }

  const percentageOnly = window.entitlement <= 0;
  return {
    used: window.used,
    total: window.entitlement,
    remaining: window.remaining,
    remainingPercentage: window.remainingPercentage,
    resetAt: window.resetAt,
    unlimited: false,
    // NOT `fractionReported`: the display layer reads that flag as
    // "percentage-only", and these windows carry real used/entitlement counts.
    quotaSource: "responseHeaders",
    ...(percentageOnly ? { isPercentageOnly: true } : {}),
    overage: { used: window.overageUsed, permitted: window.overagePermitted },
  };
}

/** Convert every parsed window into `UsageQuota`s keyed by window name. */
export function githubQuotaHeadersToUsageQuotas(headers: unknown): Record<string, UsageQuota> {
  const parsed = parseGitHubQuotaHeaders(headers);
  if (!parsed) return {};

  const quotas: Record<string, UsageQuota> = {};
  for (const [windowKey, window] of Object.entries(parsed.windows)) {
    // Unlimited windows are dropped here for the same reason `getGitHubUsage`
    // drops them: they carry no credit information.
    if (window.unlimited) continue;
    if (window.entitlement <= 0 && window.remainingPercentage === undefined) continue;
    quotas[windowKey] = githubQuotaWindowToUsageQuota(window);
  }
  return quotas;
}