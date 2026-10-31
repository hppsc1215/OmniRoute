// @vitest-environment jsdom
/**
 * ModelCompatPopover — per-model "Include thoughts" toggle.
 *
 *  1) Shown for Gemini-translator providers (antigravity) when a change handler is wired.
 *  2) Hidden for other providers (openai) and when no handler is passed.
 *  3) Reflects the current value and reports the flipped value on click.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/shared/components", async () => ({
  ...(await import("../../helpers/sharedComponentStubs")).formStubs,
  Toggle: ({
    label,
    checked,
    onChange,
    disabled,
  }: {
    label?: string;
    checked?: boolean;
    onChange?: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={Boolean(checked)}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
    >
      {label}
    </button>
  ),
}));

const { default: ModelCompatPopover } =
  await import("../../../src/app/(dashboard)/dashboard/providers/[id]/components/ModelCompatPopover");

// providerText() only uses the i18n key when the translator exposes `has`; otherwise it
// renders the English fallback. Expose `has` so the switch is addressable by its key.
const t = Object.assign((key: string) => key, { has: () => true });
const containers: Array<{ root: ReturnType<typeof createRoot>; el: HTMLDivElement }> = [];

beforeEach(() => {
  // The popover loads model-level param filters when it opens.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ block: [], allow: [] }), { status: 200 }))
  );
});

afterEach(() => {
  for (const { root, el } of containers.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
  vi.unstubAllGlobals();
});

async function renderOpen(props: Record<string, unknown>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  containers.push({ root, el });
  await act(async () => {
    root.render(
      <ModelCompatPopover
        t={t}
        providerId="antigravity"
        modelId="gemini-3.8-flash-tiered"
        effectiveModelNormalize={() => false}
        effectiveModelPreserveDeveloper={() => true}
        getUpstreamHeadersRecord={() => ({})}
        onCompatPatch={() => {}}
        {...props}
      />
    );
  });
  const trigger = el.querySelector('button[title="compatAdjustmentsTitle"]') as HTMLButtonElement;
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger.click();
  });
}

const includeThoughtsSwitch = () =>
  document.body.querySelector(
    '[role="switch"][aria-label="compatIncludeThoughtsShort"]'
  ) as HTMLButtonElement | null;

describe("ModelCompatPopover include-thoughts toggle", () => {
  it("is shown for antigravity and reflects the current value", async () => {
    await renderOpen({ includeThoughts: true, onIncludeThoughtsChange: () => {} });
    const sw = includeThoughtsSwitch();
    expect(sw).toBeTruthy();
    expect(sw?.getAttribute("aria-checked")).toBe("true");
  });

  it("reports the flipped value on click", async () => {
    const onChange = vi.fn();
    await renderOpen({ includeThoughts: false, onIncludeThoughtsChange: onChange });
    await act(async () => {
      includeThoughtsSwitch()?.click();
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("is hidden for providers without the Gemini translator", async () => {
    await renderOpen({ providerId: "openai", onIncludeThoughtsChange: () => {} });
    expect(includeThoughtsSwitch()).toBeNull();
  });

  it("is hidden when no change handler is wired", async () => {
    await renderOpen({});
    expect(includeThoughtsSwitch()).toBeNull();
  });
});
