import test from "node:test";
import assert from "node:assert/strict";

// Pure-function coverage for buildCallLogListRows (src/app/api/usage/call-logs/route.ts):
// - merges active/completed in-memory entries with persisted DB rows
// - sorts by priority (active > completed > persisted) then newest-first
// - carries correlationId through so the GET handler can filter on it
import { buildCallLogListRows } from "../../src/app/api/usage/call-logs/route.ts";

test("buildCallLogListRows: active requests sort before completed and persisted rows", () => {
  const now = 1_000_000;
  const rows = buildCallLogListRows({
    logs: [
      {
        id: "persisted-1",
        timestamp: new Date(now - 5_000).toISOString(),
        correlationId: "corr-a",
      },
    ],
    connections: [],
    pendingDetails: [
      {
        id: "active-1",
        startedAt: now - 1_000,
        provider: "openai",
        model: "gpt-4o",
        connectionId: "conn-1",
        correlationId: "corr-a",
      },
    ],
    completedDetails: [
      {
        id: "completed-1",
        startedAt: now - 3_000,
        completedAt: now - 2_000,
        provider: "anthropic",
        model: "claude",
        connectionId: "conn-2",
        correlationId: "corr-b",
      },
    ],
    now,
  });

  assert.equal(rows.length, 3);
  // active (priority 0) first, then completed (priority 1), then persisted (priority 2)
  assert.equal(rows[0].id, "active-1");
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].id, "completed-1");
  assert.equal(rows[1].completed, true);
  assert.equal(rows[2].id, "persisted-1");
});

test("buildCallLogListRows: within the same priority, newest timestamp sorts first", () => {
  const now = 2_000_000;
  const rows = buildCallLogListRows({
    logs: [
      { id: "old", timestamp: new Date(now - 10_000).toISOString() },
      { id: "new", timestamp: new Date(now - 1_000).toISOString() },
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [],
    now,
  });

  assert.deepEqual(
    rows.map((r) => (r as Record<string, unknown>).id),
    ["new", "old"]
  );
});

test("buildCallLogListRows: in-memory entries carry correlationId for downstream filtering", () => {
  const now = 3_000_000;
  const rows = buildCallLogListRows({
    logs: [],
    connections: [],
    pendingDetails: [
      {
        id: "active-cid",
        startedAt: now - 500,
        provider: "openai",
        model: "gpt-4o",
        connectionId: "conn-1",
        correlationId: "corr-xyz",
      },
    ],
    completedDetails: [
      {
        id: "completed-no-cid",
        startedAt: now - 4_000,
        completedAt: now - 3_000,
        provider: "anthropic",
        model: "claude",
        connectionId: "conn-2",
      },
    ],
    now,
  });

  const active = rows.find((r) => (r as Record<string, unknown>).id === "active-cid") as
    Record<string, unknown> | undefined;
  const completed = rows.find((r) => (r as Record<string, unknown>).id === "completed-no-cid") as
    Record<string, unknown> | undefined;
  assert.equal(active?.correlationId, "corr-xyz");
  assert.equal(completed?.correlationId, null);
});

test("buildCallLogListRows: dedupes completed in-memory entries already persisted to the DB", () => {
  const now = 4_000_000;
  const rows = buildCallLogListRows({
    logs: [{ id: "dup-1", timestamp: new Date(now - 1_000).toISOString() }],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      {
        id: "dup-1",
        startedAt: now - 3_000,
        completedAt: now - 2_000,
        provider: "openai",
        model: "gpt-4o",
        connectionId: "conn-1",
      },
    ],
    now,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "dup-1");
  // persisted row wins (no `completed` flag)
  assert.equal(rows[0].completed, undefined);
});

test("buildCallLogListRows: dedupes completed in-memory entries sharing correlationId with a persisted DB row (different IDs)", () => {
  const now = 4_000_000;
  const correlationId = "corr-unique-123";
  const rows = buildCallLogListRows({
    logs: [
      {
        id: "c7bfe657-338a-4635-aa69-3baea2e9931a", // UUID in DB
        correlationId,
        timestamp: new Date(now - 1_000).toISOString(),
        status: 200,
        model: "gemini-3.8-flash-tiered",
        requestedModel: "antigravity/gemini-3.8-flash-tiered",
        apiKeyName: "openchamber Windows",
      },
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      {
        id: "1762244984756-3b5a9c8d1e2f-0", // pendingRequestId in RAM
        correlationId,
        startedAt: now - 3_000,
        completedAt: now - 1_000,
        provider: "antigravity",
        model: "gemini-3.8-flash-tiered",
        connectionId: "conn-ag",
      },
    ],
    now,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "c7bfe657-338a-4635-aa69-3baea2e9931a");
  assert.equal(rows[0].completed, undefined);
  assert.equal(rows[0].requestedModel, "antigravity/gemini-3.8-flash-tiered");
});

test("buildCallLogListRows: keeps completed in-memory attempt when DB only has an earlier attempt for the same correlationId", () => {
  const now = 4_000_000;
  const correlationId = "corr-fallback-456";
  const rows = buildCallLogListRows({
    logs: [
      {
        id: "attempt-1-db-uuid",
        correlationId,
        timestamp: new Date(now - 5_000).toISOString(), // Attempt 1 finished at now - 5000
        status: 502,
        model: "provider-a-model",
      },
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      {
        id: "attempt-2-ram-id",
        correlationId,
        startedAt: now - 3_000, // Attempt 2 started at now - 3000 (after attempt 1)
        completedAt: now - 1_000,
        provider: "provider-b",
        model: "provider-b-model",
        status: 200,
      },
    ],
    now,
  });

  // Both attempts should be visible: attempt 1 (persisted 502) and attempt 2 (in-memory 200)
  assert.equal(rows.length, 2);
  const attempt1 = rows.find((r) => (r as Record<string, unknown>).id === "attempt-1-db-uuid") as
    Record<string, unknown> | undefined;
  const attempt2 = rows.find((r) => (r as Record<string, unknown>).id === "attempt-2-ram-id") as
    Record<string, unknown> | undefined;
  assert.ok(attempt1, "attempt 1 from DB must be present");
  assert.ok(attempt2, "attempt 2 from RAM must be present");
  assert.equal(attempt1.status, 502);
  assert.equal(attempt2.status, 200);
});

test("buildCallLogListRows: dedupes completed in-memory attempt once DB has that attempt persisted (2 real attempts, not 3)", () => {
  const now = 4_000_000;
  const correlationId = "corr-fallback-both-persisted";
  const rows = buildCallLogListRows({
    logs: [
      {
        id: "attempt-1-db-uuid",
        correlationId,
        timestamp: new Date(now - 5_000).toISOString(),
        status: 502,
        model: "provider-a-model",
      },
      {
        id: "attempt-2-db-uuid",
        correlationId,
        timestamp: new Date(now - 1_000).toISOString(), // Attempt 2 now persisted
        status: 200,
        model: "provider-b-model",
      },
    ],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      {
        id: "attempt-2-ram-id",
        correlationId,
        startedAt: now - 3_000,
        completedAt: now - 1_000,
        provider: "provider-b",
        model: "provider-b-model",
        status: 200,
      },
    ],
    now,
  });

  // Exactly 2 attempts in DB, in-memory duplicate of attempt 2 is dropped
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => (r as Record<string, unknown>).id === "attempt-1-db-uuid"));
  assert.ok(rows.some((r) => (r as Record<string, unknown>).id === "attempt-2-db-uuid"));
  assert.ok(!rows.some((r) => (r as Record<string, unknown>).id === "attempt-2-ram-id"));
});

test("/api/logs/[id]: falls back to matching in-memory completedDetail by correlationId when DB row lacks payloads", async () => {
  const { GET } = await import("../../src/app/api/logs/[id]/route.ts");
  const { storeCompletedDetail, clearCompletedDetails } =
    await import("../../src/lib/usage/completedRequestDetails.ts");
  const { saveCallLog } = await import("../../src/lib/usageDb.ts");
  const typeBridge = (d: unknown) => d as Parameters<typeof storeCompletedDetail>[0];

  const dbUuid = "11111111-2222-3333-4444-555555555555";
  const correlationId = "corr-detail-test-789";

  await saveCallLog({
    id: dbUuid,
    correlationId,
    timestamp: new Date().toISOString(),
    status: 200,
    model: "test-model",
    provider: "test-provider",
  });

  storeCompletedDetail(
    typeBridge({
      id: "ram-pending-id-999",
      correlationId,
      startedAt: Date.now() - 2000,
      completedAt: Date.now() - 500,
      model: "test-model",
      provider: "test-provider",
      connectionId: "conn-1",
      clientRequest: { messages: [{ role: "user", content: "hi" }] },
      clientResponse: { choices: [{ message: { content: "hello" } }] },
    })
  );

  try {
    const response = await GET(undefined as unknown as Request, {
      params: Promise.resolve({ id: dbUuid }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, dbUuid);
    assert.ok(body.pipelinePayloads);
    assert.deepEqual(body.pipelinePayloads.clientRequest, {
      messages: [{ role: "user", content: "hi" }],
    });
  } finally {
    clearCompletedDetails();
  }
});
