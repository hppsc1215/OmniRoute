/**
 * GitHub Copilot cost accounting (ghe-copilot / gh / github).
 *
 * Regression for the 2026-11-07 under-report: every `ghe-copilot` Claude Haiku 5.5 call
 * in production was billed at Claude Haiku 5.5's flat <=100K rates ($0.10/$0.50) even
 * though 38 of 39 requests carried 215K-262K prompt tokens, so the ledger reported
 * $0.91 for a session GitHub charged ~$4.79 (1 credit = $0.01).
 *
 * Source of truth for every number below:
 * https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ghe-pricing-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "ghe-pricing-test-secret";

const { DEFAULT_PRICING } = await import("../../src/shared/constants/pricing/default-pricing.ts");
const { computeCostFromPricing, resolveEffectiveRates } = await import(
  "../../src/lib/usage/costCalculator.ts"
);
const core = await import("../../src/lib/db/core.ts");
const { getPricingForModel, updatePricing } = await import("@/lib/db/settings");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { recordLedgerFromCost } = await import("../../src/lib/usage/costLedgerRecorder.ts");
const { listLedgerEntries } = await import("../../src/lib/db/costLedger.ts");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/responseTranslator.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

type Row = {
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  cache_creation?: number;
  long_context?: Row & { threshold?: number; inclusive?: boolean };
};

const copilotRows = (DEFAULT_PRICING as unknown as Record<string, Record<string, Row>>)["gh"];
const row = (model: string) => copilotRows[model];

// 2026-11-07 session: 39 requests, 9,014,301 prompt tokens, 114,023 output tokens.
const SESSION_INPUT = 9_014_301;
const SESSION_OUTPUT = 114_023;

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("ghe-copilot, gh and github resolve to one shared Copilot rate-card table", () => {
  const providers = DEFAULT_PRICING as unknown as Record<string, unknown>;
  assert.equal(providers.gh, providers["ghe-copilot"], "GHE transport shares the `gh` table");
  assert.equal(providers.github, providers["ghe-copilot"], "github.com transport shares it too");
  // No per-transport copies: a row edited once is seen by both transports.
  assert.equal(
    (providers["ghe-copilot"] as Record<string, Row>)["claude-haiku-5.5"],
    copilotRows["claude-haiku-5.5"]
  );
});

test("Claude Haiku 5.5 keeps the rate card's long-context tier", () => {
  const haiku = row("claude-haiku-5.5");
  assert.equal(haiku.input, 0.1);
  assert.equal(haiku.output, 0.5);
  assert.equal(haiku.cached, 0.01);
  assert.equal(haiku.cache_creation, 0.125);
  assert.deepEqual(haiku.long_context, {
    threshold: 100_000,
    input: 0.5,
    output: 2.5,
    cached: 0.05,
    reasoning: 2.5,
    cache_creation: 0.625,
  });
});

test("(a) 215,815 in / 1,046 out on ghe-copilot bills the >100K tier for the whole request", () => {
  const tokens = { input: 215_815, output: 1_046 };
  const cost = computeCostFromPricing(row("claude-haiku-5.5"), tokens);
  assert.equal(cost, (215_815 * 0.5 + 1_046 * 2.5) / 1e6);
  // 5x the flat estimate the ledger used to store.
  assert.equal(cost, 0.1105225);
  assert.ok(Math.abs(cost - 0.021825 * 5) < 0.0015, "tier cost is ~5x the flat one");

  const rates = resolveEffectiveRates(row("claude-haiku-5.5"), tokens);
  assert.equal(rates?.input, 0.5, "ledger unit price input reflects the applied tier");
  assert.equal(rates?.output, 2.5, "ledger unit price output reflects the applied tier");
});

test("(b) 94,582 in stays on the default tier and at the threshold the tier is exclusive", () => {
  const flat = computeCostFromPricing(row("claude-haiku-5.5"), { input: 94_582, output: 1_046 });
  assert.ok(Math.abs(flat - (94_582 * 0.1 + 1_046 * 0.5) / 1e6) < 1e-12);
  assert.equal(resolveEffectiveRates(row("claude-haiku-5.5"), { input: 94_582 })?.input, 0.1);

  // The rate card is "Long context > 100K", so exactly 100K is still default.
  const atThreshold = computeCostFromPricing(row("claude-haiku-5.5"), { input: 100_000 });
  assert.equal(atThreshold, (100_000 * 0.1) / 1e6);
});

test("(c) the 2026-11-07 session aggregates to ~$4.75, not $0.91", () => {
  const cost = computeCostFromPricing(row("claude-haiku-5.5"), {
    input: SESSION_INPUT,
    output: SESSION_OUTPUT,
  });
  // GitHub's own credit counter moved ~480-490 credits for this session ($4.80-$4.90).
  const githubCreditsUsd = 4.75;
  assert.ok(
    Math.abs(cost - githubCreditsUsd) / githubCreditsUsd <= 0.01,
    `aggregate ${cost} must land within 1% of ${githubCreditsUsd}`
  );
  const flatCost = (SESSION_INPUT * 0.1 + SESSION_OUTPUT * 0.5) / 1e6;
  assert.ok(cost > flatCost * 4.9, "the fix recovers the ~5x under-report");
});

test("(d) 60K prompt + 50K cache read crosses the 100K threshold", () => {
  // The Copilot Claude path (targetFormat "claude") translates Anthropic usage before
  // costing, folding cache reads into the prompt total: 60K non-cached + 50K cached is a
  // 110K prompt, not a 60K one.
  const claudeUsage = {
    input_tokens: 60_000,
    cache_read_input_tokens: 50_000,
    cache_creation_input_tokens: 0,
    output_tokens: 100,
  };
  const translated = translateNonStreamingResponse(
    {
      id: "msg_ghe",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5.5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: claudeUsage,
    },
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    { model: "claude-haiku-5.5" }
  ) as { usage: Record<string, unknown> };

  assert.equal(translated.usage.prompt_tokens, 110_000, "cache reads are part of the prompt");
  assert.equal(
    computeCostFromPricing(row("claude-haiku-5.5"), translated.usage),
    (60_000 * 0.5 + 50_000 * 0.05 + 100 * 2.5) / 1e6,
    "the translated 110K prompt is billed at the long-context tier"
  );

  // Cache writes count toward the prompt length too, and an inclusive `cache_creation_in_prompt`
  // marker keeps them from being subtracted twice.
  assert.equal(
    resolveEffectiveRates(row("claude-haiku-5.5"), {
      prompt_tokens: 105_000,
      cached_tokens: 40_000,
      prompt_tokens_details: { cache_creation_tokens: 25_000, cache_creation_in_prompt: true },
    })?.input,
    0.5
  );
  // A 90K prompt stays on the default tier even with 60K of it cached.
  assert.equal(
    resolveEffectiveRates(row("claude-haiku-5.5"), { prompt_tokens: 90_000, cached_tokens: 60_000 })
      ?.input,
    0.1
  );
});

test("the rate card fixes the rows Copilot was under-billing", () => {
  // Claude Haiku 4.5 was priced at half the published rate ($0.50/$2.50).
  assert.equal(row("claude-haiku-4.5").input, 1.0);
  assert.equal(row("claude-haiku-4.5").output, 5.0);
  assert.equal(row("claude-4.5-haiku").input, 1.0, "legacy id follows the same model rate");
  // Sonnet 4.6 cache reads are $0.30 on Copilot (not Anthropic's $1.50).
  assert.equal(row("claude-sonnet-4.6").cached, 0.3);
  // Sonnet 5.5 cache reads are $0.10, Sonnet 5's are $0.20.
  assert.equal(row("claude-sonnet-5-5").cached, 0.1);
  assert.equal(row("claude-sonnet-5").cached, 0.2);
  // GPT-6.1 Sol switches above 272K.
  assert.equal(row("gpt-6.1-sol").long_context?.threshold, 272_000);
  assert.equal(row("gpt-6.1-sol").long_context?.input, 4.0);
  assert.equal(row("gpt-5.6-luna").long_context?.threshold, 200_000);
  assert.equal(row("grok-4.6").long_context?.threshold, 200_000);
});

test("a long-context tier that raises output without reasoning does not discount thinking", () => {
  const base = row("gpt-6-astra");
  assert.equal(base.reasoning, 50);
  const rates = resolveEffectiveRates(base, { input: 300_000 });
  assert.equal(rates?.output, 75);
  assert.equal(rates?.reasoning, 75, "reasoning follows the tiered output rate, never a discount");
  // A tier that names output only must drop the stale premium (50) rather than subtract it.
  const handRolled = {
    input: 10,
    output: 50,
    cached: 1,
    reasoning: 50,
    cache_creation: 12.5,
    long_context: { threshold: 272_000, input: 20, output: 75 },
  };
  assert.equal(resolveEffectiveRates(handRolled, { input: 300_000 })?.reasoning, undefined);
  const cost = computeCostFromPricing(handRolled, { input: 300_000, output: 10_000, reasoning: 10_000 });
  assert.ok(Math.abs(cost - (300_000 * 20 + 10_000 * 75) / 1e6) < 1e-9);
  const astraCost = computeCostFromPricing(base, {
    input: 300_000,
    output: 10_000,
    reasoning: 10_000,
  });
  assert.ok(Math.abs(astraCost - (300_000 * 20 + 10_000 * 75) / 1e6) < 1e-9);
});

test("a flat DB pricing override cannot strip the long-context tier", async () => {
  core.resetDbInstance();
  // Exactly the row the live DB carries for ghe-copilot: flat rates, no long_context.
  await updatePricing({
    "ghe-copilot": {
      "claude-haiku-5.5": {
        input: 0.1,
        output: 0.5,
        cached: 0,
        reasoning: 0,
        cache_creation: 0,
      },
    },
  });

  const merged = (await getPricingForModel("ghe-copilot", "claude-haiku-5.5")) as Row;
  assert.equal(merged.input, 0.1, "the override still owns the flat rate");
  assert.ok(merged.long_context, "the default rate card's long-context tier survives the merge");

  const created = await apiKeysDb.createApiKey("ghe-pricing", "machine-ghe-pricing");
  await recordLedgerFromCost({
    apiKeyId: created.id,
    provider: "ghe-copilot",
    model: "claude-haiku-5.5",
    tokens: { input: 215_815, output: 1_046 },
    amountUsd: computeCostFromPricing(merged, { input: 215_815, output: 1_046 }),
  });

  const [entry] = listLedgerEntries(created.id);
  assert.equal(entry.unitPriceInput, 0.5, "ledger stores the effective tier input rate");
  assert.equal(entry.unitPriceOutput, 2.5, "ledger stores the effective tier output rate");
  assert.equal(entry.amountUsd, 0.1105225);
  assert.equal(entry.tokensInput, 215_815);
});
