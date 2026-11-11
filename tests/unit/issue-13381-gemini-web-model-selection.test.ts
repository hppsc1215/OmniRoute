// #13381 — gemini-web advertised model IDs but never selected the requested
// model in the Gemini UI: every alias opened the identical page and ran the
// identical automation, so two structurally different advertised models
// produced byte-identical Playwright traces, and the OpenAI-shaped `model`
// field on the response was a caller-supplied label, not an observed fact.
//
// Owner decision (2026-09-15, Option B): implement real selection, fail closed
// when the switch cannot be confirmed. Rewritten 2026-11-11 after measuring the
// live UI: models are chosen through a MENU PICKER
// (`[data-test-id="bard-mode-menu-button"]`, aria-label
// "Open mode picker, currently <mode>") whose `[role="menuitemradio"]` options
// are clicked, then the picker label is read back. The old toggle/indicator
// selectors were never valid against a real account (a bare
// `button[aria-haspopup="menu"]` matched "Upload & tools" first, and a real
// Playwright click timed out on Google's consent overlay).
//
// This suite proves the STRUCTURE against a fake page: a confirmed read-back
// proceeds, an unconfirmed one never does, and an unknown id never runs the
// account default under the requested label.

import test from "node:test";
import assert from "node:assert/strict";

const { GeminiWebExecutor } = await import("../../open-sse/executors/gemini-web.ts");
const { GEMINI_WEB_UNSUPPORTED_CONTROL_CODE } =
  await import("../../open-sse/executors/gemini-web/capabilities.ts");
const { GEMINI_WEB_MODEL_MODES, GEMINI_WEB_THINKING_LEVELS } =
  await import("../../open-sse/executors/gemini-web/modeSelection.ts");

type Call = { fn: string; args: unknown[] };

interface DomScript {
  /** `aria-label` the mode-picker button reports ("… derzeit ausgewählt: …"). */
  pickerLabel?: string;
  /** Visible labels of the picker's `[role="menuitemradio"]` options. */
  options?: string[];
  /** What the clicked option reports for aria-checked/aria-selected; absent = null. */
  checked?: boolean;
  /** Rendered answer snapshot; absent = nothing rendered (-> 502). */
  answer?: { text: string; busy: string | null };
}

interface PageScript {
  dom?: DomScript;
}

/**
 * Configurable fake Playwright. `evaluate` decides what to answer from the
 * serialized callback's own source (the production helpers are distinguished by
 * the selectors they query), which keeps the fake independent of internal
 * function names.
 */
function makeFakePlaywright(calls: Call[], script: PageScript = {}) {
  const dom = script.dom ?? {};
  return {
    newContext: async (opts: unknown) => {
      calls.push({ fn: "newContext", args: [opts] });
      return {
        addCookies: async (cookies: unknown) => {
          calls.push({ fn: "addCookies", args: [cookies] });
        },
        cookies: async () => [],
        newPage: async () => ({
          on: (event: string) => {
            calls.push({ fn: "page.on", args: [event] });
          },
          goto: async (url: string, opts2: unknown) => {
            calls.push({ fn: "goto", args: [url, opts2] });
          },
          waitForTimeout: async (ms: number) => {
            calls.push({ fn: "waitForTimeout", args: [ms] });
          },
          waitForSelector: async (selector: string, opts2: unknown) => {
            calls.push({ fn: "waitForSelector", args: [selector, opts2] });
            if (!selector.includes(".ql-editor")) return null;
            return {
              click: async () => {
                calls.push({ fn: "editor.click", args: [] });
              },
            };
          },
          evaluate: async (fn: (...args: never[]) => unknown, arg?: unknown) => {
            const source = String(fn);
            // consent.ts — no dialog in the fake DOM
            if (/alle ablehnen|reject all/i.test(source)) return "";
            // executor — focus the composer through the DOM (no click: overlay scrims)
            if (source.includes("contenteditable")) {
              calls.push({ fn: "dom.focus.composer", args: [] });
              return true;
            }
            // modeSelection.ts — read the clicked option's selected state
            if (source.includes("aria-checked")) return dom.checked ?? null;
            // modeSelection.ts — click the matching picker option
            if (source.includes("menuitemradio")) {
              const pattern = new RegExp(String(arg), "i");
              const match = (dom.options ?? []).find((label) => pattern.test(label));
              if (!match) return "";
              calls.push({ fn: "dom.click.option", args: [match] });
              return match;
            }
            // modeSelection.ts — read the picker label back
            if (source.includes("mode picker")) return dom.pickerLabel ?? "";
            // domAnswer.ts — answer snapshot
            if (source.includes("message-content")) return dom.answer ?? { text: "", busy: null };
            return "";
          },
          keyboard: {
            type: async (text: string, opts2: unknown) => {
              calls.push({ fn: "keyboard.type", args: [text, opts2] });
            },
            insertText: async (text: string) => {
              calls.push({ fn: "keyboard.insertText", args: [text] });
            },
            press: async (key: string) => {
              calls.push({ fn: "keyboard.press", args: [key] });
            },
          },
        }),
      };
    },
    close: async () => {
      calls.push({ fn: "browser.close", args: [] });
    },
  };
}

interface ErrorBodyLike {
  error: { message: string; type: string; code: string };
}

async function runWithFakePage(
  model: string,
  script: PageScript,
  extra: Record<string, unknown> = {}
): Promise<{ calls: Call[]; status: number; body: ErrorBodyLike | Record<string, unknown> }> {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const calls: Call[] = [];
  playwright.chromium.launch = (async () =>
    makeFakePlaywright(calls, script)) as unknown as typeof originalLaunch;
  try {
    const executor = new GeminiWebExecutor();
    const result = await executor.execute({
      model,
      body: { messages: [{ role: "user", content: "What is 2+2?" }], stream: false, ...extra },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=fake" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });
    const body = (await result.response.json()) as ErrorBodyLike | Record<string, unknown>;
    return { calls, status: result.response.status, body };
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
}

function contentOf(body: ErrorBodyLike | Record<string, unknown>): string {
  const choices = (body as { choices?: Array<{ message?: { content?: string } }> }).choices;
  return choices?.[0]?.message?.content ?? "";
}

// ─── Regression guard: two different advertised models must diverge ────────

test(
  "#13381: distinct advertised gemini-web model IDs drive distinguishable Playwright " +
    "automation (per-model selection is genuinely attempted)",
  async () => {
    // A confirmed switch reaches the prompt and returns the rendered answer.
    const runA = await runWithFakePage("gemini-3.8-flash", {
      dom: {
        pickerLabel: "Modusauswahl öffnen, derzeit ausgewählt: Flash",
        options: ["Schnellinfo 3.5 Flash-Lite", "Vielseitige Unterstützung 3.8 Flash"],
        answer: { text: "4", busy: null },
      },
    });
    // A different model whose option the picker does not offer fails closed instead
    // of running whatever mode the account happened to leave selected.
    const runB = await runWithFakePage("gemini-3.1-pro", {
      dom: {
        pickerLabel: "Modusauswahl öffnen, derzeit ausgewählt: Flash",
        options: ["Vielseitige Unterstützung 3.8 Flash"],
      },
    });

    assert.notDeepEqual(
      runA.calls,
      runB.calls,
      "expected the automation trace to DIFFER between two distinct advertised models " +
        "(proving model selection is attempted) — an identical trace would mean the " +
        "executor still never selects the requested Gemini UI mode"
    );

    assert.equal(runA.status, 200, "a confirmed switch answers from the rendered DOM");
    assert.equal(contentOf(runA.body), "4");
    assert.ok(
      runA.calls.some((c) => c.fn === "dom.click.option" && /3\.8 Flash/.test(String(c.args[0]))),
      "the requested model's picker option must be clicked"
    );

    assert.equal(
      runB.status,
      400,
      "an unconfirmed non-default model must fail closed, never silently proceed"
    );
    assert.equal((runB.body as ErrorBodyLike).error.code, GEMINI_WEB_UNSUPPORTED_CONTROL_CODE);

    const gotoCall = runA.calls.find((c) => c.fn === "goto");
    assert.ok(gotoCall);
    assert.equal(gotoCall!.args[0], "https://gemini.google.com/app");

    // The core dishonesty this issue reported: runB must NOT reach the editor at all —
    // proceeding under an unconfirmed model label is exactly the bug being fixed.
    assert.equal(
      runB.calls.some((c) => c.fn === "dom.focus.composer"),
      false,
      "an unconfirmed model must never reach the prompt editor"
    );
  }
);

// ─── (a) Read-back confirms -> proceeds ─────────────────────────────────────

test("#13381: a confirmed model-mode read-back lets the request proceed to the prompt", async () => {
  const descriptor = GEMINI_WEB_MODEL_MODES["gemini-3.8-flash"];
  assert.ok(descriptor.menuLabelPattern && descriptor.expectedIndicatorPattern);

  const { status, calls, body } = await runWithFakePage("gemini-3.8-flash", {
    dom: {
      pickerLabel: "Modusauswahl öffnen, derzeit ausgewählt: Flash",
      options: ["Schnellinfo 3.5 Flash-Lite", "Vielseitige Unterstützung 3.8 Flash"],
      answer: { text: "4", busy: "false" },
    },
  });

  assert.equal(status, 200, "a CONFIRMED mode switch must proceed and answer");
  assert.equal(contentOf(body), "4");
  assert.ok(
    calls.some((c) => c.fn === "dom.click.option" && String(c.args[0]).includes("3.8 Flash")),
    "the matching picker option must have been clicked"
  );
  assert.ok(
    calls.some((c) => c.fn === "dom.focus.composer"),
    "must reach the prompt editor once confirmed"
  );
});

// ─── (b) Control missing -> 400, never a silent 200 ─────────────────────────

test("#13381: a missing mode picker fails closed with 400, not a silent 200", async () => {
  const { status, body } = await runWithFakePage("gemini-3.8-flash", { dom: {} });

  assert.notEqual(status, 200);
  assert.equal(status, 400);
  const err = (body as ErrorBodyLike).error;
  assert.equal(err.code, GEMINI_WEB_UNSUPPORTED_CONTROL_CODE);
  assert.match(err.message, /gemini-3\.8-flash/);
  assert.equal(err.message.includes("at /"), false, "error bodies must stay sanitized");
});

// ─── (c) Read-back disagrees -> 400, not a silent success ───────────────────

test("#13381: a mismatched read-back fails closed with 400, not a silent success", async () => {
  const { status, body } = await runWithFakePage("gemini-3.8-flash", {
    dom: {
      // Option was offered and clicked, but the UI still reports another mode.
      pickerLabel: "Modusauswahl öffnen, derzeit ausgewählt: Argon",
      options: ["Vielseitige Unterstützung 3.8 Flash"],
      answer: { text: "4", busy: "false" },
    },
  });

  assert.notEqual(status, 200);
  assert.equal(status, 400);
  assert.equal((body as ErrorBodyLike).error.code, GEMINI_WEB_UNSUPPORTED_CONTROL_CODE);
});

// ─── Unknown model id -> 400, not a silent account-default run ──────────────

test("#13381: an advertised-but-unmapped model id fails closed instead of running the account default", async () => {
  const { status, body } = await runWithFakePage("gemini-4.0-ultra-does-not-exist", {
    dom: { answer: { text: "4", busy: "false" } },
  });

  assert.equal(status, 400);
  assert.equal((body as ErrorBodyLike).error.code, GEMINI_WEB_UNSUPPORTED_CONTROL_CODE);
});

// ─── Thinking depth (#13381 follow-up) — a SOFT hint, never a hard failure ──

test("#13381: a requested thinking level is applied and verified when the control allows it", async () => {
  const descriptor = GEMINI_WEB_THINKING_LEVELS.high;
  assert.ok(descriptor.menuLabelPattern);

  const { status, calls } = await runWithFakePage(
    "gemini-3.8-flash",
    {
      dom: {
        pickerLabel: "Modusauswahl öffnen, derzeit ausgewählt: Flash",
        options: [
          "Vielseitige Unterstützung 3.8 Flash",
          "Niedrig Fast and efficient",
          "Mittel Ausgewogener Tiefgang",
          "Hoch Besonders gründlich",
        ],
        checked: true,
        answer: { text: "4", busy: "false" },
      },
    },
    { reasoning_effort: "high" }
  );

  assert.equal(status, 200);
  assert.ok(
    calls.some((c) => c.fn === "dom.click.option" && /hoch|high/i.test(String(c.args[0]))),
    "the requested thinking level must be clicked"
  );
});

test("#13381: an unconfirmable thinking level is logged and IGNORED, never a 400", async () => {
  // Measured 2026-11-11: the picker label echoes the model only, so a level that
  // exposes no aria-checked cannot be verified. A client-side reasoning_effort is a
  // soft hint — it must not turn a servable request into a 400.
  const { status, body } = await runWithFakePage(
    "gemini-3.8-flash",
    {
      dom: {
        pickerLabel: "Modusauswahl öffnen, derzeit ausgewählt: Flash",
        options: ["Vielseitige Unterstützung 3.8 Flash", "Hoch Besonders gründlich"],
        checked: false,
        answer: { text: "4", busy: "false" },
      },
    },
    { reasoning_effort: "high" }
  );

  assert.equal(status, 200, "thinking depth must never fail the request");
  assert.equal(contentOf(body), "4");
});

test("#13381: reasoning_effort none/minimal never triggers the thinking control at all", async () => {
  for (const effort of ["none", "minimal"]) {
    const { status, calls } = await runWithFakePage(
      "gemini-3.8-flash",
      {
        dom: {
          pickerLabel: "Modusauswahl öffnen, derzeit ausgewählt: Flash",
          options: [
            "Vielseitige Unterstützung 3.8 Flash",
            "Niedrig Fast and efficient",
            "Hoch Besonders gründlich",
          ],
          answer: { text: "4", busy: "false" },
        },
      },
      { reasoning_effort: effort }
    );
    assert.equal(status, 200, `effort="${effort}" must reach the ordinary prompt path`);
    assert.equal(
      calls.some((c) => c.fn === "dom.click.option" && /niedrig|mittel|hoch|low|medium|high/i.test(String(c.args[0]))),
      false,
      `effort="${effort}" must not attempt a thinking-level switch`
    );
  }
});
