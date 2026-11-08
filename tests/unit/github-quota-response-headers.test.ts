/**
 * github-quota-response-headers.test.ts
 *
 * GitHub Copilot reports the account's AI-credit state on every inference
 * response as `x-quota-snapshot-*` headers. For GitHub Enterprise
 * (`ghe-copilot`) that is the ONLY quota source — the public
 * api.github.com/copilot_internal/user endpoint is not the tenant's API — so the
 * parse has to be exact: a mis-read `ent=-1` renders an unlimited bucket as a 0%
 * bar, and a mis-parsed `rst` parks the account past a window that replenished.
 *
 * The fixture values are the measured (URL-encoded) header from a live GHE
 * connection: ent 5000, crUsed 988, totRem 4012.5, rem 80.2.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GITHUB_QUOTA_HEADER_PREFIX,
  githubQuotaHeadersToUsageQuotas,
  githubQuotaWindowToUsageQuota,
  parseGitHubQuotaHeaders,
  parseGitHubQuotaResetAt,
  parseGitHubQuotaSnapshotHeader,
} from "../../open-sse/services/usage/githubQuotaHeaders.ts";

const PREMIUM =
  "crUsed=988&ent=5000&ov=0.0&ovPerm=true&rem=80.2&rst=2026-12-01T00%3A00%3A00Z&totRem=4012.5";
const CHAT =
  "crUsed=0&ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-12-01T00%3A00%3A00Z&totRem=-1";
const COMPLETIONS =
  "crUsed=0&ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-12-01T00%3A00%3A00Z&totRem=-1";

function headers(record: Record<string, string>) {
  return record;
}

test("parses the measured premium_interactions header into credits used / entitlement", () => {
  const window = parseGitHubQuotaSnapshotHeader(PREMIUM);
  assert.ok(window);
  assert.equal(window.unlimited, false);
  assert.equal(window.used, 988);
  assert.equal(window.entitlement, 5000);
  assert.equal(window.remaining, 4012.5);
  // 4012.5 / 5000 = 80.25% — computed from the credit counts, not the rounded `rem`.
  assert.equal(window.remainingPercentage, 80.25);
  // `rst` is URL-encoded upstream and must be decoded to a real ISO instant.
  assert.equal(window.resetAt, "2026-12-01T00:00:00.000Z");
  assert.equal(window.overageUsed, 0);
  assert.equal(window.overagePermitted, true);
});

test("ent=-1 is unlimited and never reported as an exhausted window", () => {
  const window = parseGitHubQuotaSnapshotHeader(CHAT);
  assert.ok(window);
  assert.equal(window.unlimited, true);
  assert.equal(window.entitlement, 0);
  assert.equal(window.remaining, 0);
  assert.equal(window.remainingPercentage, 100);
  assert.equal(window.resetAt, "2026-12-01T00:00:00.000Z");
});

test("collects every quota window of a response and keeps the earliest reset", () => {
  const parsed = parseGitHubQuotaHeaders(
    headers({
      "x-ratelimit-remaining": "42",
      [`${GITHUB_QUOTA_HEADER_PREFIX}premium_interactions`]: PREMIUM,
      [`${GITHUB_QUOTA_HEADER_PREFIX}chat`]: CHAT,
      [`${GITHUB_QUOTA_HEADER_PREFIX}completions`]:
        "crUsed=0&ent=300&ov=0.0&ovPerm=false&rem=50.0&rst=2026-11-15T00%3A00%3A00Z&totRem=150",
    })
  );
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed.windows).sort(), [
    "chat",
    "completions",
    "premium_interactions",
  ]);
  assert.equal(parsed.windows.completions.remaining, 150);
  assert.equal(parsed.resetAt, "2026-11-15T00:00:00.000Z");
});

test("accepts a Headers-like object (real provider responses) as well as a plain record", () => {
  const headerObject = new Headers();
  headerObject.set(`${GITHUB_QUOTA_HEADER_PREFIX}premium_interactions`, PREMIUM);
  const parsed = parseGitHubQuotaHeaders(headerObject);
  assert.ok(parsed);
  assert.equal(parsed.windows.premium_interactions.used, 988);
});

test("returns null when the response carries no quota snapshot header", () => {
  assert.equal(
    parseGitHubQuotaHeaders(headers({ "content-type": "application/json" })),
    null
  );
  assert.equal(parseGitHubQuotaHeaders(null), null);
  assert.equal(parseGitHubQuotaHeaders(undefined), null);
  assert.equal(parseGitHubQuotaHeaders({}), null);
});

test("skips garbage instead of publishing a bogus 0%-remaining quota", () => {
  const parsed = parseGitHubQuotaHeaders(
    headers({
      [`${GITHUB_QUOTA_HEADER_PREFIX}premium_interactions`]: "not a query string",
      [`${GITHUB_QUOTA_HEADER_PREFIX}chat`]: "",
      // Unparseable value, missing every field.
      [`${GITHUB_QUOTA_HEADER_PREFIX}completions`]: "crUsed=&ent=&totRem=&rem=",
    })
  );
  assert.equal(parsed, null);
});

test("ignores header suffixes that are not usable window keys", () => {
  const parsed = parseGitHubQuotaHeaders(
    headers({
      [`${GITHUB_QUOTA_HEADER_PREFIX}premium_interactions`]: PREMIUM,
      // Path traversal / injection-ish suffixes must never reach the DB as a window key.
      [`${GITHUB_QUOTA_HEADER_PREFIX}../../etc/passwd`]: PREMIUM,
      [`${GITHUB_QUOTA_HEADER_PREFIX}`]: PREMIUM,
    })
  );
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed.windows), ["premium_interactions"]);
});

test("tolerates a partially decoded / non-encoded reset timestamp", () => {
  assert.equal(parseGitHubQuotaResetAt("2026-12-01T00:00:00Z"), "2026-12-01T00:00:00.000Z");
  assert.equal(parseGitHubQuotaResetAt("2026-12-01T00%3A00%3A00Z"), "2026-12-01T00:00:00.000Z");
  // Epoch seconds and millis are both accepted.
  assert.equal(parseGitHubQuotaResetAt("1796083200"), "2026-12-01T00:00:00.000Z");
  assert.equal(parseGitHubQuotaResetAt("1796083200000"), "2026-12-01T00:00:00.000Z");
  // Garbage must not become a valid reset instant.
  assert.equal(parseGitHubQuotaResetAt("not-a-date"), null);
  assert.equal(parseGitHubQuotaResetAt(""), null);
  assert.equal(parseGitHubQuotaResetAt(undefined), null);
  assert.equal(parseGitHubQuotaResetAt("0"), null);
});

test("missing optional fields degrade gracefully", () => {
  const window = parseGitHubQuotaSnapshotHeader("ent=100&totRem=100");
  assert.ok(window);
  assert.equal(window.entitlement, 100);
  assert.equal(window.used, 0);
  assert.equal(window.remaining, 100);
  assert.equal(window.remainingPercentage, 100);
  assert.equal(window.resetAt, null);
  assert.equal(window.overageUsed, 0);
  assert.equal(window.overagePermitted, false);
});

test("derives the missing half of used/entitlement when one side is absent", () => {
  // Only credits used + entitlement: remaining is arithmetic.
  const onlyUsed = parseGitHubQuotaSnapshotHeader("crUsed=1500&ent=5000");
  assert.ok(onlyUsed);
  assert.equal(onlyUsed.remaining, 3500);
  assert.equal(onlyUsed.remainingPercentage, 70);
  assert.equal(onlyUsed.used, 1500);

  // Only entitlement + remaining: used is arithmetic.
  const onlyRemaining = parseGitHubQuotaSnapshotHeader("ent=5000&totRem=1000");
  assert.ok(onlyRemaining);
  assert.equal(onlyRemaining.used, 4000);
  assert.equal(onlyRemaining.remainingPercentage, 20);
});

test("clamps inconsistent upstream numbers instead of exceeding 100%", () => {
  const window = parseGitHubQuotaSnapshotHeader("crUsed=9000&ent=5000&totRem=9000");
  assert.ok(window);
  assert.equal(window.remaining, 5000);
  assert.equal(window.remainingPercentage, 100);

  const negative = parseGitHubQuotaSnapshotHeader("crUsed=-5&ent=5000&totRem=-5");
  assert.ok(negative);
  assert.equal(negative.used, 0);
  // ent > 0 wins over a negative totRem: the window is NOT unlimited, and a
  // nonsensical remaining count falls back to "nothing consumed".
  assert.equal(negative.unlimited, false);
  assert.equal(negative.remaining, 5000);
  assert.equal(negative.remainingPercentage, 100);
});

test("overage is carried through for the persistence metadata", () => {
  const window = parseGitHubQuotaSnapshotHeader(
    "crUsed=5000&ent=5000&ov=120.5&ovPerm=true&rem=0.0&totRem=0"
  );
  assert.ok(window);
  assert.equal(window.overageUsed, 120.5);
  assert.equal(window.overagePermitted, true);
  assert.equal(window.remainingPercentage, 0);
});

function usageQuotas(record: Record<string, string>) {
  return githubQuotaHeadersToUsageQuotas(record);
}

test("converts a metered window into the shared UsageQuota shape", () => {
  const quotas = usageQuotas({
    [`${GITHUB_QUOTA_HEADER_PREFIX}premium_interactions`]: PREMIUM,
  });
  const premium = quotas.premium_interactions;
  assert.ok(premium);
  assert.equal(premium.used, 988);
  assert.equal(premium.total, 5000);
  assert.equal(premium.remaining, 4012.5);
  assert.equal(premium.remainingPercentage, 80.25);
  assert.equal(premium.resetAt, "2026-12-01T00:00:00.000Z");
  assert.equal(premium.unlimited, false);
  // Deliberately absent: the display layer treats `fractionReported` as
  // "percentage-only", which would hide the used/entitlement counts.
  assert.equal(premium.fractionReported, undefined);
  assert.equal(premium.quotaSource, "responseHeaders");
  assert.deepEqual(premium.overage, { used: 0, permitted: true });
});

test("unlimited chat/completions windows are dropped, like the active github fetcher", () => {
  const quotas = usageQuotas({
    [`${GITHUB_QUOTA_HEADER_PREFIX}premium_interactions`]: PREMIUM,
    [`${GITHUB_QUOTA_HEADER_PREFIX}chat`]: CHAT,
    [`${GITHUB_QUOTA_HEADER_PREFIX}completions`]: COMPLETIONS,
  });
  assert.deepEqual(Object.keys(quotas), ["premium_interactions"]);
});

test("an unlimited window converted directly stays hidden from the display gate", () => {
  const window = parseGitHubQuotaSnapshotHeader(CHAT);
  assert.ok(window);
  const quota = githubQuotaWindowToUsageQuota(window);
  assert.equal(quota.unlimited, true);
  assert.equal(quota.total, 0);
  // Mirrors shouldDisplayGitHubQuota(): unlimited && total <= 0 is hidden.
  assert.equal(quota.total > 0 || quota.remainingPercentage !== undefined, true);
});

test("a percentage-only window keeps the provider's percentage and flags itself", () => {
  const quotas = usageQuotas({
    [`${GITHUB_QUOTA_HEADER_PREFIX}premium_interactions`]: "rem=42.5&rst=2026-12-01T00%3A00%3A00Z",
  });
  const premium = quotas.premium_interactions;
  assert.ok(premium);
  assert.equal(premium.total, 0);
  assert.equal(premium.remainingPercentage, 42.5);
  assert.equal(premium.isPercentageOnly, true);
});

test("oversized header values are rejected without parsing", () => {
  const huge = `crUsed=1&ent=5000&pad=${"x".repeat(5000)}`;
  assert.equal(parseGitHubQuotaSnapshotHeader(huge), null);
});
