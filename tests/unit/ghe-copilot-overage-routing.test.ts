/**
 * ghe-copilot-overage-routing.test.ts
 *
 * Regression guard for the dangerous half of the passive Copilot capture:
 * `x-quota-snapshot-premium_interactions` can legitimately read `rem=0.0`
 * (all 5000 AI credits consumed) while `ovPerm=true` says the account may keep
 * serving and be billed for the overage. Parking that connection until the
 * monthly reset would take a working `ghe-copilot` connection out of routing
 * for weeks.
 *
 * Covered:
 *   a) used == entitlement + ovPerm=true  -> not exhausted, routing keeps it,
 *      quota cutoff policy does not block, and the exemption survives a cache
 *      eviction/restart through the `quota_snapshots` metadata;
 *   b) used == entitlement + ovPerm=false -> documented behaviour: exhausted
 *      until the reset (upstream rejects credit-billed requests anyway);
 *   c) 988 / 5000 + ovPerm=true           -> dashboard keeps used / entitlement,
 *      ~80% left, reset date, plus the overage marker.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ghe-overage-routing-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const quotaCache = await import("../../src/domain/quotaCache.ts");
const capture = await import("../../src/lib/usage/githubQuotaCapture.ts");
const quotaParsing =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts");
const quotaUtils =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx");
const { evaluateQuotaLimitPolicy } = await import("../../src/sse/services/quotaLimitPolicy.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");

const RESET_HEADER = "2026-12-01T00%3A00%3A00Z";
const RESET_ISO = "2026-12-01T00:00:00.000Z";
const OBSERVED_AT = Date.parse("2026-11-08T10:00:00.000Z");

const CHAT = `crUsed=0&ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=${RESET_HEADER}&totRem=-1`;

function premiumHeader(input: {
  used: number;
  entitlement?: number;
  remaining: number;
  remainingPercentage: number;
  overagePermitted: boolean;
}): string {
  const entitlement = input.entitlement ?? 5000;
  return [
    `crUsed=${input.used}`,
    `ent=${entitlement}`,
    "ov=0.0",
    `ovPerm=${input.overagePermitted}`,
    `rem=${input.remainingPercentage}`,
    `rst=${RESET_HEADER}`,
    `totRem=${input.remaining}`,
  ].join("&");
}

function headers(premium: string): Record<string, string> {
  return {
    "x-quota-snapshot-premium_interactions": premium,
    "x-quota-snapshot-chat": CHAT,
    "x-quota-snapshot-completions": CHAT,
  };
}

function captureSnapshot(connectionId: string, premium: string, now = OBSERVED_AT): void {
  const recorded = capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId,
    headers: headers(premium),
    force: true,
    now,
  });
  assert.equal(recorded, true);
}

// ─── (a) credits exhausted, overage permitted ───────────────────────────────

test("ovPerm=true + all credits used keeps the connection routable", () => {
  const connectionId = "conn-ghe-overage-on";
  captureSnapshot(
    connectionId,
    premiumHeader({
      used: 5000,
      remaining: 0,
      remainingPercentage: 0,
      overagePermitted: true,
    })
  );

  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry);
  // The real reading is preserved for display...
  assert.equal(entry.quotas.premium_interactions.remainingPercentage, 0);
  assert.equal(entry.quotas.premium_interactions.overagePermitted, true);
  // ...but it is informational for routing, so nothing is parked.
  assert.equal(entry.exhausted, false);
  assert.equal(entry.nextResetAt, null);

  // Exactly what auth.ts (quota-aware selection) and quotaStrategies.ts call.
  assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, "ghe-copilot"), false);
  assert.equal(quotaCache.isAccountQuotaExhausted(connectionId), false);

  // Combo health / per-connection cutoff policy must not see a 0% cutoff either.
  assert.equal(
    quotaCache.getQuotaWindowStatus(connectionId, "premium_interactions")?.reachedThreshold,
    false
  );
  assert.deepEqual(
    evaluateQuotaLimitPolicy("ghe-copilot", {
      id: connectionId,
      providerSpecificData: {
        limitPolicy: {
          enabled: true,
          windows: ["premium_interactions"],
          thresholdPercent: 2,
        },
      },
    }).blocked,
    false
  );
});

test("the overage exemption survives a cache eviction (quota_snapshots hydrate)", () => {
  const connectionId = "conn-ghe-overage-on";
  quotaCache.__clearForTests();
  assert.equal(quotaCache.getQuotaCache(connectionId), null);

  // No in-memory entry: this hydrates from quota_snapshots, the path a process
  // restart takes. raw_data must carry the interpretation flag, not just 0%.
  assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, "ghe-copilot"), false);
  const hydrated = quotaCache.getQuotaCache(connectionId);
  assert.ok(hydrated);
  assert.equal(hydrated.quotas.premium_interactions.overagePermitted, true);
  assert.equal(hydrated.exhausted, false);
});

// ─── (b) credits exhausted, overage NOT permitted ───────────────────────────

test("ovPerm=false + all credits used is exhausted until the reset (documented)", () => {
  const connectionId = "conn-ghe-overage-off";
  captureSnapshot(
    connectionId,
    premiumHeader({
      used: 5000,
      remaining: 0,
      remainingPercentage: 0,
      overagePermitted: false,
    })
  );

  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry);
  assert.equal(entry.quotas.premium_interactions.overagePermitted, undefined);
  // Conservative by design: without overage the upstream has no way to serve a
  // credit-billed request, so the account is parked until the monthly reset.
  assert.equal(entry.exhausted, true);
  // #14359 caps the park window; the stored reset is the cap, not the raw rst.
  assert.ok(entry.nextResetAt);
  assert.ok(Date.parse(entry.nextResetAt as string) > Date.now());
  assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, "ghe-copilot"), true);
});

// ─── (c) normal reading: 988 / 5000 ─────────────────────────────────────────

test("a changed ovPerm repairs a cache parked by the previous reading", () => {
  const connectionId = "conn-ghe-overage-flip";
  captureSnapshot(
    connectionId,
    premiumHeader({
      used: 5000,
      remaining: 0,
      remainingPercentage: 0,
      overagePermitted: false,
    })
  );
  assert.equal(quotaCache.getQuotaCache(connectionId)?.exhausted, true);

  // Same 0% reading, only the overage permission changed. No `force`: the
  // throttle must still let the routing cache follow the permission flip (a
  // 0%->0% move alone would otherwise skip the rewrite).
  const recorded = capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId,
    headers: headers(
      premiumHeader({
        used: 5000,
        remaining: 0,
        remainingPercentage: 0,
        overagePermitted: true,
      })
    ),
    now: OBSERVED_AT + 1_000,
  });
  assert.equal(recorded, true);

  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry);
  assert.equal(entry.quotas.premium_interactions.overagePermitted, true);
  assert.equal(entry.exhausted, false);
  assert.equal(quotaCache.isQuotaExhaustedForRequest(connectionId, "ghe-copilot"), false);
});

test("988 / 5,000 displays credits, ~80% left, reset date and the overage marker", () => {
  const connectionId = "conn-ghe-normal";
  captureSnapshot(
    connectionId,
    premiumHeader({
      used: 988,
      remaining: 4012.5,
      remainingPercentage: 80.2,
      overagePermitted: true,
    })
  );

  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry);
  assert.equal(entry.exhausted, false);
  // 4012.5 / 5000 is what the credit counts say; `rem=80.2` is upstream's rounded view.
  assert.equal(entry.quotas.premium_interactions.remainingPercentage, 80.25);

  const rows = quotaParsing.parseQuotaData("ghe-copilot", {
    quotas: providerLimitsDb.getProviderLimitsCache(connectionId)?.quotas,
  }) as Array<Record<string, unknown>>;
  const premium = rows.find((row) => row.name === "premium_interactions");
  assert.ok(premium);

  assert.equal(premium.used, 988);
  assert.equal(premium.total, 5000);
  assert.equal(premium.remaining, 4012.5);
  assert.equal(premium.remainingPercentage, 80.25);
  assert.equal(premium.resetAt, RESET_ISO);
  assert.deepEqual(premium.overage, { used: 0, permitted: true });

  // The row must render credits, not collapse to a percentage-only bar.
  assert.equal(quotaUtils.shouldShowQuotaUsageCount(premium), true);
  assert.equal(
    `${Number(premium.used).toLocaleString("en-US")} / ${Number(premium.total).toLocaleString(
      "en-US"
    )}`,
    "988 / 5,000"
  );
  assert.equal(Math.round(quotaUtils.getQuotaRemainingPercentage(premium)), 80);
  assert.equal(Math.round(Number(premium.remainingPercentage)), 80);
});

test("a fully consumed overage window still displays 5,000 / 5,000 and 0% left", () => {
  const connectionId = "conn-ghe-overage-display";
  captureSnapshot(
    connectionId,
    premiumHeader({
      used: 5000,
      remaining: 0,
      remainingPercentage: 0,
      overagePermitted: true,
    })
  );

  const entry = quotaCache.getQuotaCache(connectionId);
  assert.ok(entry);
  const rows = quotaParsing.parseQuotaData("ghe-copilot", {
    quotas: providerLimitsDb.getProviderLimitsCache(connectionId)?.quotas,
  }) as Array<Record<string, unknown>>;
  const premium = rows.find((row) => row.name === "premium_interactions");
  assert.ok(premium);
  assert.equal(quotaUtils.shouldShowQuotaUsageCount(premium), true);
  assert.equal(premium.used, 5000);
  assert.equal(premium.total, 5000);
  assert.equal(quotaUtils.getQuotaRemainingPercentage(premium), 0);
  assert.equal((premium.overage as { permitted?: boolean }).permitted, true);
});
