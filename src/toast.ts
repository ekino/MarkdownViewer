// Tiny toast for transient user-facing messages (errors, info).
// Single visible toast at a time. No dependencies, ~1 KiB shipped.

export type ToastKind = "info" | "error";

const TOAST_TIMEOUT_MS = 4000;

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | null = null;

function ensureRoot(): HTMLDivElement {
  if (toastEl) return toastEl;
  toastEl = document.createElement("div");
  toastEl.id = "toast";
  toastEl.setAttribute("role", "status");
  toastEl.setAttribute("aria-live", "polite");
  toastEl.style.display = "none";
  document.body.appendChild(toastEl);
  return toastEl;
}

export function showToast(message: string, kind: ToastKind = "info"): void {
  const el = ensureRoot();
  el.textContent = message;
  el.dataset.kind = kind;
  el.style.display = "block";
  el.onclick = hideToast;
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(hideToast, TOAST_TIMEOUT_MS);
}

export function hideToast(): void {
  if (!toastEl) return;
  toastEl.style.display = "none";
  toastEl.textContent = "";
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
}

// Test seam — resets module state so each test starts clean.
export function _resetToastForTests(): void {
  if (toastEl && toastEl.parentNode) {
    toastEl.parentNode.removeChild(toastEl);
  }
  toastEl = null;
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
}
