/**
 * Gemini Web answer reader — DOM source (second capture path).
 *
 * The executor used to rely on intercepting the `StreamGenerate` XHR to get the
 * answer. On a live account that request no longer exists: the reply is
 * delivered out-of-band (service-worker fetch, which `page.on("response")`
 * never sees) and is only observable in the rendered DOM. Result: the network
 * capture never fired, the executor waited out its whole window and answered
 * `502 No response from Gemini` even though Gemini had replied.
 *
 * This module reads the answer from the DOM instead. Measured 2026-11-11 on a
 * signed-in free-tier account:
 *   <model-response> → <message-content aria-busy="false"> → .markdown
 *
 * `aria-busy` is `"false"` once Gemini finished the message, and the text must
 * additionally be unchanged across consecutive polls, so a partially streamed
 * answer is never reported as final. When the attribute is absent (other UI
 * renders) the stability requirement is stricter instead of trusting the text.
 * The network path stays in place (older accounts/locales still use it);
 * whichever source produces text first wins.
 */

/** Poll cadence while waiting for the rendered answer. */
export const GEMINI_DOM_POLL_INTERVAL_MS = 600;
/** Identical reads required before a non-empty answer is trusted as final. */
export const GEMINI_DOM_STABLE_POLLS = 2;
/** Extra identical reads required when the UI exposes no `aria-busy` at all. */
export const GEMINI_DOM_STABLE_POLLS_UNMARKED = GEMINI_DOM_STABLE_POLLS + 1;

/** Minimal Playwright-shaped page this reader needs — the real `Page` satisfies it. */
export interface GeminiDomPage {
  evaluate<R>(pageFunction: () => R): Promise<R>;
  waitForTimeout(milliseconds: number): Promise<unknown>;
}

export interface GeminiDomSnapshot {
  /** Rendered answer text, `""` when nothing is rendered yet. */
  text: string;
  /** `aria-busy` of the message container: "true" while streaming, "false" when done, null if absent. */
  busy: string | null;
}

/**
 * Read the last rendered Gemini answer plus its completion marker.
 * Never throws: a detached page/evaluate failure reports "nothing rendered".
 */
export async function readGeminiDomSnapshot(page: GeminiDomPage): Promise<GeminiDomSnapshot> {
  try {
    return await page.evaluate(() => {
      // The prompt echo lives in <user-query>; never mistake it for the answer.
      const inPrompt = (el: Element) =>
        Boolean(el.closest("user-query, user-query-content, .user-query-container"));
      const selectors = [
        "model-response message-content",
        "message-content",
        "model-response .markdown",
      ];
      let target: Element | null = null;
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector)).filter((n) => !inPrompt(n));
        const last = nodes[nodes.length - 1];
        if (last) {
          target = last;
          break;
        }
      }
      if (!target) return { text: "", busy: null };
      const busyHost = target.closest("[aria-busy]");
      const busy = target.getAttribute("aria-busy") ?? busyHost?.getAttribute("aria-busy") ?? null;
      const body = target.querySelector(".markdown") ?? target;
      const text = ((body as HTMLElement).innerText || "").trim();
      return { text, busy };
    });
  } catch {
    return { text: "", busy: null };
  }
}

/** Read the last rendered Gemini answer, or `""` while it is still streaming. */
export async function readGeminiDomAnswer(page: GeminiDomPage): Promise<string> {
  const snapshot = await readGeminiDomSnapshot(page);
  return snapshot.busy === "true" ? "" : snapshot.text;
}

/**
 * Wait for a complete answer from either source.
 *
 * @param page         Playwright page on gemini.google.com
 * @param timeoutMs    overall budget (see resolveResponseTimeoutMs)
 * @param networkText  getter for the legacy `StreamGenerate` capture; polled first
 *                     so a network hit still short-circuits the DOM wait
 */
export async function waitForGeminiDomAnswer(
  page: GeminiDomPage,
  timeoutMs: number,
  networkText: () => string = () => ""
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let candidate = "";
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const fromNetwork = networkText();
    if (fromNetwork) return fromNetwork;

    const snapshot = await readGeminiDomSnapshot(page);
    if (snapshot.busy === "true" || !snapshot.text) {
      // Still streaming (or nothing rendered yet): restart the stability window.
      candidate = "";
      stablePolls = 0;
    } else {
      const required =
        snapshot.busy === "false" ? GEMINI_DOM_STABLE_POLLS : GEMINI_DOM_STABLE_POLLS_UNMARKED;
      if (snapshot.text === candidate) {
        stablePolls += 1;
      } else {
        candidate = snapshot.text;
        stablePolls = 1;
      }
      if (stablePolls >= required) return candidate;
    }

    await page.waitForTimeout(GEMINI_DOM_POLL_INTERVAL_MS);
  }

  // Last chance: the answer may have completed exactly at the deadline.
  return networkText() || (await readGeminiDomAnswer(page));
}
