import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetToastForTests, hideToast, showToast } from "./toast";

afterEach(() => {
  _resetToastForTests();
  vi.useRealTimers();
});

describe("toast", () => {
  it("creates the toast element on first show", () => {
    expect(document.getElementById("toast")).toBeNull();
    showToast("hello");
    const el = document.getElementById("toast");
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe("hello");
    expect(el?.style.display).toBe("block");
    expect(el?.dataset.kind).toBe("info");
  });

  it("marks error toasts with a kind attribute", () => {
    showToast("bad", "error");
    expect(document.getElementById("toast")?.dataset.kind).toBe("error");
  });

  it("replaces the previous message on consecutive shows", () => {
    showToast("first");
    showToast("second");
    expect(document.getElementById("toast")?.textContent).toBe("second");
  });

  it("auto-hides after the timeout", () => {
    vi.useFakeTimers();
    showToast("temp");
    expect(document.getElementById("toast")?.style.display).toBe("block");
    vi.advanceTimersByTime(4001);
    expect(document.getElementById("toast")?.style.display).toBe("none");
  });

  it("hides on click", () => {
    showToast("clickme");
    const el = document.getElementById("toast") as HTMLDivElement;
    el.click();
    expect(el.style.display).toBe("none");
  });

  it("hideToast() is a no-op when nothing is shown", () => {
    expect(() => hideToast()).not.toThrow();
  });
});
