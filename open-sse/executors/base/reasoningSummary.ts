// Shared /responses reasoning-summary injection for the GitHub Copilot executors.
// Both GithubExecutor (registry "gh") and GheCopilotExecutor (registry
// "ghe-copilot") run the identical gate on their /responses routes; keeping one
// copy here prevents silent divergence between parent and child executor.
// Deps are config only (no host import → no cycle).
import { getModelTargetFormat } from "../../config/providerModels.ts";

/**
 * Request visible reasoning summaries on a Copilot /responses route.
 *
 * GitHub Copilot's Responses API encrypts reasoning ("private reasoning")
 * unless the request opts into a visible summary via `reasoning.summary:
 * "concise"`. Measured against a live GHE Copilot /responses endpoint
 * (gpt-5.6-luna): "auto" leaves the choice to the model per reasoning block —
 * most blocks still come back encrypted, so the ENCRYPTED_REASONING_PLACEHOLDER
 * streams intermittently. "concise" forces a visible summary for every block.
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
    const reasoning = body.reasoning;
    if (
      reasoning &&
      typeof reasoning === "object" &&
      !Array.isArray(reasoning) &&
      (reasoning as Record<string, unknown>).effort !== undefined &&
      (reasoning as Record<string, unknown>).summary === undefined
    ) {
      (reasoning as Record<string, unknown>).summary = "concise";
    } else if (body.reasoning === undefined && typeof body.reasoning_effort === "string") {
      // Top-level `reasoning_effort` only: create the `reasoning` object from
      // it (see docstring above). `body` is a plain object (github.ts spreads
      // the source body), so the write is safe.
      body.reasoning = {
        effort: body.reasoning_effort,
        summary: "concise",
      };
    }
  }
}
