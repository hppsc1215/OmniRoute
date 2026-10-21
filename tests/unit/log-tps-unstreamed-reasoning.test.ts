import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLogTpsTitle,
  computeLogTps,
  resolveTpsWindowMs,
} from "../../src/shared/utils/logTps.ts";

// Real antigravity/gemini-3.8-flash-tiered row: 410 output tokens, 380 of them
// thinking tokens that were metered in usage but never streamed to the client
// (reasoning_chars NULL). TTFT (5485 ms) only ends at the first visible content
// chunk, i.e. AFTER all thinking happened, so duration - TTFT = 36 ms and the
// old math reported ~11,389 tok/s.
const GEMINI_ROW = { out: 410, reasoning: 380, duration: 5521, ttft: 5485 };

test("unstreamed reasoning: TPS uses full duration instead of duration - TTFT", () => {
  const tps = computeLogTps(
    GEMINI_ROW.out,
    GEMINI_ROW.reasoning,
    GEMINI_ROW.duration,
    GEMINI_ROW.ttft,
    null
  );
  assert.ok(Math.abs(tps - 410 / 5.521) < 0.01, `got ${tps}`);
  assert.ok(tps < 100, `implausible TPS ${tps}`);
});

test("reasoning_chars = 0 counts as not streamed", () => {
  assert.equal(resolveTpsWindowMs(5521, 5485, 380, 0), 5521);
});

test("streamed reasoning keeps generation-time math (duration - TTFT)", () => {
  // Reasoning was visible in the stream, so it happened after TTFT.
  assert.equal(resolveTpsWindowMs(90_000, 60_000, 800, 4200), 30_000);
  const tps = computeLogTps(1000, 800, 90_000, 60_000, 4200);
  assert.ok(Math.abs(tps - 33.333) < 0.01, `got ${tps}`);
});

test("no reasoning tokens: unchanged generation-time math", () => {
  // Kiro row from the same screenshot: 1299 out, TTFT 5810 of 28231 ms.
  assert.equal(resolveTpsWindowMs(28_231, 5_810, null, null), 22_421);
});

test("callers that do not pass reasoningChars keep the historical behavior", () => {
  assert.equal(resolveTpsWindowMs(5521, 5485, 380, undefined), 36);
  const legacy = computeLogTps(410, 380, 5521, 5485);
  assert.ok(legacy > 10_000, "legacy 4-arg call must stay unchanged");
});

test("tooltip does not claim a generation window for unstreamed reasoning", () => {
  const log = {
    duration: GEMINI_ROW.duration,
    ttft: GEMINI_ROW.ttft,
    tokens: { reasoning: GEMINI_ROW.reasoning },
    reasoningChars: null,
  };
  const title = buildLogTpsTitle(log, 74.26, (ms) => `${ms}ms`);
  assert.ok(!title.includes("generation"), title);
  assert.ok(title.includes("reasoning 380 tok"), title);
});
