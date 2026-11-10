/**
 * Kiro retires IDE builds on a published schedule (https://kiro.dev/changelog/ide/)
 * and answers every build below the current floor with
 *
 *   403 {"message":"This version of Kiro is no longer supported. ...",
 *        "reason":"FEATURE_NOT_SUPPORTED"}
 *
 * The gate reads the `KiroIDE-<version>-<machineId>` token out of `User-Agent`.
 * OmniRoute used to send `AWS-SDK-JS/3.0.0 kiro-ide/1.0.0`, which carries no
 * parsable version at all, so the November 2026 wave (which retired everything
 * below 0.11.133) took chat AND the model catalog AND the credit badge down at
 * once — and the 403 parked the connection as `banned`.
 *
 * These tests pin the two things that must not regress: the pinned version has
 * to stay above the retired floor, and every Kiro request path has to send a
 * parsable `KiroIDE-<version>` fingerprint instead of an unversioned suffix.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { KiroExecutor } from "../../open-sse/executors/kiro.ts";
import { getKiroServiceHeaders } from "../../open-sse/config/providerHeaderProfiles.ts";
import { KIRO_IDE_VERSION, buildKiroFingerprint } from "../../open-sse/services/kiroUserAgent.ts";

/** Newest Kiro IDE build AWS had already retired when this pin was written. */
const RETIRED_FLOOR = [0, 11, 133];

function parseVersion(value: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  assert.ok(match, `"${value}" is not a semantic version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const KIRO_IDE_UA_PATTERN = /KiroIDE-\d+\.\d+\.\d+(-[0-9a-f]{64})?/;

test("pinned Kiro IDE version is above the retired build floor", () => {
  assert.ok(
    compareVersions(parseVersion(KIRO_IDE_VERSION), RETIRED_FLOOR) > 0,
    `KIRO_IDE_VERSION ${KIRO_IDE_VERSION} must be newer than the retired floor ` +
      `${RETIRED_FLOOR.join(".")} — bump it to the current release from https://kiro.dev/downloads`
  );
});

test("kiro chat headers carry a parsable KiroIDE version fingerprint", () => {
  const executor = new KiroExecutor("kiro");
  const headers = executor.buildHeaders(
    {
      accessToken: "test-token",
      providerSpecificData: { authMethod: "idc", clientId: "test-client-id" },
    } as never,
    true
  ) as Record<string, string>;

  assert.match(headers["User-Agent"], KIRO_IDE_UA_PATTERN);
  assert.ok(headers["User-Agent"].includes(`KiroIDE-${KIRO_IDE_VERSION}-`));
  assert.ok(headers["X-Amz-User-Agent"].includes(`KiroIDE-${KIRO_IDE_VERSION}-`));
  // The event-stream target must survive the header rewrite.
  assert.equal(
    headers["X-Amz-Target"],
    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
  );
});

test("static kiro service headers are versioned too (usage + connection test paths)", () => {
  const headers = getKiroServiceHeaders("application/json");
  assert.match(headers["User-Agent"], KIRO_IDE_UA_PATTERN);
  assert.match(headers["X-Amz-User-Agent"], KIRO_IDE_UA_PATTERN);
});

test("kiro fingerprint is stable per connection identity and varies across connections", () => {
  const first = buildKiroFingerprint({ clientId: "client-a" }, "token-a");
  const again = buildKiroFingerprint({ clientId: "client-a" }, "token-b");
  const second = buildKiroFingerprint({ clientId: "client-b" }, "token-a");

  assert.equal(first.userAgent, again.userAgent, "token rotation must not change the machine id");
  assert.notEqual(first.userAgent, second.userAgent);
  assert.equal(
    first.amzUserAgent.split(" ").at(-1),
    `KiroIDE-${KIRO_IDE_VERSION}-${first.userAgent.split("-").at(-1)}`
  );
});

test("kiro fingerprint falls back to the access token when the connection has no client id", () => {
  const fingerprint = buildKiroFingerprint({}, "standalone-token");
  assert.match(fingerprint.userAgent, KIRO_IDE_UA_PATTERN);
  assert.notEqual(
    fingerprint.userAgent,
    buildKiroFingerprint({}, "another-standalone-token").userAgent
  );
});
