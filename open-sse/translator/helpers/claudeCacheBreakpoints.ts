/**
 * Rolling prompt-cache breakpoint placement for Claude-format requests.
 *
 * Anthropic caches the request prefix UP TO each `cache_control` breakpoint
 * (max 4 per request). For an agent loop the useful layout is:
 *
 *   1. last tool definition — the tool schema block, re-sent verbatim every turn
 *   2. last system block    — the static agent prompt
 *   3. last message         — everything the model has seen so far, so turn N+1
 *                             reads the prefix written by turn N
 *   4. previous user turn   — one-turn-back anchor: survives a rewrite of the
 *                             newest turn (compression, dedup) that would
 *                             otherwise invalidate the deepest breakpoint
 *
 * The OpenAI->Claude translator can only see the client-shaped body, so it can
 * neither know the routed provider's caching capability nor place a rolling
 * marker on the newest turn (which is usually a `tool`/`tool_result` message).
 * This module runs on the FINAL Claude body, after translation and after the
 * legacy heuristic in `prepareClaudeRequest`.
 *
 * Contract: existing markers (client-supplied, or the legacy heuristic's) are
 * never overwritten — this only fills empty anchor points. The caller applies
 * `enforceCacheControlBlockLimit()` afterwards to honor Anthropic's 4-block cap.
 */

/** Content block types Anthropic accepts `cache_control` on. */
const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_use", "tool_result", "document"]);

export interface CacheBreakpointMarker {
  type: string;
  ttl?: string;
}

type Block = Record<string, unknown> & { type?: string; cache_control?: unknown };
type Msg = { role?: string; content?: unknown };
type Body = { system?: unknown; tools?: unknown; messages?: unknown };

function isMarkerPresent(block: Block): boolean {
  return block.cache_control !== undefined && block.cache_control !== null;
}

function asBlocks(value: unknown): Block[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is Block => item !== null && typeof item === "object");
}

/** Content blocks of `msg`, converting a plain-string body into one text block. */
function messageBlocks(msg: Msg): Block[] | null {
  if (Array.isArray(msg.content)) return msg.content as Block[];
  if (typeof msg.content === "string" && msg.content.length > 0) {
    const block: Block = { type: "text", text: msg.content };
    msg.content = [block];
    return [block];
  }
  return null;
}

/**
 * Mark the last cacheable block of `blocks` unless one already carries a marker.
 * Returns true when this call added a breakpoint.
 */
function markLastCacheableBlock(blocks: Block[] | null, marker: CacheBreakpointMarker): boolean {
  if (!blocks || blocks.length === 0) return false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || typeof block !== "object") continue;
    if (isMarkerPresent(block)) {
      // The deepest block is already a breakpoint — a second marker in the same
      // message buys nothing (Anthropic stops the prefix at the deeper one).
      return false;
    }
    if (typeof block.type === "string" && !CACHEABLE_BLOCK_TYPES.has(block.type)) continue;
    block.cache_control = { ...marker };
    return true;
  }
  return false;
}

/**
 * Index of the latest user-role message strictly before `beforeIndex`.
 * A `tool` message in OpenAI format becomes a user `tool_result` block later,
 * so this intentionally favors the newest user turn that is not the last one.
 */
function previousUserIndex(messages: Msg[], beforeIndex: number): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

/**
 * Place the rolling breakpoint set on a translated Claude body.
 *
 * `maxBreakpoints` is Anthropic's per-request cap (4). Existing markers — client
 * supplied or from the legacy heuristic — count against it and are never
 * removed or overwritten here; only empty anchor points are filled, deepest
 * first, so a tight budget still lands on the most valuable breakpoints.
 *
 * @returns the number of breakpoints added (0 when every anchor is already marked)
 */
export function applyClaudeCacheBreakpoints(
  body: Body,
  marker: CacheBreakpointMarker,
  maxBreakpoints = 4
): number {
  if (!body || typeof body !== "object") return 0;
  let budget = maxBreakpoints - countCacheBreakpoints(body);
  if (budget <= 0) return 0;
  let added = 0;
  const tryAdd = (blocks: Block[] | null) => {
    if (budget <= 0) return;
    if (markLastCacheableBlock(blocks, marker)) {
      added++;
      budget--;
    }
  };

  const messages = Array.isArray(body.messages) ? (body.messages as Msg[]) : [];
  const lastIndex = messages.length - 1;
  const lastMessage = lastIndex >= 0 ? messages[lastIndex] : null;

  // 3. Rolling anchor: the newest message. Deepest breakpoint, so add it first —
  // if the cap ever forces a choice, the deepest anchor caches the most tokens.
  if (lastMessage) tryAdd(messageBlocks(lastMessage));

  // 1. Tool definitions: identical on every turn of a session.
  tryAdd(asBlocks(body.tools));

  // 2. System prompt: identical on every turn of a session.
  tryAdd(asBlocks(body.system));

  // 4. One-turn-back anchor.
  const prevUser = previousUserIndex(messages, lastIndex);
  if (prevUser >= 0) tryAdd(messageBlocks(messages[prevUser]));

  return added;
}

/** Count `cache_control` markers anywhere in the body (system, tools, messages). */
export function countCacheBreakpoints(body: Body): number {
  if (!body || typeof body !== "object") return 0;
  let count = 0;
  const countBlocks = (blocks: Block[] | null) => {
    if (!blocks) return;
    for (const block of blocks) if (isMarkerPresent(block)) count++;
  };
  countBlocks(asBlocks(body.system));
  countBlocks(asBlocks(body.tools));
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages as Msg[]) countBlocks(asBlocks(msg?.content));
  }
  return count;
}
