import test from "node:test";
import assert from "node:assert/strict";
import { buildKiroUsageResult } from "@omniroute/open-sse/services/usage.ts";

type KiroQuotaResult = {
  plan: string;
  quotas: Record<
    string,
    {
      used: number;
      total: number;
      remaining: number;
      remainingPercentage?: number;
      unlimited: boolean;
    }
  >;
};

function exhaustedKiroUsage(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionInfo: { subscriptionTitle: "Kiro Pro" },
    usageBreakdownList: [
      {
        resourceType: "AGENTIC_REQUEST",
        currentUsageWithPrecision: 100,
        usageLimitWithPrecision: 100,
        freeTrialInfo: {
          currentUsageWithPrecision: 25,
          usageLimitWithPrecision: 25,
        },
      },
    ],
    ...overrides,
  };
}

test("#4469 Kiro overageStatus ENABLED keeps exhausted base quota routable", () => {
  const result = buildKiroUsageResult(
    exhaustedKiroUsage({
      overageConfiguration: { overageStatus: "ENABLED" },
    })
  ) as KiroQuotaResult;

  assert.equal(result.quotas.agentic_request.remaining, 0);
  // Report the real consumption (0% left) even though overage keeps the account routable.
  assert.equal(result.quotas.agentic_request.remainingPercentage, 0);
  assert.equal(result.quotas.agentic_request.unlimited, true);
  assert.equal(result.quotas.agentic_request_freetrial.remainingPercentage, 0);
  assert.equal(result.quotas.agentic_request_freetrial.unlimited, true);
});

test("#4469 Kiro top-level overageEnabled keeps exhausted base quota routable", () => {
  const result = buildKiroUsageResult(
    exhaustedKiroUsage({
      overageEnabled: true,
    })
  ) as KiroQuotaResult;

  assert.equal(result.quotas.agentic_request.remainingPercentage, 0);
  assert.equal(result.quotas.agentic_request.unlimited, true);
});

test("Kiro overage reports the consumed portion instead of a permanent 100% left", () => {
  const result = buildKiroUsageResult({
    subscriptionInfo: { subscriptionTitle: "KIRO POWER" },
    overageConfiguration: { overageStatus: "ENABLED" },
    nextDateReset: 1.782864e9,
    usageBreakdownList: [
      {
        displayName: "Credit",
        resourceType: "CREDIT",
        currentUsageWithPrecision: 1351.45,
        usageLimitWithPrecision: 10000,
      },
    ],
  }) as KiroQuotaResult;

  const credit = result.quotas.credit;
  assert.equal(credit.used, 1351.45);
  assert.equal(credit.total, 10000);
  assert.equal(credit.unlimited, true);
  assert.ok(
    Math.abs((credit.remainingPercentage ?? 0) - 86.4855) < 0.001,
    `expected ~86.49% left, got ${credit.remainingPercentage}`
  );
});

test("#4469 Kiro disabled overage preserves exhausted quota signal", () => {
  const result = buildKiroUsageResult(
    exhaustedKiroUsage({
      overageConfiguration: { overageStatus: "DISABLED" },
      overageEnabled: false,
    })
  ) as KiroQuotaResult;

  assert.equal(result.quotas.agentic_request.remaining, 0);
  assert.equal(result.quotas.agentic_request.remainingPercentage, undefined);
  assert.equal(result.quotas.agentic_request.unlimited, false);
  assert.equal(result.quotas.agentic_request_freetrial.unlimited, false);
});
