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
import { readPassiveGitHubQuotaSnapshot, PASSIVE_QUOTA_SOURCE } from "./githubQuotaSnapshotStore";
import { mergeProviderLimitsCacheEntry, toProviderLimitsCacheEntry } from "./providerLimitsCache";

type JsonRecord = Record<string, unknown>;

/**
 * Reason stamped on the passive Copilot usage envelope.
 *
 * Kept as a stable string (not a boolean) so a persisted envelope can still be
 * recognised without a DB read, and so `_passive` can never be confused with the
 * `_stale` marker that means "the live probe failed".
 */
export const PASSIVE_COPILOT_REASON = "Captured from GitHub Copilot response headers.";

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * True when this usage envelope is the passively captured Copilot snapshot
 * rather than the product of a live quota probe.
 *
 * `_passive` is the only marker the passive envelope carries. The legacy
 * `_stale` + reason pair is still recognised so an envelope produced before the
 * split (or replayed from an old in-memory row) keeps classifying correctly —
 * but a passive read is never *rendered* as stale, because it no longer sets
 * `_stale`.
 */
export function isPassiveCopilotQuotaUsage(provider: string, usage: JsonRecord): boolean {
  if (provider !== "ghe-copilot") return false;
  return (
    usage._passive === true ||
    (usage._stale === true && usage._staleReason === PASSIVE_COPILOT_REASON)
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
 * One window's counts, always read from a single observation.
 *
 * GitHub sends `crUsed` and `totRem` in the same header, but the two can lag
 * each other (observed live: `crUsed=1011&ent=5000&totRem=3925.6`, where
 * 1011 + 3925.6 ≠ 5000). `totRem` moves with every response, so it is the
 * fresher field: when the reported `used` disagrees with `total - remaining` by
 * more than rounding, `used` is re-derived from `remaining`. The percentage is
 * then always computed from the same, reconciled pair — never from a mix of an
 * older `used` and a newer `remaining`.
 */
export function normalizeCreditObservation(quota: JsonRecord & { used: number; total: number }): {
  used: number;
  remaining: number;
  remainingPercentage: number;
} {
  const total = quota.total;
  const reportedUsed = Math.max(0, quota.used);
  const reportedRemaining =
    typeof quota.remaining === "number" && Number.isFinite(quota.remaining)
      ? Math.max(0, quota.remaining)
      : Math.max(total - reportedUsed, 0);
  const derivedUsed = Math.max(total - reportedRemaining, 0);
  const used =
    Math.abs(reportedUsed - derivedUsed) > 0.5 ? derivedUsed : Math.min(reportedUsed, total);
  const remaining = Math.max(total - used, 0);
  return {
    used,
    remaining,
    remainingPercentage: total > 0 ? (remaining / total) * 100 : 0,
  };
}

/**
 * Keep cached credit counts when the incoming entry is an all-percentage-only
 * reading. The reset stays the incoming one (same period, checked above), but
 * `used`, `remaining` and the percentage are taken together from the cached
 * observation — a newer incoming percentage next to an older cached `used`
 * would describe two different moments and break used + remaining = total.
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
    const counts = normalizeCreditObservation(cached);
    quotas[windowKey] = {
      ...visible,
      used: counts.used,
      total: cached.total,
      remaining: counts.remaining,
      remainingPercentage: counts.remainingPercentage,
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

/**
 * GHE Copilot (`ghe-copilot`) AI-credit windows are captured passively from
 * `x-quota-snapshot-*` response headers on the chat path
 * (`githubQuotaCapture.ts`) and persisted in the Provider Limits cache + quota
 * snapshots (`githubQuotaSnapshotStore.ts`).
 *
 * A snapshot younger than this is authoritative for background syncs — no point
 * probing the tenant. A user-triggered refresh still probes live (see
 * `fetchLiveProviderLimitsWithOptions`): the tenant endpoint answers on GHE and
 * is the only way an empty/older snapshot can move forward.
 */
export const GHE_PASSIVE_SNAPSHOT_FRESH_MS = 45 * 60_000;

/**
 * The passive envelope deliberately carries NO `_stale` marker: `_stale` means
 * "the live probe failed, this is the last known value", and a passive capture
 * is a successful read of a different source. `_passive` + `_observedAt` let the
 * dashboard render a neutral "captured from Copilot responses" hint instead of
 * the refresh-failed tooltip/health degradation.
 */
function copilotPassiveSnapshotUsage(
  snapshot: NonNullable<ReturnType<typeof readPassiveGitHubQuotaSnapshot>>
): JsonRecord {
  return {
    quotas: snapshot.quotas,
    message: null,
    // The observation time is the last chat response that carried the headers,
    // not "now" — keep it so the UI can say how old the reading is.
    _passive: true,
    _passiveReason: PASSIVE_COPILOT_REASON,
    ...(snapshot.observedAt ? { _observedAt: snapshot.observedAt } : {}),
  };
}

/**
 * Fresh passive Copilot quota as a usage envelope, or null when the connection
 * has never produced one (or the reading is older than the freshness window).
 */
export function resolveCopilotPassiveUsage(
  provider: string | null | undefined,
  connectionId: string | null | undefined,
  nowMs: number = Date.now()
): JsonRecord | null {
  if (provider !== "ghe-copilot") return null;

  const snapshot = readPassiveGitHubQuotaSnapshot(connectionId);
  if (!snapshot || Object.keys(snapshot.quotas).length === 0) return null;

  const observedMs = snapshot.observedAt ? Date.parse(snapshot.observedAt) : Number.NaN;
  if (!Number.isFinite(observedMs) || nowMs - observedMs >= GHE_PASSIVE_SNAPSHOT_FRESH_MS) {
    return null;
  }
  return copilotPassiveSnapshotUsage(snapshot);
}

/**
 * Keep a captured Copilot snapshot as the answer when the live fetch produced no
 * quota (tenant endpoint missing, expired token, throttled probe).
 */
export function withPassiveCopilotQuotaFallback(
  provider: string | null | undefined,
  connectionId: string | null | undefined,
  usage: JsonRecord
): JsonRecord {
  if (provider !== "ghe-copilot") return usage;
  if (isRecord(usage?.quotas) && Object.keys(usage.quotas).length > 0) return usage;

  const snapshot = readPassiveGitHubQuotaSnapshot(connectionId);
  if (!snapshot) return usage;
  return { ...usage, ...copilotPassiveSnapshotUsage(snapshot) };
}
