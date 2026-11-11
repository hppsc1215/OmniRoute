/**
 * Regression for the Gemini Web answer-capture path.
 *
 * The executor used to get the answer only by intercepting the `StreamGenerate`
 * XHR. On a live account that request no longer exists: the reply arrives from a
 * service-worker fetch, which `page.on("response")` never reports, so the
 * executor waited out its window and returned `502 No response from Gemini`
 * although Gemini had answered (verified against a live free-tier account
 * 2026-11-11: 33 intercepted gemini.google.com responses, none of them
 * `StreamGenerate`, while `<model-response>` rendered the answer).
 *
 * `waitForGeminiDomAnswer` therefore reads the rendered DOM and only accepts an
 * answer that is finished (`message-content[aria-busy="false"]`) and stable
 * across two polls. These tests pin that contract with a fake page — no browser.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/gemini-web/domAnswer.ts");
const { readGeminiDomAnswer, waitForGeminiDomAnswer, GEMINI_DOM_POLL_INTERVAL_MS } = mod;

type Snapshot = { ariaBusy: string | null; text: string } | null;

/** Fake Playwright page that replays a scripted sequence of DOM snapshots. */
function fakePage(snapshots: Snapshot[], opts: { fail?: boolean } = {}) {
  let i = 0;
  const waits: number[] = [];
  return {
    waits,
    async evaluate<R>(): Promise<R> {
      if (opts.fail) throw new Error("Target page, context or browser has been closed");
      const snap = snapshots[Math.min(i, snapshots.length - 1)];
      i += 1;
      if (!snap) return { text: "", busy: null } as unknown as R;
      return { text: snap.text, busy: snap.ariaBusy } as unknown as R;
    },
    async waitForTimeout(ms: number): Promise<void> {
      waits.push(ms);
    },
  };
}

describe("gemini-web DOM answer reader", () => {
  it("ignores an answer that is still streaming (aria-busy not false)", async () => {
    const page = fakePage([{ ariaBusy: "true", text: "ZWIE" }]);
    assert.equal(await readGeminiDomAnswer(page), "");
  });

  it("returns the rendered answer once aria-busy is false", async () => {
    const page = fakePage([{ ariaBusy: "false", text: "PONG" }]);
    assert.equal(await readGeminiDomAnswer(page), "PONG");
  });

  it("never throws when the page is gone", async () => {
    const page = fakePage([{ ariaBusy: "false", text: "PONG" }], { fail: true });
    assert.equal(await readGeminiDomAnswer(page), "");
  });

  it("waits until the answer is stable before accepting it", async () => {
    const page = fakePage([
      { ariaBusy: "false", text: "ZWIE" }, // partial
      { ariaBusy: "false", text: "ZWIEBEL" }, // still growing
      { ariaBusy: "false", text: "ZWIEBEL42" }, // first sighting
      { ariaBusy: "false", text: "ZWIEBEL42" }, // stable -> accept
    ]);
    const answer = await waitForGeminiDomAnswer(page, 5000);
    assert.equal(answer, "ZWIEBEL42");
    assert.equal(page.waits.length, 3, "one poll per non-final read");
    assert.ok(page.waits.every((ms) => ms === GEMINI_DOM_POLL_INTERVAL_MS));
  });

  it("lets a legacy StreamGenerate capture win without touching the DOM", async () => {
    const page = fakePage([{ ariaBusy: "false", text: "DOM-TEXT" }]);
    const answer = await waitForGeminiDomAnswer(page, 5000, () => "NETWORK-TEXT");
    assert.equal(answer, "NETWORK-TEXT");
    assert.equal(page.waits.length, 0);
  });

  it("returns empty (-> the executor's 502) when nothing ever renders", async () => {
    const page = fakePage([null]);
    const answer = await waitForGeminiDomAnswer(page, 1200);
    assert.equal(answer, "");
    assert.ok(page.waits.length >= 1, "must actually poll before giving up");
  });
});
