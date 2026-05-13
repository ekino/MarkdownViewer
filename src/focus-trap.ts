/**
 * Generic focus-trap utilities for modal dialogs.
 *
 * A trap keeps keyboard focus inside a container while the modal is open,
 * cycles Tab / Shift+Tab between the first and last focusable elements,
 * and restores the previously focused element when the trap is released.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

/**
 * Return the list of keyboard-focusable elements within `root`, in document
 * order. Elements that are hidden (display:none, visibility:hidden) or have
 * an explicit `aria-hidden="true"` are filtered out.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return candidates.filter(isVisiblyFocusable);
}

function isVisiblyFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.tabIndex < 0) return false;
  // Walk up the tree and reject the element if any ancestor (or itself) is
  // display:none or visibility:hidden. This is robust across jsdom and real
  // browsers; offsetParent is unreliable in jsdom for visible elements.
  for (
    let node: HTMLElement | null = el;
    node && node !== document.body.parentElement;
    node = node.parentElement
  ) {
    const cs = getComputedStyle(node);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden") return false;
  }
  return true;
}

export interface FocusTrap {
  /** Re-focus the first focusable element inside the trap (useful after a tab switch or content change). */
  refocusFirst: () => void;
  /**
   * Focus a specific element inside the trap. The element must be focusable
   * (matches focusableWithin); otherwise nothing happens.
   */
  focusElement: (el: HTMLElement | null | undefined) => void;
  /** Release the trap, detach listeners and restore the previously focused element. */
  release: () => void;
}

export interface TrapFocusOptions {
  /**
   * The element (or a getter returning it) that should receive focus when the
   * trap is activated. When omitted, the first focusable element wins —
   * which is the right default for dialogs without a clear anchor, but a poor
   * choice for tabbed modals where the active tab is the natural target.
   */
  initialFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
}

/**
 * Activate a focus trap on `container`. Stores the currently focused element
 * so it can be restored when the trap is released.
 *
 * Returns a handle with `refocusFirst()` (call after tab switches that change
 * the visible content), `focusElement(el)` (explicit anchor — used by the
 * Preferences tabs to focus the active tab on switch) and `release()`.
 *
 * The container itself must already be visible when this is called, otherwise
 * `focusableWithin` will return nothing and initial focus will silently fail.
 */
export function trapFocus(
  container: HTMLElement,
  options: TrapFocusOptions = {}
): FocusTrap {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  function focusFirst(): void {
    const els = focusableWithin(container);
    if (els.length > 0) els[0].focus();
  }

  function focusElement(el: HTMLElement | null | undefined): void {
    if (!el) {
      focusFirst();
      return;
    }
    // Only focus elements that are actually focusable inside the container.
    if (!container.contains(el)) {
      focusFirst();
      return;
    }
    const focusables = focusableWithin(container);
    if (focusables.includes(el)) {
      el.focus();
    } else {
      focusFirst();
    }
  }

  function focusInitial(): void {
    const desired =
      typeof options.initialFocus === "function"
        ? options.initialFocus()
        : options.initialFocus;
    if (desired) {
      focusElement(desired);
    } else {
      focusFirst();
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Tab") return;
    const els = focusableWithin(container);
    if (els.length === 0) {
      e.preventDefault();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey) {
      if (active === first || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener("keydown", onKeyDown);
  // Defer initial focus so the caller's open animation (display:flex →
  // visible class) can complete and elements are actually focusable.
  requestAnimationFrame(focusInitial);

  return {
    refocusFirst() {
      focusFirst();
    },
    focusElement(el) {
      focusElement(el);
    },
    release() {
      container.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && document.body.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    },
  };
}
