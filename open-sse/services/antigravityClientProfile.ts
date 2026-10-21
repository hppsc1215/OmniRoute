import {
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";
import { getAntigravityContentHeaders } from "./antigravityHeaders.ts";
import type { AntigravityCredentialsLike } from "./antigravityIdentity.ts";
import {
  resolveAntigravityCliVersion,
  resolveAntigravityIdeVersion,
} from "./antigravityVersion.ts";

export {
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";

type AntigravityProfileCredentials = AntigravityCredentialsLike & {
  providerSpecificData?: Record<string, unknown> | null;
};

const ABSENT_CONTENT_IDENTITY_HEADERS = [
  "x-client-name",
  "x-client-version",
  "x-machine-id",
  "x-vscode-sessionid",
  "X-Goog-Api-Client",
  "Client-Metadata",
] as const;

export function getAntigravityClientProfile(
  credentials?: AntigravityProfileCredentials | null
): AntigravityClientProfile {
  const fromProviderData =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
      ? credentials.providerSpecificData.clientProfile
      : undefined;

  return normalizeAntigravityClientProfile(fromProviderData);
}

export function resolveAntigravityClientVersion(
  profile: AntigravityClientProfile
): Promise<string> {
  return profile === "cli" ? resolveAntigravityCliVersion() : resolveAntigravityIdeVersion();
}

export function removeHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
}

function getProjectHeaderValue(body: unknown): string | null {
  const project =
    body && typeof body === "object" ? (body as Record<string, unknown>).project : null;
  if (typeof project !== "string" || project.trim().length === 0) return null;
  if (project === "test-project" || project === "project-id" || project === "aicode-consumers")
    return null;
  return project;
}

/**
 * Per-connection opt-out for the `x-goog-user-project` header. Some accounts
 * (e.g. the shared `aicode-consumers` project) always answer 403 when the header
 * is present, which costs one wasted upstream send per request before the
 * header-less retry. Default stays on so custom GCP projects keep working.
 */
export function shouldSendProjectHeader(
  credentials: AntigravityProfileCredentials | null | undefined
): boolean {
  const data = credentials?.providerSpecificData;
  if (!data || typeof data !== "object" || Array.isArray(data)) return true;
  return data.sendProjectHeader !== false;
}

/** Apply the selected official client identity to a Cloud Code content request. */
export function applyAntigravityClientProfileHeaders(
  headers: Record<string, string>,
  credentials: AntigravityProfileCredentials | null | undefined,
  body: unknown
): AntigravityClientProfile {
  const profile = getAntigravityClientProfile(credentials);
  const identityHeaders = getAntigravityContentHeaders(profile);

  removeHeaderCaseInsensitive(headers, "User-Agent");
  headers["User-Agent"] = identityHeaders["User-Agent"];
  for (const name of ABSENT_CONTENT_IDENTITY_HEADERS) {
    removeHeaderCaseInsensitive(headers, name);
  }

  const project = shouldSendProjectHeader(credentials) ? getProjectHeaderValue(body) : null;
  removeHeaderCaseInsensitive(headers, "x-goog-user-project");
  // The native Go CLI (consumer auth) sends no quota-project header at all; only the IDE
  // profile does. sendAntigravityRequest still retries once without it on a 403.
  if (project && profile !== "cli") {
    headers["x-goog-user-project"] = project;
  }

  return profile;
}
