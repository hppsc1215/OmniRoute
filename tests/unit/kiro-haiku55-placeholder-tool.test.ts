import test from "node:test";
import assert from "node:assert/strict";

import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";
import { KiroExecutor } from "../../open-sse/executors/kiro.ts";
import { KIRO_PLACEHOLDER_TOOL_NAME } from "../../open-sse/executors/kiroToolCallValidation.ts";

// claude-haiku-5.5 on Kiro refuses every request without a tool schema
// (HTTP 200, metadataEvent stopReason CONTENT_FILTERED, no content). The
// translator injects one inert placeholder tool; the executor hides it.

type KiroTool = { toolSpecification?: { name?: string } };

function currentTools(payload: unknown): KiroTool[] | undefined {
  const p = payload as {
    conversationState: {
      currentMessage: {
        userInputMessage: { userInputMessageContext?: { tools?: KiroTool[] } };
      };
    };
  };
  return p.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools;
}

const toolLess = {
  messages: [
    { role: "system", content: "You name coding sessions." },
    { role: "user", content: "fix docker build" },
  ],
};

test("tool-less claude-haiku-5.5 request gets the placeholder tool", () => {
  const payload = buildKiroPayload("claude-haiku-5.5", toolLess, true, {});
  const tools = currentTools(payload);
  assert.ok(Array.isArray(tools));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolSpecification?.name, KIRO_PLACEHOLDER_TOOL_NAME);
});

test("dash-spelled claude-haiku-5-5 is normalized and also gets the placeholder", () => {
  const payload = buildKiroPayload("claude-haiku-5-5", toolLess, true, {});
  assert.equal(currentTools(payload)?.[0]?.toolSpecification?.name, KIRO_PLACEHOLDER_TOOL_NAME);
});

test("client tools are kept as-is, no placeholder added", () => {
  const body = {
    ...toolLess,
    tools: [
      {
        type: "function",
        function: { name: "read_file", parameters: { type: "object", properties: {} } },
      },
    ],
  };
  const names = currentTools(buildKiroPayload("claude-haiku-5.5", body, true, {}))?.map(
    (t) => t.toolSpecification?.name
  );
  assert.deepEqual(names, ["read_file"]);
});

test("other Kiro models stay tool-less", () => {
  for (const model of ["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-5.5"]) {
    assert.equal(currentTools(buildKiroPayload(model, toolLess, true, {})), undefined, model);
  }
});

// --- executor: a call to the placeholder must never reach the client ---

const enc = new TextEncoder();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function frame(eventType: string, payload: unknown): Uint8Array {
  const name = enc.encode(":event-type");
  const value = enc.encode(eventType);
  const headers = new Uint8Array(1 + name.length + 3 + value.length);
  headers[0] = name.length;
  headers.set(name, 1);
  let o = 1 + name.length;
  headers[o++] = 7;
  headers[o++] = (value.length >> 8) & 0xff;
  headers[o++] = value.length & 0xff;
  headers.set(value, o);
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, headers.length, false);
  view.setUint32(8, crc32(out.slice(0, 8)), false);
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  view.setUint32(total - 4, crc32(out.slice(0, total - 4)), false);
  return out;
}

function eventStream(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(f);
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } }
  );
}

test("executor drops placeholder tool calls and keeps finish_reason stop", async () => {
  const executor = new KiroExecutor();
  const response = eventStream([
    frame("assistantResponseEvent", { content: "Fix Docker Build" }),
    frame("toolUseEvent", { toolUseId: "t1", name: KIRO_PLACEHOLDER_TOOL_NAME, input: {} }),
    frame("metricsEvent", { inputTokens: 3, outputTokens: 4 }),
  ]);
  const text = await executor.transformEventStreamToSSE(response, "claude-haiku-5.5").text();
  assert.match(text, /"content":"Fix Docker Build"/);
  assert.doesNotMatch(text, new RegExp(KIRO_PLACEHOLDER_TOOL_NAME));
  assert.doesNotMatch(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /"finish_reason":"stop"/);
});
