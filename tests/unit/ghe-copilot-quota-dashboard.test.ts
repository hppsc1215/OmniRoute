/**
 * ghe-copilot-quota-dashboard.test.ts
 *
 * Display logic for the GitHub Enterprise Copilot AI-credit card in
 * Usage > Provider Limits. The provider must (a) pass the visibility gate that
 * decides whether the row exists at all, (b) resolve the github column schema so
 * `premium_interactions` lands in a fixed column, and (c) hide the unlimited
 * chat/completions buckets (ent=-1) instead of drawing empty 0% bars.
 */
import test from "node:test";
import assert from "node:assert/strict";

const quotaParsing =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts");
const providerColumns =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/providerColumns.ts");
const quotaUtils =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx");
const providerQuotaVisibility = await import("../../src/shared/utils/providerQuotaVisibility.ts");
const providersConstants = await import("../../src/shared/constants/providers.ts");
const supportedProviders = await import("../../open-sse/services/usage/supportedProviders.ts");
const fetcherProviders = await import("../../open-sse/services/usage/fetcherProviders.ts");

const RESET_AT = "2026-12-01T00:00:00.000Z";

/** Exactly what the passive capture writes into the Provider Limits cache entry. */
const GHE_CACHED_ENTRY = {
  quotas: {
    premium_interactions: {
      used: 988,
      total: 5000,
      remaining: 4012.5,
      remainingPercentage: 80.25,
      resetAt: RESET_AT,
      unlimited: false,
      quotaSource: "responseHeaders",
      overage: { used: 0, permitted: true },
    },
    chat: {
      used: 0,
      total: 0,
      remaining: 0,
      remainingPercentage: 100,
      resetAt: RESET_AT,
      unlimited: true,
      quotaSource: "responseHeaders",
    },
    completions: {
      used: 0,
      total: 0,
      remaining: 0,
      remainingPercentage: 100,
      resetAt: RESET_AT,
      unlimited: true,
      quotaSource: "responseHeaders",
    },
  },
  plan: null,
  message: null,
  fetchedAt: "2026-11-08T10:00:00.000Z",
  source: "passive",
};

test("ghe-copilot is offered in the provider quota view and has a usage fetcher", () => {
  assert.equal(providerQuotaVisibility.supportsProviderQuota("ghe-copilot"), true);
  assert.ok(providersConstants.USAGE_SUPPORTED_PROVIDERS.includes("ghe-copilot"));
  assert.ok(supportedProviders.USAGE_SUPPORTED_PROVIDERS.includes("ghe-copilot"));
  // A provider in the display list without a wired fetcher computes a quota nobody
  // asks for; both lists must agree (usage-provider-list-drift).
  assert.ok(fetcherProviders.USAGE_FETCHER_PROVIDERS.includes("ghe-copilot"));
  // The standard github provider keeps working unchanged.
  assert.equal(providerQuotaVisibility.supportsProviderQuota("github"), true);
});

test("only the AI-credit bucket is rendered; unlimited buckets are hidden", () => {
  const quotas = quotaParsing.parseQuotaData("ghe-copilot", GHE_CACHED_ENTRY);
  assert.deepEqual(
    quotas.map((quota) => quota.name),
    ["premium_interactions"]
  );

  const premium = quotas[0];
  assert.equal(premium.used, 988);
  assert.equal(premium.total, 5000);
  assert.equal(premium.remaining, 4012.5);
  assert.equal(premium.remainingPercentage, 80.25);
  assert.equal(premium.resetAt, RESET_AT);
  assert.equal(premium.staleAfterReset, false);
});

test("the premium row renders used / entitlement and a percentage bar", () => {
  const quotas = quotaParsing.parseQuotaData("ghe-copilot", GHE_CACHED_ENTRY);
  const premium = quotas.find((quota) => quota.name === "premium_interactions");
  assert.ok(premium);

  // The card prints `used / total` only when the quota carries real credit counts.
  assert.equal(quotaUtils.shouldShowQuotaUsageCount(premium), true);
  assert.equal(quotaUtils.isPercentageOnlyQuota(premium), false);
  assert.equal(quotaUtils.getQuotaRemainingPercentage(premium), 80.25);
});

test("ghe-copilot resolves the github column schema", () => {
  const quotas = quotaParsing.parseQuotaData("ghe-copilot", GHE_CACHED_ENTRY);
  const schema = providerColumns.getProviderColumns("ghe-copilot", quotas);

  assert.deepEqual(
    schema.columns.map((column) => column.key),
    ["chat", "completions", "premium_interactions"]
  );
  const premiumColumn = schema.columns.find((column) => column.key === "premium_interactions");
  assert.ok(premiumColumn?.quota);
  assert.equal(premiumColumn.quota.used, 988);
  assert.equal(premiumColumn.quota.total, 5000);
  assert.equal(premiumColumn.label, quotaUtils.formatQuotaLabel("premium_interactions"));
  // chat/completions are unlimited → the column renders as an em-dash cell.
  const chatColumn = schema.columns.find((column) => column.key === "chat");
  assert.equal(chatColumn?.quota, null);
  assert.equal(schema.overflowCount, 0);
});

test("the github provider keeps its existing three-column schema", () => {
  const schema = providerColumns.getProviderColumns("github", [
    { name: "premium_interactions", used: 120, total: 300, remaining: 180 },
  ]);
  assert.deepEqual(
    schema.columns.map((column) => column.key),
    ["chat", "completions", "premium_interactions"]
  );
});

test("a percentage-only fallback snapshot still renders a bar, without credit counts", () => {
  const quotas = quotaParsing.parseQuotaData("ghe-copilot", {
    quotas: {
      premium_interactions: {
        used: 0,
        total: 0,
        remaining: 0,
        remainingPercentage: 80,
        resetAt: RESET_AT,
        unlimited: false,
        fractionReported: true,
        isPercentageOnly: true,
        quotaSource: "responseHeaders",
      },
    },
  });

  const premium = quotas[0];
  assert.equal(premium.name, "premium_interactions");
  assert.equal(premium.remainingPercentage, 80);
  assert.equal(premium.isPercentageOnly, true);
  assert.equal(quotaUtils.shouldShowQuotaUsageCount(premium), false);
});

test("an exhausted AI-credit window survives the parser", () => {
  const quotas = quotaParsing.parseQuotaData("ghe-copilot", {
    quotas: {
      premium_interactions: {
        used: 5000,
        total: 5000,
        remaining: 0,
        remainingPercentage: 0,
        resetAt: RESET_AT,
        unlimited: false,
      },
    },
  });
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].remainingPercentage, 0);
});
