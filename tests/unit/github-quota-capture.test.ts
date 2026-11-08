/**
 * github-quota-capture.test.ts
 *
 * Persistence mapping of the passive Copilot quota capture. The capture writes
 * through the mechanisms the active fetchers already use — quota cache (routing)
 * + the `quota_snapshots` row it owns (history, percentage-only), and the
 * Provider Limits cache (the dashboard row, and the only durable carrier of the
 * credit counts). `ghe-copilot` has no quota endpoint to poll, so whatever a
 * response header said is the only accounting the tenant will ever get.
 *
 * Throttling is part of the contract: the capture runs on every chat request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ghe-quota-capture-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const capture = await import("../../src/lib/usage/githubQuotaCapture.ts");
const store = await import("../../src/lib/usage/githubQuotaSnapshotStore.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");

const PREMIUM =
  "crUsed=988&ent=5000&ov=0.0&ovPerm=true&rem=80.2&rst=2026-12-01T00%3A00%3A00Z&totRem=4012.5";
const CHAT = "crUsed=0&ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-12-01T00%3A00%3A00Z&totRem=-1";

const CONNECTION_ID = "conn-ghe-1";

/** Loosely-typed mirrors of the row/entry shapes under test. */
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
type SnapshotRowLike = {
  provider?: string;
  window_key?: string;
  windowKey?: string;
  remaining_percentage?: number | null;
  remainingPercentage?: number | null;
  next_reset_at?: string | null;
  nextResetAt?: string | null;
  is_exhausted?: number;
  raw_data?: string | null;
  rawData?: string | null;
};
type CacheEntryLike = {
  quotas?: Record<string, QuotaLike> | null;
  plan?: unknown;
  message?: string | null;
  fetchedAt?: string;
  source?: string | null;
};

function quotaHeaders(overrides: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-quota-snapshot-premium_interactions": PREMIUM,
    "x-quota-snapshot-chat": CHAT,
    "x-quota-snapshot-completions": CHAT,
    ...overrides,
  };
}

function premiumHeader(used: number, entitlement: number, remaining: number) {
  const percent = ((remaining / entitlement) * 100).toFixed(1);
  return `crUsed=${used}&ent=${entitlement}&ov=0.0&ovPerm=true&rem=${percent}&rst=2026-12-01T00%3A00%3A00Z&totRem=${remaining}`;
}

async function resetStorage() {
  coreDb.resetDbInstance();
  quotaCache.__clearForTests();
  capture.__resetGitHubQuotaCaptureStateForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("only the github family is captured", () => {
  for (const provider of ["github", "ghe-copilot", "GHE-COPILOT", " github "]) {
    assert.equal(capture.isGitHubQuotaCaptureProvider(provider), true, provider);
  }
  for (const provider of ["claude", "codex", "", null, undefined]) {
    assert.equal(capture.isGitHubQuotaCaptureProvider(provider), false, String(provider));
  }

  assert.equal(
    capture.recordGitHubQuotaFromResponseHeaders({
      provider: "claude",
      connectionId: CONNECTION_ID,
      headers: quotaHeaders(),
      force: true,
    }),
    false
  );
  assert.equal(
    capture.recordGitHubQuotaFromResponseHeaders({
      provider: "ghe-copilot",
      connectionId: "",
      headers: quotaHeaders(),
      force: true,
    }),
    false
  );
});

test("a quota-less response is a no-op", () => {
  assert.equal(
    capture.recordGitHubQuotaFromResponseHeaders({
      provider: "ghe-copilot",
      connectionId: CONNECTION_ID,
      headers: { "content-type": "application/json" },
      force: true,
    }),
    false
  );
  assert.equal(quotaCache.getQuotaCache(CONNECTION_ID), null);
  assert.equal(providerLimitsDb.getProviderLimitsCache(CONNECTION_ID), null);
});

test("records the remaining share into the routing quota cache", () => {
  const recorded = capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: Date.parse("2026-11-08T10:00:00.000Z"),
    force: true,
  });
  assert.equal(recorded, true);

  const entry = quotaCache.getQuotaCache(CONNECTION_ID);
  assert.ok(entry);
  assert.equal(entry.provider, "ghe-copilot");

  const premium = entry.quotas.premium_interactions;
  assert.ok(premium);
  // 4012.5 / 5000 credits left.
  assert.equal(premium.remainingPercentage, 80.25);
  assert.equal(premium.resetAt, "2026-12-01T00:00:00.000Z");
  assert.equal(premium.fractionReported, undefined);
  assert.equal(entry.exhausted, false);
});

test("the quota cache keeps the percentage-only snapshot row for history", () => {
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: Date.parse("2026-11-08T10:00:00.000Z"),
    force: true,
  });

  const rows = quotaSnapshotsDb.getLatestQuotaSnapshotsForConnection(CONNECTION_ID);
  // Unlimited chat/completions still produce a window row (they are real windows
  // upstream); what matters is that premium_interactions carries the percentage.
  const premium = rows.find(
    (row) =>
      ((row as unknown as SnapshotRowLike).window_key ??
        (row as unknown as SnapshotRowLike).windowKey) === "premium_interactions"
  ) as unknown as SnapshotRowLike;
  assert.ok(premium);
  assert.equal(premium.provider, "ghe-copilot");
  assert.equal(premium.remaining_percentage ?? premium.remainingPercentage, 80.25);
  assert.equal(premium.next_reset_at ?? premium.nextResetAt, "2026-12-01T00:00:00.000Z");
  // No duplicate insert: one capture produces one row per window.
  const all = quotaSnapshotsDb.getQuotaSnapshots({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    since: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(all.length, rows.length);
});

test("writes the Provider Limits cache entry the dashboard renders", () => {
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "github",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: Date.parse("2026-11-08T10:00:00.000Z"),
    force: true,
  });

  const entry = providerLimitsDb.getProviderLimitsCache(CONNECTION_ID);
  assert.ok(entry);
  assert.equal(entry.source, "passive");
  assert.equal(entry.message, null);
  assert.equal(entry.fetchedAt, "2026-11-08T10:00:00.000Z");

  const quotas = entry.quotas as Record<string, QuotaLike>;
  assert.equal(quotas.premium_interactions.used, 988);
  assert.equal(quotas.premium_interactions.total, 5000);
  assert.equal(quotas.premium_interactions.remaining, 4012.5);
  assert.equal(quotas.premium_interactions.remainingPercentage, 80.25);
  assert.equal(quotas.premium_interactions.resetAt, "2026-12-01T00:00:00.000Z");
  assert.equal(quotas.premium_interactions.unlimited, false);
  // No `fractionReported`: the display layer would read it as "percentage-only"
  // and hide the used / entitlement counts.
  assert.equal(quotas.premium_interactions.fractionReported, undefined);
  assert.deepEqual(quotas.premium_interactions.overage, { used: 0, permitted: true });
  // ent=-1 buckets stay unlimited so the display gate can hide them.
  assert.equal(quotas.chat.unlimited, true);
  assert.equal(quotas.chat.total, 0);
});

test("keeps the previous plan label when refreshing the dashboard cache", () => {
  providerLimitsDb.setProviderLimitsCache(CONNECTION_ID, {
    quotas: null,
    plan: "Copilot Enterprise",
    message: null,
    fetchedAt: "2026-11-01T00:00:00.000Z",
    source: "scheduled",
  });

  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    force: true,
  });

  const entry = providerLimitsDb.getProviderLimitsCache(CONNECTION_ID);
  assert.ok(entry);
  assert.equal(entry.plan, "Copilot Enterprise");
  assert.equal(entry.source, "passive");
});

test("throttles the durable dashboard write but keeps the in-memory quota fresh", () => {
  const first = Date.parse("2026-11-08T10:00:00.000Z");
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: first,
    force: true,
  });

  // 10s later, more credits consumed → the routing cache must reflect it immediately...
  const second = first + 10_000;
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders({
      "x-quota-snapshot-premium_interactions": premiumHeader(1500, 5000, 3500),
    }),
    now: second,
  });
  const cached = quotaCache.getQuotaCache(CONNECTION_ID);
  assert.equal(cached?.quotas.premium_interactions.remainingPercentage, 70);

  // ...while the dashboard row keeps the last persisted snapshot.
  const entry = providerLimitsDb.getProviderLimitsCache(CONNECTION_ID) as CacheEntryLike;
  assert.equal(entry.fetchedAt, "2026-11-08T10:00:00.000Z");
  assert.equal(entry.quotas.premium_interactions.used, 988);
});

test("skips the durable write when the numbers did not change", () => {
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: Date.parse("2026-11-08T10:00:00.000Z"),
    force: true,
  });

  // Same snapshot, far outside the throttle window: nothing to record.
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: Date.parse("2026-11-08T12:00:00.000Z"),
  });

  const entry = providerLimitsDb.getProviderLimitsCache(CONNECTION_ID) as CacheEntryLike;
  assert.equal(entry.fetchedAt, "2026-11-08T10:00:00.000Z");
});

test("sub-percent churn does not rewrite the routing cache or its snapshot row", () => {
  const first = Date.parse("2026-11-08T10:00:00.000Z");
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: first,
    force: true,
  });
  const before = quotaSnapshotsDb.getQuotaSnapshots({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    since: "2000-01-01T00:00:00.000Z",
  }).length;

  // 0.4% drift — a busy account drips credits like this on every request.
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders({
      "x-quota-snapshot-premium_interactions": premiumHeader(1008, 5000, 3992),
    }),
    now: first + 5000,
  });

  const after = quotaSnapshotsDb.getQuotaSnapshots({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    since: "2000-01-01T00:00:00.000Z",
  }).length;
  assert.equal(after, before);

  // The cache keeps the last coarse reading instead of churning.
  const cached = quotaCache.getQuotaCache(CONNECTION_ID);
  assert.equal(cached?.quotas.premium_interactions.remainingPercentage, 80.25);
});

test("writes again once the throttle window elapsed and the numbers moved", () => {
  const first = Date.parse("2026-11-08T10:00:00.000Z");
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: first,
    force: true,
  });

  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders({
      "x-quota-snapshot-premium_interactions": premiumHeader(1500, 5000, 3500),
    }),
    now: first + capture.PASSIVE_PERSIST_INTERVAL_MS + 1,
  });

  const entry = providerLimitsDb.getProviderLimitsCache(CONNECTION_ID) as CacheEntryLike;
  assert.equal(entry.quotas.premium_interactions.used, 1500);
  assert.equal(entry.fetchedAt, "2026-11-08T10:01:00.001Z");
});

test("reads the snapshot back from the Provider Limits cache", () => {
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: Date.parse("2026-11-08T10:00:00.000Z"),
    force: true,
  });

  const snapshot = store.readPassiveGitHubQuotaSnapshot(CONNECTION_ID);
  assert.ok(snapshot);
  assert.equal(snapshot.source, "providerLimits");
  assert.equal(snapshot.observedAt, "2026-11-08T10:00:00.000Z");
  const quotas = snapshot.quotas as Record<string, QuotaLike>;
  assert.equal(quotas.premium_interactions.used, 988);
  assert.equal(quotas.premium_interactions.total, 5000);
});

test("falls back to quota_snapshots when the dashboard cache was cleared", () => {
  capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId: CONNECTION_ID,
    headers: quotaHeaders(),
    now: Date.parse("2026-11-08T10:00:00.000Z"),
    force: true,
  });
  providerLimitsDb.deleteProviderLimitsCache(CONNECTION_ID);

  const snapshot = store.readPassiveGitHubQuotaSnapshot(CONNECTION_ID);
  assert.ok(snapshot);
  assert.equal(snapshot.source, "snapshots");
  const quotas = snapshot.quotas as Record<string, QuotaLike>;
  // The snapshot row is percentage-only; the bar survives a restart, the credit
  // counts do not — that is why the Provider Limits row is the primary source.
  assert.equal(quotas.premium_interactions.remainingPercentage, 80.25);
  assert.equal(quotas.premium_interactions.resetAt, "2026-12-01T00:00:00.000Z");
  assert.equal(quotas.premium_interactions.isPercentageOnly, true);
});

test("never reads a snapshot for an unknown connection", () => {
  assert.equal(store.readPassiveGitHubQuotaSnapshot("nope"), null);
  assert.equal(store.readPassiveGitHubQuotaSnapshot(""), null);
  assert.equal(store.readPassiveGitHubQuotaSnapshot(null), null);
});
