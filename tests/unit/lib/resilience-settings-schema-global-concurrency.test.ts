/**
 * Hierarchical admission (#7778) added requestQueue.globalConcurrentRequests to the
 * dashboard, the normalizer and the chat pipeline, but not to the strict
 * requestQueueSettingsSchema. The dashboard always sends the full requestQueue
 * object, so every "Request Queue & Rate" save failed with
 * `requestQueue: Unrecognized key: "globalConcurrentRequests"` (HTTP 400).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  requestQueueSettingsSchema,
  updateResilienceSchema,
} from "../../../src/shared/validation/schemas/settings.ts";
import {
  DEFAULT_RESILIENCE_SETTINGS,
  mergeResilienceSettings,
} from "../../../src/lib/resilience/settings.ts";

// Exactly what ResilienceTab sends when saving the Request Queue & Rate card.
const DASHBOARD_REQUEST_QUEUE_PAYLOAD = {
  autoEnableApiKeyProviders: true,
  requestsPerMinute: 100,
  minTimeBetweenRequestsMs: 1000,
  concurrentRequests: 20,
  globalConcurrentRequests: 0,
  maxWaitMs: 120000,
  executionMaxWaitMs: 600000,
};

test("updateResilienceSchema accepts the dashboard requestQueue payload", () => {
  const result = updateResilienceSchema.safeParse({
    requestQueue: DASHBOARD_REQUEST_QUEUE_PAYLOAD,
  });
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("requestQueueSettingsSchema accepts globalConcurrentRequests 0 (disabled) and the max", () => {
  for (const value of [0, 1, 100_000]) {
    const result = requestQueueSettingsSchema.safeParse({ globalConcurrentRequests: value });
    assert.equal(result.success, true, `globalConcurrentRequests ${value} should be accepted`);
  }
});

test("requestQueueSettingsSchema rejects out-of-range or fractional globalConcurrentRequests", () => {
  for (const value of [-1, 100_001, 1.5]) {
    const result = requestQueueSettingsSchema.safeParse({ globalConcurrentRequests: value });
    assert.equal(result.success, false, `globalConcurrentRequests ${value} should be rejected`);
  }
});

test("requestQueueSettingsSchema still rejects unknown keys", () => {
  const result = requestQueueSettingsSchema.safeParse({ notARealKey: 1 });
  assert.equal(result.success, false);
});

test("a validated globalConcurrentRequests patch reaches the resolved settings", () => {
  const parsed = updateResilienceSchema.parse({
    requestQueue: { globalConcurrentRequests: 8 },
  });
  const merged = mergeResilienceSettings(DEFAULT_RESILIENCE_SETTINGS, {
    requestQueue: parsed.requestQueue,
  });
  assert.equal(merged.requestQueue.globalConcurrentRequests, 8);
});
