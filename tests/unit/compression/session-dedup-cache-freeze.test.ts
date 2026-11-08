/**
 * session-dedup must not rewrite history that is inside the prompt-cache prefix.
 *
 * The engine rewrites the LONGEST suffix block that also appeared in an EARLIER
 * message. Its "never touch the current turn" guard is `calculateCurrentTurnStart()`
 * = index after the last assistant message — a boundary defined from the END of the
 * array, so it moves forward every turn: a message that was the protected current
 * turn in request N becomes rewritable history in request N+1, and its bytes change
 * retroactively. For a caching-capable target that invalidates the whole cached
 * prefix from that message onwards (observed: an old tool result replaced with
 * `[dedup:ref sha=…]` two turns after it had been sent upstream).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sessionDedupEngine } from "../../../open-sse/services/compression/engines/session-dedup/index.ts";

const BLOCK = `function expensiveCalc(x) {
  // step 1
  const a = x * 2;
  // step 2
  const b = a + 100;
  // step 3
  return b;
}`;

type Msg = { role: string; content: string };

/** A conversation whose turn-1 message repeats verbatim in a later history turn. */
function conversation(): { model: string; messages: Msg[] } {
  return {
    model: "claude-haiku-5.5",
    messages: [
      { role: "user", content: `Here is the code:\n${BLOCK}` },
      { role: "assistant", content: "Understood." },
      { role: "user", content: `Review it again please:\n${BLOCK}` },
      { role: "assistant", content: "Looks fine." },
      { role: "user", content: "run the tests" },
      { role: "assistant", content: "Running tests now." },
      { role: "user", content: "test output: 3 passing" },
    ],
  };
}

function applyDedup(
  body: { model: string; messages: Msg[] },
  provider?: string,
  stepConfig: Record<string, unknown> = {}
) {
  return sessionDedupEngine.apply(structuredClone(body), {
    stepConfig,
    ...(provider ? { provider, targetFormat: "claude" } : {}),
  });
}

describe("session-dedup cache freeze", () => {
  it("freezes already-sent history for a caching-capable target", () => {
    const body = conversation();
    const result = applyDedup(body, "ghe-copilot");
    assert.deepEqual(
      result.body.messages,
      body.messages,
      "no message that is already part of the cached prefix may be rewritten"
    );
    assert.equal(result.compressed, false);
  });

  it("still dedups history when the target has no prompt cache (legacy behaviour)", () => {
    const body = conversation();
    const result = applyDedup(body);
    assert.equal(result.compressed, true, "legacy path must keep deduplicating history");
    const rewritten = (result.body.messages as Msg[]).filter((m) =>
      m.content.includes("[dedup:ref")
    );
    assert.equal(rewritten.length, 1);
    assert.equal(
      (result.body.messages[0] as Msg).content.includes("[dedup:ref"),
      false,
      "first occurrence kept"
    );
  });

  it("honours the freezeSentHistory step flag even without a provider", () => {
    const body = conversation();
    const result = applyDedup(body, undefined, { freezeSentHistory: true });
    assert.deepEqual(result.body.messages, body.messages);
  });

  it("keeps rewriting the live turn (bounded tail churn) when frozen", () => {
    // The newest tool result repeats an earlier block: it may be deduped, because it
    // is the tail of the prefix — losing one turn of cache is cheaper than re-sending it.
    const body = conversation();
    body.messages.push({ role: "assistant", content: "checking the diff" });
    body.messages.push({ role: "user", content: `diff context:\n${BLOCK}` });
    const result = applyDedup(body, "ghe-copilot");
    const last = (result.body.messages as Msg[]).at(-1)!;
    assert.ok(last.content.includes("[dedup:ref"), "the live turn may still be compressed");
    // …and every earlier message must be byte-identical to what the client sent.
    const prefix = (result.body.messages as Msg[]).slice(0, -1);
    assert.deepEqual(prefix, body.messages.slice(0, -1));
  });
});
