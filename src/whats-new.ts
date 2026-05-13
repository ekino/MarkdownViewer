// "What's New" screen. Two entry points:
//   - autoShowAfterUpdate: detects a version bump since last launch and
//     opens the modal automatically on first launch of the new version.
//   - showManually: triggered by the Help menu item — always opens, even
//     when there's no version delta.
//
// Release notes are fetched from the GitHub Releases API and rendered
// through the same DOMPurify-backed markdown pipeline the app uses for
// user documents. The fetched body is attacker-controlled if the
// signing key is ever compromised, so sanitization is non-negotiable.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { Store } from "@tauri-apps/plugin-store";
import { parseMarkdown } from "./markdown";
import { t } from "./i18n";

export const LAST_SEEN_VERSION_KEY = "lastSeenVersion";

export interface ReleaseRender {
  htmlBody: string;
  publishedAt: string | null;
  releaseUrl: string | null;
}

export interface WhatsNewDeps {
  store: Store;
  showModal: (version: string, info: ReleaseRender) => void;
}

interface ReleaseInfo {
  body: string;
  published_at: string | null;
  html_url: string | null;
}

// True when the installed version is strictly newer than what we last
// rendered the What's New screen for. Skip on first-ever launch
// (lastSeen empty) — there's no "what's new" relative to nothing.
export function shouldAutoShow(
  current: string,
  lastSeen: string | null | undefined,
): boolean {
  if (!lastSeen) return false;
  return current !== lastSeen;
}

export async function autoShowAfterUpdate(deps: WhatsNewDeps): Promise<void> {
  const current = await getVersion();
  const lastSeen = await deps.store.get<string>(LAST_SEEN_VERSION_KEY);
  if (!shouldAutoShow(current, lastSeen)) {
    // Still record the current version so the *next* update triggers
    // the auto-show. Without this, every cold launch on a fresh install
    // would be eligible the moment they update.
    if (!lastSeen) {
      await deps.store.set(LAST_SEEN_VERSION_KEY, current);
      await deps.store.save();
    }
    return;
  }
  const info = await loadRelease(current);
  if (!info) {
    // Network failure — don't pester the user, and don't update
    // lastSeen so we'll retry next launch.
    return;
  }
  deps.showModal(current, info);
  await deps.store.set(LAST_SEEN_VERSION_KEY, current);
  await deps.store.save();
}

export async function showManually(deps: WhatsNewDeps): Promise<void> {
  const current = await getVersion();
  const info = await loadRelease(current);
  deps.showModal(
    current,
    info ?? {
      htmlBody: `<p>${escapeText(t("whatsnew.unavailable"))}</p>`,
      publishedAt: null,
      releaseUrl: null,
    },
  );
}

async function loadRelease(version: string): Promise<ReleaseRender | null> {
  try {
    // Fetched on the Rust side so the renderer doesn't need a CSP
    // connect-src exception for api.github.com.
    const info = await invoke<ReleaseInfo | null>("fetch_release_notes", {
      version,
    });
    if (!info || !info.body.trim()) return null;
    return {
      // parseMarkdown already runs DOMPurify on its output.
      htmlBody: parseMarkdown(info.body),
      publishedAt: info.published_at,
      releaseUrl: info.html_url,
    };
  } catch (e) {
    // L3: surface for debugging while keeping the UX silent on failure.
    console.warn("Release notes fetch failed:", e);
    return null;
  }
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
}
