/**
 * providerLimitsQuotaMerge.ts — what a Provider Limits sync may (not) overwrite.
 *
 * A `ghe-copilot` quota reading can come from two places: a live probe and the
 * passive capture of `x-quota-snapshot-*` response headers. Only the passive
 * Provider Limits entry carries the AI-credit counts; `quota_snapshots` rows are
 * percentage-only when the capture never wrote counts (legacy rows). Two rules
 * keep the durable cache from degrading itself:
 *
 *   1. a sync that merely re-serves the passive snapshot must not stamp its own
 *      `manual` / `scheduled` marker over the `passive` one — `readPassiveGitHubQuotaSnapshot`
 *      trusts the marker, and losing it sends the next read to the degraded rows;
 *   2. an all-percentage-only sync result must not replace credit counts that
 *      are already cached for the same window/period.
 *
 * Leaf module (no imports from `providerLimits.ts`) so both the single
 * connection and the bulk sync paths share exactly one policy.
 *
 * @module lib/usage/providerLimitsQuotaMerge
 */

import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { PASSIVE_QUOTA_SOURCE } from "./githubQuotaSnapshotStore";
import { mergeProviderLimitsCacheEntry, toProviderLimitsCacheEntry } from "./providerLimitsCache";

type JsonRecord = Record<string, unknown>;

/** `_staleReason` stamped by the passive Copilot usage envelope. */
export const PASSIVE_COPILOT_STALE_REASON = "Captured from GitHub Copilot response headers.";

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * True when this usage envelope is the passively captured Copilot snapshot
 * rather than the product of a live quota probe.
 */
export function isPassiveCopilotQuotaUsage(provider: string, usage: JsonRecord): boolean {
  return (
    provider === "ghe-copilot" &&
    usage._stale === true &&
    usage._staleReason === PASSIVE_COPILOT_STALE_REASON
  );
}

/** A window with no credit counts — a percentage bar only. */
function isPercentageOnlyQuota(quota: JsonRecord): boolean {
  return quota.isPercentageOnly === true || (quota.used === 0 && quota.total === 0);
}

/** A window that carries real credit counts for the current period. */
function hasCreditCounts(quota: unknown): quota is JsonRecord & {
  used: number;
  total: number;
  remaining?: number;
} {
  if (!isRecord(quota) || quota.isPercentageOnly === true) return false;
  return (
    typeof quota.used === "number" &&
    Number.isFinite(quota.used) &&
    quota.used >= 0 &&
    typeof quota.total === "number" &&
    Number.isFinite(quota.total) &&
    quota.total > 0
  );
}

function sameResetPeriod(incoming: JsonRecord, cached: JsonRecord): boolean {
  const incomingReset = typeof incoming.resetAt === "string" ? incoming.resetAt : null;
  const cachedReset = typeof cached.resetAt === "string" ? cached.resetAt : null;
  // A known mismatch means the cached counts belong to a past billing period.
  return !incomingReset || !cachedReset || incomingReset === cachedReset;
}

/**
 * Keep cached credit counts when the incoming entry is an all-percentage-only
 * reading. The incoming percentage/reset stay authoritative; only the counts
 * (and the flags that let the display layer render them) are restored.
 */
export function preserveCreditBearingQuotas(
  next: ProviderLimitsCacheEntry,
  previous: ProviderLimitsCacheEntry | null | undefined
): ProviderLimitsCacheEntry {
  if (!next.quotas || !previous?.quotas) return next;
  const incoming = Object.entries(next.quotas).filter((entry): entry is [string, JsonRecord] =>
    isRecord(entry[1])
  );
  if (incoming.length === 0 || !incoming.every(([, quota]) => isPercentageOnlyQuota(quota))) {
    return next;
  }

  const quotas: JsonRecord = { ...next.quotas };
  let restored = false;
  for (const [windowKey, quota] of incoming) {
    const cached = previous.quotas[windowKey];
    if (!hasCreditCounts(cached) || !sameResetPeriod(quota, cached)) continue;
    const { isPercentageOnly: _degraded, ...visible } = quota;
    quotas[windowKey] = {
      ...visible,
      used: cached.used,
      total: cached.total,
      remaining:
        typeof cached.remaining === "number"
          ? cached.remaining
          : Math.max(cached.total - cached.used, 0),
      unlimited: cached.unlimited === true,
      ...(isRecord(cached.overage) ? { overage: cached.overage } : {}),
      quotaSource: typeof cached.quotaSource === "string" ? cached.quotaSource : "responseHeaders",
    };
    restored = true;
  }

  return restored ? { ...next, quotas } : next;
}

/**
 * Build the durable Provider Limits entry a sync should persist.
 *
 * `source` is the sync's own trigger; it is overridden with `passive` when the
 * usage it carries was captured from Copilot response headers, because the
 * marker describes the reading, not the action that stored it.
 *
 * Returns the raw conversion (`next`) as well, because callers inspect
 * `next.message` to detect error-only results.
 */
export function buildProviderLimitsCacheEntry(
  provider: string,
  usage: JsonRecord,
  source: string,
  previous: ProviderLimitsCacheEntry | null | undefined
): { next: ProviderLimitsCacheEntry; cache: ProviderLimitsCacheEntry } {
  const effectiveSource = isPassiveCopilotQuotaUsage(provider, usage)
    ? PASSIVE_QUOTA_SOURCE
    : source;
  const next = toProviderLimitsCacheEntry(usage, effectiveSource);
  const cache = mergeProviderLimitsCacheEntry(
    provider,
    preserveCreditBearingQuotas(next, previous),
    previous
  );
  return { next, cache };
}
