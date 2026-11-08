/**
 * session-dedup must leave a prompt-cache target byte-identical, turn after turn.
 *
 * Anthropic-style prefix caching is byte-exact: request N+1 reuses cached tokens only up
 * to the first message whose serialized bytes differ from request N. A rewrite is
 * therefore cache-safe only when the emitted form of message i is a pure function of
 * messages 0..i — independent of how many messages follow it.
 *
 * The engine keyed its "never rewrite the current turn" guard on
 * `calculateCurrentTurnStart()` (the index after the last assistant message), a boundary
 * measured from the END of the array. It moves forward every turn, so the message that
 * was protected in request N becomes rewritable history in N+1 and its bytes change
 * retroactively. The `freezeSentHistory` follow-up inverted the direction without fixing
 * it: the live-turn tool result was emitted as `[dedup:ref sha=…]` in request N and as
 * the original text in request N+1 (the reviewer's probe, reproduced below).
 *
 * Fixed by not rewriting caching targets at all:
 *  - protecting the live turn AND freezing sent history is provably a no-op — every
 *    message is protected while it is live and frozen afterwards, so the only rewrite
 *    that ever survives is the live turn, exactly the bytes that change next turn;
 *  - rewriting every duplicate regardless of position is position-stable but hides the
 *    tool result the model just asked for behind a marker nothing resolves
 *    (`__sessionDedupMap__` is documented but never attached), so the model re-reads the
 *    file and that re-read is deduped again — forever;
 *  - a cache read bills at a fraction of the input price, while a broken prefix re-bills
 *    every token from the rewritten message onwards at the cache-write price, so a
 *    dedup marker can only pay off by invalidating the prefix it lives in.
 *
 * Non-caching targets keep the legacy behaviour and are asserted as such.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";

/** Reviewer's probe: an 11-line block repeated from a user message into a tool result. */
const BLOCK = `function expensiveCalc(x) {
  // padding line 1
  // padding line 2
  // padding line 3
  // padding line 4
  // padding line 5
  // padding line 6
  // padding line 7
  // padding line 8
  // padding line 9
  return x * 2;
}`;

type Msg = { role: string; content: string; tool_call_id?: string };
type Body = { model: string; messages: Msg[]; tools?: unknown[] };
type Target = { provider: string; targetFormat: string; model: string };

const CCR_RETRIEVE_TOOL = {
  type: "function",
  function: { name: "omniroute_ccr_retrieve", description: "retrieve a stored block" },
};

/**
 * Turn-by-turn growth of one conversation (same prefix + a new turn each time), with the
 * repeated block appearing in the first user message, in a tool result, and again in a
 * later user message and tool result.
 */
function conversationTurns(): Msg[][] {
  const t1: Msg[] = [
    { role: "user", content: `Here is the code:\n${BLOCK}` },
    { role: "assistant", content: "Reading the file again." },
    { role: "tool", tool_call_id: "t1", content: `file contents:\n${BLOCK}` },
  ];
  const t2: Msg[] = [
    ...t1,
    { role: "assistant", content: "Now running tests." },
    { role: "tool", tool_call_id: "t2", content: "3 passing" },
  ];
  const t3: Msg[] = [
    ...t2,
    { role: "user", content: `Same block again, please:\n${BLOCK}` },
    { role: "assistant", content: "Running the tests again." },
    { role: "tool", tool_call_id: "t3", content: `file contents:\n${BLOCK}` },
  ];
  return [t1, t2, t3];
}

const CACHING_TARGETS: Target[] = [
  // ghe-copilot / github dispatch Claude models to Copilot's native /v1/messages shim.
  { provider: "ghe-copilot", targetFormat: "claude", model: "claude-haiku-5.5" },
  { provider: "github", targetFormat: "claude", model: "claude-sonnet-5" },
  { provider: "claude", targetFormat: "claude", model: "claude-sonnet-5" },
  // OpenAI-format automatic prefix caching (#3955).
  { provider: "openai", targetFormat: "openai", model: "gpt-5.1" },
];

function apply(
  body: Body,
  target?: Target,
  stepConfig: Record<string, unknown> = {}
): { body: Record<string, unknown>; compressed: boolean } {
  return sessionDedupEngine.apply(structuredClone(body) as Record<string, unknown>, {
    stepConfig,
    ...(target ?? {}),
  });
}

function messagesOf(body: Record<string, unknown>): Msg[] {
  return body["messages"] as Msg[];
}

/** The property under test: the emitted prefix may not change when the tail grows. */
function assertPrefixStable(previous: Msg[], next: Msg[], label: string): void {
  assert.ok(
    next.length > previous.length,
    `${label}: the grown request must contain the previous request as its prefix`
  );
  for (let i = 0; i < previous.length; i++) {
    assert.equal(
      JSON.stringify(next[i]),
      JSON.stringify(previous[i]),
      `${label}: message ${i} (role=${previous[i].role}) was emitted as different bytes — ` +
        `the upstream prompt cache resets from here on.\n` +
        `  request N  : ${JSON.stringify(previous[i])}\n` +
        `  request N+1: ${JSON.stringify(next[i])}`
    );
  }
}

describe("session-dedup prompt-cache prefix stability", () => {
  for (const target of CACHING_TARGETS) {
    it(`emits every sent message unchanged on every turn (${target.provider})`, () => {
      const outputs = conversationTurns().map((messages) =>
        messagesOf(apply({ model: target.model, messages }, target).body)
      );

      for (let t = 1; t < outputs.length; t++) {
        assertPrefixStable(outputs[t - 1], outputs[t], `${target.provider} turn ${t}->${t + 1}`);
      }
    });
  }

  it("reproduces the reviewer's probe: the live-turn tool result is not swapped for a marker", () => {
    const target = CACHING_TARGETS[0];
    const [t1, t2] = conversationTurns();

    const requestN = messagesOf(apply({ model: target.model, messages: t1 }, target).body);
    const requestN1 = messagesOf(apply({ model: target.model, messages: t2 }, target).body);

    // Turn N: the tool result is the live turn. Turn N+1: it is history. Same bytes.
    assert.equal(
      requestN[2].content,
      `file contents:\n${BLOCK}`,
      "the live tool result must reach the model verbatim (no `[dedup:ref …]`)"
    );
    assert.equal(
      requestN1[2].content,
      `file contents:\n${BLOCK}`,
      "the same message must still be verbatim on the next turn"
    );
    assert.equal(JSON.stringify(requestN1[2]), JSON.stringify(requestN[2]));
    assert.equal(requestN[2].content.includes("[dedup:ref"), false);
  });

  it("never rewrites a caching target at all, with or without fuzzy enabled", () => {
    const target = CACHING_TARGETS[0];
    for (const stepConfig of [{}, { fuzzy: { enabled: true } }, { minBlockChars: 20 }]) {
      for (const messages of conversationTurns()) {
        const body: Body = {
          model: target.model,
          messages,
          tools: [CCR_RETRIEVE_TOOL],
        };
        const result = apply(body, target, stepConfig);
        assert.equal(result.compressed, false, `no rewrite for ${JSON.stringify(stepConfig)}`);
        assert.equal(
          JSON.stringify(messagesOf(result.body)),
          JSON.stringify(messages),
          "the request body must be emitted byte-identically"
        );
      }
    }
  });

  it("honours the freezeSentHistory step flag even without a provider", () => {
    for (const messages of conversationTurns()) {
      const result = apply({ model: "claude-haiku-5.5", messages }, undefined, {
        freezeSentHistory: true,
      });
      assert.equal(result.compressed, false);
      assert.equal(JSON.stringify(messagesOf(result.body)), JSON.stringify(messages));
    }
  });

  it("still dedups history for a non-caching target (legacy behaviour unchanged)", () => {
    const [t1, t2] = conversationTurns();
    const target: Target = {
      provider: "ollama",
      targetFormat: "openai",
      model: "qwen3-coder",
    };

    // Turn 1: the repeated block is the live tool result — protected, as before.
    const first = apply({ model: target.model, messages: t1 }, target);
    assert.equal(first.compressed, false, "the live turn must stay protected");
    assert.equal(JSON.stringify(messagesOf(first.body)), JSON.stringify(t1));

    // Turn 2: the same message is history now — rewritten, as before.
    const second = apply({ model: target.model, messages: t2 }, target);
    assert.equal(second.compressed, true, "legacy path must keep deduplicating history");
    const rewritten = messagesOf(second.body);
    assert.equal(rewritten[0].content, t2[0].content, "first occurrence kept intact");
    assert.match(rewritten[2].content, /^file contents:\n\[dedup:ref sha=[0-9a-f]{24}\]$/);
    assert.equal(rewritten[4].content, "3 passing", "live turn still untouched");
  });
});
