import test from "node:test";
import assert from "node:assert/strict";
import GithubExecutor from "../../open-sse/executors/github.ts";
import GheCopilotExecutor from "../../open-sse/executors/ghe-copilot.ts";
import type ProviderCredentials from "../../open-sse/executors/base.ts";

/**
 * Regression tests: GitHub Copilot / GHE Copilot Responses-API reasoning
 * visibility.
 *
 * Root cause (measured against a live GHE Copilot /responses endpoint,
 * gpt-5.6-luna): the upstream encrypts reasoning ("private reasoning")
 * unless the request opts into a visible summary via `reasoning.summary`.
 * `"auto"` leaves the choice to the model per reasoning block — most
 * blocks still come back encrypted, so the ENCRYPTED_REASONING_PLACEHOLDER
 * streams (the intermittent encrypted-message symptom). `"concise"`
 * forces a visible summary for every block (verified live: placeholder
 * deltas 0, real reasoning text streamed).
 *
 * Fix: executors inject `reasoning.summary: "concise"` on the /responses
 * route when an effort is set but no explicit summary was provided.
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
  // reasoning object survives but must NOT gain a summary (claude routes
  // to /chat/completions, where the injection does not apply).
  assert.equal((out.reasoning as Record<string, unknown>).summary, undefined);
  assert.equal((out.reasoning as Record<string, unknown>).effort, "high");
});

test("GHE: leaves plain reasoning_effort top-level (no reasoning object) untouched", () => {
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
  // No reasoning object existed; nothing to enrich (upstream already
  // streams visible reasoning for the top-level chat-style field).
  assert.equal(out.reasoning, undefined);
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
