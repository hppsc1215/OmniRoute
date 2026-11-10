// tests/unit/combo/prompt-token-ceiling.test.ts
// Long-context price-tier guard: per-target `maxPromptTokens` on a combo step.
//
// Motivation: GitHub Copilot bills Claude Haiku 5.5 5x above 100k prompt tokens
// (cache reads count toward the threshold), so a combo must be able to say
// "use this target only while the prompt is small, otherwise fall through".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyPromptTokenCeilings,
  buildPromptTokenCeilingResponse,
  resolvePromptTokenSafetyFactor,
  type PromptTokenCeilingExclusion,
} from "../../../open-sse/services/combo/promptTokenCeiling.ts";
import {
  recordEstimatorCalibrationFromUsage,
  resetEstimatorCalibrationForTests,
} from "../../../open-sse/services/estimatorCalibration.ts";
import { resolveComboTargets } from "../../../open-sse/services/combo/comboStructure.ts";
import { comboTargetDecision } from "../../../open-sse/services/combo/statusDecisionTable.ts";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** 40,000 chars of prose = 10,000 chars/4 tokens. */
function bodyWithPromptChars(chars: number) {
  return { model: "auto", messages: [{ role: "user", content: "x".repeat(chars) }], stream: true };
}

function target(over: Partial<ResolvedComboTarget> = {}): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: "s1",
    executionKey: "s1",
    modelStr: "ghe-copilot/claude-haiku-5.5",
    provider: "ghe-copilot",
    providerId: "ghe-copilot",
    connectionId: null,
    weight: 0,
    label: null,
    ...over,
  };
}

function warmCalibration(provider: string, model: string, ratio: number) {
  for (let i = 0; i < 3; i += 1) {
    recordEstimatorCalibrationFromUsage({
      provider,
      model,
      estimatedTokens: 10_000,
      usage: { prompt_tokens: Math.round(10_000 * ratio) },
      toolsPresent: false,
    });
  }
}

beforeEach(() => resetEstimatorCalibrationForTests());

test("no ceiling anywhere: targets are returned untouched and the body is not measured", () => {
  const targets = [target(), target({ stepId: "s2", executionKey: "s2" })];
  const result = applyPromptTokenCeilings({
    targets,
    body: bodyWithPromptChars(4_000_000),
    log,
  });
  assert.deepEqual(result.excluded, []);
  assert.equal(result.targets, targets);
});

test("small prompt keeps the cheap target; large prompt drops it to fall through", () => {
  const haiku = target({ maxPromptTokens: 15_000 });
  const fallback = target({
    stepId: "s2",
    executionKey: "s2",
    modelStr: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    providerId: "anthropic",
  });

  const small = applyPromptTokenCeilings({
    targets: [haiku, fallback],
    body: bodyWithPromptChars(40_000), // ~10k estimated
    log,
  });
  assert.deepEqual(small.excluded, []);
  assert.deepEqual(
    small.targets.map((t) => t.modelStr),
    ["ghe-copilot/claude-haiku-5.5", "anthropic/claude-sonnet-5"]
  );

  const large = applyPromptTokenCeilings({
    targets: [haiku, fallback],
    body: bodyWithPromptChars(80_000), // ~20k estimated > 15k ceiling
    log,
  });
  assert.deepEqual(
    large.targets.map((t) => t.modelStr),
    ["anthropic/claude-sonnet-5"],
    "the over-ceiling target must be dropped so the attempt loop falls through"
  );
  assert.equal(large.excluded.length, 1);
  assert.equal(large.excluded[0].modelStr, "ghe-copilot/claude-haiku-5.5");
  assert.equal(large.excluded[0].maxPromptTokens, 15_000);
  assert.ok(large.excluded[0].estimatedPromptTokens > 15_000);
});

test("a target without a ceiling is never dropped by a sibling's ceiling", () => {
  const limited = target({ maxPromptTokens: 1_000 });
  const unlimited = target({
    stepId: "s2",
    executionKey: "s2",
    modelStr: "openai/gpt-5",
    provider: "openai",
    providerId: "openai",
  });
  const result = applyPromptTokenCeilings({
    targets: [limited, unlimited],
    body: bodyWithPromptChars(400_000),
    log,
  });
  assert.deepEqual(
    result.targets.map((t) => t.modelStr),
    ["openai/gpt-5"]
  );
});

test("learned calibration doubles the estimate (Claude tokenizer vs chars/4)", () => {
  const haiku = target({ maxPromptTokens: 15_000 });
  const body = bodyWithPromptChars(40_000); // base 10k, real ~20k for Claude

  const cold = applyPromptTokenCeilings({ targets: [haiku], body, log });
  assert.deepEqual(cold.excluded, [], "cold bucket prices at chars/4 (10k <= 15k)");

  warmCalibration("ghe-copilot", "claude-haiku-5.5", 2);
  const warm = applyPromptTokenCeilings({ targets: [haiku], body, log });
  assert.equal(warm.excluded.length, 1, "warm bucket must reject the same body");
  assert.ok(
    Math.abs(warm.excluded[0].estimatedPromptTokens - 20_000) <= 64,
    `calibrated estimate must double the ~10k base, got ${warm.excluded[0].estimatedPromptTokens}`
  );
});

test("promptTokenSafetyFactor inflates the comparison (cold-start margin)", () => {
  const haiku = target({ maxPromptTokens: 15_000 });
  const body = bodyWithPromptChars(40_000); // 10k estimate
  assert.equal(
    applyPromptTokenCeilings({ targets: [haiku], body, log }).excluded.length,
    0
  );
  const guarded = applyPromptTokenCeilings({
    targets: [haiku],
    body,
    config: { promptTokenSafetyFactor: 2 },
    log,
  });
  assert.equal(guarded.excluded.length, 1);
  assert.ok(Math.abs(guarded.excluded[0].estimatedPromptTokens - 20_000) <= 64);
});

test("resolvePromptTokenSafetyFactor ignores invalid values and defaults to 1", () => {
  assert.equal(resolvePromptTokenSafetyFactor(undefined), 1);
  assert.equal(resolvePromptTokenSafetyFactor({}), 1);
  assert.equal(resolvePromptTokenSafetyFactor({ promptTokenSafetyFactor: 0 }), 1);
  assert.equal(resolvePromptTokenSafetyFactor({ promptTokenSafetyFactor: "oops" }), 1);
  assert.equal(resolvePromptTokenSafetyFactor({ promptTokenSafetyFactor: 2.5 }), 2.5);
  assert.equal(resolvePromptTokenSafetyFactor({ promptTokenSafetyFactor: "3" }), 3);
});

test("combo steps carry maxPromptTokens onto the resolved target", () => {
  const targets = resolveComboTargets(
    {
      name: "haiku-cheap",
      models: [
        { kind: "model", model: "ghe-copilot/claude-haiku-5.5", maxPromptTokens: 85_000 },
        "anthropic/claude-sonnet-5",
      ],
    },
    [],
    1,
    new Map()
  );
  assert.equal(targets.length, 2);
  assert.equal(targets[0].maxPromptTokens, 85_000);
  assert.equal(targets[1].maxPromptTokens, undefined);
});

test("all targets over their ceiling produce a 400 naming each ceiling", async () => {
  const excluded: PromptTokenCeilingExclusion[] = [
    {
      modelStr: "ghe-copilot/claude-haiku-5.5",
      maxPromptTokens: 85_000,
      estimatedPromptTokens: 190_000,
    },
  ];
  const response = buildPromptTokenCeilingResponse({
    comboName: "haiku-cheap",
    poolSize: 1,
    excluded,
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { code: string; message: string };
    diagnostics: { terminalReason: string; excluded: Array<{ reason: string }> };
  };
  assert.equal(body.error.code, "prompt_token_ceiling_exceeded");
  assert.match(body.error.message, /haiku-cheap/);
  assert.match(body.error.message, /estimated 190000 > max 85000/);
  assert.equal(body.diagnostics.terminalReason, "prompt_token_ceiling_exceeded");
  assert.equal(body.diagnostics.excluded[0].reason, "prompt_tokens");
});

// Regression guard for the no-code alternative (`max_input_tokens` capability
// override): the local 400 must stay a *failover* signal for a combo, not a
// combo-stopping 400 — the message contains "prompt", which the generic
// COMBO_400_STOP_ROWS would otherwise stop on.
test("the local input-cap 400 keeps advancing a combo instead of stopping it", () => {
  const message =
    "Input exceeds maximum input tokens for ghe-copilot/claude-haiku-5.5: " +
    "estimated 90000 input tokens, max input 85000. " +
    "Reduce the prompt or route to a model with a larger input limit.";
  assert.equal(comboTargetDecision(400, message), "advance");
});
