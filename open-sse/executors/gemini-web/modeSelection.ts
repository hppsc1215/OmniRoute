/**
 * Per-model Gemini Web UI mode selection + verification (#13381, Option B).
 *
 * `gemini.google.com/app` exposes its models through a **menu picker**: a button
 * (`[data-test-id="bard-mode-menu-button"]`) labelled
 * "Modusauswahl öffnen, derzeit ausgewählt: <mode>" / "Open mode picker,
 * currently <mode>" opens a list of `[role="menuitemradio"]` options. Selecting a
 * model therefore means opening that picker, clicking the option, and reading the
 * button's label back to prove the switch landed — a click alone is never treated
 * as success (#13381).
 *
 * The previous implementation assumed a toggle that *cycled* modes, used
 * `button[aria-haspopup="menu"]` (which matches "Upload & tools" first in document
 * order), and clicked with Playwright (which Google's consent overlay intercepts,
 * 30 s timeout). Measured 2026-11-11 against a live Pro account, locale de-DE:
 *   - picker label: "Modusauswahl öffnen, derzeit ausgewählt: Argon"
 *   - options: "Schnellinfo 3.5 Flash-Lite", "Vielseitige Unterstützung 3.8 Flash",
 *     "Detaillierte Recherche 3.1 Pro", "Code und Analyse 4 Argon",
 *     "Denkaufwand" → "Niedrig" / "Mittel" / "Hoch"
 *   - the account remembered "Argon" from a previous session, so NO mode can be
 *     assumed active on load — every request selects and verifies explicitly.
 *   - DOM `click()` on the picker and on the option works; `elementHandle.click`
 *     does not (consent overlay).
 *
 * Fail-closed stays the contract for model selection: an unconfirmed switch
 * rejects the request with `unsupported_control_for_provider` instead of
 * answering under a label that was never actually active. Thinking depth is a
 * soft hint and is attempted best-effort by the executor.
 */

/** Reasons `selectGeminiUiMode`/`selectGeminiModel` can fail closed. */
export type GeminiModeSelectionFailureReason =
  | "control_not_found"
  | "option_not_found"
  | "indicator_mismatch"
  | "unknown_model";

export interface GeminiWebModeDescriptor {
  /** The advertised `gweb/<model>` id, or a synthetic label for non-model controls. */
  readonly id: string;
  /**
   * true: this is a mode `gemini.google.com/app` already shows on load — no UI
   * interaction is attempted, nothing to confirm. No *model* sets it: the app
   * remembers the last-used mode per account (measured: opened in "Argon"), so
   * "the default" is not a stable assumption.
   */
  readonly isDefault: boolean;
  /** Matched against each picker option's visible text to pick the mode. */
  readonly menuLabelPattern?: RegExp;
  /** Text the picker's read-back label must match once the switch is confirmed. */
  readonly expectedIndicatorPattern?: RegExp;
}

/**
 * The model picker button. `aria-haspopup="menu"` alone is too broad (see
 * header) and the aria-label is localized — hence data-test-id first, then both
 * measured locale spellings.
 */
export const GEMINI_MODE_PICKER_SELECTOR =
  '[data-test-id="bard-mode-menu-button"], button[aria-label*="mode picker" i], ' +
  'button[aria-label*="Modusauswahl" i]';

/** Poll cadence while the menu animates in / the label updates. */
const SELECTION_POLL_INTERVAL_MS = 200;

/**
 * Model -> Gemini UI mode map for the `gweb/<model>` ids advertised by
 * `open-sse/config/providers/registry/gemini/web/index.ts`. Keep both catalogs in
 * sync: an advertised model with no entry here fails closed as `unknown_model`
 * (see `resolveGeminiModelMode`) — the honest outcome for a model this module
 * cannot select.
 *
 * Patterns anchor on the model name/version instead of the localized marketing
 * prefix ("Schnellinfo" / "Quick answers") so they survive a locale switch.
 */
export const GEMINI_WEB_MODEL_MODES: Readonly<Record<string, GeminiWebModeDescriptor>> = {
  "gemini-3.5-flash-lite": {
    id: "gemini-3.5-flash-lite",
    isDefault: false,
    menuLabelPattern: /flash-lite/i,
    expectedIndicatorPattern: /flash-lite/i,
  },
  "gemini-3.8-flash": {
    id: "gemini-3.8-flash",
    isDefault: false,
    menuLabelPattern: /3\.8\s*flash/i,
    // Measured read-back: the button drops the version and says "…: Flash".
    // Must not match the Flash-Lite label, hence the negative lookahead.
    expectedIndicatorPattern: /flash(?!\s*-?\s*lite)/i,
  },
  "gemini-3.1-pro": {
    id: "gemini-3.1-pro",
    isDefault: false,
    menuLabelPattern: /3\.1\s*pro/i,
    // Same truncation: the button says "…: Pro".
    expectedIndicatorPattern: /\bpro\b/i,
  },
  "gemini-4-argon": {
    id: "gemini-4-argon",
    isDefault: false,
    menuLabelPattern: /\bargon\b/i,
    expectedIndicatorPattern: /\bargon\b/i,
  },
};

/**
 * The "Denkaufwand" (thinking effort) levels (#13381 follow-up). Not models: they
 * change how long Gemini reasons, and the picker label does not echo them, so
 * they are verified through the option's own selected state instead.
 */
export const GEMINI_WEB_THINKING_LEVELS: Readonly<
  Record<"low" | "medium" | "high", GeminiWebModeDescriptor>
> = {
  low: {
    id: "thinking-low",
    isDefault: false,
    menuLabelPattern: /\b(niedrig|low)\b/i,
    expectedIndicatorPattern: /\b(niedrig|low)\b/i,
  },
  medium: {
    id: "thinking-medium",
    isDefault: false,
    menuLabelPattern: /\b(mittel|medium)\b/i,
    expectedIndicatorPattern: /\b(mittel|medium)\b/i,
  },
  high: {
    id: "thinking-high",
    isDefault: false,
    menuLabelPattern: /\b(hoch|high)\b/i,
    expectedIndicatorPattern: /\b(hoch|high)\b/i,
  },
};

/** Map an OpenAI-style `reasoning_effort` onto a measured "Denkaufwand" level. */
export function resolveThinkingLevel(effort: unknown): "low" | "medium" | "high" {
  const value = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  if (value === "medium") return "medium";
  if (value === "high" || value === "xhigh" || value === "max" || value === "ultra") return "high";
  return "low";
}

/** Minimal Playwright-shaped page the selection step needs — the real `Page` satisfies this. */
export interface GeminiAutomationPage {
  evaluate<R>(pageFunction: () => R): Promise<R>;
  evaluate<R, A>(pageFunction: (arg: A) => R, arg: A): Promise<R>;
  waitForTimeout(milliseconds: number): Promise<unknown>;
}

export interface GeminiModeSelectionResult {
  confirmed: boolean;
  reason?: GeminiModeSelectionFailureReason;
  descriptor?: GeminiWebModeDescriptor;
}

/**
 * Wait until the mode picker exists in the DOM. Measured 2026-11-11: the composer
 * is interactive ~1.2 s BEFORE the picker renders, so a single lookup right after
 * the composer appears reported "control_not_found" and rejected the request.
 */
async function waitForModePicker(
  page: GeminiAutomationPage,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let present = false;
    try {
      present = await page.evaluate(() => {
        return Boolean(
          document.querySelector('[data-test-id="bard-mode-menu-button"]') ||
            document.querySelector('button[aria-label*="mode picker" i]') ||
            document.querySelector('button[aria-label*="Modusauswahl" i]')
        );
      });
    } catch {
      return false;
    }
    if (present) return true;
    await page.waitForTimeout(SELECTION_POLL_INTERVAL_MS);
  }
  return false;
}

/** Open the mode picker. Returns false when the picker never appears. */
async function openModePicker(
  page: GeminiAutomationPage,
  timeoutMs = 10000
): Promise<boolean> {
  if (!(await waitForModePicker(page, timeoutMs))) return false;
  try {
    return await page.evaluate(() => {
      const el =
        document.querySelector('[data-test-id="bard-mode-menu-button"]') ||
        document.querySelector('button[aria-label*="mode picker" i]') ||
        document.querySelector('button[aria-label*="Modusauswahl" i]');
      if (!el) return false;
      el.click();
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Click the picker option matching `patternSource`; returns its label or "".
 * DOM `click()` on purpose: the consent overlay swallows Playwright clicks.
 */
async function clickModeOption(
  page: GeminiAutomationPage,
  patternSource: string
): Promise<string> {
  try {
    return await page.evaluate((source: string) => {
      const re = new RegExp(source, "i");
      const options = Array.from(
        document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')
      );
      for (const el of options) {
        const label = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!label || !re.test(label)) continue;
        el.click();
        return label;
      }
      return "";
    }, patternSource);
  } catch {
    return "";
  }
}

/**
 * After clicking, report whether the option itself says it is selected.
 * `null` means this DOM offers no such signal (older/other renders).
 */
async function readOptionChecked(
  page: GeminiAutomationPage,
  patternSource: string
): Promise<boolean | null> {
  try {
    return await page.evaluate((source: string) => {
      const re = new RegExp(source, "i");
      const options = Array.from(
        document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')
      );
      for (const el of options) {
        const label = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!label || !re.test(label)) continue;
        const checked = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected");
        if (checked === null) return null;
        return checked === "true";
      }
      return null;
    }, patternSource);
  } catch {
    return null;
  }
}

/** Read the picker button's `aria-label` ("… derzeit ausgewählt: <mode>"). */
async function readModePickerLabel(page: GeminiAutomationPage): Promise<string> {
  try {
    return await page.evaluate(() => {
      const el =
        document.querySelector('[data-test-id="bard-mode-menu-button"]') ||
        document.querySelector('button[aria-label*="mode picker" i]') ||
        document.querySelector('button[aria-label*="Modusauswahl" i]');
      return el ? el.getAttribute("aria-label") || "" : "";
    });
  } catch {
    return "";
  }
}

/** Click an option, polling while the menu animates in. Shared by both controls. */
async function clickOptionWithRetry(
  page: GeminiAutomationPage,
  labelPattern: RegExp,
  timeoutMs: number
): Promise<string> {
  let clickedLabel = "";
  const deadline = Date.now() + timeoutMs;
  while (!clickedLabel && Date.now() < deadline) {
    clickedLabel = await clickModeOption(page, labelPattern.source);
    if (!clickedLabel) await page.waitForTimeout(SELECTION_POLL_INTERVAL_MS);
  }
  return clickedLabel;
}

/**
 * Try to switch the live Gemini Web page to `descriptor`'s mode, then READ
 * BACK the picker label before reporting success. A click landing is never
 * itself treated as success — only a pattern-matching label is (#13381).
 */
export async function selectGeminiUiMode(
  page: GeminiAutomationPage,
  descriptor: GeminiWebModeDescriptor,
  timeoutMs = 5000
): Promise<GeminiModeSelectionResult> {
  if (descriptor.isDefault) return { confirmed: true, descriptor };

  const labelPattern = descriptor.menuLabelPattern;
  const expected = descriptor.expectedIndicatorPattern;
  if (!labelPattern || !expected) {
    return { confirmed: false, reason: "control_not_found", descriptor };
  }

  if (!(await openModePicker(page))) {
    return { confirmed: false, reason: "control_not_found", descriptor };
  }

  const clickedLabel = await clickOptionWithRetry(page, labelPattern, timeoutMs);
  if (!clickedLabel) return { confirmed: false, reason: "option_not_found", descriptor };

  // Read the active mode back from the picker button.
  const readDeadline = Date.now() + timeoutMs;
  while (Date.now() < readDeadline) {
    const label = await readModePickerLabel(page);
    if (label && expected.test(label)) return { confirmed: true, descriptor };
    await page.waitForTimeout(SELECTION_POLL_INTERVAL_MS);
  }

  return { confirmed: false, reason: "indicator_mismatch", descriptor };
}

export function resolveGeminiModelMode(modelId: string): GeminiWebModeDescriptor | null {
  return GEMINI_WEB_MODEL_MODES[modelId] ?? null;
}

/** Select + verify the requested advertised model's Gemini UI mode. */
export async function selectGeminiModel(
  page: GeminiAutomationPage,
  modelId: string,
  timeoutMs?: number
): Promise<GeminiModeSelectionResult> {
  const descriptor = resolveGeminiModelMode(modelId);
  if (!descriptor) return { confirmed: false, reason: "unknown_model" };
  return selectGeminiUiMode(page, descriptor, timeoutMs);
}

/**
 * Select + verify a "Denkaufwand" level (#13381 follow-up).
 *
 * Verified through the option's own selected state, because the picker label
 * echoes the model only. An option exposing neither `aria-checked` nor
 * `aria-selected` is reported unverified — the caller treats thinking depth as a
 * soft hint and continues (see the executor).
 */
export async function selectGeminiThinkingLevel(
  page: GeminiAutomationPage,
  level: "low" | "medium" | "high",
  timeoutMs = 5000
): Promise<GeminiModeSelectionResult> {
  const descriptor = GEMINI_WEB_THINKING_LEVELS[level];
  if (!descriptor.menuLabelPattern) {
    return { confirmed: false, reason: "unknown_model", descriptor };
  }
  if (!(await openModePicker(page))) {
    return { confirmed: false, reason: "control_not_found", descriptor };
  }
  const clickedLabel = await clickOptionWithRetry(page, descriptor.menuLabelPattern, timeoutMs);
  if (!clickedLabel) return { confirmed: false, reason: "option_not_found", descriptor };

  const checked = await readOptionChecked(page, descriptor.menuLabelPattern.source);
  if (checked === true) return { confirmed: true, descriptor };
  return { confirmed: false, reason: "indicator_mismatch", descriptor };
}

const REASON_DETAIL: Record<GeminiModeSelectionFailureReason, string> = {
  unknown_model: "it is not one of the advertised, selectable gweb models",
  control_not_found: "the mode picker used to switch models was not found",
  option_not_found: "the mode picker did not offer an option for it",
  indicator_mismatch: "the mode picker still reports a different active mode",
};

/**
 * Client-facing explanation for a failed-closed selection, safe to put
 * directly in a response body (no selector text, no stack trace).
 */
export function describeModeSelectionFailure(
  controlLabel: string,
  reason: GeminiModeSelectionFailureReason | undefined
): string {
  const detail = (reason && REASON_DETAIL[reason]) || "the switch could not be verified";
  return (
    `Model provider "gemini-web" could not verify that "${controlLabel}" is actually active in ` +
    `the Gemini web UI (${detail}). Rather than silently answering under a model/mode label that ` +
    'may not be accurate, the request was rejected with "unsupported_control_for_provider" — ' +
    "see #13381."
  );
}
