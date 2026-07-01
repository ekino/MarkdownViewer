// Lightweight, self-contained debug HUD: per-phase document-open timings and a
// live FPS meter. Toggled from main.ts (Cmd/Ctrl+Shift+D). Kept out of
// index.html on purpose — it is dev tooling, not shipped UI, so it builds its
// own DOM and injects its own styles the first time it is shown.

export interface PhaseTimings {
  ping: number;
  read: number;
  parse: number;
  images: number;
  mermaid: number;
  dom: number;
  outline: number;
}

export interface OpenRecord {
  file: string;
  total: number;
  phases: PhaseTimings;
}

export interface DebugOverlay {
  recordOpen: (rec: OpenRecord) => void;
  toggle: () => void;
  isVisible: () => boolean;
  destroy: () => void;
}

const PHASE_LABELS: Array<[keyof PhaseTimings, string]> = [
  ["ping", "ipc ping (no-op)"],
  ["read", "read file (IPC)"],
  ["parse", "parse markdown"],
  ["images", "resolve images"],
  ["mermaid", "mermaid"],
  ["dom", "copy/lightbox"],
  ["outline", "outline"],
];

function ms(n: number): string {
  return `${n.toFixed(1)} ms`;
}

// Pure: renders an open record as ordered "label: value" lines, slowest phase
// flagged. Unit-tested without touching the DOM.
export function formatOpenRecord(rec: OpenRecord): string[] {
  let slowestKey: keyof PhaseTimings = "parse";
  let slowestVal = -1;
  for (const [key] of PHASE_LABELS) {
    if (rec.phases[key] > slowestVal) {
      slowestVal = rec.phases[key];
      slowestKey = key;
    }
  }
  const lines = PHASE_LABELS.map(([key, label]) => {
    const flag = key === slowestKey ? "  ◀ slowest" : "";
    return `${label}: ${ms(rec.phases[key])}${flag}`;
  });
  lines.push(`total: ${ms(rec.total)}`);
  return lines;
}

// Pure: the full clipboard payload (header + phase lines) for one open.
export function formatClipboard(rec: OpenRecord, fps: number): string {
  const header = [`open: ${rec.file}`, `FPS ${fps}`];
  return [...header, ...formatOpenRecord(rec)].join("\n");
}

const STYLE_ID = "mdv-debug-style";
const CSS = `
.mdv-debug {
  position: fixed;
  bottom: 12px;
  left: 12px;
  z-index: 99999;
  min-width: 240px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(12, 14, 18, 0.92);
  color: #e6e6e6;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  user-select: none;
  cursor: pointer;
}
.mdv-debug:active { background: rgba(30, 34, 42, 0.96); }
.mdv-debug__fps { font-size: 15px; font-weight: 700; }
.mdv-debug__fps b { color: #4ade80; }
.mdv-debug__title { margin: 8px 0 2px; color: #93c5fd; }
.mdv-debug__lines { white-space: pre; margin: 0; }
.mdv-debug__hint { margin-top: 8px; color: #6b7280; font-size: 10px; }
`;

export function createDebugOverlay(
  win: Window = window,
  doc: Document = document
): DebugOverlay {
  let visible = false;
  let el: HTMLElement | null = null;
  let fpsValueEl: HTMLElement | null = null;
  let linesEl: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let hintEl: HTMLElement | null = null;
  let rafId: number | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let frames = 0;
  let windowStart = 0;
  let lastFps = 0;
  let last: OpenRecord | null = null;

  const DEFAULT_HINT = "click to copy · ⌘⇧D to close";

  function ensureStyle(): void {
    if (doc.getElementById(STYLE_ID)) {
      return;
    }
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function build(): void {
    ensureStyle();
    el = doc.createElement("div");
    el.className = "mdv-debug";
    el.setAttribute("aria-hidden", "true");

    const fpsEl = doc.createElement("div");
    fpsEl.className = "mdv-debug__fps";
    fpsEl.append("FPS ");
    fpsValueEl = doc.createElement("b");
    fpsValueEl.textContent = "--";
    fpsEl.appendChild(fpsValueEl);

    titleEl = doc.createElement("div");
    titleEl.className = "mdv-debug__title";
    titleEl.textContent = "no document opened yet";

    linesEl = doc.createElement("pre");
    linesEl.className = "mdv-debug__lines";

    hintEl = doc.createElement("div");
    hintEl.className = "mdv-debug__hint";
    hintEl.textContent = DEFAULT_HINT;

    el.appendChild(fpsEl);
    el.appendChild(titleEl);
    el.appendChild(linesEl);
    el.appendChild(hintEl);
    el.addEventListener("click", copyToClipboard);
    doc.body.appendChild(el);
    if (last) {
      renderRecord(last);
    }
  }

  function flashHint(message: string): void {
    if (!hintEl) {
      return;
    }
    hintEl.textContent = message;
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
    }
    hintTimer = setTimeout(() => {
      if (hintEl) {
        hintEl.textContent = DEFAULT_HINT;
      }
      hintTimer = null;
    }, 1200);
  }

  function copyToClipboard(): void {
    if (!last) {
      flashHint("nothing to copy yet");
      return;
    }
    const text = formatClipboard(last, lastFps);
    const clip = win.navigator?.clipboard;
    if (clip?.writeText) {
      clip.writeText(text).then(
        () => flashHint("copied ✓"),
        () => flashHint("copy failed")
      );
    } else {
      flashHint("clipboard unavailable");
    }
  }

  function renderRecord(rec: OpenRecord): void {
    if (titleEl) {
      titleEl.textContent = `open: ${rec.file}`;
    }
    if (linesEl) {
      linesEl.textContent = formatOpenRecord(rec).join("\n");
    }
  }

  function loop(now: number): void {
    frames++;
    const elapsed = now - windowStart;
    if (elapsed >= 500) {
      const fps = Math.round((frames * 1000) / elapsed);
      lastFps = fps;
      if (fpsValueEl) {
        fpsValueEl.textContent = String(fps);
      }
      frames = 0;
      windowStart = now;
    }
    rafId = win.requestAnimationFrame(loop);
  }

  function startFps(): void {
    frames = 0;
    windowStart = win.performance.now();
    rafId = win.requestAnimationFrame(loop);
  }

  function stopFps(): void {
    if (rafId !== null) {
      win.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function show(): void {
    if (visible) {
      return;
    }
    visible = true;
    build();
    startFps();
  }

  function hide(): void {
    if (!visible) {
      return;
    }
    visible = false;
    stopFps();
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    el?.remove();
    el = fpsValueEl = linesEl = titleEl = hintEl = null;
  }

  return {
    recordOpen(rec: OpenRecord): void {
      last = rec;
      if (visible) {
        renderRecord(rec);
      }
    },
    toggle(): void {
      if (visible) {
        hide();
      } else {
        show();
      }
    },
    isVisible: () => visible,
    destroy: hide,
  };
}
