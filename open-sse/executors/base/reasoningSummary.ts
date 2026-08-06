// Shared /responses reasoning-summary injection for the GitHub Copilot executors.
// Both GithubExecutor (registry "gh") and GheCopilotExecutor (registry
// "ghe-copilot") run the identical gate on their /responses routes; keeping one
// copy here prevents silent divergence between parent and child executor.
// Deps are config only (no host import → no cycle).
import { getModelTargetFormat } from "../../config/providerModels.ts";

/**
 * Allowed values for `reasoning.summary` on the upstream /responses endpoint.
 * Measured against a live GHE Copilot /responses endpoint (gpt-5.6-luna):
 *   - "concise": 51 chars of visible summary text
 *   - "auto":    457 chars (model chooses; some blocks stay encrypted)
 *   - "detailed": 960 chars (maximum visible reasoning)
 * In all modes exactly one of two reasoning items remains encrypted_content-only
 * (upstream design — never recoverable by a proxy).
 */
export const RESPONSES_REASONING_SUMMARY_VALUES = ["concise", "auto", "detailed"] as const;
export type ResponsesReasoningSummary = (typeof RESPONSES_REASONING_SUMMARY_VALUES)[number];

export const DEFAULT_RESPONSES_REASONING_SUMMARY: ResponsesReasoningSummary = "concise";

/**
 * Env override for the injected summary value. Invalid values fall back to the
 * default instead of being forwarded — a bogus `reasoning.summary` is rejected
 * by the upstream with HTTP 400 `unsupported_value`.
 */
export function getResponsesReasoningSummaryOverride(): ResponsesReasoningSummary {
  const raw = process.env.OMNIROUTE_RESPONSES_REASONING_SUMMARY?.trim().toLowerCase();
  if (raw && (RESPONSES_REASONING_SUMMARY_VALUES as readonly string[]).includes(raw)) {
    return raw as ResponsesReasoningSummary;
  }
  return DEFAULT_RESPONSES_REASONING_SUMMARY;
}

/**
 * Request visible reasoning summaries on a Copilot /responses route.
 *
 * GitHub Copilot's Responses API encrypts reasoning ("private reasoning")
 * unless the request opts into a visible summary via `reasoning.summary`.
 * Measured against a live GHE Copilot /responses endpoint (gpt-5.6-luna):
 * "concise" yields 51 chars of visible summary text, "auto" 457, "detailed"
 * 960 — in all modes exactly one of two reasoning items remains encrypted
 * (upstream design, never recoverable by a proxy). The injected value comes
 * from the `OMNIROUTE_RESPONSES_REASONING_SUMMARY` env override, defaulting to
 * "concise"; invalid values fall back to the default (upstream rejects bogus
 * summary values with HTTP 400 `unsupported_value`).
 *
 * Mirrors the buildUrl /responses gate: fires only when the registry marks the
 * model targetFormat "openai-responses" or the id matches /codex/i, and the
 * executor's supportsResponsesEndpoint() accepts it (Claude/Gemini are routed
 * to their native endpoints and never reach /responses). Chat/completions
 * routes are untouched.
 *
 * Injection is client-wins: an existing `reasoning` object only gets its
 * summary set when the client did not already send one (`summary ===
 * undefined`). A top-level `reasoning_effort` without a `reasoning` object
 * (OpenAI-shaped bodies carry the effort this way) gets a `reasoning` object
 * created from it — the /responses endpoint only honors a visible summary on
 * the `reasoning` object. The top-level field is left intact: both forms are
 * valid upstream.
 *
 * Mutates `body` in place. Returns nothing.
 */
export function injectResponsesReasoningSummary(
  registry: string,
  model: string,
  supportsResponses: boolean,
  body: Record<string, unknown>
): void {
  const responsesTargetFormat = getModelTargetFormat(registry, model);
  if ((responsesTargetFormat === "openai-responses" || /codex/i.test(model)) && supportsResponses) {
    const summaryValue = getResponsesReasoningSummaryOverride();
    const reasoning = body.reasoning;
    if (
      reasoning &&
      typeof reasoning === "object" &&
      !Array.isArray(reasoning) &&
      (reasoning as Record<string, unknown>).effort !== undefined &&
      (reasoning as Record<string, unknown>).summary === undefined
    ) {
      (reasoning as Record<string, unknown>).summary = summaryValue;
    } else if (body.reasoning === undefined && typeof body.reasoning_effort === "string") {
      // Top-level `reasoning_effort` only: create the `reasoning` object from
      // it (see docstring above). `body` is a plain object (github.ts spreads
      // the source body), so the write is safe.
      body.reasoning = {
        effort: body.reasoning_effort,
        summary: summaryValue,
      };
    }
  }
}
