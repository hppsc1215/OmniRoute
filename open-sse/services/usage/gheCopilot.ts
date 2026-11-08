/**
 * usage/gheCopilot.ts — quota for GitHub Enterprise Copilot (`ghe-copilot`) connections.
 *
 * Two sources, in this order:
 *
 *  1. PASSIVE — every inference response on a GHE tenant carries
 *     `x-quota-snapshot-*` headers (AI credits used / entitlement / reset /
 *     overage). `src/lib/usage/githubQuotaCapture.ts` records them on the chat
 *     path and `src/lib/usage/providerLimits.ts` serves that snapshot. This is
 *     the only source guaranteed to exist: `api.github.com/copilot_internal/user`
 *     is not the tenant's API, and no chat request is ever sent just to poll quota.
 *
 *  2. ACTIVE — the tenant-scoped equivalent `<gheUrl>/api/v3/copilot_internal/user`,
 *     the same REST base `src/lib/oauth/providers/ghe-copilot.ts` already uses for
 *     `/api/v3/user` and `/api/v3/copilot_internal/v2/token`. Best-effort bootstrap
 *     only: a tenant that does not expose it (404/403) degrades to a message,
 *     never to an error state on the connection.
 *
 * This module is deliberately free of `src/` imports: the passive snapshot is
 * served by `src/lib/usage/providerLimits.ts` (which owns the freshness policy
 * and only falls back to this probe). Keeping the read out of here also avoids
 * the ESM init cycle described in `open-sse/services/quotaPreflight.ts` and adds
 * no open-sse -> src boundary edge.
 */

import { getGitHubCopilotInternalUserHeaders } from "../../config/providerHeaderProfiles.ts";
import { fetchWithConnectionProxy } from "../connectionProxyFetch.ts";
import { buildGitHubUsageFromInternalUserPayload } from "./github.ts";

type JsonRecord = Record<string, unknown>;

/** The "nothing captured yet" answer, shared by every degradation path. */
export const GHE_COPILOT_NO_DATA_MESSAGE =
  "GitHub Enterprise Copilot connected. AI-credit usage appears here after the first request to the tenant (captured from response headers).";

const GHE_INTERNAL_USER_TIMEOUT_MS = 8_000;

/** Normalize `gheUrl` into the tenant REST base (`<host>/api/v3`). */
export function resolveGheApiBaseUrl(providerSpecificData?: JsonRecord | null): string | null {
  const raw = providerSpecificData?.gheUrl;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;

  const base = `${parsed.protocol}//${parsed.host}`;
  return base.endsWith("/api/v3") ? base : `${base}/api/v3`;
}

/** Tenant endpoint for the Copilot user/quota payload, or null without a gheUrl. */
export function resolveGheInternalUserUrl(providerSpecificData?: JsonRecord | null): string | null {
  const base = resolveGheApiBaseUrl(providerSpecificData);
  return base ? `${base}/copilot_internal/user` : null;
}

/**
 * Usage fetcher for `ghe-copilot` connections.
 *
 * Never throws: the Provider Limits sync treats a thrown error as a connection
 * failure, and a quota read must not mark a working tenant connection as broken.
 */
export async function getGheCopilotUsage(
  accessToken?: string,
  providerSpecificData?: JsonRecord,
  connectionId?: string
) {
  const url = resolveGheInternalUserUrl(providerSpecificData);
  if (!accessToken || !url) return { message: GHE_COPILOT_NO_DATA_MESSAGE };

  const init: RequestInit = {
    headers: getGitHubCopilotInternalUserHeaders(`Bearer ${accessToken}`),
    signal: AbortSignal.timeout(GHE_INTERNAL_USER_TIMEOUT_MS),
  };

  try {
    const response = connectionId
      ? await fetchWithConnectionProxy(connectionId, url, init)
      : await globalThis.fetch(url, init);
    if (!response?.ok) return { message: GHE_COPILOT_NO_DATA_MESSAGE };

    const payload = (await response.json()) as unknown;
    const usage = buildGitHubUsageFromInternalUserPayload(payload);
    if (!usage || Object.keys(usage.quotas).length === 0) {
      return { message: GHE_COPILOT_NO_DATA_MESSAGE };
    }
    return { plan: usage.plan, resetDate: usage.resetDate, quotas: usage.quotas };
  } catch {
    // 404/403/timeout/TLS: the tenant does not expose the endpoint. The passive
    // capture is the real source; this probe is only a bootstrap.
    return { message: GHE_COPILOT_NO_DATA_MESSAGE };
  }
}
