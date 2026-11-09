/**
 * ghe-copilot-quota-degradation.test.ts
 *
 * Regression for the live "AI credits disappeared" failure: Usage > Provider
 * Limits showed `used=0 / total=0 / isPercentageOnly=true` for a `ghe-copilot`
 * connection and never recovered.
 *
 * The loop was:
 *   passive capture writes counts with `source:"passive"`
 *   → the next manual Provider Limits sync re-stamps the row as `manual`
 *   → `readPassiveGitHubQuotaSnapshot` ignores a non-`passive` row
 *   → it falls back to `quota_snapshots`, whose `raw_data` held only the two
 *     boolean flags, so the read fabricated a percentage-only quota
 *   → that degraded quota was written back, self-perpetuating.
 *
 * These tests exercise the real modules (DB + cache + sync) end to end; only the
 * upstream HTTP call is avoided by serving the passively captured snapshot,
 * which is exactly what production does while that snapshot is fresh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ghe-quota-degradation-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-ghe-quota-degradation-secret";

const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const capture = await import("../../src/lib/usage/githubQuotaCapture.ts");
const store = await import("../../src/lib/usage/githubQuotaSnapshotStore.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");
const quotaMerge = await import("../../src/lib/usage/providerLimitsQuotaMerge.ts");

const RESET_AT = "2026-12-01T00:00:00.000Z";
const USED = 998;
const ENTITLEMENT = 5000;
const REMAINING = ENTITLEMENT - USED;

// Live header shape: crUsed / ent / ov / ovPerm / rem / rst / totRem.
const PREMIUM = `crUsed=${USED}&ent=${ENTITLEMENT}&ov=0.0&ovPerm=true&rem=80.0&rst=2026-12-01T00%3A00%3A00Z&totRem=${REMAINING}`;
const CHAT = "crUsed=0&ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-12-01T00%3A00%3A00Z&totRem=-1";

type QuotaLike = {
  used?: number;
  total?: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt?: string | null;
  unlimited?: boolean;
  fractionReported?: boolean;
  isPercentageOnly?: boolean;
  quotaSource?: string;
  overage?: { used: number; permitted: boolean };
};
type EntryLike = {
  quotas?: Record<string, QuotaLike> | null;
  plan?: unknown;
  message?: string | null;
  fetchedAt?: string;
  source?: string | null;
};

type SnapshotRowView = {
  windowKey?: string;
  rawData?: string | null;
  remainingPercentage?: number | null;
};

let connectionId = "";

/**
 * The DB helper returns camelCase rows at runtime (rowToCamel); its declared
 * type is the snake_case storage shape, so read through the runtime shape.
 */
function snapshots(id: string): SnapshotRowView[] {
  return quotaSnapshotsDb.getLatestQuotaSnapshotsForConnection(id) as unknown as SnapshotRowView[];
}

async function resetStorage() {
  coreDb.resetDbInstance();
  quotaCache.__clearForTests();
  capture.__resetGitHubQuotaCaptureStateForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const connection = await providersDb.createProviderConnection({
    provider: "ghe-copilot",
    authType: "oauth",
    name: `ghe-quota-degradation-${Date.now()}`,
    accessToken: "ghu_test_token",
    refreshToken: "ghr_test_token",
    tokenExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
    isActive: true,
  });
  connectionId = connection.id;
}

function capturePassiveSnapshot(now = Date.now()) {
  const recorded = capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId,
    headers: {
      "content-type": "application/json",
      "x-quota-snapshot-premium_interactions": PREMIUM,
      "x-quota-snapshot-chat": CHAT,
    },
    now,
    force: true,
  });
  assert.equal(recorded, true);
}

function seedSnapshotRow(options: {
  windowKey?: string;
  percentage: number | null;
  rawData: string | null;
}) {
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "ghe-copilot",
    connection_id: connectionId,
    window_key: options.windowKey ?? "premium_interactions",
    remaining_percentage: options.percentage,
    is_exhausted: 0,
    next_reset_at: RESET_AT,
    window_duration_ms: null,
    raw_data: options.rawData,
  });
}

function premium(entry: EntryLike | null | undefined): QuotaLike {
  const quota = entry?.quotas?.premium_interactions;
  assert.ok(quota, "expected a premium_interactions quota");
  return quota;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a manual Provider Limits sync never degrades a passively captured credit balance", async () => {
  capturePassiveSnapshot();

  const captured = providerLimitsDb.getProviderLimitsCache(connectionId) as EntryLike | null;
  assert.equal(captured?.source, "passive");
  assert.equal(premium(captured).used, USED);
  assert.equal(premium(captured).total, ENTITLEMENT);

  // 1st manual sync — the action that used to re-stamp the row as `manual`.
  await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
  const afterFirst = providerLimitsDb.getProviderLimitsCache(connectionId) as EntryLike | null;
  assert.equal(afterFirst?.source, "passive", "the passive marker must survive a manual sync");
  assert.equal(premium(afterFirst).used, USED);
  assert.equal(premium(afterFirst).total, ENTITLEMENT);
  assert.equal(premium(afterFirst).isPercentageOnly, undefined);

  // 2nd manual sync, still with no chat traffic — the live loop degraded here.
  // `resolveCopilotPassiveUsage` now reads the row it wrote itself, so if the
  // marker or the counts were lost this sync would persist 0/0 for good.
  await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
  const afterSecond = providerLimitsDb.getProviderLimitsCache(connectionId) as EntryLike | null;
  assert.equal(afterSecond?.source, "passive");
  assert.equal(premium(afterSecond).used, USED);
  assert.equal(premium(afterSecond).total, ENTITLEMENT);
  assert.equal(premium(afterSecond).remaining, REMAINING);
  assert.equal(premium(afterSecond).isPercentageOnly, undefined);
});

test("a credit-bearing cache row is trusted even when its source is not passive", () => {
  providerLimitsDb.setProviderLimitsCache(connectionId, {
    quotas: {
      premium_interactions: {
        used: USED,
        total: ENTITLEMENT,
        remaining: REMAINING,
        remainingPercentage: 80.04,
        resetAt: RESET_AT,
        unlimited: false,
        quotaSource: "responseHeaders",
      },
    },
    plan: null,
    message: null,
    fetchedAt: new Date().toISOString(),
    source: "manual",
  });
  // The degraded snapshot row is older/less useful; the counts must win.
  seedSnapshotRow({ percentage: 79.7, rawData: null });

  const snapshot = store.readPassiveGitHubQuotaSnapshot(connectionId);
  assert.equal(snapshot?.source, "providerLimits");
  assert.equal(premium(snapshot).used, USED);
  assert.equal(premium(snapshot).total, ENTITLEMENT);
  assert.equal(premium(snapshot).isPercentageOnly, undefined);
});

test("a percentage-only cache row is still rejected in favour of the snapshots", () => {
  providerLimitsDb.setProviderLimitsCache(connectionId, {
    quotas: {
      premium_interactions: {
        used: 0,
        total: 0,
        remaining: 0,
        remainingPercentage: 79.7,
        resetAt: RESET_AT,
        unlimited: false,
        fractionReported: true,
        isPercentageOnly: true,
        quotaSource: "responseHeaders",
      },
    },
    plan: null,
    message: null,
    fetchedAt: new Date().toISOString(),
    source: "manual",
  });
  seedSnapshotRow({ percentage: 65.5, rawData: null });

  const snapshot = store.readPassiveGitHubQuotaSnapshot(connectionId);
  assert.equal(snapshot?.source, "snapshots");
  assert.equal(premium(snapshot).used, 0);
  assert.equal(premium(snapshot).total, 0);
  assert.equal(premium(snapshot).isPercentageOnly, true);
  assert.equal(premium(snapshot).remainingPercentage, 65.5);
});

test("an all-percentage-only sync result does not overwrite cached credit counts", () => {
  const previous = {
    quotas: {
      premium_interactions: {
        used: USED,
        total: ENTITLEMENT,
        remaining: REMAINING,
        remainingPercentage: 80.04,
        resetAt: RESET_AT,
        unlimited: false,
        quotaSource: "responseHeaders",
        overage: { used: 0, permitted: true },
      },
    },
    plan: null,
    message: null,
    fetchedAt: "2026-11-09T08:51:12.000Z",
    source: "passive",
  };
  const degradedSyncUsage = {
    quotas: {
      premium_interactions: {
        used: 0,
        total: 0,
        remaining: 0,
        remainingPercentage: 79.7,
        resetAt: RESET_AT,
        unlimited: false,
        fractionReported: true,
        isPercentageOnly: true,
        quotaSource: "responseHeaders",
      },
    },
    message: null,
  };

  const { next, cache } = quotaMerge.buildProviderLimitsCacheEntry(
    "ghe-copilot",
    degradedSyncUsage,
    "manual",
    previous
  );
  // The raw conversion is still degraded…
  assert.equal(premium(next).used, 0);
  // …but the persisted entry keeps the counts, drops the percentage-only flag,
  // and still takes the fresh percentage.
  assert.equal(premium(cache).used, USED);
  assert.equal(premium(cache).total, ENTITLEMENT);
  assert.equal(premium(cache).remaining, REMAINING);
  assert.equal(premium(cache).remainingPercentage, 79.7);
  assert.equal(premium(cache).isPercentageOnly, undefined);
});

test("a real credit update still replaces the cached counts", () => {
  const previous = {
    quotas: {
      premium_interactions: {
        used: USED,
        total: ENTITLEMENT,
        remaining: REMAINING,
        remainingPercentage: 80.04,
        resetAt: RESET_AT,
        unlimited: false,
      },
    },
    plan: null,
    message: null,
    fetchedAt: "2026-11-09T08:51:12.000Z",
    source: "passive",
  };
  const nextUsage = {
    quotas: {
      premium_interactions: {
        used: 1200,
        total: ENTITLEMENT,
        remaining: ENTITLEMENT - 1200,
        remainingPercentage: 76,
        resetAt: RESET_AT,
        unlimited: false,
      },
    },
    message: null,
  };

  const { cache } = quotaMerge.buildProviderLimitsCacheEntry(
    "ghe-copilot",
    nextUsage,
    "manual",
    previous
  );
  assert.equal(premium(cache).used, 1200);
  assert.equal(premium(cache).remaining, ENTITLEMENT - 1200);
});

test("counts from a previous reset period are not preserved", () => {
  const previous = {
    quotas: {
      premium_interactions: {
        used: USED,
        total: ENTITLEMENT,
        remaining: REMAINING,
        remainingPercentage: 80.04,
        resetAt: RESET_AT,
        unlimited: false,
      },
    },
    plan: null,
    message: null,
    fetchedAt: "2026-11-09T08:51:12.000Z",
    source: "passive",
  };
  const degradedNextPeriod = {
    quotas: {
      premium_interactions: {
        used: 0,
        total: 0,
        remaining: 0,
        remainingPercentage: 100,
        resetAt: "2027-01-01T00:00:00.000Z",
        unlimited: false,
        isPercentageOnly: true,
      },
    },
    message: null,
  };

  const { cache } = quotaMerge.buildProviderLimitsCacheEntry(
    "ghe-copilot",
    degradedNextPeriod,
    "manual",
    previous
  );
  assert.equal(premium(cache).used, 0);
  assert.equal(premium(cache).total, 0);
});

test("setQuotaCache persists credit counts into raw_data and the snapshot read is lossless", () => {
  quotaCache.setQuotaCache(
    connectionId,
    "ghe-copilot",
    {
      premium_interactions: {
        used: USED,
        total: ENTITLEMENT,
        remaining: REMAINING,
        remainingPercentage: 80.04,
        resetAt: RESET_AT,
        unlimited: false,
        overage: { used: 3, permitted: true },
      },
      chat: {
        used: 0,
        total: 0,
        remaining: 0,
        remainingPercentage: 100,
        resetAt: RESET_AT,
        unlimited: true,
      },
    },
    {}
  );

  const rows = snapshots(connectionId);
  const premiumRow = rows.find((row) => row.windowKey === "premium_interactions");
  assert.ok(premiumRow?.rawData);
  const metadata = JSON.parse(premiumRow.rawData as string);
  assert.deepEqual(metadata, {
    source: "response_headers",
    creditsUsed: USED,
    entitlement: ENTITLEMENT,
    remaining: REMAINING,
    remainingPercentage: 80.04,
    unlimited: false,
    overageUsed: 3,
    overagePermitted: true,
  });

  // The unlimited window has no real counts: legacy boolean-only metadata.
  const chatRow = rows.find((row) => row.windowKey === "chat");
  assert.equal(chatRow?.rawData, '{"fractionReported":false}');

  // Without a Provider Limits row the read must rebuild the counts from the
  // snapshot row, not the degraded percentage-only shape.
  providerLimitsDb.deleteProviderLimitsCache(connectionId);
  const snapshot = store.readPassiveGitHubQuotaSnapshot(connectionId);
  assert.equal(snapshot?.source, "snapshots");
  assert.equal(premium(snapshot).used, USED);
  assert.equal(premium(snapshot).total, ENTITLEMENT);
  assert.equal(premium(snapshot).remaining, REMAINING);
  assert.equal(premium(snapshot).isPercentageOnly, undefined);
});

test("a count change with an unchanged percentage still writes a snapshot row", () => {
  const quotas = (used: number) => ({
    premium_interactions: {
      used,
      total: ENTITLEMENT,
      remaining: ENTITLEMENT - used,
      // Same one-decimal percentage for both counts, as the live header does.
      remainingPercentage: 80.0,
      resetAt: RESET_AT,
      unlimited: false,
    },
  });

  quotaCache.setQuotaCache(connectionId, "ghe-copilot", quotas(USED), {});
  quotaCache.setQuotaCache(connectionId, "ghe-copilot", quotas(USED + 1), {});

  const rows = snapshots(connectionId);
  const premiumRow = rows.find((row) => row.windowKey === "premium_interactions");
  const metadata = JSON.parse(premiumRow?.rawData as string);
  assert.equal(metadata.creditsUsed, USED + 1);
});

test("legacy raw_data rows keep producing the degraded percentage-only shape", () => {
  providerLimitsDb.deleteProviderLimitsCache(connectionId);
  seedSnapshotRow({ percentage: 79.7, rawData: null });

  const snapshot = store.readPassiveGitHubQuotaSnapshot(connectionId);
  assert.equal(snapshot?.source, "snapshots");
  assert.equal(premium(snapshot).used, 0);
  assert.equal(premium(snapshot).total, 0);
  assert.equal(premium(snapshot).remaining, 0);
  assert.equal(premium(snapshot).remainingPercentage, 79.7);
  assert.equal(premium(snapshot).isPercentageOnly, true);
});

test("legacy fractionReported:false rows stay hidden from the snapshot read", () => {
  providerLimitsDb.deleteProviderLimitsCache(connectionId);
  seedSnapshotRow({ percentage: 0, rawData: '{"fractionReported":false}' });

  assert.equal(store.readPassiveGitHubQuotaSnapshot(connectionId), null);
});

test("percentage-only windows keep the legacy boolean-only raw_data", () => {
  quotaCache.setQuotaCache(
    connectionId,
    "ghe-copilot",
    {
      premium_interactions: {
        used: 0,
        total: 0,
        remaining: 0,
        remainingPercentage: 0,
        resetAt: RESET_AT,
        fractionReported: false,
      },
    },
    {}
  );

  const rows = snapshots(connectionId);
  const row = rows.find((entry) => entry.windowKey === "premium_interactions");
  assert.deepEqual(JSON.parse(row?.rawData as string), { fractionReported: false });
});
