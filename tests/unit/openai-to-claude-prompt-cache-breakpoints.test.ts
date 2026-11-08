/**
 * Anthropic prompt caching for OpenAI-format clients routed to a Claude-format
 * provider (VS Code Copilot Chat, opencode, …).
 *
 * Root cause under test: `prepareClaudeRequest()` gated its breakpoint passes on a
 * hardcoded Anthropic-native allowlist (`claude` / vertex / `anthropic-compatible-*`).
 * `ghe-copilot` and `github` dispatch Claude models to Copilot's native
 * `/v1/messages` shim, which DOES honor and report prompt caching, but the strip
 * passes still ran for them — every marker the OpenAI->Claude translator placed was
 * deleted and none was re-added. Upstream received zero breakpoints, so every turn
 * re-billed the whole prompt (`cache_creation_input_tokens: 0`).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { translateRequest } from "../../open-sse/translator/index.ts";
import {
  applyClaudeCacheBreakpoints,
  countCacheBreakpoints,
} from "../../open-sse/translator/helpers/claudeCacheBreakpoints.ts";
import {
  providerAcceptsClaudeCacheBreakpoints,
  requestCarriesCacheControl,
  targetAcceptsClientCacheMarkers,
} from "../../open-sse/utils/cacheControlPolicy.ts";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";

type ClaudeBody = {
  system?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
};

const TOOL_COUNT = 5;

function toolDefinitions() {
  return Array.from({ length: TOOL_COUNT }, (_, i) => ({
    type: "function",
    function: {
      name: `tool_${i}`,
      description: `Copilot tool ${i}`,
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path"],
      },
    },
  }));
}

/** Turn 1..N of a VS Code Copilot Chat agent loop in OpenAI wire format. */
function agentBody(turn: number) {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "Read src/a.ts and fix the off-by-one bug." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_read",
          type: "function",
          function: { name: "tool_0", arguments: '{"path":"src/a.ts"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_read", content: "export function a() { return 1; }" },
    { role: "assistant", content: "The loop bound is wrong; patching line 3." },
  ];
  if (turn >= 2) {
    messages.push({ role: "user", content: "Now also update the tests." });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_test",
          type: "function",
          function: { name: "tool_1", arguments: '{"path":"src/a.test.ts"}' },
        },
      ],
    });
    messages.push({ role: "tool", tool_call_id: "call_test", content: "no tests yet" });
  }
  if (turn >= 3) {
    // A real agent loop always alternates: the assistant answers the tool result
    // before the next user turn. (A user turn sent directly after a `tool` message
    // is merged into the tool_result message by the translator's role coalescing —
    // a pre-existing shape quirk, not a caching-policy concern.)
    messages.push({ role: "assistant", content: "Tests added; change summarized." });
    messages.push({ role: "user", content: "Great — summarize the change." });
  }
  return {
    model: "claude-haiku-5.5",
    system: "You are a coding agent embedded in VS Code Copilot Chat. ".repeat(20),
    tools: toolDefinitions(),
    messages,
  };
}

function translate(body: Record<string, unknown>, provider: string, preserveCacheControl = false) {
  return translateRequest(
    "openai",
    "claude",
    "claude-haiku-5.5",
    structuredClone(body),
    false,
    null,
    provider,
    null,
    { preserveCacheControl }
  ) as unknown as ClaudeBody;
}

function markerIndexes(body: ClaudeBody) {
  const positions: string[] = [];
  body.tools?.forEach((tool, i) => {
    if (tool.cache_control) positions.push(`tool[${i}]`);
  });
  body.system?.forEach((block, i) => {
    if (block.cache_control) positions.push(`system[${i}]`);
  });
  body.messages.forEach((message, i) => {
    (message.content ?? []).forEach((block, j) => {
      if (block.cache_control)
        positions.push(`message[${i}].${message.role}.${String(block.type)}[${j}]`);
    });
  });
  return positions;
}

function stripMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMarkers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "cache_control") continue;
      out[key] = stripMarkers(child);
    }
    return out;
  }
  return value;
}

test("ghe-copilot: OpenAI-format agent loop gets 4 effective breakpoints", () => {
  const body = translate(agentBody(3), "ghe-copilot");
  const positions = markerIndexes(body);

  assert.ok(positions.length > 0, "translated Claude body must carry cache_control breakpoints");
  assert.ok(
    positions.length <= 4,
    `Anthropic allows at most 4 breakpoints, got ${positions.length}`
  );
  assert.equal(positions.length, 4, `expected the full anchor set, got ${positions.join(", ")}`);

  // 1. last tool definition (the tool block is re-sent verbatim every turn)
  assert.ok(
    positions.some((p) => p === `tool[${TOOL_COUNT - 1}]`),
    `breakpoint must sit on the last tool, got ${positions.join(", ")}`
  );
  // 2. last system block
  assert.ok(
    positions.includes("system[0]"),
    `breakpoint must sit on the system block, got ${positions.join(", ")}`
  );

  // 3. rolling anchor on the LAST message (turn N+1 reads the prefix written in turn N)
  const lastIndex = body.messages.length - 1;
  assert.ok(
    positions.some((p) => p.startsWith(`message[${lastIndex}].`)),
    `breakpoint must sit on the last message (index ${lastIndex}), got ${positions.join(", ")}`
  );

  // 4. one-turn-back anchor on the newest user turn that is not the last message
  const previousUser = body.messages.map((m) => m.role).lastIndexOf("user", lastIndex - 1);
  assert.ok(previousUser >= 0, "fixture must contain an earlier user turn");
  assert.ok(
    positions.some((p) => p.startsWith(`message[${previousUser}].`)),
    `breakpoint must sit on the previous user turn (index ${previousUser}), got ${positions.join(", ")}`
  );
});

test("github (gh) routing behaves like ghe-copilot", () => {
  for (const provider of ["github", "gh"]) {
    const positions = markerIndexes(translate(agentBody(2), provider));
    assert.ok(
      positions.length > 0 && positions.length <= 4,
      `${provider}: got ${positions.join(", ")}`
    );
    const body = translate(agentBody(2), provider);
    const lastIndex = body.messages.length - 1;
    assert.ok(
      markerIndexes(body).some((p) => p.startsWith(`message[${lastIndex}].`)),
      `${provider}: missing rolling anchor on the last message`
    );
  }
});

test("Copilot breakpoints use the 5-minute marker (no extended-TTL beta header upstream)", () => {
  // executors/github.ts sends `anthropic-version` only — a `ttl: "1h"` marker is an
  // Anthropic beta field and must not be sent to a shim that never negotiated it.
  const body = translate(agentBody(2), "ghe-copilot");
  for (const tool of body.tools ?? []) {
    if (tool.cache_control) assert.deepEqual(tool.cache_control, { type: "ephemeral" });
  }
  for (const block of body.system ?? []) {
    if (block.cache_control) assert.deepEqual(block.cache_control, { type: "ephemeral" });
  }
  for (const message of body.messages) {
    for (const block of message.content) {
      if (block.cache_control) assert.deepEqual(block.cache_control, { type: "ephemeral" });
    }
  }
});

test("the translated prefix of turn N is byte-identical inside turn N+1 (cache is hittable)", () => {
  const turn2 = translate(agentBody(2), "ghe-copilot");
  const turn3 = translate(agentBody(3), "ghe-copilot");

  // Compare CONTENT only: `cache_control` is request metadata (it selects where the
  // cache prefix starts/stops), not part of the tokenized prefix Anthropic hashes.
  const previousPrefix = stripMarkers(turn2.messages) as ClaudeBody["messages"];
  const nextPrefix = (stripMarkers(turn3.messages) as ClaudeBody["messages"]).slice(
    0,
    previousPrefix.length
  );
  assert.deepEqual(
    nextPrefix,
    previousPrefix,
    "message content of turn N must survive verbatim in turn N+1, otherwise the prefix cache can never hit"
  );
  assert.deepEqual(stripMarkers(turn2.tools), stripMarkers(turn3.tools));
  assert.deepEqual(stripMarkers(turn2.system), stripMarkers(turn3.system));

  // And turn N+1 must carry a breakpoint at or beyond the end of turn N's content, so
  // the whole previous prefix is inside a cached span.
  const deepest = turn3.messages
    .map((message, index) => (message.content.some((block) => block.cache_control) ? index : -1))
    .filter((index) => index >= 0)
    .pop();
  assert.ok(deepest !== undefined, "turn N+1 must carry a message breakpoint");
  assert.ok(
    deepest >= turn2.messages.length - 1,
    `deepest breakpoint (message ${deepest}) must cover turn N's last message (${turn2.messages.length - 1})`
  );
});

test("client cache_control markers survive translation for caching-capable targets", () => {
  const body: Record<string, unknown> = agentBody(2);
  const messages = body.messages as Array<Record<string, unknown>>;
  // opencode / ai-sdk style: system block + newest user text part carry markers.
  body.system = [{ type: "text", text: "You are opencode.", cache_control: { type: "ephemeral" } }];
  messages[messages.length - 1] = {
    role: "user",
    content: [{ type: "text", text: "final question", cache_control: { type: "ephemeral" } }],
  };

  const preserved = translate(body, "ghe-copilot", true);
  const positions = markerIndexes(preserved);
  assert.ok(positions.includes("system[0]"), "client system marker must survive");
  const lastIndex = preserved.messages.length - 1;
  assert.ok(
    positions.some((p) => p.startsWith(`message[${lastIndex}].`)),
    `client marker on the newest user turn must survive, got ${positions.join(", ")}`
  );
  assert.ok(positions.length <= 4);
});

test("client markers are capped at Anthropic's limit even when the client floods", () => {
  const body = {
    model: "claude-haiku-5.5",
    system: Array.from({ length: 3 }, (_, i) => ({
      type: "text",
      text: `system ${i}`,
      cache_control: { type: "ephemeral" },
    })),
    tools: [
      {
        type: "function",
        function: { name: "tool", parameters: { type: "object" } },
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `m${i}`, cache_control: { type: "ephemeral" } }],
    })),
  };

  const translated = translate(body, "ghe-copilot", true);
  const positions = markerIndexes(translated);
  assert.equal(
    positions.length,
    4,
    `cap must hold at 4, got ${positions.length}: ${positions.join(", ")}`
  );
});

test("legacy Anthropic-native layout is unchanged for provider claude", () => {
  const body = translate(agentBody(2), "claude");
  const positions = markerIndexes(body);
  assert.equal(positions.length, 4);
  // The long-tested layout: system + last tool + second-to-last user + last assistant.
  assert.ok(positions.includes("system[0]"));
  assert.ok(positions.some((p) => p.startsWith("tool[")));
  const lastAssistant = body.messages.map((m) => m.role).lastIndexOf("assistant");
  assert.ok(
    positions.some((p) => p.startsWith(`message[${lastAssistant}].assistant`)),
    `claude layout must keep the last-assistant anchor, got ${positions.join(", ")}`
  );
});

test("non-Anthropic Claude-shape providers get no injected breakpoints", () => {
  // kimi-coding speaks the Messages wire format but has no Anthropic prompt cache;
  // its shim is strict about block fields, so the strip passes must still win.
  const body = translate(agentBody(2), "kimi-coding");
  assert.equal(markerIndexes(body).length, 0);
});

test("applyClaudeCacheBreakpoints fills only empty anchors and honors the budget", () => {
  const body = {
    tools: [{ name: "t" }],
    system: [{ type: "text", text: "sys" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      {
        role: "user",
        content: [{ type: "text", text: "u2", cache_control: { type: "ephemeral" } }],
      },
    ],
  };
  const added = applyClaudeCacheBreakpoints(body, { type: "ephemeral" }, 4);
  // The client already marked the last message, so that anchor is skipped (and
  // costs no budget): tool + system + previous user fill the remaining 3 slots.
  assert.equal(added, 3);
  assert.equal(countCacheBreakpoints(body), 4);
  assert.deepEqual((body.tools[0] as { cache_control?: unknown }).cache_control, {
    type: "ephemeral",
  });
  assert.deepEqual((body.system[0] as { cache_control?: unknown }).cache_control, {
    type: "ephemeral",
  });
  // Client marker untouched (same object value, not overwritten with our TTL).
  assert.deepEqual((body.messages[2].content[0] as { cache_control?: unknown }).cache_control, {
    type: "ephemeral",
  });

  const second = applyClaudeCacheBreakpoints(body, { type: "ephemeral", ttl: "1h" }, 4);
  assert.equal(second, 0, "budget is already spent — a second pass must not add markers");
  assert.equal(countCacheBreakpoints(body), 4);
});

test("providerAcceptsClaudeCacheBreakpoints gates the breakpoint injection", () => {
  assert.equal(providerAcceptsClaudeCacheBreakpoints("ghe-copilot"), true);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("github"), true);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("gh"), true);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("claude"), true);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("anthropic-compatible-local"), true);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("vertex"), true);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("kimi-coding"), false);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("glm"), false);
  assert.equal(providerAcceptsClaudeCacheBreakpoints("openai"), false);
  assert.equal(providerAcceptsClaudeCacheBreakpoints(null), false);
  // Per-connection override wins in both directions.
  assert.equal(
    providerAcceptsClaudeCacheBreakpoints("custom-claude", { supportsPromptCaching: true }),
    true
  );
  assert.equal(
    providerAcceptsClaudeCacheBreakpoints("claude", { supportsPromptCaching: false }),
    false
  );
});

test("targetAcceptsClientCacheMarkers separates wire shape from caching capability", () => {
  // Claude-format leg: only an Anthropic-native endpoint accepts the block field.
  assert.equal(
    targetAcceptsClientCacheMarkers({ provider: "ghe-copilot", targetFormat: "claude" }),
    true
  );
  assert.equal(
    targetAcceptsClientCacheMarkers({ provider: "github", targetFormat: "claude" }),
    true
  );
  assert.equal(
    targetAcceptsClientCacheMarkers({ provider: "kimi-coding", targetFormat: "claude" }),
    false,
    "kimi speaks the Messages shape without an Anthropic cache — its shim must not receive markers"
  );
  assert.equal(targetAcceptsClientCacheMarkers({ provider: "glm", targetFormat: "claude" }), false);
  // OpenAI-format leg keeps the broad caching-provider gate (DashScope & co).
  assert.equal(
    targetAcceptsClientCacheMarkers({ provider: "alibaba", targetFormat: "openai" }),
    true
  );
  assert.equal(
    targetAcceptsClientCacheMarkers({ provider: "openai", targetFormat: "openai" }),
    true
  );
  assert.equal(
    targetAcceptsClientCacheMarkers({ provider: "gemini", targetFormat: "gemini" }),
    false
  );
  // A per-connection override can opt a custom Claude endpoint in or out.
  assert.equal(
    targetAcceptsClientCacheMarkers({
      provider: "my-claude-proxy",
      targetFormat: "claude",
      connectionCacheOverride: { supportsPromptCaching: true },
    }),
    true
  );
});

test("requestCarriesCacheControl detects markers in OpenAI-shape bodies", () => {
  assert.equal(requestCarriesCacheControl({ messages: [{ role: "user", content: "hi" }] }), false);
  assert.equal(
    requestCarriesCacheControl({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
    }),
    true
  );
  assert.equal(
    requestCarriesCacheControl({
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
    }),
    true
  );
  assert.equal(
    requestCarriesCacheControl({ tools: [{ cache_control: { type: "ephemeral" } }] }),
    true
  );
  assert.equal(
    requestCarriesCacheControl({
      messages: [{ role: "user", cache_control: { type: "ephemeral" } }],
    }),
    true
  );
  assert.equal(requestCarriesCacheControl(null), false);
});

test("prepareClaudeRequest does not break client markers on tool definitions for caching targets", () => {
  // The tool-shape normalization used to rebuild each tool and drop cache_control,
  // silently deleting a client breakpoint from the (verbatim re-sent) tool block.
  const body = {
    system: [{ type: "text", text: "sys" }],
    tools: [
      { name: "a", input_schema: { type: "object" } },
      {
        name: "b",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  const prepared = prepareClaudeRequest(structuredClone(body), "ghe-copilot", true) as {
    tools: Array<{ name: string; cache_control?: unknown }>;
  };
  const marked = prepared.tools.find((tool) => tool.cache_control);
  assert.deepEqual(marked?.cache_control, { type: "ephemeral", ttl: "5m" });
});
