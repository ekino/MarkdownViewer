import { trapFocus, type FocusTrap } from "./focus-trap";

export interface ConfirmOptions {
  title: string;
  message: string;
  okLabel: string;
  cancelLabel: string;
  /** When true, the OK button uses a destructive style (red). */
  destructive?: boolean;
}

interface Refs {
  backdrop: HTMLDivElement;
  title: HTMLElement;
  message: HTMLElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

function getRefs(): Refs | null {
  const backdrop = document.getElementById(
    "confirm-backdrop"
  ) as HTMLDivElement | null;
  const title = document.getElementById("confirm-title");
  const message = document.getElementById("confirm-message");
  const ok = document.getElementById("confirm-ok") as HTMLButtonElement | null;
  const cancel = document.getElementById(
    "confirm-cancel"
  ) as HTMLButtonElement | null;
  if (!backdrop || !title || !message || !ok || !cancel) return null;
  return { backdrop, title, message, ok, cancel };
}

let activeTrap: FocusTrap | null = null;
let activeCleanup: (() => void) | null = null;

/**
 * Open a confirmation dialog and resolve when the user picks OK or Cancel.
 *
 * Replaces the blocking native `confirm()` with a styled modal that
 * integrates with the rest of the app (theme, i18n, focus trap, Escape to
 * cancel, click-outside to cancel).
 *
 * Only one confirm dialog can be open at a time; calling this while another
 * one is open cancels the previous one and opens the new one.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const refs = getRefs();
  if (!refs) {
    // Defensive fallback when the markup is missing (e.g. in tests that don't
    // mount index.html): use the native confirm so callers still work.
    return Promise.resolve(window.confirm(options.message));
  }

  // If a previous dialog is still open, cancel it before opening the new one.
  activeCleanup?.();

  const { backdrop, title, message, ok, cancel } = refs;
  title.textContent = options.title;
  message.textContent = options.message;
  ok.textContent = options.okLabel;
  cancel.textContent = options.cancelLabel;
  ok.classList.toggle("destructive", options.destructive === true);

  backdrop.style.display = "flex";
  requestAnimationFrame(() => backdrop.classList.add("visible"));
  activeTrap = trapFocus(backdrop);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    function close(result: boolean): void {
      if (settled) return;
      settled = true;
      backdrop.classList.remove("visible");
      cleanup();
      setTimeout(() => {
        // Only hide if no other dialog opened in the meantime.
        if (!backdrop.classList.contains("visible")) {
          backdrop.style.display = "none";
        }
      }, 180);
      resolve(result);
    }

    function onOkClick(): void {
      close(true);
    }
    function onCancelClick(): void {
      close(false);
    }
    function onBackdropClick(e: MouseEvent): void {
      if (e.target === backdrop) close(false);
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        // Enter while focus is on the OK button is the default; otherwise let
        // the user explicitly press the button.
        if (document.activeElement === ok) {
          e.preventDefault();
          close(true);
        }
      }
    }

    function cleanup(): void {
      ok.removeEventListener("click", onOkClick);
      cancel.removeEventListener("click", onCancelClick);
      backdrop.removeEventListener("click", onBackdropClick);
      document.removeEventListener("keydown", onKeyDown);
      activeTrap?.release();
      activeTrap = null;
      activeCleanup = null;
    }

    ok.addEventListener("click", onOkClick);
    cancel.addEventListener("click", onCancelClick);
    backdrop.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onKeyDown);

    activeCleanup = () => close(false);
  });
}
