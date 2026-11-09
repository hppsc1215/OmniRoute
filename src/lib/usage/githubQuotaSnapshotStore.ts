/**
 * githubQuotaSnapshotStore.ts — read side of the passive GitHub Copilot quota capture.
 *
 * Kept separate from `githubQuotaCapture.ts` on purpose: this module must stay a
 * LEAF (DB only) because it is imported by the `getUsageForProvider` graph
 * (`open-sse/services/usage/gheCopilot.ts`). Importing `@/domain/quotaCache`
 * there would close the ESM init cycle
 * `quotaCache → usage.ts → usage/gheCopilot.ts → capture → quotaCache` that the
 * repo already hits with openrouter (see `open-sse/services/quotaPreflight.ts`).
 * The recorder, which does touch the quota cache, is only imported by the chat
 * pipeline (`chatCore/executeProviderRequest.ts`).
 *
 * Two durable sources, in freshness order:
 *   1. the Provider Limits cache row (`source: "passive"`, or any row that still
 *      carries real credit counts), rewritten at most once a minute while the
 *      account is in use;
 *   2. the newest `quota_snapshots` row per window, for a connection that has
 *      not been used since the Provider Limits cache was cleared. Rows written
 *      before the credit counts were persisted are percentage-only.
 *
 * @module lib/usage/githubQuotaSnapshotStore
 */

import { getProviderLimitsCache } from "@/lib/db/providerLimits";
import { getLatestQuotaSnapshotsForConnection } from "@/lib/db/quotaSnapshots";

export const PASSIVE_QUOTA_SOURCE = "passive";

/** Providers whose `quota_snapshots` rows this store may read back. */
const GITHUB_FAMILY_PROVIDERS = new Set(["github", "ghe-copilot"]);

export type PassiveGitHubQuotaSnapshot = {
  quotas: Record<string, unknown>;
  /** When the snapshot was observed upstream (ISO-8601), null when unknown. */
  observedAt: string | null;
  source: "providerLimits" | "snapshots";
};

type SnapshotRowLike = {
  provider?: string;
  window_key?: string;
  windowKey?: string;
  raw_data?: string | null;
  rawData?: string | null;
  remaining_percentage?: number | null;
  remainingPercentage?: number | null;
  next_reset_at?: string | null;
  nextResetAt?: string | null;
  created_at?: string;
  createdAt?: string;
};

function readSnapshotRows(connectionId: string): PassiveGitHubQuotaSnapshot | null {
  let snapshots: unknown[];
  try {
    snapshots = getLatestQuotaSnapshotsForConnection(connectionId) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;

  const quotas: Record<string, unknown> = {};
  let observedAt: string | null = null;

  for (const raw of snapshots) {
    const row = raw as SnapshotRowLike;
    // `rowToCamel` leaves snake_case keys intact on some driver paths, so read both.
    const windowKey = row.window_key ?? row.windowKey;
    if (!windowKey) continue;

    const provider = String(row.provider ?? "");
    if (!GITHUB_FAMILY_PROVIDERS.has(provider)) continue;

    const rawData = row.raw_data ?? row.rawData;
    let metadata: Record<string, unknown> = {};
    if (typeof rawData === "string" && rawData.length > 0) {
      try {
        metadata = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }

    const storedPercentage = row.remaining_percentage ?? row.remainingPercentage;
    const percentage = Number.isFinite(Number(storedPercentage))
      ? Number(storedPercentage)
      : undefined;
    const resetAt = row.next_reset_at ?? row.nextResetAt ?? null;

    if (metadata.source !== "response_headers") {
      // `quota_snapshots` rows written by `setQuotaCache` are percentage-only.
      // They are a degraded but honest fallback: the bar still shows the right
      // remaining share and reset, just without the credit counts.
      if (percentage === undefined || percentage === null) continue;
      if (metadata.fractionReported === false) continue;
      quotas[windowKey] = {
        used: 0,
        total: 0,
        remaining: 0,
        remainingPercentage: percentage,
        resetAt,
        unlimited: false,
        fractionReported: true,
        isPercentageOnly: true,
        quotaSource: "responseHeaders",
      };
    } else {
      const entitlement = Number(metadata.entitlement);
      const used = Number(metadata.creditsUsed);
      const remaining = Number(metadata.remaining);
      const metadataPercentage = Number(metadata.remainingPercentage);

      quotas[windowKey] = {
        used: Number.isFinite(used) ? used : 0,
        total: Number.isFinite(entitlement) ? entitlement : 0,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        remainingPercentage: Number.isFinite(metadataPercentage)
          ? metadataPercentage
          : (percentage ?? 0),
        resetAt,
        unlimited: metadata.unlimited === true,
        // No `fractionReported`: these rows carry real used/entitlement counts,
        // and the display layer reads that flag as "percentage-only".
        quotaSource: "responseHeaders",
        overage: {
          used: Number(metadata.overageUsed) || 0,
          permitted: metadata.overagePermitted === true,
        },
      };
    }

    const createdAt = row.created_at ?? row.createdAt ?? null;
    if (createdAt && (!observedAt || createdAt > observedAt)) observedAt = createdAt;
  }

  if (Object.keys(quotas).length === 0) return null;
  return { quotas, observedAt, source: "snapshots" };
}

/** A window that carries real credit counts (not the percentage-only shape). */
function hasCreditBearingQuota(quotas: Record<string, unknown>): boolean {
  return Object.values(quotas).some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const quota = value as Record<string, unknown>;
    if (quota.isPercentageOnly === true) return false;
    return (
      typeof quota.used === "number" &&
      Number.isFinite(quota.used) &&
      typeof quota.total === "number" &&
      Number.isFinite(quota.total) &&
      quota.total > 0
    );
  });
}

/**
 * Latest passive Copilot quota snapshot for a connection.
 *
 * Returns null when the connection has never produced a quota-bearing response.
 * Never throws — callers are dashboard/fetcher paths that must degrade to a
 * message instead of failing.
 */
export function readPassiveGitHubQuotaSnapshot(
  connectionId: string | null | undefined
): PassiveGitHubQuotaSnapshot | null {
  if (typeof connectionId !== "string" || connectionId.trim().length === 0) return null;

  try {
    const cached = getProviderLimitsCache(connectionId);
    if (cached?.quotas && Object.keys(cached.quotas).length > 0) {
      // The `passive` marker is the normal case. A row rewritten by a Provider
      // Limits sync can still be the only carrier of the credit counts, so
      // accept it too — otherwise the counts are ignored and the degraded
      // snapshot rows take over permanently. Percentage-only rows stay rejected.
      if (cached.source === PASSIVE_QUOTA_SOURCE || hasCreditBearingQuota(cached.quotas)) {
        return {
          quotas: cached.quotas as Record<string, unknown>,
          observedAt: cached.fetchedAt ?? null,
          source: "providerLimits",
        };
      }
    }
  } catch {
    // No DB / build phase — fall through to snapshots.
  }

  return readSnapshotRows(connectionId);
}
