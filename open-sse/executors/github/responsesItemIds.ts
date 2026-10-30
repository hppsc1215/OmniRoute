/**
 * GitHub / GHE Copilot `/responses` streams obfuscate the item id per event: every
 * `output_item.*`, `content_part.*` and `output_text.*` event of ONE message carries a
 * different opaque id, while `output_index` stays stable. The Responses -> Chat translator
 * treats explicit ids as authoritative, so each `*.done` / `response.completed` snapshot
 * looked like an unseen message and re-emitted the full text (the answer arrived 4x).
 *
 * In the Responses API one output_index is exactly one item, so every id of an
 * output_index is pinned to the first one Copilot issued for it. Streams with stable ids
 * pass through unchanged.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function outputIndexOf(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function claim(ids: Map<number, string>, index: number, id: string): string {
  const pinned = ids.get(index);
  if (pinned !== undefined) return pinned;
  ids.set(index, id);
  return id;
}

/** Pin one parsed Responses event. Returns the same reference when nothing changed. */
export function pinResponsesEventItemIds(event: unknown, ids: Map<number, string>): unknown {
  if (!isRecord(event)) return event;
  let next = event;

  const index = outputIndexOf(event.output_index);
  if (index !== undefined) {
    if (typeof event.item_id === "string" && event.item_id) {
      const pinned = claim(ids, index, event.item_id);
      if (pinned !== event.item_id) next = { ...next, item_id: pinned };
    }
    const item = event.item;
    if (isRecord(item) && typeof item.id === "string" && item.id) {
      const pinned = claim(ids, index, item.id);
      if (pinned !== item.id) next = { ...next, item: { ...item, id: pinned } };
    }
  }

  const response = event.response;
  if (isRecord(response) && Array.isArray(response.output)) {
    let changed = false;
    const output = response.output.map((item: unknown, i: number) => {
      const pinned = ids.get(i);
      if (!pinned || !isRecord(item) || typeof item.id !== "string" || item.id === pinned) {
        return item;
      }
      changed = true;
      return { ...item, id: pinned };
    });
    if (changed) next = { ...next, response: { ...response, output } };
  }

  return next;
}

function rewriteSseLine(line: string, ids: Map<number, string>): string {
  if (!line.startsWith("data:")) return line;
  const hasCr = line.endsWith("\r");
  const payload = (hasCr ? line.slice(0, -1) : line).slice(5).trim();
  if (!payload || payload === "[DONE]") return line;
  try {
    const parsed: unknown = JSON.parse(payload);
    const pinned = pinResponsesEventItemIds(parsed, ids);
    if (pinned === parsed) return line;
    return `data: ${JSON.stringify(pinned)}${hasCr ? "\r" : ""}`;
  } catch {
    return line;
  }
}

/** Line-buffered SSE transform; holds the output_index -> id map for one stream. */
export function createResponsesItemIdPinTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const ids = new Map<number, string>();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length === 0) return;
      controller.enqueue(
        encoder.encode(lines.map((line) => `${rewriteSseLine(line, ids)}\n`).join(""))
      );
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewriteSseLine(buffer, ids)));
      buffer = "";
    },
  });
}

function isResponsesUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/responses");
  } catch {
    return false;
  }
}

/** Wrap a successful `/responses` SSE response; everything else is returned as-is. */
export function pinCopilotResponsesItemIds(response: Response, url: unknown): Response {
  const contentType = response.headers.get("content-type") || "";
  if (
    !response.ok ||
    !isResponsesUrl(url) ||
    !contentType.includes("text/event-stream") ||
    typeof response.body?.pipeThrough !== "function"
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  // The rewrite can change the byte length.
  headers.delete("content-length");
  return new Response(response.body.pipeThrough(createResponsesItemIdPinTransform()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
