/**
 * Gemini Web — Google consent dialog dismissal.
 *
 * A fresh browser context (the executor creates one per request) starts with no
 * consent state, so gemini.google.com renders Google's "Before you continue"
 * cookie dialog over the app. Measured 2026-11-11: the overlay sits in
 * `.cdk-overlay-container` and intercepts pointer events, so EVERY Playwright
 * click in the executor timed out after 30 s
 * (`elementHandle.click: Timeout 30000ms exceeded` →
 * `<span …>Measure audience engagement and site statistics…</span> from
 * <div class="cdk-overlay-container">… subtree intercepts pointer events`),
 * while the composer itself was present and ready.
 *
 * The dialog is dismissed with a DOM `click()` (not a Playwright click — the
 * overlay is exactly what makes a real click un-actionable) on the reject
 * button, which is enough to let the app become interactive. Best-effort by
 * design: an already-consented context has no dialog and this is a no-op.
 */

/** Minimal Playwright-shaped page this helper needs — the real `Page` satisfies it. */
export interface GeminiConsentPage {
  evaluate<R>(pageFunction: () => R): Promise<R>;
  waitForTimeout(milliseconds: number): Promise<unknown>;
}

export const GEMINI_CONSENT_POLL_INTERVAL_MS = 300;

/**
 * Dismiss Google's cookie-consent dialog when it is showing.
 *
 * @returns the label that was clicked, or `""` when no dialog was present.
 */
export async function dismissGeminiConsent(
  page: GeminiConsentPage,
  timeoutMs = 5000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let clicked = "";
    try {
      clicked = await page.evaluate(() => {
        // Regex literals are part of the serialized function body, so they travel
        // to the page — module-scope constants would not.
        const patterns = [
          /^reject all$/i,
          /^alle ablehnen$/i,
          /^accept all$/i,
          /^alle akzeptieren$/i,
          /^decline$/i,
        ];
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const el of buttons) {
          const text = (el.innerText || "").trim();
          if (!text) continue;
          if (!patterns.some((re) => re.test(text))) continue;
          el.click();
          return text;
        }
        return "";
      });
    } catch {
      // Page navigated or detached mid-poll — treat as "no dialog".
      return "";
    }
    if (clicked) {
      await page.waitForTimeout(400);
      return clicked;
    }
    await page.waitForTimeout(GEMINI_CONSENT_POLL_INTERVAL_MS);
  }
  return "";
}
