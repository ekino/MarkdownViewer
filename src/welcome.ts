// Welcome view: renders the Recents list inside the existing #empty-state.
// The two big buttons (Open File / Open Folder) and tips are static HTML;
// only the recents list needs JS to render and react to validation results.

import { t } from "./i18n";
import type { RecentEntry } from "./recents";

export interface RecentDisplayEntry extends RecentEntry {
  missing: boolean;
}

export interface WelcomeHandlers {
  onOpenRecent: (entry: RecentEntry) => void;
  onReveal: (entry: RecentEntry) => void;
  onRemove: (entry: RecentEntry) => void;
  onClear: () => void;
}

// Build the path-display string. For files we show the parent directory;
// for folders we show the full path. Truncation is handled by CSS (the
// list item uses RTL ellipsis so the rightmost segments stay visible).
function pathDisplay(entry: RecentEntry): string {
  if (entry.kind === "folder") return entry.path;
  const lastSep = Math.max(
    entry.path.lastIndexOf("/"),
    entry.path.lastIndexOf("\\"),
  );
  return lastSep > 0 ? entry.path.slice(0, lastSep) : entry.path;
}

export function renderRecentsList(
  container: HTMLElement,
  entries: readonly RecentDisplayEntry[],
  handlers: WelcomeHandlers,
): void {
  container.replaceChildren();
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "welcome-recent-item";
    if (entry.missing) {
      li.classList.add("missing");
      li.title = t("welcome.missing");
    }
    li.dataset.path = entry.path;
    li.dataset.kind = entry.kind;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.displayName;

    const path = document.createElement("span");
    path.className = "path";
    path.textContent = pathDisplay(entry);

    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = entry.kind === "folder" ? "FOLDER" : "FILE";

    li.append(name, path, kind);
    li.addEventListener("click", () => handlers.onOpenRecent(entry));
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showRecentContextMenu(e, entry, handlers);
    });
    container.appendChild(li);
  }
}

export function updateWelcomeVisibility(
  recentsWrap: HTMLElement,
  hasEntries: boolean,
): void {
  recentsWrap.hidden = !hasEntries;
}

// Light-weight context menu — no Portal, just an absolutely positioned div
// dismissed on the next click anywhere. Reused by the sidebar in PR 2
// task #12 via showContextMenu().
export function showContextMenu(
  x: number,
  y: number,
  items: Array<{ label: string; disabled?: boolean; onSelect: () => void }>,
): void {
  // Remove any previous menu first.
  document.querySelectorAll(".ctx-menu").forEach((n) => n.remove());

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      item.onSelect();
      menu.remove();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Defer the dismiss listener so the originating right-click doesn't
  // immediately close the menu we just opened.
  setTimeout(() => {
    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", dismiss, true);
      }
    };
    document.addEventListener("mousedown", dismiss, true);
  }, 0);

  // Clamp inside viewport.
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = `${Math.max(0, vw - rect.width - 4)}px`;
  if (rect.bottom > vh) menu.style.top = `${Math.max(0, vh - rect.height - 4)}px`;
}

function showRecentContextMenu(
  e: MouseEvent,
  entry: RecentEntry,
  handlers: WelcomeHandlers,
): void {
  showContextMenu(e.clientX, e.clientY, [
    { label: t("welcome.reveal"), onSelect: () => handlers.onReveal(entry) },
    { label: t("welcome.remove"), onSelect: () => handlers.onRemove(entry) },
  ]);
}
