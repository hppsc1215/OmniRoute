/**
 * Model compatibility protocol keys — shared between client UI and server.
 * Must not import Node or DB code so client components can import safely.
 */

/** Client request shapes from detectFormat — compat options apply when the client uses this protocol */
export const MODEL_COMPAT_PROTOCOL_KEYS = ["openai", "openai-responses", "claude"] as const;

export type ModelCompatProtocolKey = (typeof MODEL_COMPAT_PROTOCOL_KEYS)[number];

/** Providers whose Gemini translator honors the per-model `includeThoughts` compat flag. */
export const INCLUDE_THOUGHTS_PROVIDERS = ["antigravity", "agy", "gemini"] as const;

export function supportsIncludeThoughtsToggle(providerId: string): boolean {
  return (INCLUDE_THOUGHTS_PROVIDERS as readonly string[]).includes(providerId);
}
