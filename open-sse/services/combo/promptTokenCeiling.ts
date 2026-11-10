/**
 * Per-target prompt-token ceilings for combo routing.
 *
 * Why: some providers sell a tier whose price jumps when the prompt crosses a
 * size. GitHub Copilot bills Claude Haiku 5.5 at $0.10/$0.50 per 1M prompt
 * tokens up to 100k, and at $0.50/$2.50 (5x) for a request whose prompt —
 * input + cache reads + cache writes — exceeds 100k, so one 215k-token agent
 * call costs as much as five normal ones. Prompt caching cannot avoid that
 * tier because cache reads count toward the threshold.
 *
 * A combo target can therefore declare `maxPromptTokens`: the largest prompt
 * it may serve. Targets whose estimated prompt exceeds their ceiling are
 * dropped BEFORE dispatch, so the attempt loop falls through to the next
 * target (or returns an explicit 400 when no target is left) instead of paying
 * the long-context tier.
 *
 * Estimate: `estimateFinalInputTokens` — the same messages + tools + system +
 * instructions breakdown chatCore's context guard uses — scaled by the learned
 * actual/estimated ratio (`applyEstimatorCalibration`, #14931) for the
 * target's (provider, model, tools) bucket, then by
 * `config.promptTokenSafetyFactor` (default 1).
 *
 * Error margin: the raw estimator prices everything at chars/4, which
 * undercounts code-heavy JSON by up to ~2x for Claude-family tokenizers (a
 * measured agent body: 16,393 local vs 32,065 real). The calibration bucket
 * closes that gap after `MIN_SAMPLES` completed requests for the same shape;
 * until then (fresh process, calibration disabled, or a brand-new model) the
 * estimate can be that far low. Set `promptTokenSafetyFactor` to ~2 when that
 * cold window must not be crossed, or lower `maxPromptTokens` accordingly.
 *
 * @internal — not part of the public combo.ts barrel.
 */
import { estimateFinalInputTokens } from "../../handlers/chatCore/contextEstimation.ts";
import { applyEstimatorCalibration } from "../estimatorCalibration.ts";
import { parseModel } from "../model.ts";
import { errorResponseWithComboDiagnostics } from "../../utils/error.ts";
import type { ComboLogger, ResolvedComboTarget } from "./types.ts";

/** Multiplier applied to the calibrated estimate; 1 = trust the calibration. */
export const DEFAULT_PROMPT_TOKEN_SAFETY_FACTOR = 1;

/** Log a warning when a kept target sits this close to its ceiling. */
const NEAR_CEILING_RATIO = 0.85;

export type PromptTokenCeilingExclusion = {
  modelStr: string;
  maxPromptTokens: number;
  estimatedPromptTokens: number;
};

export type PromptTokenCeilingResult = {
  targets: ResolvedComboTarget[];
  excluded: PromptTokenCeilingExclusion[];
};

function readPositiveNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * `promptTokenSafetyFactor` from the resolved combo config (combo layer,
 * `comboDefaults` or provider overrides — the usual cascade). Non-finite or
 * non-positive values fall back to the default.
 */
export function resolvePromptTokenSafetyFactor(
  config: Record<string, unknown> | null | undefined
): number {
  return readPositiveNumber(config?.promptTokenSafetyFactor) ?? DEFAULT_PROMPT_TOKEN_SAFETY_FACTOR;
}

/** Agent traffic carries tool schemas; the calibration keeps that shape separate. */
export function requestCarriesTools(body: Record<string, unknown>): boolean {
  const tools = body.tools ?? body.functions;
  return Array.isArray(tools) && tools.length > 0;
}

/**
 * Effective prompt-token estimate for one target: the shared char-based
 * breakdown scaled by the learned actual/estimated ratio for the target's
 * (provider, model, tools) bucket and by the combo's safety factor.
 */
export function estimatePromptTokensForTarget(args: {
  baseEstimate: number;
  provider: string | null | undefined;
  modelStr: string;
  toolsPresent: boolean;
  safetyFactor: number;
}): number {
  const { baseEstimate, provider, modelStr, toolsPresent, safetyFactor } = args;
  if (!(baseEstimate > 0)) return 0;
  const model = parseModel(modelStr).model || modelStr;
  const calibrated = applyEstimatorCalibration(provider, model, baseEstimate, toolsPresent);
  return Math.ceil(Math.max(0, calibrated) * safetyFactor);
}

/**
 * Drop every target whose estimated prompt exceeds its own `maxPromptTokens`.
 * Targets without a ceiling are always kept; when no target declares one the
 * body is never measured.
 */
export function applyPromptTokenCeilings(args: {
  targets: ResolvedComboTarget[];
  body: Record<string, unknown>;
  config?: Record<string, unknown> | null;
  log?: ComboLogger | null;
}): PromptTokenCeilingResult {
  const { targets, body, config, log } = args;
  if (!targets.some((target) => readPositiveNumber(target.maxPromptTokens) != null)) {
    return { targets, excluded: [] };
  }
  const baseEstimate = estimateFinalInputTokens(body);
  if (!(baseEstimate > 0)) return { targets, excluded: [] };

  const toolsPresent = requestCarriesTools(body);
  const safetyFactor = resolvePromptTokenSafetyFactor(config);
  const kept: ResolvedComboTarget[] = [];
  const excluded: PromptTokenCeilingExclusion[] = [];

  for (const target of targets) {
    const ceiling = readPositiveNumber(target.maxPromptTokens);
    if (ceiling == null) {
      kept.push(target);
      continue;
    }
    const estimatedPromptTokens = estimatePromptTokensForTarget({
      baseEstimate,
      provider: target.providerId || target.provider,
      modelStr: target.modelStr,
      toolsPresent,
      safetyFactor,
    });
    if (estimatedPromptTokens > ceiling) {
      excluded.push({ modelStr: target.modelStr, maxPromptTokens: ceiling, estimatedPromptTokens });
      log?.info?.(
        "COMBO",
        `Prompt-token ceiling skipped ${target.modelStr}: estimated ${estimatedPromptTokens} > maxPromptTokens ${ceiling}`
      );
      continue;
    }
    if (estimatedPromptTokens >= ceiling * NEAR_CEILING_RATIO) {
      log?.warn?.(
        "COMBO",
        `Prompt-token ceiling nearly reached for ${target.modelStr}: estimated ${estimatedPromptTokens} of maxPromptTokens ${ceiling}`
      );
    }
    kept.push(target);
  }

  return { targets: kept, excluded };
}

/**
 * Terminal 400 for a combo whose every target rejected the prompt size. The
 * body names each ceiling so the operator can raise it without digging into
 * logs; `prompt_token_ceiling_exceeded` keeps it distinguishable from a real
 * upstream context overflow.
 */
export function buildPromptTokenCeilingResponse(args: {
  comboName: string;
  poolSize: number;
  excluded: PromptTokenCeilingExclusion[];
}): Response {
  const { comboName, poolSize, excluded } = args;
  const detail = excluded
    .map((entry) => `${entry.modelStr} (estimated ${entry.estimatedPromptTokens} > max ${entry.maxPromptTokens})`)
    .join(", ");
  const message =
    `Prompt is too large for every target of combo "${comboName}": ${detail}. ` +
    "Raise or remove maxPromptTokens on a step, or add a target with a larger ceiling.";
  return errorResponseWithComboDiagnostics(
    400,
    message,
    {
      poolSize,
      attempted: 0,
      excluded: excluded.map((entry) => {
        const parsed = parseModel(entry.modelStr);
        return {
          provider: parsed.provider || parsed.providerAlias || "unknown",
          model: parsed.model || entry.modelStr,
          reason: "prompt_tokens",
        };
      }),
      attemptOrder: [],
      terminalReason: "prompt_token_ceiling_exceeded",
    },
    { code: "prompt_token_ceiling_exceeded", type: "invalid_request_error" }
  );
}
