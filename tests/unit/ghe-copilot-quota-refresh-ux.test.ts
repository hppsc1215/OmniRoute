/**
 * ghe-copilot-quota-refresh-ux.test.ts
 *
 * The Usage > Provider Limits card for `ghe-copilot` used to report a FALSE
 * failure: every passive capture was wrapped in `_stale: true`, so the dashboard
 * rendered "Last refresh failed — showing cached data" and the health overview
 * flagged `previousSnapshot` after a perfectly successful read. A manual refresh
 * never probed anything either — `resolveCopilotPassiveUsage` short-circuited the
 * fetch for 45 minutes, even on a user-forced sync.
 *
 * These tests pin the split:
 *   - passive capture → `_passive` + `_observedAt`, NEVER `_stale`;
 *   - genuine probe failure → `_stale` (unchanged, all providers);
 *   - manual refresh → live tenant probe first, passive only as fallback;
 *   - one window's used/remaining/percentage come from one observation;
 *   - a plan-less GHE connection is tier "Enterprise", not "Unknown".
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ghe-quota-refresh-ux-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-ghe-quota-refresh-ux-secret";

const coreDb = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const capture = await import("../../src/lib/usage/githubQuotaCapture.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");
const quotaMerge = await import("../../src/lib/usage/providerLimitsQuotaMerge.ts");
const gheCopilot = await import("../../open-sse/services/usage/gheCopilot.ts");
const healthOverview =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/healthOverview.ts");
const providerLimitsUtils =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const RESET_AT = "2026-12-01T00:00:00.000Z";
const PREMIUM = `crUsed=988&ent=5000&ov=0.0&ovPerm=true&rem=80.2&rst=2026-12-01T00%3A00%3A00Z&totRem=4012.5`;
const CHAT = `crUsed=0&ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-12-01T00%3A00%3A00Z&totRem=-1`;

type UsageLike = {
  quotas?: Record<string, Record<string, unknown>>;
  plan?: string | null;
  message?: string | null;
  _passive?: boolean;
  _passiveReason?: string;
  _observedAt?: string;
  _stale?: boolean;
  _staleSince?: string;
  _staleReason?: string;
};

let connectionId = "";

async function resetStorage(options: { withGheUrl?: boolean } = {}) {
  coreDb.resetDbInstance();
  quotaCache.__clearForTests();
  capture.__resetGitHubQuotaCaptureStateForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const connection = await providersDb.createProviderConnection({
    provider: "ghe-copilot",
    authType: "oauth",
    name: `ghe-refresh-ux-${Date.now()}`,
    accessToken: "ghu_test_token",
    refreshToken: "ghr_test_token",
    tokenExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
    isActive: true,
    providerSpecificData: options.withGheUrl ? { gheUrl: "https://ghe.example.com" } : undefined,
  });
  connectionId = connection.id;
}

function capturePassive(now = Date.now(), used = 988) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-quota-snapshot-chat": CHAT,
  };
  headers["x-quota-snapshot-premium_interactions"] = PREMIUM.replace(
    "crUsed=988",
    `crUsed=${used}`
  ).replace("totRem=4012.5", `totRem=${5000 - used}`);
  const recorded = capture.recordGitHubQuotaFromResponseHeaders({
    provider: "ghe-copilot",
    connectionId,
    headers,
    now,
    force: true,
  });
  assert.equal(recorded, true);
}

function seedCacheQuota(
  fetchedAt: string,
  source = "passive",
  options: { percentageOnly?: boolean } = {}
) {
  providerLimitsDb.setProviderLimitsCache(connectionId, {
    quotas: {
      premium_interactions: {
        used: options.percentageOnly ? 0 : 1000,
        total: options.percentageOnly ? 0 : 5000,
        remaining: options.percentageOnly ? undefined : 4000,
        remainingPercentage: 80,
        resetAt: RESET_AT,
        unlimited: false,
        quotaSource: "responseHeaders",
      },
    },
    plan: null,
    message: null,
    fetchedAt,
    source,
  });
}

function liveInternalUserPayload() {
  return {
    copilot_plan: "Copilot Enterprise",
    quota_reset_date: RESET_AT,
    quota_snapshots: {
      premium_interactions: {
        credits_used: 1078,
        entitlement: 5000,
        remaining: 3922.1,
        percent_remaining: 78.4,
        quota_reset_at: RESET_AT,
        unlimited: false,
      },
      chat: { unlimited: true },
      completions: { unlimited: true },
    },
  };
}

/** Replace global fetch for the duration of one test; returns the recorded calls. */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push(url);
    return handler(url);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a passive Copilot capture is healthy: _passive + _observedAt, never _stale", () => {
  const observedAt = new Date().toISOString();
  capturePassive(Date.parse(observedAt));

  const usage = providerLimits.resolveCopilotPassiveUsage(
    "ghe-copilot",
    connectionId
  ) as UsageLike | null;
  assert.ok(usage);
  assert.equal(usage._passive, true);
  assert.equal(usage._observedAt, observedAt);
  assert.equal(usage._passiveReason, quotaMerge.PASSIVE_COPILOT_REASON);
  assert.equal(usage._stale, undefined);
  assert.equal(usage._staleSince, undefined);
  assert.equal(usage._staleReason, undefined);

  // The fallback path used by a live probe that produced no quota carries the
  // same neutral marker (this is the path the card actually renders).
  const fallback = providerLimits.withPassiveCopilotQuotaFallback("ghe-copilot", connectionId, {
    message: "no live quota",
  }) as UsageLike;
  assert.equal(fallback._passive, true);
  assert.equal(fallback._stale, undefined);
});

test("a manual refresh probes the tenant instead of short-circuiting on the fresh snapshot", async () => {
  await resetStorage({ withGheUrl: true });
  capturePassive();
  const stub = stubFetch(() => Response.json(liveInternalUserPayload()));
  try {
    const { usage, cache } = await providerLimits.fetchAndPersistProviderLimits(
      connectionId,
      "manual"
    );
    const typed = usage as UsageLike;
    // The credential refresh mints a Copilot token first; the quota probe is
    // the tenant's copilot_internal/user endpoint, exactly once.
    assert.deepEqual(
      stub.calls.filter((url) => url.endsWith("/copilot_internal/user")),
      ["https://ghe.example.com/api/v3/copilot_internal/user"]
    );
    // The shared GitHub parser derives `used` from entitlement - remaining
    // (the live payload's `credits_used` is not the field it reads), and the
    // result is arithmetically consistent for this one observation.
    assert.equal(typed.quotas?.premium_interactions.used, 1077.9);
    assert.equal(typed.quotas?.premium_interactions.remaining, 3922.1);
    assert.equal(typed.quotas?.premium_interactions.total, 5000);
    assert.equal(typed._passive, undefined);
    assert.equal(typed._stale, undefined);
    // The live reading replaces the passive marker in the durable cache too.
    assert.equal(cache.source, "manual");
    assert.equal(cache.plan, "Copilot Enterprise");
  } finally {
    stub.restore();
  }
});

test("a manual refresh falls back to the passive snapshot when the tenant probe fails", async () => {
  await resetStorage({ withGheUrl: true });
  capturePassive();
  const stub = stubFetch(() => new Response("not found", { status: 404 }));
  try {
    const { usage, cache } = await providerLimits.fetchAndPersistProviderLimits(
      connectionId,
      "manual"
    );
    const typed = usage as UsageLike;
    assert.equal(stub.calls.filter((url) => url.endsWith("/copilot_internal/user")).length, 1);
    assert.equal(typed.quotas?.premium_interactions.used, 988);
    assert.equal(typed._passive, true);
    assert.ok(typed._observedAt);
    // A failed probe that still yields the passive reading is NOT an error card.
    assert.equal(typed._stale, undefined);
    assert.equal(cache.source, "passive");
  } finally {
    stub.restore();
  }
});

test("a background sync keeps the fresh passive snapshot without probing", async () => {
  await resetStorage({ withGheUrl: true });
  capturePassive();
  const stub = stubFetch(() => Response.json(liveInternalUserPayload()));
  try {
    const { usage } = await providerLimits.fetchAndPersistProviderLimits(connectionId, "scheduled");
    assert.equal(stub.calls.filter((url) => url.endsWith("/copilot_internal/user")).length, 0);
    assert.equal((usage as UsageLike)._passive, true);
  } finally {
    stub.restore();
  }
});

test("a genuine probe failure still marks the answer stale", async () => {
  await resetStorage({ withGheUrl: true });
  // A previous reading exists, but it is percentage-only (no credit counts), so
  // it is not a passive credit snapshot and the 404 has no healthy fallback: it
  // must surface as the stale/cached state.
  seedCacheQuota("2026-11-09T10:00:00.000Z", "manual", { percentageOnly: true });
  const stub = stubFetch(() => new Response("not found", { status: 404 }));
  try {
    const { usage } = await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
    const typed = usage as UsageLike;
    assert.equal(typed._stale, true);
    assert.equal(typed._staleSince, "2026-11-09T10:00:00.000Z");
    assert.equal(typed._staleReason, gheCopilot.GHE_COPILOT_NO_DATA_MESSAGE);
    assert.equal(typed._passive, undefined);
  } finally {
    stub.restore();
  }
});

test("health treats a passive capture as healthy and a failed probe as previousSnapshot", () => {
  const connection = {
    id: connectionId,
    provider: "ghe-copilot",
    isActive: true,
    name: "ghe",
  };
  const data = {
    quotas: [
      {
        name: "premium_interactions",
        used: 988,
        total: 5000,
        remaining: 4012.5,
        remainingPercentage: 80.25,
        resetAt: RESET_AT,
      },
    ],
  };

  const passive = healthOverview.buildHealthAccount(connection, {
    ...data,
    raw: { _passive: true },
  });
  assert.equal(
    passive.reasons.some((reason) => reason.type === "previousSnapshot"),
    false
  );

  const stale = healthOverview.buildHealthAccount(connection, {
    ...data,
    raw: { _stale: true },
  });
  assert.equal(
    stale.reasons.some((reason) => reason.type === "previousSnapshot"),
    true
  );
});

test("a plan-less GHE connection is tier Enterprise, other providers stay Unknown", () => {
  const enterprise = providerLimitsUtils.normalizePlanTier(null, "ghe-copilot");
  assert.equal(enterprise.key, "enterprise");
  assert.equal(enterprise.label, "Enterprise");
  assert.equal(providerLimitsUtils.normalizePlanTier("", "ghe-copilot").key, "enterprise");
  // A provider-name fallback (not a plan) also resolves to Enterprise for GHE.
  assert.equal(
    providerLimitsUtils.normalizePlanTier("GitHub Copilot", "ghe-copilot").key,
    "enterprise"
  );

  assert.equal(providerLimitsUtils.normalizePlanTier(null, "github").key, "unknown");
  assert.equal(providerLimitsUtils.normalizePlanTier(null).key, "unknown");
});

test("the card renders a neutral passive hint instead of the refresh-failed tooltip", () => {
  const expanded = fs.readFileSync(
    path.join(
      REPO_ROOT,
      "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/parts/QuotaCardExpanded.tsx"
    ),
    "utf8"
  );
  assert.match(expanded, /passiveQuotaHint/);
  assert.match(expanded, /passiveQuotaAsOf/);
  // The stale tooltip stays bound to hasStaleData only (genuine failures).
  assert.match(expanded, /hasStaleData\s*\n?\s*\?\s*t\("staleQuotaTooltip"\)/);

  const en = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "src/i18n/messages/en.json"), "utf8"));
  const de = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "src/i18n/messages/de.json"), "utf8"));
  for (const key of ["passiveQuotaHint", "passiveQuotaAsOf", "passiveQuotaTooltip"]) {
    assert.equal(typeof en.usage[key], "string", `en.usage.${key}`);
    assert.equal(typeof de.usage[key], "string", `de.usage.${key}`);
  }
});

test("preserveCreditBearingQuotas keeps used/remaining/percentage from one observation", () => {
  const next = {
    quotas: {
      premium_interactions: {
        used: 0,
        total: 0,
        remainingPercentage: 78.4,
        resetAt: RESET_AT,
        isPercentageOnly: true,
      },
    },
    plan: null,
    message: null,
    fetchedAt: "2026-11-09T11:40:00.000Z",
    source: "manual",
  };
  const previous = {
    quotas: {
      premium_interactions: {
        // Deliberately inconsistent legacy row: 1011 + 3925.6 ≠ 5000.
        used: 1011,
        total: 5000,
        remaining: 3925.6,
        remainingPercentage: 78.4,
        resetAt: RESET_AT,
        unlimited: false,
      },
    },
    plan: null,
    message: null,
    fetchedAt: "2026-11-09T11:29:33.000Z",
    source: "passive",
  };

  const merged = quotaMerge.preserveCreditBearingQuotas(next, previous);
  const quota = merged.quotas!.premium_interactions as Record<string, number>;
  assert.equal(quota.used, 1074.4);
  assert.equal(quota.remaining, 3925.6);
  assert.equal(quota.total, 5000);
  assert.ok(Math.abs(quota.used + quota.remaining - quota.total) < 1e-9);
  // The percentage describes the restored counts, not the newer incoming bar.
  assert.ok(Math.abs(quota.remainingPercentage - (3925.6 / 5000) * 100) < 1e-9);
});

test("isPassiveCopilotQuotaUsage recognises the new marker and never a live failure", () => {
  assert.equal(quotaMerge.isPassiveCopilotQuotaUsage("ghe-copilot", { _passive: true }), true);
  assert.equal(
    quotaMerge.isPassiveCopilotQuotaUsage("ghe-copilot", {
      _stale: true,
      _staleReason: quotaMerge.PASSIVE_COPILOT_REASON,
    }),
    true
  );
  assert.equal(
    quotaMerge.isPassiveCopilotQuotaUsage("ghe-copilot", {
      _stale: true,
      _staleReason: "HTTP 429",
    }),
    false
  );
  assert.equal(quotaMerge.isPassiveCopilotQuotaUsage("github", { _passive: true }), false);
});
