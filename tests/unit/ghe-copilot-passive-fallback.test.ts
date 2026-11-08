/**
 * ghe-copilot-passive-fallback.test.ts
 *
 * How Usage > Provider Limits answers for a `ghe-copilot` connection.
 *
 * The AI-credit snapshot is captured passively on the chat path; this layer
 * decides when that snapshot is authoritative (fresh → no probe at all) and when
 * it is the fallback (the live probe produced no quota). It must never answer
 * for `github`, which has a working public endpoint.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ghe-passive-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");

const CONNECTION_ID = "conn-ghe-fallback";

type QuotaLike = { used?: number; total?: number; remainingPercentage?: number };
type UsageLike = {
  quotas?: Record<string, QuotaLike>;
  message?: string | null;
  _stale?: boolean;
  _staleSince?: string;
};
const RESET_AT = "2026-12-01T00:00:00.000Z";

function passiveEntry(fetchedAt: string, used = 988) {
  return {
    quotas: {
      premium_interactions: {
        used,
        total: 5000,
        remaining: 5000 - used,
        remainingPercentage: ((5000 - used) / 5000) * 100,
        resetAt: RESET_AT,
        unlimited: false,
        quotaSource: "responseHeaders",
      },
    },
    plan: null,
    message: null,
    fetchedAt,
    source: "passive",
  };
}

test.beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a fresh snapshot answers without probing the tenant", () => {
  const now = Date.parse("2026-11-08T10:00:00.000Z");
  providerLimitsDb.setProviderLimitsCache(CONNECTION_ID, passiveEntry("2026-11-08T09:59:00.000Z"));

  const usage = providerLimits.resolveCopilotPassiveUsage(
    "ghe-copilot",
    CONNECTION_ID,
    now
  ) as UsageLike | null;
  assert.ok(usage);
  assert.equal(usage.quotas?.premium_interactions.used, 988);
  assert.equal(usage.quotas?.premium_interactions.total, 5000);
  assert.equal(usage.message, null);
  // The reading time is the last chat response, not "now".
  assert.equal(usage._stale, true);
  assert.equal(usage._staleSince, "2026-11-08T09:59:00.000Z");
});

test("a snapshot older than the freshness window defers to the live probe", () => {
  const now = Date.parse("2026-11-08T10:00:00.000Z");
  providerLimitsDb.setProviderLimitsCache(CONNECTION_ID, passiveEntry("2026-11-08T08:00:00.000Z"));

  assert.equal(providerLimits.resolveCopilotPassiveUsage("ghe-copilot", CONNECTION_ID, now), null);
});

test("an unparsable observation time is treated as stale", () => {
  providerLimitsDb.setProviderLimitsCache(CONNECTION_ID, passiveEntry("not-a-date"));
  assert.equal(providerLimits.resolveCopilotPassiveUsage("ghe-copilot", CONNECTION_ID), null);
});

test("the standard github provider is not served from the passive path", () => {
  providerLimitsDb.setProviderLimitsCache(CONNECTION_ID, passiveEntry(new Date().toISOString()));
  assert.equal(providerLimits.resolveCopilotPassiveUsage("github", CONNECTION_ID), null);
  assert.equal(providerLimits.resolveCopilotPassiveUsage("claude", CONNECTION_ID), null);
});

test("live quotas always win over the fallback", () => {
  providerLimitsDb.setProviderLimitsCache(CONNECTION_ID, passiveEntry(new Date().toISOString()));
  const live = {
    quotas: { premium_interactions: { used: 20, total: 100, remainingPercentage: 80 } },
    message: "fresh from upstream",
  };

  const merged = providerLimits.withPassiveCopilotQuotaFallback(
    "ghe-copilot",
    CONNECTION_ID,
    live
  ) as unknown as UsageLike;
  assert.equal(merged, live);
  assert.equal(merged.message, "fresh from upstream");
});

test("a live probe with no quota degrades to the captured snapshot", () => {
  providerLimitsDb.setProviderLimitsCache(CONNECTION_ID, passiveEntry("2026-11-08T09:59:00.000Z"));

  const merged = providerLimits.withPassiveCopilotQuotaFallback("ghe-copilot", CONNECTION_ID, {
    message: "GitHub Enterprise Copilot connected. AI-credit usage appears here...",
  }) as unknown as UsageLike;

  assert.equal(merged.quotas?.premium_interactions.used, 988);
  assert.equal(merged.message, null);
  assert.equal(merged._stale, true);
});

test("without any snapshot the live answer is passed through untouched", () => {
  const live = { message: "GitHub Enterprise Copilot connected." };
  const merged = providerLimits.withPassiveCopilotQuotaFallback("ghe-copilot", CONNECTION_ID, live);
  assert.equal(merged, live);

  const github = { message: "whatever" };
  assert.equal(
    providerLimits.withPassiveCopilotQuotaFallback("github", CONNECTION_ID, github),
    github
  );
});
