/**
 * Pricing data — GitHub Copilot.
 *
 * Both Copilot transports bill from the same published rate card: `github` (github.com,
 * alias `gh`) and `ghe-copilot` (GitHub Enterprise). They therefore share this single
 * table — `DEFAULT_PRICING_OAUTH` maps all three keys onto `GITHUB_COPILOT_PRICING`
 * instead of duplicating rows per transport.
 *
 * Copilot is usage-billed: every request is charged per token in GitHub AI credits
 * (1 credit = $0.01), so a seat is NOT a flat rate and these rows are the real tariff.
 *
 * Source of truth (rate card read 2026-11-08):
 * https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 * All rates are US$ per 1M tokens.
 *
 * `long_context` mirrors the rate card's "Long context" tier: once the prompt crosses
 * `threshold`, the tier rates replace the flat ones for the WHOLE request. The prompt
 * size is cache-inclusive (input + cache reads + cache writes) — see
 * `applyLongContextTier` in src/lib/usage/costCalculator.ts. Tiered models: Claude
 * Haiku 5.5 (>100K), GPT-5.6 Luna (>200K), Grok (>200K), GPT-5.6/6/6.1 (>272K).
 */
import {
  CLAUDE_FABLE_5_1_PRICING,
  CLAUDE_HAIKU_5_PRICING,
  CLAUDE_OPUS_5_5_PRICING,
  CLAUDE_OPUS_5_PRICING,
  CLAUDE_SONNET_5_PRICING,
  GEMINI_3_7_FLASH_PROMO_PRICING,
  GEMINI_3_8_FLASH_PROMO_PRICING,
  GEMINI_4_ARGON_PROMO_PRICING,
  GPT_6_ASTRA_PRICING,
  withOpenAiLongContextTier,
} from "./shared-tiers";

type CopilotRates = {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  cache_creation: number;
};

/**
 * One rate-card row. Copilot publishes a single output rate (thinking/output tokens
 * included), so `reasoning` follows `output` instead of carrying a premium.
 */
function row(input: number, cached: number, cacheWrite: number, output: number): CopilotRates {
  return { input, output, cached, reasoning: output, cache_creation: cacheWrite };
}

/** A rate-card row plus its "Long context" tier (threshold counted in prompt tokens). */
function tiered(base: CopilotRates, threshold: number, tier: CopilotRates) {
  return { ...base, long_context: { threshold, ...tier } };
}

// ── Anthropic ────────────────────────────────────────────────────────────────
// Anthropic rows carry a cache-write rate; the rate card lists it separately from
// cached input.
const COPILOT_CLAUDE_SONNET_4 = row(3.0, 0.3, 3.75, 15.0);
const COPILOT_CLAUDE_OPUS_4_8 = row(5.0, 0.5, 6.25, 25.0);

// ── OpenAI ───────────────────────────────────────────────────────────────────
// "Not applicable" cache write on the rate card => 0, so a provider that reports
// cache-write tokens is not charged for a rate Copilot does not publish.
const COPILOT_GPT_5_3_CODEX = row(1.75, 0.175, 0, 14.0);
const COPILOT_GPT_5_4_NANO = row(0.2, 0.02, 0, 1.25);

// ── xAI ──────────────────────────────────────────────────────────────────────
const COPILOT_GROK = tiered(row(2.0, 0.5, 0, 6.0), 200_000, row(4.0, 1.0, 0, 12.0));

export const GITHUB_COPILOT_PRICING = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  "claude-haiku-4.5": row(1.0, 0.1, 1.25, 5.0),
  // Legacy Copilot id for the same model (Haiku 4.5) — was priced at half the rate card.
  "claude-4.5-haiku": row(1.0, 0.1, 1.25, 5.0),
  // Claude Haiku 5.5: <=100K $0.10/$0.50, >100K $0.50/$2.50 for the whole request.
  // Same published rates as Anthropic's own → reuse the shared tiered constant.
  "claude-haiku-5.5": CLAUDE_HAIKU_5_PRICING,
  "claude-haiku-5-5": CLAUDE_HAIKU_5_PRICING,
  "claude-sonnet-4": COPILOT_CLAUDE_SONNET_4,
  "claude-sonnet-4.6": COPILOT_CLAUDE_SONNET_4,
  "claude-sonnet-5": CLAUDE_SONNET_5_PRICING,
  // Sonnet 5.5 cache reads are $0.10 (Sonnet 5 is $0.20) → own row.
  "claude-sonnet-5-5": row(2.0, 0.1, 2.5, 10.0),
  "claude-opus-4.8": COPILOT_CLAUDE_OPUS_4_8,
  "claude-opus-4.8-fast": row(10.0, 1.0, 12.5, 50.0),
  "claude-opus-5": CLAUDE_OPUS_5_PRICING,
  "claude-opus-5.5": CLAUDE_OPUS_5_5_PRICING,
  "claude-fable-5": row(10.0, 1.0, 12.5, 50.0),
  "claude-fable-5.1": CLAUDE_FABLE_5_1_PRICING,

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  "gpt-5.3-codex": COPILOT_GPT_5_3_CODEX,
  "gpt-5.4-nano": COPILOT_GPT_5_4_NANO,
  "gpt-5.6-luna": tiered(row(0.2, 0.02, 0.25, 1.2), 200_000, row(0.4, 0.04, 0.5, 1.8)),
  "gpt-5.6-sol": tiered(row(4.0, 0.4, 5.0, 20.0), 272_000, row(8.0, 0.8, 10.0, 30.0)),
  "gpt-5.6-terra": tiered(row(2.0, 0.2, 2.5, 12.0), 272_000, row(4.0, 0.4, 5.0, 18.0)),
  // Copilot's GPT-6 Astra row is exactly 2x input/cache rates and 1.5x output above 272K.
  "gpt-6-astra": withOpenAiLongContextTier(GPT_6_ASTRA_PRICING),
  "gpt-6-luna": tiered(row(0.1, 0.01, 0.125, 0.5), 272_000, row(0.2, 0.02, 0.25, 0.75)),
  "gpt-6-sol": tiered(row(2.0, 0.2, 2.5, 10.0), 272_000, row(4.0, 0.4, 5.0, 15.0)),
  "gpt-6.1-sol": tiered(row(2.0, 0.1, 2.5, 10.0), 272_000, row(4.0, 0.2, 5.0, 15.0)),
  "gpt-6.1-terra": tiered(row(1.0, 0.05, 1.25, 5.0), 272_000, row(2.0, 0.1, 2.5, 7.5)),

  // ── Google / Microsoft / xAI / Moonshot ────────────────────────────────────
  "gemini-3.8-flash": GEMINI_3_8_FLASH_PROMO_PRICING,
  "gemini-4-argon": GEMINI_4_ARGON_PROMO_PRICING,
  "mai-code-1.1-flash": row(0.2, 0.02, 0, 1.2),
  "grok-4.5": COPILOT_GROK,
  "grok-4.6": COPILOT_GROK,
  "grok-4.7": COPILOT_GROK,
  "kimi-k3": row(3.0, 0.3, 0, 15.0),

  // ── Legacy ids (absent from the 2026-11 rate card) ─────────────────────────
  // Kept verbatim so retired-but-still-callable Copilot ids keep a price instead of
  // silently accounting to $0. Do not extend this block: new models belong on the
  // rate-card rows above.
  "gpt-5": { input: 3.0, output: 12.0, cached: 1.5, reasoning: 18.0, cache_creation: 3.0 },
  "gpt-5-mini": { input: 0.75, output: 3.0, cached: 0.375, reasoning: 4.5, cache_creation: 0.75 },
  "gpt-5.1-codex": { input: 4.0, output: 16.0, cached: 2.0, reasoning: 24.0, cache_creation: 4.0 },
  "gpt-5.1-codex-max": {
    input: 8.0,
    output: 32.0,
    cached: 4.0,
    reasoning: 48.0,
    cache_creation: 8.0,
  },
  "gpt-4.1": { input: 2.5, output: 10.0, cached: 1.25, reasoning: 15.0, cache_creation: 2.5 },
  "claude-4.5-sonnet": {
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    reasoning: 22.5,
    cache_creation: 3.0,
  },
  "claude-4.5-opus": { input: 5.0, output: 25.0, cached: 0.5, reasoning: 37.5, cache_creation: 5.0 },
  "gemini-3-pro": { input: 2.0, output: 12.0, cached: 0.25, reasoning: 18.0, cache_creation: 2.0 },
  "gemini-3-flash": { input: 0.5, output: 3.0, cached: 0.03, reasoning: 4.5, cache_creation: 0.5 },
  "gemini-3.7-flash": GEMINI_3_7_FLASH_PROMO_PRICING,
  "gemini-2.5-pro": {
    input: 2.0,
    output: 12.0,
    cached: 0.25,
    reasoning: 18.0,
    cache_creation: 2.0,
  },
  "grok-code-fast-1": {
    input: 0.5,
    output: 2.0,
    cached: 0.25,
    reasoning: 3.0,
    cache_creation: 0.5,
  },
};
