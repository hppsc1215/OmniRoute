/**
 * ghe-copilot-usage-fetcher.test.ts
 *
 * The `ghe-copilot` usage fetcher is a BOOTSTRAP probe only: a GHE tenant has no
 * public copilot_internal/user endpoint, and no chat request may ever be sent
 * just to refresh quota. Its job is to try `<gheUrl>/api/v3/copilot_internal/user`
 * once and degrade to a message — never throw, never mark the connection broken.
 * Serving the passively captured snapshot is `providerLimits.ts`'s job (see
 * ghe-copilot-passive-fallback.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";

const gheCopilot = await import("../../open-sse/services/usage/gheCopilot.ts");

const RESET_AT = "2026-12-01T00:00:00.000Z";

type QuotaLike = { used?: number; total?: number; remaining?: number };
type UsageLike = { quotas?: Record<string, QuotaLike>; message?: string };

test("derives the tenant REST base from gheUrl", () => {
  assert.equal(
    gheCopilot.resolveGheApiBaseUrl({ gheUrl: "https://ghe.example.com" }),
    "https://ghe.example.com/api/v3"
  );
  assert.equal(
    gheCopilot.resolveGheApiBaseUrl({ gheUrl: "https://ghe.example.com/" }),
    "https://ghe.example.com/api/v3"
  );
  assert.equal(
    gheCopilot.resolveGheInternalUserUrl({ gheUrl: "https://ghe.example.com" }),
    "https://ghe.example.com/api/v3/copilot_internal/user"
  );
  // No protocol smuggling or path injection from stored connection metadata.
  assert.equal(gheCopilot.resolveGheApiBaseUrl({ gheUrl: "ftp://ghe.example.com" }), null);
  assert.equal(gheCopilot.resolveGheApiBaseUrl({ gheUrl: "not a url" }), null);
  assert.equal(gheCopilot.resolveGheApiBaseUrl({ gheUrl: 42 }), null);
  assert.equal(gheCopilot.resolveGheApiBaseUrl({}), null);
  assert.equal(gheCopilot.resolveGheApiBaseUrl(null), null);
});

test("bootstraps from the tenant endpoint when nothing was captured yet", async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        copilot_plan: "enterprise",
        quota_reset_date: RESET_AT,
        quota_snapshots: {
          premium_interactions: { entitlement: 5000, remaining: 4000, percent_remaining: 80 },
          chat: { unlimited: true },
          completions: { unlimited: true },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  const usage = (await gheCopilot.getGheCopilotUsage(
    "gho_token",
    { gheUrl: "https://ghe.example.com" },
    undefined
  )) as UsageLike;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ghe.example.com/api/v3/copilot_internal/user");
  const authHeader = new Headers(calls[0].init?.headers).get("authorization");
  assert.equal(authHeader, "Bearer gho_token");

  assert.equal(usage.quotas?.premium_interactions.used, 1000);
  assert.equal(usage.quotas?.premium_interactions.total, 5000);
  assert.equal(usage.quotas?.premium_interactions.remaining, 4000);
  // Unlimited buckets are dropped, exactly like the github fetcher.
  assert.equal(usage.quotas?.chat, undefined);
});

test("a tenant that does not expose the endpoint degrades to a message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not found", { status: 404 }));

  const usage = (await gheCopilot.getGheCopilotUsage(
    "gho_token",
    { gheUrl: "https://ghe.example.com" },
    undefined
  )) as UsageLike;

  assert.equal(usage.quotas, undefined);
  assert.match(String(usage.message), /GitHub Enterprise Copilot connected/);
});

test("a network failure never throws (the sync would mark the connection broken)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNREFUSED");
  });

  const usage = (await gheCopilot.getGheCopilotUsage(
    "gho_token",
    { gheUrl: "https://ghe.example.com" },
    undefined
  )) as UsageLike;
  assert.match(String(usage.message), /GitHub Enterprise Copilot connected/);
});

test("without a token or a gheUrl there is nothing to probe", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => {
    throw new Error("fetch must not be called without credentials");
  });

  const noToken = (await gheCopilot.getGheCopilotUsage(
    undefined,
    { gheUrl: "https://ghe.example.com" },
    undefined
  )) as UsageLike;
  assert.match(String(noToken.message), /GitHub Enterprise Copilot connected/);

  const noUrl = (await gheCopilot.getGheCopilotUsage("gho_token", {}, undefined)) as UsageLike;
  assert.match(String(noUrl.message), /GitHub Enterprise Copilot connected/);

  assert.equal(fetchMock.mock.callCount(), 0);
});

test("an unparsable tenant payload is treated as no data", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })
  );

  const usage = (await gheCopilot.getGheCopilotUsage(
    "gho_token",
    { gheUrl: "https://ghe.example.com" },
    undefined
  )) as UsageLike;
  assert.match(String(usage.message), /GitHub Enterprise Copilot connected/);
});
