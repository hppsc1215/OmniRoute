import { describe, it, afterEach } from "node:test";
import { equal, ok } from "node:assert/strict";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import {
  mergeModelCompatOverride,
  removeModelCompatOverride,
  getModelCompatOverrides,
} from "../../src/lib/db/models/compat.ts";
import { getModelIncludeThoughts } from "../../src/lib/db/models/modelIncludeThoughts.ts";
import { supportsIncludeThoughtsToggle } from "../../src/shared/constants/modelCompat.ts";

const PROVIDER = "antigravity";
const MODEL = "gemini-3.8-flash-high";
const OTHER_MODEL = "gemini-3.8-flash-low";

type ThinkingConfig = { thinkingLevel?: string; includeThoughts?: boolean };

function thinkingConfigOf(translated: unknown): ThinkingConfig | undefined {
  return (
    translated as {
      request?: { generationConfig?: { thinkingConfig?: ThinkingConfig } };
    }
  )?.request?.generationConfig?.thinkingConfig;
}

/** Hindsight-shaped request: non-streaming, explicit effort, JSON mode. */
function openAiBody(extra: Record<string, unknown> = {}) {
  return {
    model: `${PROVIDER}/${MODEL}`,
    messages: [
      { role: "system", content: "Extract facts." },
      { role: "user", content: "Return valid json only." },
    ],
    reasoning_effort: "high",
    response_format: { type: "json_object" },
    temperature: 0.1,
    ...extra,
  };
}

function translateOpenAI(model: string, body: Record<string, unknown>) {
  return translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, model, body, false, null, PROVIDER);
}

describe("per-model includeThoughts compat override", () => {
  afterEach(() => {
    removeModelCompatOverride(PROVIDER, MODEL);
    removeModelCompatOverride(PROVIDER, OTHER_MODEL);
  });

  it("default (unset): Gemini 3.8 with explicit effort sends thinkingLevel without includeThoughts", () => {
    equal(getModelIncludeThoughts(PROVIDER, MODEL), undefined);
    const tc = thinkingConfigOf(translateOpenAI(MODEL, openAiBody()));
    ok(tc, "thinkingConfig must exist");
    equal(tc.thinkingLevel, "high");
    equal(tc.includeThoughts, undefined);
  });

  it("override on: includeThoughts is forced while the requested thinkingLevel is kept", () => {
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: true });
    equal(getModelIncludeThoughts(PROVIDER, MODEL), true);
    const tc = thinkingConfigOf(translateOpenAI(MODEL, openAiBody()));
    equal(tc?.thinkingLevel, "high");
    equal(tc?.includeThoughts, true);
  });

  it("provider-prefixed model ids resolve to the same override", () => {
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: true });
    equal(getModelIncludeThoughts(PROVIDER, `${PROVIDER}/${MODEL}`), true);
    const tc = thinkingConfigOf(translateOpenAI(`${PROVIDER}/${MODEL}`, openAiBody()));
    equal(tc?.includeThoughts, true);
  });

  it("is scoped to the one model: a sibling model is unaffected", () => {
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: true });
    const tc = thinkingConfigOf(translateOpenAI(OTHER_MODEL, openAiBody({ model: OTHER_MODEL })));
    equal(tc?.includeThoughts, undefined);
  });

  it("an explicit client include_thoughts value wins over the override", () => {
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: true });
    const tc = thinkingConfigOf(translateOpenAI(MODEL, openAiBody({ include_thoughts: false })));
    equal(tc?.includeThoughts, undefined);
  });

  it("null clears the override and drops the compat row when nothing else is set", () => {
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: true });
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: null });
    equal(getModelIncludeThoughts(PROVIDER, MODEL), undefined);
    equal(
      getModelCompatOverrides(PROVIDER).some((e) => e.id === MODEL),
      false,
      "an override row with no remaining flags must not be persisted"
    );
    const tc = thinkingConfigOf(translateOpenAI(MODEL, openAiBody()));
    equal(tc?.includeThoughts, undefined);
  });

  it("explicit false is stored but behaves like the default", () => {
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: false });
    equal(getModelIncludeThoughts(PROVIDER, MODEL), false);
    const tc = thinkingConfigOf(translateOpenAI(MODEL, openAiBody()));
    equal(tc?.includeThoughts, undefined);
  });

  it("dashboard display id (gemini-3.8-flash-tiered) is matched before the upstream alias", () => {
    // The dashboard stores the override under the id the client requests; the
    // -tiered → -high alias is resolved later in the executor, not in the translator.
    const TIERED = "gemini-3.8-flash-tiered";
    mergeModelCompatOverride(PROVIDER, TIERED, { includeThoughts: true });
    try {
      const tc = thinkingConfigOf(
        translateOpenAI(TIERED, openAiBody({ model: `${PROVIDER}/${TIERED}` }))
      );
      equal(tc?.thinkingLevel, "high");
      equal(tc?.includeThoughts, true);
    } finally {
      removeModelCompatOverride(PROVIDER, TIERED);
    }
  });

  it("Claude-format clients get the override too", () => {
    mergeModelCompatOverride(PROVIDER, MODEL, { includeThoughts: true });
    const translated = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.ANTIGRAVITY,
      MODEL,
      {
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: "enabled", budget_tokens: 8192 },
        messages: [{ role: "user", content: "Return valid json only." }],
      },
      false,
      null,
      PROVIDER
    );
    equal(thinkingConfigOf(translated)?.includeThoughts, true);
  });

  it("dashboard toggle is offered only for Gemini-translator providers", () => {
    ok(supportsIncludeThoughtsToggle("antigravity"));
    ok(supportsIncludeThoughtsToggle("agy"));
    ok(supportsIncludeThoughtsToggle("gemini"));
    equal(supportsIncludeThoughtsToggle("openai"), false);
    equal(supportsIncludeThoughtsToggle("claude"), false);
  });
});
