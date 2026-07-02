import { t } from "./i18n";

/** Progress payload emitted by the updater during download. */
export interface DownloadProgressEvent {
  event: "Started" | "Progress" | "Finished";
  data?: { contentLength?: number; chunkLength?: number };
}

/**
 * Minimal shape of the object returned by the updater plugin's `check()`.
 * Kept as an interface so the controller can be unit-tested with a fake
 * backend instead of the real Tauri plugin.
 */
export interface UpdateHandle {
  version: string;
  downloadAndInstall(
    onEvent?: (event: DownloadProgressEvent) => void
  ): Promise<void>;
}

/** The two plugin calls the controller depends on. */
export interface UpdaterBackend {
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
}

export interface CheckOptions {
  /**
   * Silent checks (app launch) stay invisible unless an update is found.
   * Non-silent checks (menu) also surface "up to date" and error states.
   */
  silent?: boolean;
}

interface ToastRefs {
  root: HTMLElement;
  icon: HTMLElement;
  text: HTMLElement;
  action: HTMLButtonElement;
  dismiss: HTMLButtonElement;
}

function getRefs(): ToastRefs | null {
  const root = document.getElementById("update-toast");
  const icon = document.getElementById("update-toast-icon");
  const text = document.getElementById("update-toast-text");
  const action = document.getElementById(
    "update-toast-action"
  ) as HTMLButtonElement | null;
  const dismiss = document.getElementById(
    "update-toast-dismiss"
  ) as HTMLButtonElement | null;
  if (!root || !icon || !text || !action || !dismiss) return null;
  return { root, icon, text, action, dismiss };
}

/** Auto-dismiss delay for the transient "up to date" / error toasts. */
const AUTO_HIDE_MS = 4000;

export interface UpdaterController {
  check(options?: CheckOptions): Promise<void>;
}

export function createUpdaterController(
  backend: UpdaterBackend,
  refs: ToastRefs | null = getRefs()
): UpdaterController {
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;

  function clearHideTimer(): void {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  }

  function hide(): void {
    if (!refs) return;
    clearHideTimer();
    refs.root.hidden = true;
    refs.action.hidden = true;
    refs.action.onclick = null;
  }

  function show(opts: {
    message: string;
    spinner: boolean;
    actionLabel?: string;
    onAction?: () => void;
    autoHide?: boolean;
  }): void {
    if (!refs) return;
    clearHideTimer();
    refs.text.textContent = opts.message;
    refs.icon.classList.toggle("update-toast-spinner", opts.spinner);
    if (opts.actionLabel && opts.onAction) {
      refs.action.hidden = false;
      refs.action.textContent = opts.actionLabel;
      refs.action.onclick = opts.onAction;
    } else {
      refs.action.hidden = true;
      refs.action.onclick = null;
    }
    refs.root.hidden = false;
    if (opts.autoHide) {
      hideTimer = setTimeout(hide, AUTO_HIDE_MS);
    }
  }

  async function check(options: CheckOptions = {}): Promise<void> {
    const silent = options.silent ?? false;
    // Guard against overlapping checks (menu spam / launch + menu race).
    if (busy) return;
    busy = true;
    try {
      let update: UpdateHandle | null = null;
      try {
        update = await backend.check();
      } catch {
        if (!silent) {
          show({ message: t("updater.error"), spinner: false, autoHide: true });
        }
        return;
      }

      if (!update) {
        if (!silent) {
          show({
            message: t("updater.upToDate"),
            spinner: false,
            autoHide: true,
          });
        }
        return;
      }

      const version = update.version;
      try {
        show({ message: t("updater.downloading"), spinner: true });
        await update.downloadAndInstall();
      } catch {
        show({ message: t("updater.error"), spinner: false, autoHide: true });
        return;
      }

      show({
        message: t("updater.restart").replace("{version}", version),
        spinner: false,
        actionLabel: t("updater.restartAction"),
        onAction: () => {
          void backend.relaunch();
        },
      });
    } finally {
      busy = false;
    }
  }

  if (refs) {
    refs.dismiss.onclick = hide;
  }

  return { check };
}
