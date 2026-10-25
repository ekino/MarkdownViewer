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
  return isRendered(el);
}

/**
 * False when `el` or an ancestor is display:none or visibility:hidden.
 */
function isRendered(el: HTMLElement): boolean {
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
  /**
   * Where focus goes on release when the element focused before the trap can
   * no longer take it (removed, hidden, disabled or inert meanwhile — e.g. a
   * button a resize swapped for another): the first of these that is shown,
   * enabled, in the tab order, not aria-hidden, and actually takes focus.
   * Not used when nothing had focus before the trap.
   */
  returnFocus?: HTMLElement[];
}

/**
 * True when focus is inside `container`, or nowhere in particular (body):
 * closing the panel may then move it. False when something else holds it,
 * such as a dialog opened from the panel.
 */
export function holdsFocus(container: HTMLElement): boolean {
  const focused = document.activeElement;
  return !focused || focused === document.body || container.contains(focused);
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
  // Focus immediately: callers reveal the container (display + visible class)
  // synchronously before trapping, so its contents are already focusable.
  // Deferring through a frame callback would silently skip initial focus
  // whenever frames are suspended, e.g. while the window is occluded.
  focusInitial();

  return {
    refocusFirst() {
      focusFirst();
    },
    focusElement(el) {
      focusElement(el);
    },
    release() {
      container.removeEventListener("keydown", onKeyDown);
      if (!previouslyFocused || previouslyFocused === document.body) return;
      if (
        document.body.contains(previouslyFocused) &&
        isRendered(previouslyFocused)
      ) {
        previouslyFocused.focus();
        if (document.activeElement === previouslyFocused) return;
      }
      for (const el of options.returnFocus ?? []) {
        if (!document.body.contains(el) || !isVisiblyFocusable(el)) continue;
        el.focus();
        if (document.activeElement === el) return;
      }
    },
  };
}
