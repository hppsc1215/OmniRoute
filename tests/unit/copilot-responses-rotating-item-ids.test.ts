import test from "node:test";
import assert from "node:assert/strict";

const { GithubExecutor } = await import("../../open-sse/executors/github.ts");
const { GheCopilotExecutor } = await import("../../open-sse/executors/ghe-copilot.ts");
const { BaseExecutor } = await import("../../open-sse/executors/base.ts");
const { openaiResponsesToOpenAIResponse } =
  await import("../../open-sse/translator/response/openai-responses.ts");

// Shape of a real GHE Copilot /responses stream (gpt-6-luna, 2026-10-30): every event of
// the single assistant message carries a DIFFERENT opaque item id. Ids are anonymized.
function copilotRotatingIdEvents(ids = (n: number) => `enc-${n}`) {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_a", status: "in_progress", output: [] },
    },
    {
      type: "response.in_progress",
      sequence_number: 1,
      response: { id: "resp_a", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { id: ids(1), type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      sequence_number: 3,
      item_id: ids(2),
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    ...["PING", "-", "42"].map((delta, i) => ({
      type: "response.output_text.delta",
      sequence_number: 4 + i,
      item_id: ids(3 + i),
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    })),
    {
      type: "response.output_text.done",
      sequence_number: 7,
      item_id: ids(6),
      output_index: 0,
      content_index: 0,
      text: "PING-42",
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      sequence_number: 8,
      item_id: ids(7),
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "PING-42", annotations: [] },
    },
    {
      type: "response.output_item.done",
      sequence_number: 9,
      output_index: 0,
      item: {
        id: ids(8),
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "PING-42", annotations: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 10,
      response: {
        id: "resp_b",
        status: "completed",
        output: [
          {
            id: ids(9),
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "PING-42", annotations: [] }],
          },
        ],
        usage: { input_tokens: 16, output_tokens: 7, total_tokens: 23 },
      },
    },
  ];
}

function toSse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

// Split into small arbitrary byte chunks so SSE lines straddle chunk boundaries.
function streamFromText(text: string, size = 37): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

function parseSseData(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

function translatedContent(events: Record<string, unknown>[]): string {
  const state = {};
  let content = "";
  for (const event of events) {
    const out = openaiResponsesToOpenAIResponse(event, state);
    for (const chunk of [out].flat()) {
      const delta = (chunk as { choices?: { delta?: { content?: string } }[] } | null)?.choices?.[0]
        ?.delta;
      if (typeof delta?.content === "string") content += delta.content;
    }
  }
  return content;
}

async function executeWithUpstream(
  executor: InstanceType<typeof GithubExecutor>,
  body: string,
  url: string,
  contentType = "text/event-stream",
  stream = true
) {
  const originalExecute = BaseExecutor.prototype.execute;
  BaseExecutor.prototype.execute = async () => ({
    response: new Response(streamFromText(body), {
      status: 200,
      headers: { "content-type": contentType },
    }),
    url,
    headers: {},
    transformedBody: {},
  });
  try {
    const result = await executor.execute({
      model: "gpt-6-luna",
      body: { input: "x" },
      stream,
      credentials: { accessToken: "token" },
    });
    return await (result as { response: Response }).response.text();
  } finally {
    BaseExecutor.prototype.execute = originalExecute;
  }
}

test("translator emits the text once when item ids are stable (control)", () => {
  assert.equal(translatedContent(copilotRotatingIdEvents(() => "msg_stable")), "PING-42");
});

for (const [name, Executor] of [
  ["ghe-copilot", GheCopilotExecutor],
  ["github", GithubExecutor],
] as const) {
  test(`${name}: rotating Copilot item ids no longer repeat the answer 4x`, async () => {
    const text = await executeWithUpstream(
      new Executor(),
      toSse(copilotRotatingIdEvents()),
      "https://api.githubcopilot.com/responses"
    );
    assert.equal(translatedContent(parseSseData(text)), "PING-42");
  });
}

test("every event of one output_index is pinned to the first id seen for it", async () => {
  const text = await executeWithUpstream(
    new GheCopilotExecutor(),
    toSse(copilotRotatingIdEvents()),
    "https://copilot-proxy.example.ghe.com/responses"
  );
  const events = parseSseData(text);
  const ids = events.flatMap((e) => {
    const item = e.item as { id?: string } | undefined;
    const output = (e.response as { output?: { id?: string }[] } | undefined)?.output ?? [];
    return [e.item_id, item?.id, ...output.map((o) => o.id)].filter(Boolean);
  });
  assert.ok(ids.length >= 9);
  assert.deepEqual([...new Set(ids)], ["enc-1"]);
  // Everything else (event lines, text, sequence numbers) is untouched.
  assert.equal(events.length, copilotRotatingIdEvents().length);
  assert.match(text, /^event: response\.created\n/);
});

test("non-streaming drain of a /responses SSE body is stabilized too", async () => {
  const text = await executeWithUpstream(
    new GheCopilotExecutor(),
    toSse(copilotRotatingIdEvents()),
    "https://api.githubcopilot.com/responses",
    "text/event-stream",
    false
  );
  assert.equal(translatedContent(parseSseData(text)), "PING-42");
});

test("chat/completions SSE and non-SSE bodies pass through byte-identical", async () => {
  const chatSse =
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
    "data: [DONE]\n\n";
  assert.equal(
    await executeWithUpstream(
      new GheCopilotExecutor(),
      chatSse,
      "https://api.githubcopilot.com/chat/completions"
    ),
    chatSse
  );

  const json = JSON.stringify({ output: [{ id: "a", type: "message" }] });
  assert.equal(
    await executeWithUpstream(
      new GheCopilotExecutor(),
      json,
      "https://api.githubcopilot.com/responses",
      "application/json"
    ),
    json
  );
});
