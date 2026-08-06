import test from "node:test";
import assert from "node:assert/strict";
import GithubExecutor from "../../open-sse/executors/github.ts";
import GheCopilotExecutor from "../../open-sse/executors/ghe-copilot.ts";
import type { ProviderCredentials } from "../../open-sse/executors/base.ts";

/**
 * Regression tests: GitHub Copilot / GHE Copilot Responses-API reasoning
 * visibility.
 *
 * Root cause (measured against a live GHE Copilot /responses endpoint,
 * gpt-5.6-luna): the upstream encrypts reasoning ("private reasoning")
 * unless the request opts into a visible summary via `reasoning.summary`.
 * Measured visibility: "concise" 51 chars, "auto" 457, "detailed" 960 — in
 * every mode exactly one of two reasoning items stays encrypted (upstream
 * design, never recoverable by a proxy).
 *
 * Fix: executors inject `reasoning.summary` on the /responses route when an
 * effort is set but no explicit summary was provided — both for the
 * `reasoning` object form and for the top-level `reasoning_effort` form
 * (OpenAI-shaped bodies), where the object is created on the fly. The injected
 * value is `OMNIROUTE_RESPONSES_REASONING_SUMMARY` (default "concise"); invalid
 * values fall back to the default. Default "concise" is asserted in the default
 * tests; override behavior is covered by dedicated tests that set/restore the
 * env var.
 */

const gheCredentials: ProviderCredentials = {
  providerSpecificData: {
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  },
};

function bodyWith(model: string, reasoning?: unknown, reasoningEffort?: string) {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  };
  if (reasoning !== undefined) body.reasoning = reasoning;
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
  return body;
}

// --- GHE Copilot executor ----------------------------------------------

test("GHE: injects reasoning.summary concise for gpt-5.6-luna on /responses route", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const out = executor.transformRequest(
    "ghe-copilot/gpt-5.6-luna",
    bodyWith("gpt-5.6-luna", { effort: "xhigh" }, "xhigh"),
    true,
    gheCredentials
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, "concise");
  assert.equal((out.reasoning as Record<string, unknown>).effort, "xhigh");
});

test("GHE: keeps explicit client reasoning.summary (client wins)", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const out = executor.transformRequest(
    "ghe-copilot/gpt-5.6-luna",
    bodyWith("gpt-5.6-luna", { effort: "high", summary: "hidden" }, "high"),
    true,
    gheCredentials
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, "hidden");
});

test("GHE: keeps explicit summary null (only undefined triggers injection)", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const out = executor.transformRequest(
    "ghe-copilot/gpt-5.6-luna",
    bodyWith("gpt-5.6-luna", { effort: "high", summary: null }, "high"),
    true,
    gheCredentials
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, null);
});

test("GHE: leaves reasoning null untouched (no crash, no injection)", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const out = executor.transformRequest(
    "ghe-copilot/gpt-5.6-luna",
    bodyWith("gpt-5.6-luna", null, "xhigh"),
    true,
    gheCredentials
  ) as Record<string, unknown>;
  // null is falsy (first branch skipped) and !== undefined (else-if skipped):
  // the reasoning field stays null, top-level effort is left intact.
  assert.equal(out.reasoning, null);
  assert.equal(out.reasoning_effort, "xhigh");
});

test("GHE: creates reasoning object from top-level reasoning_effort", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const out = executor.transformRequest(
    "ghe-copilot/gpt-5.6-luna",
    bodyWith("gpt-5.6-luna", undefined, "xhigh"),
    true,
    gheCredentials
  ) as Record<string, unknown>;
  assert.deepEqual(out.reasoning, { effort: "xhigh", summary: "concise" });
  // top-level carrier is left intact — both forms are valid upstream
  assert.equal(out.reasoning_effort, "xhigh");
});

test("GHE: leaves chat/completions (claude) models untouched", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const out = executor.transformRequest(
    "ghe-copilot/claude-opus-5",
    bodyWith("claude-opus-5", { effort: "high" }),
    true,
    gheCredentials
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, undefined);
  assert.equal((out.reasoning as Record<string, unknown>).effort, "high");
});

test("GHE: leaves gemini models untouched", () => {
  const executor = new GheCopilotExecutor({
    gheUrl: "https://ghe.company.com",
    clientId: "test-client",
    clientSecret: "test-secret",
  });
  const out = executor.transformRequest(
    "ghe-copilot/gemini-2.5-pro",
    bodyWith("gemini-2.5-pro", { effort: "high" }),
    true,
    gheCredentials
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, undefined);
});

// --- GitHub (gh) executor ----------------------------------------------

test("GH: injects reasoning.summary concise for gpt-5.4 (registry targetFormat)", () => {
  const executor = new GithubExecutor();
  const out = executor.transformRequest(
    "gpt-5.4",
    bodyWith("gpt-5.4", { effort: "xhigh" }, "xhigh"),
    true,
    {}
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, "concise");
});

test("GH: injects reasoning.summary concise for codex model names", () => {
  const executor = new GithubExecutor();
  const out = executor.transformRequest(
    "gpt-5.3-codex",
    bodyWith("gpt-5.3-codex", { effort: "high" }),
    true,
    {}
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, "concise");
});

test("GH: creates reasoning object from top-level reasoning_effort", () => {
  const executor = new GithubExecutor();
  const out = executor.transformRequest(
    "gpt-5.3-codex",
    bodyWith("gpt-5.3-codex", undefined, "xhigh"),
    true,
    {}
  ) as Record<string, unknown>;
  assert.deepEqual(out.reasoning, { effort: "xhigh", summary: "concise" });
  assert.equal(out.reasoning_effort, "xhigh");
});

test("GH: leaves claude models untouched", () => {
  const executor = new GithubExecutor();
  const out = executor.transformRequest(
    "claude-sonnet-4",
    bodyWith("claude-sonnet-4", { effort: "high" }),
    true,
    {}
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, undefined);
});

test("GH: leaves gemini models untouched", () => {
  const executor = new GithubExecutor();
  const out = executor.transformRequest(
    "gemini-2.5-pro",
    bodyWith("gemini-2.5-pro", { effort: "high" }),
    true,
    {}
  ) as Record<string, unknown>;
  assert.equal((out.reasoning as Record<string, unknown>).summary, undefined);
});

test("GH: leaves reasoning null untouched (no crash, no injection)", () => {
  const executor = new GithubExecutor();
  const out = executor.transformRequest(
    "gpt-5.4",
    bodyWith("gpt-5.4", null, "xhigh"),
    true,
    {}
  ) as Record<string, unknown>;
  // null is falsy (first branch skipped) and !== undefined (else-if skipped):
  // the reasoning field stays null, top-level effort is left intact.
  assert.equal(out.reasoning, null);
  assert.equal(out.reasoning_effort, "xhigh");
});

// --- OMNIROUTE_RESPONSES_REASONING_SUMMARY override ---------------------

const SUMMARY_ENV = "OMNIROUTE_RESPONSES_REASONING_SUMMARY";

function withSummaryEnv(value: string | undefined, fn: () => void) {
  const previous = process.env[SUMMARY_ENV];
  try {
    if (value === undefined) delete process.env[SUMMARY_ENV];
    else process.env[SUMMARY_ENV] = value;
    fn();
  } finally {
    if (previous === undefined) delete process.env[SUMMARY_ENV];
    else process.env[SUMMARY_ENV] = previous;
  }
}

test("GHE: env override OMNIROUTE_RESPONSES_REASONING_SUMMARY=detailed wins over default", () => {
  withSummaryEnv("detailed", () => {
    const executor = new GheCopilotExecutor({
      gheUrl: "https://ghe.company.com",
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const out = executor.transformRequest(
      "ghe-copilot/gpt-5.6-luna",
      bodyWith("gpt-5.6-luna", { effort: "xhigh" }, "xhigh"),
      true,
      gheCredentials
    ) as Record<string, unknown>;
    assert.equal((out.reasoning as Record<string, unknown>).summary, "detailed");
  });
});

test("GH: env override OMNIROUTE_RESPONSES_REASONING_SUMMARY=auto applies to codex models", () => {
  withSummaryEnv("auto", () => {
    const executor = new GithubExecutor();
    const out = executor.transformRequest(
      "gpt-5.3-codex",
      bodyWith("gpt-5.3-codex", undefined, "xhigh"),
      true,
      {}
    ) as Record<string, unknown>;
    assert.deepEqual(out.reasoning, { effort: "xhigh", summary: "auto" });
  });
});

test("GHE: invalid env override falls back to default concise (no upstream 400)", () => {
  withSummaryEnv("banana", () => {
    const executor = new GheCopilotExecutor({
      gheUrl: "https://ghe.company.com",
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const out = executor.transformRequest(
      "ghe-copilot/gpt-5.6-luna",
      bodyWith("gpt-5.6-luna", undefined, "xhigh"),
      true,
      gheCredentials
    ) as Record<string, unknown>;
    assert.equal((out.reasoning as Record<string, unknown>).summary, "concise");
  });
});
