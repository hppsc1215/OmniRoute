/**
 * Quota Cache — snapshot persistence helpers.
 *
 * Split out of `quotaCache.ts` (file-size cap) without behavior change: decides which
 * observed quota windows are worth persisting as DB snapshot rows (#4438 dedupe, Codex
 * restart-durability) and writes them. `quotaCache.ts` re-exports `quotaSnapshotChanged`
 * so existing importers keep their path. This module must not import `quotaCache.ts`.
 *
 * @module domain/quotaSnapshotPersistence
 */

import {
  saveQuotaSnapshot,
  getLatestQuotaSnapshotsForConnection,
  isUnreportedQuotaSnapshot,
  RETIRED_QUOTA_WINDOW_RAW_DATA,
} from "@/lib/db/quotaSnapshots";
import { recordProviderQuotaResetEventIfChanged } from "@/lib/db/quotaResetEvents";
import { safePercentage } from "@/shared/utils/formatting";
import { ACTIVE_TTL_MS, parseDate, type QuotaCacheEntry, type QuotaInfo } from "./quotaCacheState";

/**
 * Credit counts a window actually reported. `null` when the window is
 * percentage-only: no finite entitlement, no finite `used`, or explicitly
 * unlimited. This is the boundary between the lossless `raw_data` contract and
 * the legacy boolean-only metadata — a placeholder must never look lossless.
 */
export type QuotaCreditCounts = {
  used: number;
  total: number;
  remaining: number;
  overageUsed: number;
};

export function readQuotaCreditCounts(quota: Record<string, unknown>): QuotaCreditCounts | null {
  if (quota.unlimited === true) return null;
  const total = safePercentage(quota.total);
  const used = safePercentage(quota.used);
  if (total === undefined || total <= 0 || used === undefined || used < 0) return null;
  const reportedRemaining = safePercentage(quota.remaining);
  const remaining =
    reportedRemaining !== undefined && reportedRemaining >= 0
      ? reportedRemaining
      : Math.max(total - used, 0);
  const overage = quota.overage;
  const overageUsed =
    overage && typeof overage === "object"
      ? (safePercentage((overage as Record<string, unknown>).used) ?? 0)
      : 0;
  return { used, total, remaining, overageUsed };
}

/**
 * `quota_snapshots.raw_data` carries the interpretation flags hydration needs
 * and — for windows that reported real credit counts — the counts themselves,
 * in the shape `githubQuotaSnapshotStore.readSnapshotRows` already reads back
 * (`source:"response_headers"`). Percentage-only windows keep the legacy
 * boolean-only payload so old hydration behaviour is unchanged.
 */
export function quotaSnapshotMetadata(
  fractionReported: boolean,
  overagePermitted: boolean,
  creditCounts: QuotaCreditCounts | null,
  remainingPercentage: number
): string | null {
  if (fractionReported && creditCounts) {
    return JSON.stringify({
      source: "response_headers",
      creditsUsed: creditCounts.used,
      entitlement: creditCounts.total,
      remaining: creditCounts.remaining,
      remainingPercentage,
      unlimited: false,
      overageUsed: creditCounts.overageUsed,
      overagePermitted,
    });
  }
  const metadata: Record<string, boolean> = {};
  if (!fractionReported) metadata.fractionReported = false;
  if (overagePermitted) metadata.overagePermitted = true;
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

/**
 * #4438 — Decide whether a quota snapshot row is worth persisting.
 *
 * The background refresh ticks every 60s for ALL connections, so idle accounts
 * (whose quota never changes) were generating 400K+ identical snapshot rows/day.
 * Returns true only when this window has no prior cached observation, or when its
 * `remaining_percentage` / `is_exhausted` differs from the last cached entry — so
 * the first observation and every real change persist, but idle no-op refreshes
 * stop writing. Pure (no I/O) for trivial unit testing.
 */
export function quotaSnapshotChanged(
  prior:
    | {
        quotas?: Record<
          string,
          { remainingPercentage: number; used?: number; total?: number; remaining?: number }
        >;
        exhausted?: boolean;
      }
    | null
    | undefined,
  windowKey: string,
  remainingPercentage: number,
  exhausted: boolean,
  creditCounts?: QuotaCreditCounts | null
): boolean {
  if (!prior) return true;
  const priorWindow = prior.quotas?.[windowKey];
  if (!priorWindow) return true;
  if (
    priorWindow.remainingPercentage !== remainingPercentage ||
    (prior.exhausted ?? false) !== exhausted
  ) {
    return true;
  }
  // A count change can leave the reported percentage untouched (the Copilot
  // header carries one decimal), and a count-bearing window must heal a prior
  // percentage-only row even when the bar did not move — persist either way.
  if (creditCounts) {
    return (
      priorWindow.used !== creditCounts.used ||
      priorWindow.total !== creditCounts.total ||
      priorWindow.remaining !== creditCounts.remaining
    );
  }
  return false;
}

/** A persisted snapshot already records this exact fresh Codex observation. */
function savedCodexSnapshotMatches(
  snapshots: ReturnType<typeof getLatestQuotaSnapshotsForConnection> | undefined,
  windowKey: string,
  remainingPercentage: number,
  windowExhausted: boolean,
  resetAt: string | null
): boolean {
  const snapshot = snapshots?.find((row) => {
    const saved = row as unknown as Record<string, unknown>;
    return (saved.windowKey ?? row.window_key) === windowKey;
  });
  if (!snapshot || isUnreportedQuotaSnapshot(snapshot)) return false;
  const saved = snapshot as unknown as Record<string, unknown>;
  const savedAt = parseDate(String(saved.createdAt ?? saved.created_at ?? ""));
  if (savedAt === null || savedAt > Date.now() || Date.now() - savedAt >= ACTIVE_TTL_MS)
    return false;
  return (
    Number(saved.remainingPercentage ?? saved.remaining_percentage) === remainingPercentage &&
    Number(saved.isExhausted ?? saved.is_exhausted) === Number(windowExhausted) &&
    (saved.nextResetAt ?? saved.next_reset_at ?? null) === resetAt
  );
}

/**
 * #4438 stays unchanged for other providers. Codex also needs a fresh durable fact:
 * a warm cache timestamp does not prove its deduplicated snapshot survived restart.
 */
function quotaWindowSnapshotIsCurrent(
  connectionId: string,
  provider: string,
  windowKey: string,
  remainingPercentage: number,
  windowExhausted: boolean,
  fractionReported: boolean,
  reportedFlag: boolean | undefined,
  overagePermittedFlag: boolean | undefined,
  creditCounts: QuotaCreditCounts | null,
  resetAt: string | null,
  prior: QuotaCacheEntry | null,
  codexSnapshots: { current?: ReturnType<typeof getLatestQuotaSnapshotsForConnection> }
): boolean {
  const priorWindow = prior?.quotas?.[windowKey];
  if (
    quotaSnapshotChanged(prior, windowKey, remainingPercentage, windowExhausted, creditCounts) ||
    (priorWindow !== undefined && priorWindow.fractionReported !== reportedFlag) ||
    // An overage window that flips from permitted to capped (or back) is a real
    // observation even when the bar and the counts stay put.
    (priorWindow !== undefined && priorWindow.overagePermitted !== overagePermittedFlag)
  )
    return false;
  if (provider !== "codex" || !fractionReported) return true;
  codexSnapshots.current ??= getLatestQuotaSnapshotsForConnection(connectionId);
  return savedCodexSnapshotMatches(
    codexSnapshots.current,
    windowKey,
    remainingPercentage,
    windowExhausted,
    resetAt
  );
}

function persistOneQuotaWindow(
  connectionId: string,
  provider: string,
  entry: QuotaCacheEntry,
  windowKey: string,
  quotaInfo: unknown,
  quotas: Record<string, QuotaInfo>,
  prior: QuotaCacheEntry | null,
  retainedCodexWindows: Set<string>,
  codexSnapshots: { current?: ReturnType<typeof getLatestQuotaSnapshotsForConnection> }
): void {
  if (!quotaInfo || typeof quotaInfo !== "object") return;
  const normalized = quotas[windowKey];
  // Retaining an old fact is not a new observation, including in restart snapshots.
  if (!normalized || retainedCodexWindows.has(windowKey)) return;
  const { remainingPercentage } = normalized;
  const fractionReported = normalized.fractionReported !== false;
  const overagePermitted = normalized.overagePermitted === true;
  if (fractionReported) {
    recordProviderQuotaResetEventIfChanged({
      provider,
      connectionId,
      windowKey,
      currentResetAt: normalized.resetAt,
      currentRemainingPercentage: remainingPercentage,
      previousObservation: prior?.quotas?.[windowKey]
        ? {
            resetAt: prior.quotas[windowKey].resetAt,
            remainingPercentage: prior.quotas[windowKey].remainingPercentage,
          }
        : null,
    });
  }
  // #5923 (Finding #5) — is_exhausted must reflect THIS window's own remaining
  // percentage, not the connection-wide AND-across-all-windows aggregate
  // (`entry.exhausted`). A connection with one 0% window and other non-zero
  // windows previously never flagged that window's row as exhausted.
  const windowExhausted = fractionReported && !overagePermitted && remainingPercentage <= 0;
  // Real credit counts (GitHub Copilot AI credits) also ride in `raw_data`, so a
  // lossless row can be rebuilt without the Provider Limits cache entry.
  // Percentage-only windows keep the legacy metadata.
  const creditCounts = fractionReported
    ? readQuotaCreditCounts(quotaInfo as Record<string, unknown>)
    : null;
  if (
    quotaWindowSnapshotIsCurrent(
      connectionId,
      provider,
      windowKey,
      remainingPercentage,
      windowExhausted,
      fractionReported,
      normalized.fractionReported,
      normalized.overagePermitted,
      creditCounts,
      normalized.resetAt,
      prior,
      codexSnapshots
    )
  )
    return;
  try {
    saveQuotaSnapshot({
      provider,
      connection_id: connectionId,
      window_key: windowKey,
      remaining_percentage: remainingPercentage,
      is_exhausted: windowExhausted ? 1 : 0,
      next_reset_at: normalized.resetAt,
      window_duration_ms: entry.windowDurationMs ?? null,
      // Persist the interpretation flags plus any real credit counts — never
      // the raw provider payload.
      raw_data: quotaSnapshotMetadata(
        fractionReported,
        overagePermitted,
        creditCounts,
        remainingPercentage
      ),
    });
  } catch (error) {
    console.error("[quotaCache] Failed to save snapshot:", error);
  }
}

export function persistQuotaWindowSnapshots(
  connectionId: string,
  provider: string,
  entry: QuotaCacheEntry,
  rawQuotas: Record<string, unknown>,
  quotas: Record<string, QuotaInfo>,
  prior: QuotaCacheEntry | null,
  retainedCodexWindows: Set<string>
): void {
  const codexSnapshots: { current?: ReturnType<typeof getLatestQuotaSnapshotsForConnection> } = {};
  for (const [windowKey, quotaInfo] of Object.entries(rawQuotas)) {
    persistOneQuotaWindow(
      connectionId,
      provider,
      entry,
      windowKey,
      quotaInfo,
      quotas,
      prior,
      retainedCodexWindows,
      codexSnapshots
    );
  }
}

/**
 * Retire every window known for this connection (cached or persisted) that a complete usage
 * reading no longer reports: providers add and remove windows, so its absence there means the
 * window is gone. Appends one retirement record per window (history is kept) so a restart does
 * not rehydrate it. Returns the retired window keys.
 */
export function retireUnreportedQuotaWindows(
  connectionId: string,
  provider: string,
  reported: Record<string, QuotaInfo>,
  prior: QuotaCacheEntry | null
): string[] {
  const reportedKeys = new Set(Object.keys(reported));
  const known = new Set(Object.keys(prior?.quotas ?? {}));
  try {
    for (const row of getLatestQuotaSnapshotsForConnection(connectionId)) {
      const saved = row as unknown as Record<string, unknown>;
      const key = saved.windowKey ?? row.window_key;
      if (typeof key === "string" && key) known.add(key);
    }
  } catch (error) {
    console.error("[quotaCache] Failed to read snapshots for window retirement:", error);
  }
  const retired = [...known].filter((key) => !reportedKeys.has(key)).sort();
  for (const windowKey of retired) {
    try {
      saveQuotaSnapshot({
        provider,
        connection_id: connectionId,
        window_key: windowKey,
        remaining_percentage: null,
        is_exhausted: 0,
        next_reset_at: null,
        window_duration_ms: null,
        raw_data: RETIRED_QUOTA_WINDOW_RAW_DATA,
      });
    } catch (error) {
      console.error("[quotaCache] Failed to retire quota window:", error);
    }
  }
  return retired;
}
