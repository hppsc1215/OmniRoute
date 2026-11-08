/**
 * githubQuotaCapture.ts — passive GitHub / GHE Copilot AI-credit quota capture.
 *
 * GitHub Copilot reports the account's AI-credit state on inference responses
 * (`x-quota-snapshot-premium_interactions`, `-chat`, `-completions`). Those
 * headers are the only quota source that exists for GitHub Enterprise
 * (`ghe-copilot`) connections: the public `api.github.com/copilot_internal/user`
 * endpoint is not reachable for a GHE data-residency tenant, so the accounting
 * has to come from the chat traffic itself instead of polling an endpoint.
 *
 * This module is the persistence half of the capture; the pure header parsing
 * lives in `open-sse/services/usage/githubQuotaHeaders.ts` because open-sse owns
 * the provider fetchers. It writes through the EXISTING mechanisms — no new
 * table, no migration:
 *
 *   - `setQuotaCache`          → in-memory routing quota + the `quota_snapshots`
 *                               row it already writes (percentage + reset)
 *   - `setProviderLimitsCache` → the row Usage > Provider Limits renders, and the
 *                               only durable place that carries the credit counts
 *                               (used / entitlement / overage) — the snapshot row
 *                               is percentage-only by design
 *
 * Both writes are throttled per connection, because the chat hot path calls this
 * on every request: the routing cache is rewritten only when a window's remaining
 * share moved by `PASSIVE_CACHE_REFRESH_STEP_PERCENT` (it owns a snapshot row per
 * change), and the Provider Limits row at most once per
 * `PASSIVE_PERSIST_INTERVAL_MS`, only when the numbers changed.
 *
 * No secrets are logged: this module never logs header values, only window keys
 * and connection ids.
 *
 * @module lib/usage/githubQuotaCapture
 */

import { getQuotaCache, setQuotaCache } from "@/domain/quotaCache";
import {
  getProviderLimitsCache,
  setProviderLimitsCache,
  type ProviderLimitsCacheEntry,
} from "@/lib/db/providerLimits";
import {
  parseGitHubQuotaHeaders,
  githubQuotaWindowToUsageQuota,
  type ParsedGitHubQuotaHeaders,
} from "@omniroute/open-sse/services/usage/githubQuotaHeaders.ts";

/** Providers whose responses carry Copilot quota snapshot headers. */
export const GITHUB_QUOTA_CAPTURE_PROVIDERS = ["github", "ghe-copilot"] as const;

export type GitHubQuotaCaptureProvider = (typeof GITHUB_QUOTA_CAPTURE_PROVIDERS)[number];

/** Minimum gap between two durable writes (snapshot rows + provider-limits row). */
export const PASSIVE_PERSIST_INTERVAL_MS = 60_000;

/**
 * Minimum move in a window's remaining share before the routing cache is
 * rewritten. `setQuotaCache` persists a `quota_snapshots` row on every change,
 * and these headers ride on EVERY chat request — without a step, a busy account
 * would write one row per request.
 */
export const PASSIVE_CACHE_REFRESH_STEP_PERCENT = 1;

const PERSIST_SOURCE = "passive";

type PersistState = { at: number; signature: string };

const persistedAt = new Map<string, PersistState>();

export function isGitHubQuotaCaptureProvider(
  provider: string | null | undefined
): provider is GitHubQuotaCaptureProvider {
  if (typeof provider !== "string") return false;
  const normalized = provider.trim().toLowerCase();
  return (GITHUB_QUOTA_CAPTURE_PROVIDERS as readonly string[]).includes(normalized);
}

function windowSignature(parsed: ParsedGitHubQuotaHeaders): string {
  return Object.entries(parsed.windows)
    .map(
      ([key, window]) =>
        `${key}:${window.used}/${window.entitlement}/${window.remaining}/${window.remainingPercentage}/${window.resetAt ?? ""}/${window.overageUsed}/${window.overagePermitted}`
    )
    .sort()
    .join("|");
}

function writeProviderLimitsEntry(
  connectionId: string,
  quotas: Record<string, unknown>,
  observedAt: string
): void {
  // Keep whatever the previous entry carried (plan label, billing, model quotas)
  // and only replace the quota map the passive capture actually knows about.
  const previous = getProviderLimitsCache(connectionId);
  const entry: ProviderLimitsCacheEntry = {
    ...(previous ?? {}),
    plan: previous?.plan ?? null,
    quotas: quotas as ProviderLimitsCacheEntry["quotas"],
    message: null,
    fetchedAt: observedAt,
    source: PERSIST_SOURCE,
  };
  setProviderLimitsCache(connectionId, entry);
}

/**
 * Whether the routing cache should be rewritten for this snapshot.
 *
 * Refresh on first sight, on an explicit force, when a window is new/missing
 * from the cache, or when the remaining share moved by at least
 * `PASSIVE_CACHE_REFRESH_STEP_PERCENT` — `setQuotaCache` writes a snapshot row
 * per change and these headers arrive with every request.
 */
function shouldRefreshQuotaCache(
  connectionId: string,
  quotas: Record<string, unknown>,
  force: boolean
): boolean {
  if (force) return true;

  let cached;
  try {
    cached = getQuotaCache(connectionId);
  } catch {
    return true;
  }
  if (!cached) return true;

  for (const [windowKey, quota] of Object.entries(quotas)) {
    const candidate = quota as {
      remainingPercentage?: number;
      unlimited?: boolean;
      overage?: { permitted?: boolean };
    };
    // `normalizeQuotas` folds an unlimited window to fractionReported:false —
    // its percentage never "moves", so it must not force a rewrite every request.
    if (candidate.unlimited === true) continue;
    const priorPercentage = cached.quotas?.[windowKey]?.remainingPercentage;
    const nextPercentage = candidate.remainingPercentage;
    if (typeof priorPercentage !== "number" || typeof nextPercentage !== "number") return true;
    // A changed overage permission flips the window between routable and
    // exhausted even when the percentage does not move (0% either way), so the
    // routing cache has to follow it.
    if (
      (cached.quotas?.[windowKey]?.overagePermitted === true) !==
      (candidate.overage?.permitted === true)
    ) {
      return true;
    }
    if (Math.abs(priorPercentage - nextPercentage) >= PASSIVE_CACHE_REFRESH_STEP_PERCENT) {
      return true;
    }
  }
  return false;
}

function persistParsedSnapshot(
  provider: GitHubQuotaCaptureProvider,
  connectionId: string,
  parsed: ParsedGitHubQuotaHeaders,
  options: { force?: boolean; now?: number } = {}
): boolean {
  const now = options.now ?? Date.now();
  const observedAt = new Date(now).toISOString();

  const quotas: Record<string, unknown> = {};
  for (const [windowKey, window] of Object.entries(parsed.windows)) {
    quotas[windowKey] = githubQuotaWindowToUsageQuota(window);
  }
  if (Object.keys(quotas).length === 0) return false;

  // Refresh the in-memory cache — but only when a window moved enough to matter.
  // `setQuotaCache` also owns the `quota_snapshots` write (percentage + reset,
  // deduped on change), so this module must NOT insert snapshot rows itself —
  // that would double every row.
  if (shouldRefreshQuotaCache(connectionId, quotas, options.force === true)) {
    setQuotaCache(connectionId, provider, quotas);
  }

  // The credit counts (used / entitlement / overage) that the percentage-only
  // snapshot row cannot carry are stored in the Provider Limits cache entry,
  // which is durable (key_value) and is exactly what the dashboard reads.
  const signature = windowSignature(parsed);
  const previous = persistedAt.get(connectionId);
  if (!options.force && previous) {
    // Nothing changed since the last durable write — no row to add.
    if (previous.signature === signature) return true;
    if (now - previous.at < PASSIVE_PERSIST_INTERVAL_MS) return true;
  }

  try {
    writeProviderLimitsEntry(connectionId, quotas, observedAt);
  } catch (error) {
    console.warn(
      `[GitHubQuota] Failed to refresh provider limits cache for connection ${connectionId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  persistedAt.set(connectionId, { at: now, signature });
  return true;
}

/**
 * Record the Copilot quota snapshot headers of a provider response.
 *
 * Returns true when a snapshot was parsed (whether or not the durable write was
 * throttled), false when the response carried no quota header for a tracked
 * provider. Never throws: this runs on the chat hot path and quota accounting
 * must never break a send.
 */
export function recordGitHubQuotaFromResponseHeaders(input: {
  provider: string | null | undefined;
  connectionId: string | null | undefined;
  headers: unknown;
  now?: number;
  force?: boolean;
}): boolean {
  try {
    const { provider, connectionId } = input;
    if (!isGitHubQuotaCaptureProvider(provider)) return false;
    if (typeof connectionId !== "string" || connectionId.trim().length === 0) return false;

    const parsed = parseGitHubQuotaHeaders(input.headers);
    if (!parsed) return false;

    return persistParsedSnapshot(
      provider.trim().toLowerCase() as GitHubQuotaCaptureProvider,
      connectionId,
      parsed,
      { force: input.force, now: input.now }
    );
  } catch (error) {
    console.warn(
      `[GitHubQuota] Passive capture skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

/** Test-only: drop the per-connection throttle bookkeeping. */
export function __resetGitHubQuotaCaptureStateForTests(): void {
  persistedAt.clear();
}
