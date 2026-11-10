/**
 * Kiro IDE client identity (CodeWhisperer / Amazon Q runtime).
 *
 * AWS gates the runtime on the Kiro IDE version embedded in the `User-Agent`
 * header: it must carry `KiroIDE-<version>-<machineId>`. Builds below the
 * retirement floor are answered with
 *
 *   HTTP 403 {"message":"This version of Kiro is no longer supported.
 *             Please update to the latest version of Kiro to continue.",
 *             "reason":"FEATURE_NOT_SUPPORTED"}
 *
 * The retirement waves are published at https://kiro.dev/changelog/ide/: the
 * wave that took effect in November 2026 retired every build below 0.11.133,
 * and the `kiro-ide/1.0.0` suffix OmniRoute used to send is rejected the same
 * way because it carries no parsable version at all.
 *
 * `x-amz-user-agent` is NOT gated — verified against the live endpoint by
 * varying one header at a time — but it is kept in the same fingerprint shape
 * so both headers stay consistent.
 *
 * Keep KIRO_IDE_VERSION at (or above) the newest published Kiro IDE release
 * from https://kiro.dev/downloads. A stale value breaks chat, the model
 * catalog and the credit badge at the same time, and the connection is parked
 * as `banned` until someone re-enables it.
 */
import { createHash } from "crypto";

/** Newest published Kiro IDE release (https://kiro.dev/downloads). */
export const KIRO_IDE_VERSION = "1.4.121";

const KIRO_RUNTIME_SDK_VERSION = "1.0.0";
const KIRO_AGENT_OS = "windows";
const KIRO_AGENT_OS_VERSION = "10.0.26200";
const KIRO_NODE_VERSION = "22.21.1";

export type KiroFingerprint = {
  userAgent: string;
  amzUserAgent: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Stable per-connection machine id. Derived from the connection's own identity
 * so one OmniRoute install does not look like thousands of throwaway clients,
 * and so the value survives token rotation.
 */
export function kiroMachineId(providerSpecificData: unknown, accessToken?: string): string {
  const psd = asRecord(providerSpecificData);
  const seed =
    nonEmpty(psd.clientId) || nonEmpty(psd.profileArn) || nonEmpty(accessToken) || "kiro-anonymous";
  return createHash("sha256").update(String(seed)).digest("hex");
}

/** Runtime `User-Agent` / `x-amz-user-agent` pair for a Kiro connection. */
export function buildKiroFingerprint(
  providerSpecificData: unknown,
  accessToken?: string
): KiroFingerprint {
  const machineId = kiroMachineId(providerSpecificData, accessToken);
  return {
    userAgent:
      `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
      `os/${KIRO_AGENT_OS}#${KIRO_AGENT_OS_VERSION} ` +
      `lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
      `api/codewhispererruntime#${KIRO_RUNTIME_SDK_VERSION} m/N,E ` +
      `KiroIDE-${KIRO_IDE_VERSION}-${machineId}`,
    amzUserAgent: `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}-${machineId}`,
  };
}
