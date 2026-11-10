/**
 * Lite must not rewrite a message based on a boundary that moves as the conversation grows.
 *
 * Anthropic-style prefix caching is byte-exact: request N+1 reuses cached tokens only up to
 * the first message whose serialized bytes differ from request N. A transform is therefore
 * cache-safe only when the emitted form of message i is a pure function of messages 0..i —
 * independent of how many messages follow it.
 *
 * `compressToolResults()` skips the "current turn" (the messages after the last assistant
 * message) and truncates everything before it to MAX_TOOL_LENGTH. That boundary is measured
 * from the END of the array, so it moves forward every turn: a tool result request N emitted
 * whole (it was the live turn) is truncated in request N+1, the cached prefix breaks at that
 * message and every token from it onwards is re-billed at the cache-write price.
 *
 * Measured in production on 2026-11-07 (ghe-copilot/claude-haiku-5.5, stacked combo
 * "Standard Savings" = [session-dedup, lite]): lite saved 66,968 tokens/call while breaking
 * the prefix on nearly every agent turn.
 *
 * The regression fixture runs the pipeline exactly as the live combo configures it, over a
 * growing agent conversation whose tool results exceed MAX_TOOL_LENGTH, and asserts that every
 * message of the output is JSON-identical index-by-index between requests N, N+1 and N+2.
 * Non-caching targets keep the legacy truncation and are asserted as such.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyCompression,
  type CompressionMode,
} from "../../../open-sse/services/compression/strategySelector.ts";
import {
  compressToolResults,
  resolveLiteMaxToolLength,
} from "../../../open-sse/services/compression/lite.ts";
import type { CompressionConfig } from "../../../open-sse/services/compression/types.ts";

type Msg = { role: string; content: string | null; [key: string]: unknown };
type Body = { model: string; messages: Msg[] };

const MAX_TOOL_LENGTH = resolveLiteMaxToolLength();
const TRUNCATION_MARKER = "\n...[truncated]";

/** A tool result well past MAX_TOOL_LENGTH, shaped like a real `read` of a source file. */
function longToolFile(label: string, lines = 240): string {
  return Array.from(
    { length: lines },
    (_, i) => `${String(i + 1).padStart(4)}: ${label} def metric_${i}(x): return x * ${i + 1}`
  ).join("\n");
}

function readCall(id: string): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }],
  };
}

function toolResult(id: string, content: string): Msg {
  return { role: "tool", tool_call_id: id, content };
}

/**
 * One conversation observed on three consecutive agent turns. Each turn appends an assistant
 * tool call and its result; the result of the previous turn becomes history — exactly the
 * shape that flips from "live turn, untouched" to "history, truncated" on the next request.
 */
function growingTurns(): Body[] {
  const system: Msg = { role: "system", content: "You are a coding agent. Read files carefully." };
  const user: Msg = { role: "user", content: "Fix the failing metric tests in src/metrics.py." };
  const turn1: Msg[] = [
    system,
    user,
    readCall("c1"),
    toolResult("c1", longToolFile("src/metrics.py")),
  ];
  const turn2: Msg[] = [
    ...turn1,
    readCall("c2"),
    toolResult("c2", longToolFile("tests/test_metrics.py")),
  ];
  const turn3: Msg[] = [
    ...turn2,
    readCall("c3"),
    toolResult("c3", longToolFile("src/aggregates.py")),
  ];
  return [turn1, turn2, turn3].map((messages) => ({ model: "claude-haiku-5.5", messages }));
}

/** The live combo "Standard Savings" (id `default-caveman`) pipeline. */
const PRODUCTION_COMBO = [{ engine: "session-dedup" }, { engine: "lite" }];

const GHE_CLAUDE = { provider: "ghe-copilot", targetFormat: "claude", model: "claude-haiku-5.5" };
const OLLAMA_OPENAI = { provider: "ollama-cloud", targetFormat: "openai", model: "qwen3-coder" };

/**
 * Caching-CAPABLE targets that receive no Anthropic cache_control breakpoint layout. This is
 * the regression guard for the over-broad first cut (`providerSupportsCaching()`): it returned
 * true for all of these, and freezing them would have disabled lite's truncation on
 * antigravity/gemini — the largest lite consumer in production (5,145 calls since 2026-11-01,
 * 223.7M tokens saved) whose prompt growth blows the 25s relay timeout.
 */
const NO_BREAKPOINT_TARGETS = [
  { provider: "antigravity", targetFormat: "gemini", model: "gemini-3.8-flash-tiered" },
  { provider: "codex", targetFormat: "openai-responses", model: "gpt-6-luna" },
  { provider: "opencode-go", targetFormat: "openai", model: "deepseek-v4.1-flash" },
];

function runStacked(body: Body, target: Record<string, string>) {
  const config = {
    enabled: true,
    defaultMode: "stacked",
    stackedPipeline: PRODUCTION_COMBO,
    preserveSystemPrompt: true,
  };
  return applyCompression(
    JSON.parse(JSON.stringify(body)),
    "stacked" as CompressionMode,
    {
      ...target,
      config: config as unknown as CompressionConfig,
    } as Record<string, unknown>
  ).body as unknown as Body;
}

/** JSON-identical index-by-index: request N's output must be a byte-stable prefix of N+1's. */
function assertPrefixStable(earlier: Body, later: Body, label: string): void {
  assert.ok(
    later.messages.length >= earlier.messages.length,
    `${label}: the later request must not lose messages`
  );
  for (let i = 0; i < earlier.messages.length; i += 1) {
    assert.equal(
      JSON.stringify(later.messages[i]),
      JSON.stringify(earlier.messages[i]),
      `${label}: message ${i} (${earlier.messages[i].role}) changed after the conversation grew`
    );
  }
}

describe("lite tool-result truncation versus prompt-cache prefixes", () => {
  it("stacked [session-dedup, lite] keeps every message JSON-identical across turns (ghe-copilot/claude)", () => {
    const [n, n1, n2] = growingTurns().map((body) => runStacked(body, GHE_CLAUDE));

    // Sanity: the fixture is long enough to be truncated, and the live turn is emitted whole.
    const firstResult = n.messages[3].content as string;
    assert.ok(
      firstResult.length > MAX_TOOL_LENGTH,
      `fixture tool result must exceed MAX_TOOL_LENGTH (${MAX_TOOL_LENGTH}), got ${firstResult.length}`
    );
    assert.equal(n.messages[3].content, growingTurns()[0].messages[3].content);

    assertPrefixStable(n, n1, "N vs N+1");
    assertPrefixStable(n1, n2, "N+1 vs N+2");

    // The concrete production regression: the result sent whole in N must still be whole in N+1.
    const carried = n1.messages[3].content as string;
    assert.equal(carried, firstResult);
    assert.ok(
      !carried.includes(TRUNCATION_MARKER),
      "a cached tool result must not be truncated later"
    );
  });

  it("compressToolResults leaves history intact when the caller names a caching target", () => {
    const messages = [
      { role: "user", content: "read it" },
      readCall("c1"),
      toolResult("c1", longToolFile("src/metrics.py")),
      readCall("c2"),
      toolResult("c2", "done"),
    ];
    const body = { messages: messages.map((m) => ({ ...m })) as Msg[] };
    const { body: out, applied } = compressToolResults(body, GHE_CLAUDE);
    assert.equal(applied, false);
    assert.equal(out.messages![2].content, messages[2].content);
  });
});

describe("lite tool-result truncation on non-caching targets (legacy behaviour)", () => {
  it("still truncates tool results that became history (ollama-cloud/openai)", () => {
    const bodies = growingTurns();
    const n = runStacked(bodies[0], OLLAMA_OPENAI);
    const n1 = runStacked(bodies[1], OLLAMA_OPENAI);

    const original = bodies[0].messages[3].content as string;
    assert.equal(n.messages[3].content, original, "the live turn is never truncated");

    const carried = n1.messages[3].content as string;
    assert.notEqual(carried, original);
    assert.ok(carried.length < original.length);
    assert.ok(carried.endsWith(TRUNCATION_MARKER));
  });

  it("keeps the legacy truncation for direct callers that pass no target", () => {
    const content = longToolFile("src/metrics.py");
    const { body, applied } = compressToolResults({
      messages: [
        { role: "user", content: "read it" },
        readCall("c1"),
        toolResult("c1", content),
        readCall("c2"),
        toolResult("c2", "done"),
      ],
    });
    assert.equal(applied, true);
    assert.notEqual(body.messages![2].content, content);
  });

  // Regression guard for the over-broad first cut: `providerSupportsCaching()` is true for
  // antigravity/gemini, codex and plain OpenAI-format routes, but none of them receives a
  // cache_control breakpoint layout — their compression must stay byte-identical to `custom`.
  for (const target of NO_BREAKPOINT_TARGETS) {
    it(`still truncates history where no breakpoints are placed (${target.provider}/${target.model})`, () => {
      const bodies = growingTurns();
      const n = runStacked(bodies[0], target);
      const n1 = runStacked(bodies[1], target);

      const original = bodies[0].messages[3].content as string;
      assert.equal(n.messages[3].content, original, "the live turn is never truncated");

      const carried = n1.messages[3].content as string;
      assert.notEqual(carried, original, "history truncation must keep running on this target");
      assert.ok(carried.length < original.length);
      assert.ok(carried.endsWith(TRUNCATION_MARKER));
    });
  }
});
