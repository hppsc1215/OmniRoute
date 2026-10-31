/**
 * modelIncludeThoughts.ts — per-model `includeThoughts` resolver for model-compat overrides.
 *
 * Gemini 3.8+ (Antigravity / Gemini) only gets `thinkingConfig.includeThoughts` when the
 * client asks for it (see `gemini38ThinkingConfig`). Without streamed thoughts the first
 * byte of a long, non-streaming request arrives only after the whole thinking phase,
 * which can idle past relay timeouts. This flag lets an operator force thoughts back on
 * for one specific provider/model.
 *
 * Stored only in the `modelCompatOverrides` namespace (never on a customModels row), so
 * enabling it does not turn a built-in/synced model into a "manual" custom model.
 */

import { readCompatList } from "./compat";

/** The model-compat override key for the includeThoughts flag. */
const KEY = "includeThoughts";

function stripProviderPrefix(providerId: string, modelId: string): string {
  const prefix = `${providerId}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

/**
 * Explicit include-thoughts preference for a provider/model.
 * `undefined` = unset → translator default (thoughts only when the client asks).
 * `true` = always request thoughts upstream; `false` = explicit off (same as default).
 */
export function getModelIncludeThoughts(providerId: string, modelId: string): boolean | undefined {
  if (!providerId || !modelId) return undefined;
  const id = stripProviderPrefix(providerId, modelId);
  const entry = readCompatList(providerId).find((e) => e.id === id);
  if (entry && Object.prototype.hasOwnProperty.call(entry, KEY)) {
    return Boolean(entry[KEY]);
  }
  return undefined;
}
