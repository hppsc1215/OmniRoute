/**
 * Kiro adaptive thinking can spend the whole output budget on reasoning. Kiro then
 * closes the stream with reasoning frames only: no text, no tool call and no
 * stop event (Kiro never sends `messageStopEvent` on this surface, not even for
 * complete answers). Reported as `finish_reason: "stop"` this looked like a
 * finished, empty turn and agent clients (Hermes) re-sent it over and over.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { KiroExecutor } from "../../open-sse/executors/kiro.ts";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";
import { kiroEventFrame } from "../_helpers/kiroEventStreamFixture.ts";

function eventStream(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } }
  );
}

async function finishReasons(frames: Uint8Array[]): Promise<string[]> {
  const sse = new KiroExecutor().transformEventStreamToSSE(eventStream(frames), "claude-opus-5.5");
  const text = await sse.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.finish_reason)
    .filter(Boolean);
}

test("reasoning-only Kiro stream ends with finish_reason length, not stop", async () => {
  const reasons = await finishReasons([
    kiroEventFrame("reasoningContentEvent", { text: "Let me plan the posts..." }),
    kiroEventFrame("reasoningContentEvent", { text: " still planning" }),
    kiroEventFrame("contextUsageEvent", { contextUsagePercentage: 61.4 }),
    kiroEventFrame("meteringEvent", { unit: "credit", usage: 14.2 }),
  ]);
  assert.deepEqual(reasons, ["length"]);
});

test("Kiro stream with reasoning and an answer still ends with stop", async () => {
  const reasons = await finishReasons([
    kiroEventFrame("reasoningContentEvent", { text: "Thinking" }),
    kiroEventFrame("assistantResponseEvent", { content: "Here is the answer." }),
    kiroEventFrame("contextUsageEvent", { contextUsagePercentage: 10 }),
  ]);
  assert.deepEqual(reasons, ["stop"]);
});

test("Kiro stream with reasoning and a tool call still ends with tool_calls", async () => {
  const reasons = await finishReasons([
    kiroEventFrame("reasoningContentEvent", { text: "Need a tool" }),
    kiroEventFrame("toolUseEvent", { toolUseId: "call_1", name: "ping", input: { a: 1 } }),
    kiroEventFrame("toolUseEvent", { toolUseId: "call_1", name: "ping", stop: true }),
  ]);
  assert.deepEqual(reasons, ["tool_calls"]);
});

test("Opus 5.5 without client max_tokens gets the model's full output window", () => {
  const payload = buildKiroPayload(
    "claude-opus-5.5",
    { messages: [{ role: "user", content: "Plan a campaign" }], reasoning_effort: "high" },
    true,
    null
  );
  assert.equal(payload.additionalModelRequestFields?.max_tokens, 128000);
  assert.equal(payload.inferenceConfig?.maxTokens, 128000);
});

test("an explicit client max_tokens is still forwarded unchanged", () => {
  const payload = buildKiroPayload(
    "claude-opus-5.5",
    {
      messages: [{ role: "user", content: "Plan a campaign" }],
      reasoning_effort: "high",
      max_tokens: 2048,
    },
    true,
    null
  );
  assert.equal(payload.additionalModelRequestFields?.max_tokens, 2048);
  assert.equal(payload.inferenceConfig?.maxTokens, 2048);
});

test("thinking hint leaves room for the answer when max_tokens is small", () => {
  const payload = buildKiroPayload(
    "claude-opus-5.5",
    {
      messages: [{ role: "user", content: "Plan a campaign" }],
      reasoning_effort: "high",
      max_tokens: 4096,
    },
    true,
    null
  );
  const content = payload.conversationState.currentMessage.userInputMessage.content;
  const hint = Number(/<max_thinking_length>(\d+)<\/max_thinking_length>/.exec(content)?.[1]);
  assert.ok(hint > 0 && hint <= 2048, `thinking hint ${hint} must stay below half of 4096`);
});
