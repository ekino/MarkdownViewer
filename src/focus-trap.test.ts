import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { focusableWithin, trapFocus } from "./focus-trap";

function makeButton(label: string, opts: Partial<HTMLButtonElement> = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  Object.assign(b, opts);
  return b;
}

describe("focusableWithin", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  it("returns interactive elements in document order", () => {
    const a = makeButton("a");
    const b = document.createElement("input");
    const c = makeButton("c");
    root.append(a, b, c);
    expect(focusableWithin(root)).toEqual([a, b, c]);
  });

  it("skips disabled elements", () => {
    const a = makeButton("a");
    const b = makeButton("b", { disabled: true });
    root.append(a, b);
    expect(focusableWithin(root)).toEqual([a]);
  });

  it("skips elements with tabindex='-1'", () => {
    const a = makeButton("a");
    const b = makeButton("b");
    b.tabIndex = -1;
    root.append(a, b);
    expect(focusableWithin(root)).toEqual([a]);
  });

  it("skips elements with aria-hidden='true'", () => {
    const a = makeButton("a");
    const b = makeButton("b");
    b.setAttribute("aria-hidden", "true");
    root.append(a, b);
    expect(focusableWithin(root)).toEqual([a]);
  });

  it("picks up [tabindex='0'] elements that aren't natively focusable", () => {
    const a = document.createElement("div");
    a.tabIndex = 0;
    root.appendChild(a);
    expect(focusableWithin(root)).toEqual([a]);
  });

  it("includes selects, anchors with href, and textareas", () => {
    const sel = document.createElement("select");
    const link = document.createElement("a");
    link.href = "#foo";
    const ta = document.createElement("textarea");
    root.append(sel, link, ta);
    expect(focusableWithin(root)).toEqual([sel, link, ta]);
  });
});

describe("trapFocus — Tab cycling", () => {
  let root: HTMLElement;
  let outsideBtn: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    outsideBtn = makeButton("outside");
    document.body.appendChild(outsideBtn);
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("cycles Tab from last focusable back to first", () => {
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);
    const trap = trapFocus(root);

    b.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
    trap.release();
  });

  it("cycles Shift+Tab from first focusable to last", () => {
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);
    const trap = trapFocus(root);

    a.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
    trap.release();
  });

  it("does not interfere when focus is in the middle of the list", () => {
    const a = makeButton("a");
    const b = makeButton("b");
    const c = makeButton("c");
    root.append(a, b, c);
    const trap = trapFocus(root);

    b.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(event);

    // Browser default takes over (would naturally move to c); preventDefault not called.
    expect(event.defaultPrevented).toBe(false);
    trap.release();
  });

  it("pulls focus back into the trap if focus is outside the container", () => {
    const a = makeButton("a");
    root.append(a);
    const trap = trapFocus(root);

    outsideBtn.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
    trap.release();
  });

  it("ignores non-Tab keys", () => {
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);
    const trap = trapFocus(root);

    b.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(b);
    trap.release();
  });
});

describe("trapFocus — release", () => {
  it("restores the previously focused element", () => {
    const outside = makeButton("outside");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const root = document.createElement("div");
    const inside = makeButton("inside");
    root.appendChild(inside);
    document.body.appendChild(root);

    const trap = trapFocus(root);
    inside.focus();
    expect(document.activeElement).toBe(inside);

    trap.release();
    expect(document.activeElement).toBe(outside);
  });

  it("detaches the keydown listener so cycling stops", () => {
    const root = document.createElement("div");
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);
    document.body.appendChild(root);

    const trap = trapFocus(root);
    trap.release();

    b.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(event);
    // Without the trap the browser default would move focus, but the test
    // here is that the trap doesn't prevent default anymore.
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("trapFocus — initialFocus option", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("focuses the element returned by the initialFocus getter on activation", async () => {
    const a = makeButton("a");
    const b = makeButton("b");
    const c = makeButton("c");
    root.append(a, b, c);

    const trap = trapFocus(root, { initialFocus: () => b });
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement).toBe(b);
    trap.release();
  });

  it("accepts a direct HTMLElement as initialFocus", async () => {
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);

    const trap = trapFocus(root, { initialFocus: b });
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement).toBe(b);
    trap.release();
  });

  it("falls back to first focusable when initialFocus is null", async () => {
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);

    const trap = trapFocus(root, { initialFocus: null });
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement).toBe(a);
    trap.release();
  });

  it("falls back to first focusable when initialFocus getter returns null", async () => {
    const a = makeButton("a");
    root.append(a);

    const trap = trapFocus(root, { initialFocus: () => null });
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement).toBe(a);
    trap.release();
  });

  it("falls back to first focusable when initialFocus is outside the container", async () => {
    const inside = makeButton("inside");
    root.append(inside);
    const outside = makeButton("outside");
    document.body.appendChild(outside);

    const trap = trapFocus(root, { initialFocus: outside });
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement).toBe(inside);
    trap.release();
  });
});

describe("trapFocus — focusElement handle", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("focuses the requested element when it's inside the trap", () => {
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);
    const trap = trapFocus(root);

    trap.focusElement(b);
    expect(document.activeElement).toBe(b);
    trap.release();
  });

  it("falls back to first focusable when the target is null", () => {
    const a = makeButton("a");
    root.append(a);
    const trap = trapFocus(root);
    a.blur();

    trap.focusElement(null);
    expect(document.activeElement).toBe(a);
    trap.release();
  });

  it("falls back to first focusable when the target lives outside the trap", () => {
    const inside = makeButton("inside");
    root.append(inside);
    const outside = makeButton("outside");
    document.body.appendChild(outside);
    const trap = trapFocus(root);

    trap.focusElement(outside);
    expect(document.activeElement).toBe(inside);
    trap.release();
  });
});

describe("trapFocus — refocusFirst", () => {
  it("focuses the first focusable element on demand", () => {
    const root = document.createElement("div");
    const a = makeButton("a");
    const b = makeButton("b");
    root.append(a, b);
    document.body.appendChild(root);

    const trap = trapFocus(root);
    b.focus();
    expect(document.activeElement).toBe(b);

    trap.refocusFirst();
    expect(document.activeElement).toBe(a);
    trap.release();
  });

  it("does nothing when there are no focusable elements", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const trap = trapFocus(root);
    expect(() => trap.refocusFirst()).not.toThrow();
    trap.release();
  });
});
